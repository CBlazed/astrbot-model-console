/** Loopback-only agent: pairs a Hub with a one-time code, then serves read-only Engine snapshots. */
import http from 'node:http';
import {createHash,randomBytes,randomInt,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dirname,join,resolve} from 'node:path';
import {appendFile,mkdir,open,readFile,rename,writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {Gateway} from './gateway.mjs';
import {Engine,knownError} from './engine.mjs';
import * as backupModule from './backup.mjs';
import {logDiagnostic} from './diagnostics.mjs';
import {ASTRBOT_DATA_REQUIRED,discoverAstrBotData,resolveStateDir} from './config.mjs';

export const AGENT_STATE_FILE='agent.json';
export const PAIRING_TTL_MS=10*60*1000;
export const PAIRING_CODE_PATTERN=/^\d{8}$/;
export const TOKEN_PATTERN=/^[a-f0-9]{64}$/i;
export const PAIR_FAIL_LIMIT=5;
export const PAIR_FAIL_WINDOW_MS=60*1000;
export const MAX_BODY_BYTES=16*1024;
export const HOT_LOAD_TAIL_LINES=200;
export const HOT_LOAD_TAIL_BYTES=128*1024;
export const HOT_LOAD_PATTERN=/reload|hot[ -]?reload|热重载|配置已更新/i;
export const AGENT_READ_ONLY='AGENT_READ_ONLY';

const PLAN_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_BACKUP_ID=/^[0-9a-f]{8,12}$/i;
const FULL_UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_TOKEN=/^[a-z][a-z0-9-]{0,63}$/;

/** Console/agent version shown by /agent/v1/health; read once, never fatal. */
const VERSION=(()=>{try{const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));return typeof pkg.version==='string'?pkg.version:null;}catch{return null;}})();

const sha256Hex=value=>createHash('sha256').update(value,'utf8').digest('hex');

/** Constant-time comparison of two hex digests; false on malformed input instead of throwing. */
function safeEqualHex(left,right){
  if(typeof left!=='string'||typeof right!=='string'||!TOKEN_PATTERN.test(left)||!TOKEN_PATTERN.test(right))return false;
  return timingSafeEqual(Buffer.from(left,'hex'),Buffer.from(right,'hex'));
}

/** Reject any Authorization value that is not exactly one 64-hex Bearer token. */
function bearerToken(req){
  const header=req.headers?.authorization;
  if(typeof header!=='string')return null;
  const match=/^Bearer ([a-f0-9]{64})$/i.exec(header);
  return match?match[1].toLowerCase():null;
}

function codedError(code,status){const error=Error(code);error.code=code;error.status=status;return error;}

/** Whitelist error details before they leave the agent (id/backupId/outcome/code only, no paths). */
export function sanitizeErrorDetails(details){
  const safe={};
  if(!details||typeof details!=='object')return safe;
  const usable=value=>typeof value==='string'&&value.length>0&&value.length<=128;
  if(usable(details.id)&&PLAN_ID.test(details.id))safe.id=details.id;
  if(usable(details.backupId)&&(SHORT_BACKUP_ID.test(details.backupId)||FULL_UUID.test(details.backupId)))safe.backupId=details.backupId;
  if(usable(details.outcome)&&SAFE_TOKEN.test(details.outcome))safe.outcome=details.outcome;
  if(usable(details.code)&&/^[A-Z][A-Z0-9_]{0,63}$/.test(details.code))safe.code=details.code;
  return safe;
}

/** Only contract fields leave the agent; ids are UUID basenames, never absolute paths. */
function publicBackup(item){
  if(!item||typeof item!=='object')return null;
  const id=typeof item.id==='string'?item.id:null;
  if(!id||!(FULL_UUID.test(id)||SHORT_BACKUP_ID.test(id)))return null;
  const entry={id};
  if(typeof item.createdAt==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(item.createdAt)&&item.createdAt.length<=40)entry.createdAt=item.createdAt;
  if(typeof item.bytes==='number'&&Number.isFinite(item.bytes)&&item.bytes>=0)entry.bytes=Math.floor(item.bytes);
  if(Number.isInteger(item.files)&&item.files>=0)entry.files=item.files;
  if(typeof item.sqlite==='string'&&/^[a-z][a-z0-9_-]{0,15}$/.test(item.sqlite))entry.sqlite=item.sqlite;
  return entry;
}

