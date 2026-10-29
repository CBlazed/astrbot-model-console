import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  DIAGNOSTICS_KEEP,
  DIAGNOSTICS_MAX_BYTES,
  logDiagnostic,
  normalizeEvent,
  readDiagnostics,
  redactDetail,
  sanitizePath,
} from '../src/diagnostics.mjs';

const temp=async prefix=>mkdtemp(join(tmpdir(),prefix));

async function readLines(path){
  let text;
  try{text=await readFile(path,'utf8');}catch(error){if(error.code==='ENOENT')return [];throw error;}
  return text.split('\n').filter(Boolean).map(line=>JSON.parse(line));
}

test('normalizeEvent keeps only the whitelisted schema and never the token/key/body',()=>{
  const record=normalizeEvent({time:'2026-10-29T12:00:00.000Z',level:'error',event:'request-failed',code:'BACKUP_FAILED',path:'/backups',status:409,device:'dev-1',token:'abc',key:'k',body:{password:'p'},config:{secret:'s'}});
  assert.deepEqual(Object.keys(record).sort(),['code','device','event','level','path','status','time']);
  assert.equal(record.time,'2026-10-29T12:00:00.000Z');
  assert.equal(record.code,'BACKUP_FAILED');
  const text=JSON.stringify(record);
  assert.doesNotMatch(text,/abc|"token"|"key"|"body"|password|secret/);
  assert.equal(normalizeEvent({level:'warn'}),null);
  assert.equal(normalizeEvent(null),null);
  assert.equal(normalizeEvent('event'),null);
  assert.equal(normalizeEvent({event:'Bad Name'}),null);
});

test('sanitizePath drops absolute filesystem paths, queries and traversal',()=>{
  assert.equal(sanitizePath('/backups'),'/backups');
  assert.equal(sanitizePath('/backups/abc/diff?kind=profile&id=default'),'/backups/abc/diff');
  assert.equal(sanitizePath('C:\\Users\\me\\state'),null);
  assert.equal(sanitizePath('/../../etc/passwd'),null);
  assert.equal(sanitizePath('/a\\b'),null);
  assert.equal(sanitizePath(''),null);
  assert.equal(sanitizePath(null),null);
});

test('redactDetail removes secrets and absolute paths but keeps a short readable note',()=>{
  const detail=redactDetail('read failed C:\\Users\\me\\state\\backups\\1 token=abc123 key: xyz /home/me/data');
  assert.ok(detail);
  assert.doesNotMatch(detail,/C:\\|Users|abc123|xyz|\/home/);
  assert.match(detail,/\[path\]/);
  assert.match(detail,/\[redacted\]/);
  assert.equal(redactDetail(null),null);
  assert.equal(redactDetail(''),null);
  assert.ok(redactDetail('x'.repeat(500)).length<=200);
});

test('logDiagnostic appends one sanitized JSON line per event and creates the state directory',async()=>{
  const dir=join(await temp('model-console-diag-'),'nested','state');
  assert.equal(await logDiagnostic(dir,{level:'warn',event:'request-rejected',status:403,code:'ACCESS_DENIED',path:'/backups',detail:'token=deadbeef C:\\Users\\me\\secret.json'}),true);
  assert.equal(await logDiagnostic(dir,{level:'error',event:'request-failed',status:500,path:'C:\\Users\\me\\state\\x'}),true);
  const lines=await readLines(join(dir,'diagnostics.jsonl'));
  assert.equal(lines.length,2);
  assert.equal(lines[0].level,'warn');
  assert.equal(lines[0].status,403);
  assert.equal(lines[0].path,'/backups');
  assert.equal('path' in lines[1],false);
  assert.ok(lines.every(line=>/^\d{4}-\d{2}-\d{2}T/.test(line.time)));
  const text=await readFile(join(dir,'diagnostics.jsonl'),'utf8');
  assert.doesNotMatch(text,/deadbeef|C:\\\\|Users|"token"/);
  assert.equal(text.trim().split('\n').length,2);
});

