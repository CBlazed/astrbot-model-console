/**
 * Append-only diagnostics journal for the Model Console.
 *
 * One JSON object per line in `<state>/diagnostics.jsonl`. The active file is rotated once it would
 * exceed 1 MiB; rotated copies are named `diagnostics.1.jsonl` (newest) … `diagnostics.<keep>.jsonl`
 * (oldest). Every failure is swallowed: diagnostics must never break or delay the main request path.
 *
 * Event schema (extra keys are dropped by whitelist, never written):
 *   {time,level,event,code?,path?,status?,device?,detail?}
 * Strings are aggressively scrubbed so tokens, keys, request bodies, configuration values and
 * absolute filesystem paths cannot reach the file. `detail` is only for a short human note.
 */
import {appendFile,mkdir,readFile,rename,stat,unlink} from 'node:fs/promises';
import {join} from 'node:path';

export const DIAGNOSTICS_FILE='diagnostics.jsonl';
export const DIAGNOSTICS_MAX_BYTES=1024*1024;
export const DIAGNOSTICS_KEEP=3;
export const DIAGNOSTICS_MAX_DETAIL=200;

const LEVELS=new Set(['info','warn','error']);
const EVENT_NAME=/^[a-z][a-z0-9_.-]{0,63}$/;
const ERROR_CODE=/^[A-Z][A-Z0-9_]{0,63}$/;
const DEVICE_NAME=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const WINDOWS_PATH=/\b[A-Za-z]:[\\/][^\s"'<>]*/g;
const UNC_PATH=/\\\\[^\s"'<>\\]+\\[^\s"'<>]*/g;
const POSIX_PATH=/(^|[\s"'=(:,])\/[^\s"'<>]*/g;
const SECRET_PATTERN=/\b(token|secret|password|passwd|api[_-]?key|key|authorization|bearer|cookie|jwt)\b\s*[=:]?\s*\S*/gi;
const CONTROL=/[\u0000-\u001f\u007f]/g;

/** True only for a local request path: starts with "/", no query, no traversal, no absolute file path. */
export function sanitizePath(value){
  if(typeof value!=='string')return null;
  const path=value.split(/[?#]/)[0];
  if(!path||path.length>256||!path.startsWith('/'))return null;
  if(path.includes('\\')||path.includes('..'))return null;
  if(CONTROL.test(path))return null;
  if(!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(path))return null;
  return path;
}

/** Reduce free text to something that cannot carry credentials or filesystem layout. */
export function redactDetail(value){
  if(typeof value!=='string')return null;
  let text=value.replace(CONTROL,' ');
  text=text.replace(WINDOWS_PATH,'[path]');
  text=text.replace(UNC_PATH,'[path]');
  text=text.replace(POSIX_PATH,'$1[path]');
  text=text.replace(SECRET_PATTERN,'[redacted]');
  text=text.replace(/\s+/g,' ').trim();
  if(!text)return null;
  return text.slice(0,DIAGNOSTICS_MAX_DETAIL);
}

/**
 * Whitelist and sanitize one event. Returns null when the event cannot be recorded safely
 * (missing event name), so callers and file readers share exactly one shape.
 */
export function normalizeEvent(input,now=new Date()){
  if(!input||typeof input!=='object'||Array.isArray(input))return null;
  if(typeof input.event!=='string'||!EVENT_NAME.test(input.event))return null;
  const record={time:normalizeTime(input.time,now),level:LEVELS.has(input.level)?input.level:'info',event:input.event};
  if(typeof input.code==='string'&&ERROR_CODE.test(input.code))record.code=input.code;
  const path=sanitizePath(input.path);
  if(path)record.path=path;
  if(Number.isInteger(input.status)&&input.status>=100&&input.status<=599)record.status=input.status;
  if(typeof input.device==='string'&&DEVICE_NAME.test(input.device))record.device=input.device;
  const detail=redactDetail(input.detail);
  if(detail)record.detail=detail;
  return record;
}

function normalizeTime(value,now){
  if(typeof value==='string'&&value.length<=32&&/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?$/.test(value)){
    const parsed=Date.parse(value);
    if(Number.isFinite(parsed))return new Date(parsed).toISOString();
  }
  return now.toISOString();
}

/** Serialize writes so concurrent requests cannot interleave rotation; never rejects. */
let writeQueue=Promise.resolve();
function enqueue(task){
  const run=writeQueue.then(task,task);
  writeQueue=run.then(()=>{},()=>{});
  return run;
}

async function rotate(dir,file,incoming,maxBytes,keep){
  let size;
  try{size=(await stat(file)).size;}catch{return;}
  if(size===0||size+incoming<=maxBytes)return;
  for(let index=keep;index>=1;index--){
    const target=join(dir,`diagnostics.${index}.jsonl`);
    const source=index===1?file:join(dir,`diagnostics.${index-1}.jsonl`);
    try{await unlink(target);}catch{}
    try{await rename(source,target);}catch(error){if(error?.code!=='ENOENT')throw error;}
  }
}

async function writeRecord(stateDir,record,{maxBytes,keep}){
  const file=join(stateDir,DIAGNOSTICS_FILE);
  const line=`${JSON.stringify(record)}\n`;
  await mkdir(stateDir,{recursive:true});
  await rotate(stateDir,file,Buffer.byteLength(line),maxBytes,Math.max(1,keep));
  await appendFile(file,line,'utf8');
}

/**
 * Append one diagnostic event. Resolves false (never rejects, never throws) when the event is
 * invalid or the write fails, so callers can fire-and-forget.
 */
export function logDiagnostic(stateDir,event,{maxBytes=DIAGNOSTICS_MAX_BYTES,keep=DIAGNOSTICS_KEEP}={}){
  try{
    const record=normalizeEvent(event);
    if(!record||typeof stateDir!=='string'||stateDir.length===0)return Promise.resolve(false);
    const size=Number.isFinite(maxBytes)&&maxBytes>0?Math.floor(maxBytes):DIAGNOSTICS_MAX_BYTES;
    const keepCount=Number.isInteger(keep)&&keep>0?keep:DIAGNOSTICS_KEEP;
    return enqueue(()=>writeRecord(stateDir,record,{maxBytes:size,keep:keepCount})).then(()=>true,()=>false);
  }catch{
    return Promise.resolve(false);
  }
}

/**
 * Read recent sanitized events, oldest first. Rotated files are read in age order and every line is
 * re-normalized, so a tampered or truncated file cannot leak values through the export endpoint.
 */
export async function readDiagnostics(stateDir,{limit=200,keep=DIAGNOSTICS_KEEP}={}){
  if(typeof stateDir!=='string'||stateDir.length===0)return [];
  const cap=Math.min(Math.max(1,Number.isInteger(limit)?limit:200),1000);
  const keepCount=Number.isInteger(keep)&&keep>0?keep:DIAGNOSTICS_KEEP;
  const names=[];
  for(let index=keepCount;index>=1;index--)names.push(`diagnostics.${index}.jsonl`);
  names.push(DIAGNOSTICS_FILE);
  const events=[];
  for(const name of names){
    let text;
    try{text=await readFile(join(stateDir,name),'utf8');}catch{continue;}
    for(const line of text.split('\n')){
      if(!line.trim())continue;
      let parsed;
      try{parsed=JSON.parse(line);}catch{continue;}
      const record=normalizeEvent(parsed);
      if(record)events.push(record);
    }
  }
  return events.slice(-cap);
}