/** Read the last lines of a log without loading the whole file; null when it cannot be read. */
async function readLogTail(path,{maxLines=HOT_LOAD_TAIL_LINES,maxBytes=HOT_LOAD_TAIL_BYTES}={}){
  if(typeof path!=='string')return null;
  let handle;
  try{
    handle=await open(path,'r');
    const info=await handle.stat();
    if(!info.isFile())return null;
    if(info.size===0)return [];
    const start=Math.max(0,info.size-maxBytes);
    const buffer=Buffer.alloc(info.size-start);
    await handle.read(buffer,0,buffer.length,start);
    return buffer.toString('utf8').split('\n').map(line=>line.replace(/\r$/,'')).slice(-maxLines).filter(Boolean);
  }catch{return null;}
  finally{try{await handle?.close();}catch{}}
}

/**
 * Evidence for "did the running AstrBot pick the change up?" — read the local log tail (<=200 lines) and
 * look for a reload marker. Never throws: missing/unreadable logs report checked:true with a note.
 */
export async function hotLoadEvidence(dataDir){
  const lines=await readLogTail(dataDir?join(dataDir,'logs','astrbot.log'):null);
  if(lines===null)return {verified:false,checked:true,note:'无法读取本机日志，未确认热重载是否发生'};
  const marker=lines.find(line=>HOT_LOAD_PATTERN.test(line));
  if(marker)return {verified:true,checked:true,marker:marker.trim().slice(0,200)};
  return {verified:false,checked:true,note:`日志尾部 ${Math.min(lines.length,HOT_LOAD_TAIL_LINES)} 行未发现热重载标记，配置可能需重启生效`};
}

async function readJsonBody(req){
  const chunks=[];
  let bytes=0;
  for await(const chunk of req){
    bytes+=chunk.length;
    if(bytes>MAX_BODY_BYTES)throw codedError('AGENT_BODY_TOO_LARGE',413);
    chunks.push(chunk);
  }
  if(!chunks.length)return undefined;
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw codedError('AGENT_INVALID_JSON',400);}
}

/** Load the persisted token hash; anything malformed is treated as "not paired yet". */
async function loadTokenHash(statePath){
  let parsed;
  try{parsed=JSON.parse((await readFile(statePath,'utf8')).replace(/^\uFEFF/,''));}catch{return null;}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return null;
  return typeof parsed.tokenHash==='string'&&TOKEN_PATTERN.test(parsed.tokenHash)?parsed.tokenHash.toLowerCase():null;
}

/** Persist only hashes: never the pairing code and never the device token. */
async function saveState(statePath,{tokenHash,pairingHash,pairingExpiresAt},now){
  const state={
    version:1,
    tokenHash:tokenHash??null,
    pairing:pairingHash?{hash:pairingHash,expiresAt:pairingExpiresAt}:null,
    updatedAt:new Date(now).toISOString(),
  };
  const temporary=`${statePath}.${process.pid}.tmp`;
  await mkdir(dirname(statePath),{recursive:true});
  await writeFile(temporary,`${JSON.stringify(state)}\n`,{encoding:'utf8',mode:0o600});
  await rename(temporary,statePath);
}

/**
 * Start the agent HTTP server on 127.0.0.1 only.
 *
 * Returns {server,url,port,statePath,pairingCode,expiresAt,close}. The pairing code is printed by the
 * CLI and never persisted; `<state>/agent.json` keeps only sha256 hashes. `engine`, `now`, `pairingTtlMs`,
 * `pairFailLimit`, `pairFailWindowMs` are optional test hooks.
 */
