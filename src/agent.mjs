/** Loopback-only agent: pairs a Hub with a one-time code, then serves read-only Engine snapshots. */
import http from 'node:http';
import {createHash,randomBytes,randomInt,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dirname,join,resolve} from 'node:path';
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {Gateway} from './gateway.mjs';
import {Engine} from './engine.mjs';
import {ASTRBOT_DATA_REQUIRED,discoverAstrBotData,resolveStateDir} from './config.mjs';

export const AGENT_STATE_FILE='agent.json';
export const PAIRING_TTL_MS=10*60*1000;
export const PAIRING_CODE_PATTERN=/^\d{8}$/;
export const TOKEN_PATTERN=/^[a-f0-9]{64}$/i;
export const PAIR_FAIL_LIMIT=5;
export const PAIR_FAIL_WINDOW_MS=60*1000;
export const MAX_BODY_BYTES=16*1024;

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
  if(!resolvedEngine){
    const data=dataDir??await discoverAstrBotData(env);
    const gateway=new Gateway(data);
    resolvedEngine=new Engine({gateway,writeEnabled});
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
      if(url.pathname==='/agent/v1/snapshot'&&method==='GET'){
        const token=bearerToken(req);
        if(!token||!tokenHash||!safeEqualHex(sha256Hex(token),tokenHash))return send(401,{error:'AGENT_UNAUTHORIZED'});
        let snapshot;
        try{snapshot=await resolvedEngine.snapshot();}catch{return send(500,{error:'AGENT_SNAPSHOT_FAILED'});}
        return send(200,snapshot);
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