test('logDiagnostic is silent and resolves false for invalid events or unwritable paths',async()=>{
  const root=await temp('model-console-diag-');
  const asFile=join(root,'not-a-directory');
  await writeFile(asFile,'x','utf8');
  assert.equal(await logDiagnostic(join(asFile,'sub'),{event:'request-failed'}),false);
  assert.equal(await logDiagnostic(null,{event:'request-failed'}),false);
  assert.equal(await logDiagnostic(root,{event:'NOT VALID'}),false);
  assert.equal(await logDiagnostic(root,undefined),false);
  await assert.rejects(async()=>{await readFile(join(root,'diagnostics.jsonl'),'utf8');},error=>error.code==='ENOENT');
});

test('concurrent writes stay ordered, complete and parseable',async()=>{
  const dir=await temp('model-console-diag-');
  const pending=[];
  for(let index=0;index<25;index++)pending.push(logDiagnostic(dir,{level:'info',event:'apply-start',status:200,detail:`step ${index}`}));
  assert.deepEqual(await Promise.all(pending),Array(25).fill(true));
  const lines=await readLines(join(dir,'diagnostics.jsonl'));
  assert.equal(lines.length,25);
  assert.deepEqual(lines.map(line=>line.detail).slice(0,3),['step 0','step 1','step 2']);
});

test('the active file rotates at the byte cap and keeps exactly three older files',async()=>{
  const dir=await temp('model-console-diag-');
  const maxBytes=512,keep=3;
  for(let index=0;index<40;index++)await logDiagnostic(dir,{level:'info',event:'rotate-check',detail:`event-${index}-${'x'.repeat(100)}`},{maxBytes,keep});
  const base=await stat(join(dir,'diagnostics.jsonl'));
  assert.ok(base.size<=maxBytes,`active file ${base.size} exceeds ${maxBytes}`);
  for(const name of ['diagnostics.1.jsonl','diagnostics.2.jsonl','diagnostics.3.jsonl'])assert.equal((await stat(join(dir,name))).isFile(),true,name);
  await assert.rejects(async()=>{await stat(join(dir,'diagnostics.4.jsonl'));},error=>error.code==='ENOENT');
  const oldest=await readLines(join(dir,'diagnostics.3.jsonl'));
  const middle=await readLines(join(dir,'diagnostics.2.jsonl'));
  const newestOld=await readLines(join(dir,'diagnostics.1.jsonl'));
  const active=await readLines(join(dir,'diagnostics.jsonl'));
  const all=[...oldest,...middle,...newestOld,...active];
  assert.ok(all.length<40,'rotation must drop the oldest events');
  assert.ok(all.length>0);
  assert.equal(all.at(-1).detail,`event-39-${'x'.repeat(100)}`);
  const sequence=all.map(line=>Number(/^event-(\d+)-/.exec(line.detail)?.[1]));
  assert.ok(sequence.every(Number.isInteger));
  assert.deepEqual(sequence,[...sequence].sort((a,b)=>a-b));
  assert.equal(new Set(sequence).size,sequence.length);
  assert.ok(DIAGNOSTICS_MAX_BYTES>=1024*1024);
  assert.equal(DIAGNOSTICS_KEEP,3);
});

test('readDiagnostics returns the newest events first-in-last-out by age and re-sanitizes tampered lines',async()=>{
  const dir=await temp('model-console-diag-');
  for(let index=0;index<5;index++)await logDiagnostic(dir,{level:'info',event:'read-check',detail:`n-${index}`});
  await writeFile(join(dir,'diagnostics.1.jsonl'),`${JSON.stringify({time:'2026-10-29T00:00:00.000Z',level:'warn',event:'manual',detail:'C:\\Users\\me token=abc123'})}\n`,'utf8');
  const events=await readDiagnostics(dir,{limit:3});
  assert.equal(events.length,3);
  assert.deepEqual(events.map(event=>event.detail),['n-2','n-3','n-4']);
  const all=await readDiagnostics(dir);
  assert.equal(all.length,6);
  assert.equal(all[0].event,'manual');
  assert.doesNotMatch(all[0].detail,/C:\\|Users|abc123/);
  assert.deepEqual(await readDiagnostics(null),[]);
});