export async function startAgent({env=process.env,dataDir,stateDir,port=0,writeEnabled=false,engine,now=Date.now,pairingTtlMs=PAIRING_TTL_MS,pairFailLimit=PAIR_FAIL_LIMIT,pairFailWindowMs=PAIR_FAIL_WINDOW_MS}={}){
  const state=stateDir??resolveStateDir(env);
  await mkdir(state,{recursive:true});
  const statePath=join(state,AGENT_STATE_FILE);
  let tokenHash=await loadTokenHash(statePath);
  const pairingCode=String(randomInt(0,100000000)).padStart(8,'0');
  const pairingHash=sha256Hex(pairingCode);
  const startedMs=now();
  const expiresMs=startedMs+pairingTtlMs;
  await saveState(statePath,{tokenHash,pairingHash,pairingExpiresAt:new Date(expiresMs).toISOString()},startedMs);

  let resolvedEngine=engine;
  const resolvedDataDir=dataDir??(engine?undefined:await discoverAstrBotData(env));
  if(!resolvedEngine){
    const gateway=new Gateway(resolvedDataDir);
    const backupsDir=join(state,'backups');
    const backupsWiring=typeof backupModule.listBackups==='function'&&typeof backupModule.readBackupResource==='function'
      ?{list:()=>backupModule.listBackups(backupsDir),read:(backupId,resource)=>backupModule.readBackupResource(backupsDir,backupId,resource)}
      :null;
    resolvedEngine=writeEnabled
      ?new Engine({
        gateway,
        writeEnabled:true,
        backups:backupsWiring??undefined,
        backup:()=>backupModule.backupState(resolvedDataDir,backupsDir,{env,onWarning:(code)=>logDiagnostic(state,{level:'warn',event:'backup-warning',code:typeof code==='string'?code:undefined})}),
        audit:event=>appendFile(join(state,'audit.jsonl'),JSON.stringify({...event,time:new Date().toISOString()})+'\n'),
      })
      :new Engine({gateway,writeEnabled:false});
  }

  /** Pairing code becomes unusable after one successful pair or after its TTL. */
  let activePairingHash=pairingHash;
  let activePairingExpiresMs=expiresMs;
  const failureTimes=[];
  const failuresInWindow=()=>{
    const cutoff=now()-pairFailWindowMs;
    while(failureTimes.length&&failureTimes[0]<=cutoff)failureTimes.shift();
    return failureTimes.length;
  };

  const server=http.createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    const send=(status,body)=>{res.writeHead(status);res.end(JSON.stringify(body));};
    let url;
    try{url=new URL(req.url,'http://127.0.0.1');}catch{return send(404,{error:'AGENT_NOT_FOUND'});}
    const method=req.method;
    try{
      if(url.pathname==='/agent/v1/health'&&method==='GET')return send(200,{status:'ok',version:VERSION});
      if(url.pathname==='/agent/v1/pair'&&method==='POST'){
        const contentType=(req.headers['content-type']??'').split(';')[0].trim().toLowerCase();
        if(contentType!=='application/json')return send(415,{error:'AGENT_JSON_REQUIRED'});
        if(failuresInWindow()>=pairFailLimit)return send(429,{error:'AGENT_RATE_LIMITED'});
        let body;
        try{body=await readJsonBody(req);}catch(error){return send(error.status??400,{error:error.code??'AGENT_INVALID_REQUEST'});}
        if(!body||typeof body!=='object'||Array.isArray(body)||typeof body.code!=='string')return send(400,{error:'AGENT_INVALID_REQUEST'});
        const submitted=body.code;
        const matches=PAIRING_CODE_PATTERN.test(submitted)&&safeEqualHex(sha256Hex(submitted),activePairingHash);
        const expired=now()>=activePairingExpiresMs;
        if(!matches||expired||!activePairingHash){
          failureTimes.push(now());
          return send(401,{error:'AGENT_UNAUTHORIZED'});
        }
        const token=randomBytes(32).toString('hex');
        tokenHash=sha256Hex(token);
        activePairingHash=null;
        activePairingExpiresMs=0;
        failureTimes.length=0;
        try{await saveState(statePath,{tokenHash,pairingHash:null,pairingExpiresAt:null},now());}catch{return send(500,{error:'AGENT_STATE_WRITE_FAILED'});}
        return send(200,{token});
      }
      const token=bearerToken(req);
      const authenticated=()=>Boolean(token&&tokenHash&&safeEqualHex(sha256Hex(token),tokenHash));
      const jsonBody=async()=>{
        const contentType=(req.headers['content-type']??'').split(';')[0].trim().toLowerCase();
        if(contentType!=='application/json'){send(415,{error:'AGENT_JSON_REQUIRED'});return {failed:true};}
        try{return {body:await readJsonBody(req)};}catch(error){send(error.status??400,{error:error.code??'AGENT_INVALID_REQUEST'});return {failed:true};}
      };
      if(url.pathname==='/agent/v1/snapshot'&&method==='GET'){
        if(!authenticated())return send(401,{error:'AGENT_UNAUTHORIZED'});
        let snapshot;
        try{snapshot=await resolvedEngine.snapshot();}catch{return send(500,{error:'AGENT_SNAPSHOT_FAILED'});}
        return send(200,snapshot);
      }
      if(url.pathname==='/agent/v1/plans'&&method==='POST'){
        if(!authenticated())return send(401,{error:'AGENT_UNAUTHORIZED'});
        if(!writeEnabled)return send(403,{error:AGENT_READ_ONLY});
        const parsed=await jsonBody();
        if(parsed.failed)return;
        const body=parsed.body;
        if(!body||typeof body!=='object'||Array.isArray(body))return send(400,{error:'AGENT_INVALID_REQUEST'});
        try{return send(200,await resolvedEngine.plan(body.resource,body.changes,false,body.expectedRevision));}
        catch(error){return send(409,{error:knownError(error),...sanitizeErrorDetails(error?.details)});}
      }
      if(url.pathname==='/agent/v1/apply'&&method==='POST'){
        if(!authenticated())return send(401,{error:'AGENT_UNAUTHORIZED'});
        if(!writeEnabled)return send(403,{error:AGENT_READ_ONLY});
        const parsed=await jsonBody();
        if(parsed.failed)return;
        const body=parsed.body;
        if(!body||typeof body!=='object'||Array.isArray(body))return send(400,{error:'AGENT_INVALID_REQUEST'});
        let result;
        try{result=await resolvedEngine.apply(body.id);}
        catch(error){return send(409,{error:knownError(error),...sanitizeErrorDetails(error?.details)});}
        return send(200,{result,hotLoad:await hotLoadEvidence(resolvedDataDir)});
      }
      if(url.pathname==='/agent/v1/backups'&&method==='GET'){
        if(!authenticated())return send(401,{error:'AGENT_UNAUTHORIZED'});
        if(!writeEnabled)return send(403,{error:AGENT_READ_ONLY});
        let backups,stats;
        try{backups=await resolvedEngine.listBackups();stats=await resolvedEngine.backupStats();}
        catch(error){return send(409,{error:knownError(error),...sanitizeErrorDetails(error?.details)});}
        return send(200,{
          backups:(Array.isArray(backups)?backups:[]).map(publicBackup).filter(Boolean),
          stats:{
            count:Number.isInteger(stats?.count)?stats.count:0,
            bytes:typeof stats?.bytes==='number'&&Number.isFinite(stats.bytes)?Math.max(0,Math.floor(stats.bytes)):0,
          },
          limits:{keep:backupModule.backupKeep(env),maxBytes:backupModule.backupMaxBytes(env)},
        });
      }
      return send(404,{error:'AGENT_NOT_FOUND'});
    }catch{return send(500,{error:'AGENT_INTERNAL'});}
  });

  await new Promise((resolveListen,reject)=>{
    server.once('error',reject);
    server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);resolveListen();});
  });
  const actualPort=server.address().port;
  const close=async()=>{
    server.closeAllConnections?.();
    await new Promise(resolveClose=>server.close(resolveClose));
  };
  return {server,url:`http://127.0.0.1:${actualPort}`,port:actualPort,statePath,pairingCode,expiresAt:new Date(expiresMs).toISOString(),tokenHash,close};
}

