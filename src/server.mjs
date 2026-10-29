/** Loopback UI and authenticated API. Static assets never contain credentials. */
import http from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {appendFile,readFile,stat,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {Gateway} from './gateway.mjs';
import {Engine,knownError} from './engine.mjs';
import {backupState} from './backup.mjs';
import {ASTRBOT_DATA_REQUIRED,discoverAstrBotData,findLegacyState,resolveStateDir} from './config.mjs';
import {ANOTHER_INSTANCE_RUNNING,acquireLock} from './lock.mjs';
const publicRoot=fileURLToPath(new URL('../public/',import.meta.url));
const assets=new Map([['/',['index.html','text/html']],['/index.html',['index.html','text/html']],['/app.mjs',['app.mjs','text/javascript']],['/ui-state.mjs',['ui-state.mjs','text/javascript']],['/styles.css',['styles.css','text/css']]]);

const PLAN_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_BACKUP_ID=/^[0-9a-f]{8,12}$/i;
const FULL_UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN=/^[a-z][a-z0-9-]{0,63}$/;

/**
 * Whitelist error details before they enter an HTTP response (D02).
 * Only id/backupId/outcome/code may leave the process; backupId must be a UUID short id or basename UUID,
 * so absolute paths (and anything else from engine details) are dropped.
 */
export function sanitizeErrorDetails(details){
  const safe={};
  if(!details||typeof details!=='object')return safe;
  const usable=value=>typeof value==='string'&&value.length>0&&value.length<=128;
  if(usable(details.id)&&PLAN_ID.test(details.id))safe.id=details.id;
  if(usable(details.backupId)&&(SHORT_BACKUP_ID.test(details.backupId)||FULL_UUID.test(details.backupId)))safe.backupId=details.backupId;
  if(usable(details.outcome)&&TOKEN.test(details.outcome))safe.outcome=details.outcome;
  if(usable(details.code)&&/^[A-Z][A-Z0-9_]{0,63}$/.test(details.code))safe.code=details.code;
  return safe;
}

/** Reduce an apply result's backup reference to the UUID directory name; drop it if it is not a UUID. */
export function safeApplyResult(result){
  if(!result||typeof result!=='object'||typeof result.backupId!=='string')return result;
  const base=result.backupId.split(/[\\/]+/).filter(Boolean).at(-1)??'';
  if(FULL_UUID.test(base))return {...result,backupId:base};
  const {backupId,...rest}=result;
  return rest;
}

export function trustedRequest(req,port){if(req.headers.host!==`127.0.0.1:${port}`)return false;const origin=req.headers.origin;if(origin&&origin!==`http://127.0.0.1:${port}`)return false;return req.headers['sec-fetch-site']!=='cross-site';}
export function authorized(req,token,port){if(!trustedRequest(req,port))return false;const value=Buffer.from(req.headers.authorization??''),expected=Buffer.from(`Bearer ${token}`);return value.length===expected.length&&timingSafeEqual(value,expected);}
export function createServer(engine,token,{staticRoot=publicRoot}={}){const server=http.createServer(async(req,res)=>{res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");const send=(status,body)=>{res.writeHead(status);res.end(JSON.stringify(body));};if(!trustedRequest(req,server.address().port))return send(403,{error:'ACCESS_DENIED'});try{const url=new URL(req.url,'http://127.0.0.1');const asset=assets.get(url.pathname);if(req.method==='GET'&&asset){try{const content=await readFile(join(staticRoot,asset[0]));res.writeHead(200,{'Content-Type':asset[1]+'; charset=utf-8'});return res.end(content);}catch{return send(404,{error:'ASSET_NOT_FOUND'});}}if(!authorized(req,token,server.address().port))return send(403,{error:'ACCESS_DENIED'});if(req.method==='GET'&&url.pathname==='/health')return send(200,{status:'ok'});if(req.method==='GET'&&url.pathname==='/snapshot')return send(200,await engine.snapshot());if(req.method==='GET'&&url.pathname==='/capabilities'){const id=url.searchParams.get('provider_id');if(!id||id.length>512)return send(400,{error:'INVALID_PROVIDER_ID'});const levels=await engine.gateway.efforts(id);return send(200,{levels:Array.isArray(levels)?levels:[],verified:Array.isArray(levels)});}if(req.method==='POST'){if(req.headers['content-type']!=='application/json')return send(415,{error:'JSON_REQUIRED'});const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>65536)return send(413,{error:'BODY_TOO_LARGE'});chunks.push(chunk);}let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return send(400,{error:'INVALID_JSON'});}if(!body||typeof body!=='object'||Array.isArray(body))return send(400,{error:'INVALID_BODY'});if(url.pathname==='/plans')return send(200,await engine.plan(body.resource,body.changes,false,body.expectedRevision));if(url.pathname==='/apply')return send(200,safeApplyResult(await engine.apply(body.id)));}return send(404,{error:'NOT_FOUND'});}catch(e){return send(409,{error:knownError(e),...sanitizeErrorDetails(e?.details)});}});server.requestTimeout=15000;server.headersTimeout=10000;return server;}

const dataRequired=message=>{const error=Error(message);error.code=ASTRBOT_DATA_REQUIRED;return error;};

/** Validate that the discovered data path is a readable AstrBot data directory, without leaking ENOENT. */
async function resolveData(env){
  const data=await discoverAstrBotData(env);
  let info;
  try{info=await stat(data);}catch{}
  if(!info?.isDirectory())throw dataRequired(`ASTRBOT_DATA_REQUIRED: AstrBot data 目录不存在或不可读：${data}`);
  try{await stat(join(data,'cmd_config.json'));}catch{throw dataRequired(`ASTRBOT_DATA_REQUIRED: ${data} 不是可用的 AstrBot data 目录（缺少 cmd_config.json）。请用 ASTRBOT_DATA 指向正确目录。`);}
  return data;
}

function bindServer(server,port){
  return new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);resolveListen();});});
}

/**
 * Open the authorized URL without putting the session token on the PowerShell command line.
 * The URL goes into a user-private temp file; PowerShell receives only the path. Best-effort: a failed
 * launch only prints a hint, and the temp file is removed after 15s.
 */
function openInBrowser(url){
  const target=join(tmpdir(),`model-console-open-${process.pid}-${randomBytes(6).toString('hex')}.txt`);
  const cleanup=setTimeout(()=>unlink(target).catch(()=>{}),15000);
  cleanup.unref();
  writeFile(target,url,'utf8').then(()=>{
    const quoted=target.replace(/'/g,"''");
    const command=`Start-Process -FilePath ((Get-Content -LiteralPath '${quoted}' -Raw).Trim())`;
    const browser=spawn('powershell.exe',['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-Command',command],{stdio:'ignore',windowsHide:true});
    browser.on('error',()=>console.error('Browser launch failed; open the displayed local URL manually.'));
    browser.unref();
  }).catch(()=>console.error('Browser launch failed; open the displayed local URL manually.'));
}

/**
 * Start the console: resolve state, acquire the single-instance lock, discover AstrBot data, then listen.
 * Expected configuration failures print a readable message, set exitCode=1 and resolve null.
 * Returns the live http.Server on success; the lock is released on SIGINT/SIGTERM.
 */
export async function start({env=process.env,cwd=process.cwd(),argv=process.argv}={}){
  const stateDir=resolveStateDir(env);
  const legacy=join(cwd,'state');
  const legacyHint=await findLegacyState(cwd);
  if(legacyHint&&resolve(stateDir)!==resolve(legacy))console.error(legacyHint);
  let lock;
  try{lock=await acquireLock(stateDir,{port:Number(env.MODEL_CONSOLE_PORT??0)});}catch(error){
    if(error.code!==ANOTHER_INSTANCE_RUNNING)throw error;
    console.error(error.message);
    console.error('请复用第一个实例已打开的窗口，或先关闭旧实例再启动。');
    process.exitCode=1;
    return null;
  }
  try{
    const data=await resolveData(env);
    const resumeToken=env.MODEL_CONSOLE_SESSION_TOKEN;
    if(resumeToken&&!/^[a-f0-9]{64}$/.test(resumeToken))throw Error('INVALID_SESSION_TOKEN');
    const token=resumeToken??randomBytes(32).toString('hex');
    const gateway=new Gateway(data);
    const engine=new Engine({gateway,writeEnabled:argv.includes('--enable-writes'),backup:()=>backupState(data,join(stateDir,'backups')),audit:event=>appendFile(join(stateDir,'audit.jsonl'),JSON.stringify({...event,time:new Date().toISOString()})+'\n')});
    const server=createServer(engine,token);
    await bindServer(server,Number(env.MODEL_CONSOLE_PORT??0));
    lock.update({port:server.address().port}).catch(()=>{});
    const url=`http://127.0.0.1:${server.address().port}/#token=${token}`;
    console.log(JSON.stringify({url,readOnly:!engine.writeEnabled}));
    let closing=false;
    const shutdown=async()=>{
      if(closing)return;
      closing=true;
      try{await lock.release();}catch{}
      server.close(()=>process.exit(0));
      server.closeAllConnections?.();
    };
    process.once('SIGINT',shutdown);
    process.once('SIGTERM',shutdown);
    if(argv.includes('--open')&&process.platform==='win32')openInBrowser(url);
    return server;
  }catch(error){
    try{await lock.release();}catch{}
    if(error.code===ASTRBOT_DATA_REQUIRED){
      console.error(error.message);
      console.error('请先启动一次 AstrBot，或用环境变量 ASTRBOT_DATA 指定其 data 目录后重试。');
      process.exitCode=1;
      return null;
    }
    throw error;
  }
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))start().catch(()=>{console.error('Startup failed; verify local paths and Node version.');process.exitCode=1;});