/** Parse `--name=value` or `--name value`; undefined when absent. */
function optionValue(argv,name){
  const prefix=`--${name}=`;
  const inline=argv.find(argument=>argument.startsWith(prefix));
  if(inline!==undefined)return inline.slice(prefix.length);
  const index=argv.indexOf(`--${name}`);
  if(index>=0&&argv[index+1]&&!argv[index+1].startsWith('--'))return argv[index+1];
  return undefined;
}

/** CLI: node src/agent.mjs [--port=0] [--state=<dir>] [--enable-writes] */
export async function main({env=process.env,argv=process.argv.slice(2)}={}){
  const portRaw=optionValue(argv,'port');
  const port=portRaw===undefined?0:Number(portRaw);
  if(!Number.isInteger(port)||port<0||port>65535){
    console.error('AGENT_INVALID_PORT: --port 必须是 0-65535 的整数。');
    process.exitCode=1;
    return null;
  }
  const stateOverride=optionValue(argv,'state');
  const stateDir=stateOverride?resolve(stateOverride):resolveStateDir(env);
  const writeEnabled=argv.includes('--enable-writes');
  let dataDir;
  try{dataDir=await discoverAstrBotData(env);}catch(error){
    if(error.code===ASTRBOT_DATA_REQUIRED){
      console.error(error.message);
      console.error('请先启动一次 AstrBot，或用环境变量 ASTRBOT_DATA 指定其 data 目录后重试。');
      process.exitCode=1;
      return null;
    }
    throw error;
  }
  const agent=await startAgent({env,dataDir,stateDir,port,writeEnabled});
  console.log(JSON.stringify({url:agent.url,pairingCode:agent.pairingCode,expiresAt:agent.expiresAt}));
  const shutdown=async()=>{
    try{await agent.close();}catch{}
    process.exit(0);
  };
  process.once('SIGINT',shutdown);
  process.once('SIGTERM',shutdown);
  return agent;
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))main().catch(()=>{console.error('Agent startup failed; verify local paths and Node version.');process.exitCode=1;});
