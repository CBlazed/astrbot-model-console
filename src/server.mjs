/** Loopback UI and authenticated API. Static assets never contain credentials. */
import http from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {appendFile,readFile,stat,unlink,writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {Gateway} from './gateway.mjs';
import {Engine,knownError} from './engine.mjs';
import {HttpGatewayAdapter} from './http-adapter.mjs';
import {addDevice,getSecret,listDevices,loadRegistry,migrateSecrets,removeDevice,validateDevice} from './devices.mjs';
import * as backupModule from './backup.mjs';
import {logDiagnostic,readDiagnostics} from './diagnostics.mjs';
import {ASTRBOT_DATA_REQUIRED,discoverAstrBotData,findLegacyState,resolveStateDir} from './config.mjs';
import {ANOTHER_INSTANCE_RUNNING,acquireLock} from './lock.mjs';
const publicRoot=fileURLToPath(new URL('../public/',import.meta.url));
const assets=new Map([['/',['index.html','text/html']],['/index.html',['index.html','text/html']],['/app.mjs',['app.mjs','text/javascript']],['/ui-state.mjs',['ui-state.mjs','text/javascript']],['/styles.css',['styles.css','text/css']]]);

const PLAN_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_BACKUP_ID=/^[0-9a-f]{8,12}$/i;
const FULL_UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN=/^[a-z][a-z0-9-]{0,63}$/;
const DIFF_ROUTE=/^\/backups\/([^/]+)\/diff$/;
const DEVICE_HEALTH_ROUTE=/^\/devices\/([^/]+)\/health$/;
const DEVICE_ROUTE=/^\/devices\/([^/]+)$/;
const REMOTE_SNAPSHOT_TTL=5000;
const DIAGNOSTICS_LIMIT_PER_MINUTE=120;
const DIAGNOSTICS_WINDOW_MS=60*1000;
const BACKUP_WARNING_PREFIX='BACKUP_';
const RESOURCE_KINDS=new Set(['profile','plugin','provider']);
const DEFAULT_BACKUP_LIMITS=Object.freeze({keep:10,maxBytes:2048*1024*1024});

/** Decode one URL path segment; malformed escapes mean the device id is invalid. */
function decodeSegment(value){
  try{return decodeURIComponent(value);}catch{return null;}
}

/** HTTP status for a stable device error code; null means "not a device error". */
function deviceErrorStatus(error){
  const code=error?.code;
  if(typeof code!=='string'||!code.startsWith('DEVICE_')&&code!=='AGENT_READ_ONLY')return null;
  if(code==='DEVICE_NOT_FOUND')return 404;
  if(code==='DEVICE_INVALID'||code==='DEVICE_SECRET_REQUIRED')return 400;
  if(code==='DEVICE_READ_ONLY'||code==='AGENT_READ_ONLY')return 403;
  return 409;
}

const codeError=(code,message)=>{const error=Error(message??code);error.code=code;return error;};

/** RISK-04: process-wide (per state directory) diagnostics rate limit; overflow is dropped silently. */
const diagnosticWindows=new Map();
export const DIAGNOSTICS_RATE_LIMIT=DIAGNOSTICS_LIMIT_PER_MINUTE;
export function resetDiagnosticsRateLimit(){diagnosticWindows.clear();}
function allowDiagnostic(stateDir,limit=DIAGNOSTICS_LIMIT_PER_MINUTE){
  const key=typeof stateDir==='string'?stateDir:'';
  const now=Date.now();
  const recent=(diagnosticWindows.get(key)??[]).filter(time=>now-time<DIAGNOSTICS_WINDOW_MS);
  if(recent.length>=limit){diagnosticWindows.set(key,recent);return false;}
  recent.push(now);
  diagnosticWindows.set(key,recent);
  return true;
}

/** RISK-10: health responses are limited to reachable/latencyMs/error. */
function publicHealth(result){
  const health={reachable:result?.reachable===true};
  if(Number.isFinite(result?.latencyMs)&&result.latencyMs>=0)health.latencyMs=Math.floor(result.latencyMs);
  if(typeof result?.error==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(result.error))health.error=result.error;
  if(!health.reachable&&!health.error)health.error='DEVICE_UNREACHABLE';
  return health;
}

/** Package version for /health; read once at module load and never fatal. */
const VERSION=(()=>{try{const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));return typeof pkg.version==='string'?pkg.version:null;}catch{return null;}})();

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

/** Normalize a backup reference to its UUID directory/basename; anything path-like is rejected. */
function backupIdOf(value){
  if(typeof value!=='string')return null;
  const base=value.split(/[\\/]+/).filter(Boolean).at(-1)??'';
  return FULL_UUID.test(base)||SHORT_BACKUP_ID.test(base)?base:null;
}

const STRICT_RESOURCE_ID=/^[A-Za-z0-9._:-]+$/;
const PROVIDER_RESOURCE_ID=/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/**
 * Validate a {kind,id} resource reference for restore/diff routes.
 * profile/plugin keep the strict charset. Provider ids may contain "/" (e.g. <provider>/<model>),
 * but traversal, backslashes, colons, empty segments, leading/trailing slashes and >200 chars are rejected.
 */
function parseResource(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const {kind,id}=value;
  if(!RESOURCE_KINDS.has(kind))return null;
  if(typeof id!=='string'||id.length===0)return null;
  if(kind==='provider'){
    if(id.length>200||!PROVIDER_RESOURCE_ID.test(id))return null;
    if(id.split('/').some(segment=>segment==='..'))return null;
    return {kind,id};
  }
  if(id.length>128||!STRICT_RESOURCE_ID.test(id))return null;
  return {kind,id};
}

/** Expose only contract fields for a backup entry; ids are UUID basenames, never absolute paths. */
function publicBackup(item){
  if(!item||typeof item!=='object')return null;
  const id=backupIdOf(item.id);
  if(!id)return null;
  const entry={id};
  if(typeof item.createdAt==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(item.createdAt)&&item.createdAt.length<=40)entry.createdAt=item.createdAt;
  if(typeof item.bytes==='number'&&Number.isFinite(item.bytes)&&item.bytes>=0)entry.bytes=Math.floor(item.bytes);
  if(Number.isInteger(item.files)&&item.files>=0)entry.files=item.files;
  if(typeof item.sqlite==='string'&&/^[a-z][a-z0-9_-]{0,15}$/.test(item.sqlite))entry.sqlite=item.sqlite;
  return entry;
}

/** Restrict plan/diff changes to the contract shape {path,before,value,capability}. */
function publicChanges(list){
  if(!Array.isArray(list))return [];
  return list.filter(item=>item&&typeof item==='object').map(item=>({
    path:typeof item.path==='string'?item.path:null,
    before:item.before===undefined?null:item.before,
    value:item.value===undefined?null:item.value,
    capability:typeof item.capability==='string'?item.capability:null,
  }));
}

/** RISK-08: restore plan responses only expose contract top-level fields (no engine internals). */
function publicRestorePlan(plan){
  const view={mode:'restore'};
  if(typeof plan?.id==='string'&&PLAN_ID.test(plan.id))view.id=plan.id;
  const resource=parseResource(plan?.resource);
  if(resource)view.resource=resource;
  if(typeof plan?.revision==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(plan.revision))view.revision=plan.revision;
  if(typeof plan?.expiresAt==='string'&&plan.expiresAt.length<=40)view.expiresAt=plan.expiresAt;
  if(typeof plan?.impact==='string'&&plan.impact.length>0&&plan.impact.length<=200)view.impact=plan.impact;
  if(typeof plan?.warning==='string'&&plan.warning.length>0&&plan.warning.length<=500)view.warning=plan.warning;
  return view;
}

/** Remote agent plan view: same reviewed top-level fields as a local plan, no engine internals. */
function publicPlan(plan){
  const view={};
  if(typeof plan?.id==='string'&&PLAN_ID.test(plan.id))view.id=plan.id;
  const resource=parseResource(plan?.resource);
  if(resource)view.resource=resource;
  if(typeof plan?.revision==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(plan.revision))view.revision=plan.revision;
  view.changes=publicChanges(plan?.changes);
  if(typeof plan?.expiresAt==='string'&&plan.expiresAt.length<=40)view.expiresAt=plan.expiresAt;
  if(typeof plan?.impact==='string'&&plan.impact.length>0&&plan.impact.length<=200)view.impact=plan.impact;
  if(typeof plan?.warning==='string'&&plan.warning.length>0&&plan.warning.length<=500)view.warning=plan.warning;
  return view;
}

/** Evidence text from the remote log can contain local paths; redact them before display. */
function redactEvidenceText(value,limit){
  return String(value)
    .replace(/[\u0000-\u001f\u007f]/g,' ')
    .replace(/\b[A-Za-z]:[\\/][^\s"'<>]*/g,'[path]')
    .replace(/\\\\[^\s"'<>]*/g,'[path]')
    .replace(/(^|[\s"'=(:,])\/[^\s"'<>]*/g,'$1[path]')
    .replace(/\s+/g,' ')
    .trim()
    .slice(0,limit);
}

/** hotLoad evidence: booleans only plus redacted note/marker; never absolute paths. */
function publicHotLoad(value){
  if(!value||typeof value!=='object')return {verified:false,checked:false};
  const evidence={verified:value.verified===true,checked:value.checked===true};
  if(typeof value.note==='string'&&value.note)evidence.note=redactEvidenceText(value.note,300);
  if(typeof value.marker==='string'&&value.marker)evidence.marker=redactEvidenceText(value.marker,200);
  return evidence;
}

/** Backup limits reported by GET /backups; MODEL_CONSOLE_BACKUP_MAX_MB is the byte cap source. */
function backupLimits(env){
  return {keep:backupModule.backupKeep(env),maxBytes:backupModule.backupMaxBytes(env)};
}

export function createServer(engine,token,{staticRoot=publicRoot,health={},limits=DEFAULT_BACKUP_LIMITS,pruneBackups,createRemoteEngine,createSshTunnel,pairAgentDevice,createAgentAdapter,createHttpGateway,deviceStateDir,remoteSnapshotTtlMs=REMOTE_SNAPSHOT_TTL,diagnosticsLimitPerMinute=DIAGNOSTICS_LIMIT_PER_MINUTE}={}){
  const startedAt=typeof health.startedAt==='string'?health.startedAt:new Date().toISOString();
  const stateDir=typeof health.stateDir==='string'?health.stateDir:null;
  const diagnosticLimit=Number.isInteger(diagnosticsLimitPerMinute)&&diagnosticsLimitPerMinute>=0?diagnosticsLimitPerMinute:DIAGNOSTICS_LIMIT_PER_MINUTE;
  const pendingDiagnostics=new Set();
  const record=(level,event,fields)=>{
    if(!stateDir)return;
    if(!allowDiagnostic(stateDir,diagnosticLimit))return;
    const promise=logDiagnostic(stateDir,{level,event,...fields});
    pendingDiagnostics.add(promise);
    promise.finally(()=>pendingDiagnostics.delete(promise));
  };
  const pathOf=req=>{try{return new URL(req.url,'http://127.0.0.1').pathname;}catch{return null;}};
  const healthPayload=()=>({
    status:'ok',
    version:VERSION,
    dataPath:typeof health.dataPath==='string'?health.dataPath:null,
    stateDir,
    readOnly:typeof health.readOnly==='boolean'?health.readOnly:engine.writeEnabled!==true,
    startedAt,
  });
  const backupStats=async()=>{const stats=await engine.backupStats();return {count:Number.isInteger(stats?.count)?stats.count:0,bytes:typeof stats?.bytes==='number'&&Number.isFinite(stats.bytes)?Math.max(0,Math.floor(stats.bytes)):0};};

  /* ---- Devices (Epic-1 read side): registry API + remote engines/snapshots ---- */
  const registryDir=typeof deviceStateDir==='string'?deviceStateDir:stateDir;
  const remoteTtl=Number.isFinite(remoteSnapshotTtlMs)&&remoteSnapshotTtlMs>=0?remoteSnapshotTtlMs:REMOTE_SNAPSHOT_TTL;
  const remoteSessions=new Map();
  const remoteSnapshots=new Map();
  const tunnels=new Map();
  const localDevice=()=>({id:'local',name:'本机',kind:'local',readOnly:engine.writeEnabled!==true,hasSecret:false});
  /** Public device view: explicit field whitelist, so apiKey/auth internals never leave the process. */
  const publicDevice=device=>{
    const view={id:device.id,name:device.name,kind:device.kind??'http',readOnly:device.readOnly!==false,hasSecret:device.hasSecret===true};
    if(typeof device.baseUrl==='string')view.baseUrl=device.baseUrl;
    // ssh public view keeps connection metadata only: keyPath/dataPath are local filesystem paths and stay out.
    if(device.ssh&&typeof device.ssh==='object'){
      const ssh={};
      if(typeof device.ssh.host==='string')ssh.host=device.ssh.host;
      if(typeof device.ssh.user==='string')ssh.user=device.ssh.user;
      if(Number.isInteger(device.ssh.port))ssh.port=device.ssh.port;
      if(Object.keys(ssh).length)view.ssh=ssh;
    }
    if(typeof device.createdAt==='string')view.createdAt=device.createdAt;
    return view;
  };
  const findDevice=async id=>{
    if(id==='local')return localDevice();
    if(!registryDir)return null;
    const devices=await listDevices(registryDir);
    return devices.find(device=>device.id===id)??null;
  };
  /** Dynamic import keeps server.mjs loadable while the agent/ssh modules are still being built. */
  const importOptional=async(path,code)=>{try{return await import(path);}catch{throw codeError(code,`缺少模块 ${path}`);}};
  const defaultOpenSshTunnel=async device=>{
    if(!device.ssh||typeof device.ssh!=='object')throw codeError('DEVICE_INVALID','ssh 设备缺少 ssh 配置');
    const module=await importOptional('./ssh-tunnel.mjs','DEVICE_SSH_UNAVAILABLE');
    const open=module.openSshTunnel??module.createSshTunnel;
    if(typeof open!=='function')throw codeError('DEVICE_SSH_UNAVAILABLE','ssh-tunnel 模块未导出 openSshTunnel');
    let opened;
    try{opened=await open({ssh:device.ssh,baseUrl:device.baseUrl,dataPath:device.ssh.dataPath});}
    catch(error){
      if(typeof error?.code==='string'&&error.code.startsWith('DEVICE_'))throw error;
      throw codeError('DEVICE_SSH_FAILED','SSH 隧道建立失败');
    }
    if(!opened||typeof opened.baseUrl!=='string'||typeof opened.close!=='function')throw codeError('DEVICE_SSH_FAILED','SSH 隧道返回格式无效');
    return opened;
  };
  const openTunnel=typeof createSshTunnel==='function'?createSshTunnel:defaultOpenSshTunnel;
  const defaultHttpGateway=(device,{baseUrl,apiKey})=>new HttpGatewayAdapter({baseUrl,apiKey});
  const makeHttpGateway=typeof createHttpGateway==='function'?createHttpGateway:defaultHttpGateway;
  const defaultPairAgent=async(device,pairingCode)=>{
    const module=await importOptional('./agent-adapter.mjs','DEVICE_ADAPTER_UNAVAILABLE');
    if(typeof module.pairAgent!=='function')throw codeError('DEVICE_ADAPTER_UNAVAILABLE','agent-adapter 模块未导出 pairAgent');
    let result;
    try{result=await module.pairAgent({baseUrl:device.baseUrl,pairingCode});}
    catch(error){
      if(typeof error?.code==='string'&&/^(?:DEVICE_|AGENT_)/.test(error.code))throw error;
      throw codeError('DEVICE_AUTH_FAILED','Agent 配对失败');
    }
    const token=typeof result==='string'?result:result?.token;
    if(typeof token!=='string'||!token)throw codeError('DEVICE_AUTH_FAILED','Agent 配对未返回有效 token');
    return {token};
  };
  const pairDevice=typeof pairAgentDevice==='function'?pairAgentDevice:defaultPairAgent;
  const defaultAgentAdapter=async(device,token)=>{
    const module=await importOptional('./agent-adapter.mjs','DEVICE_ADAPTER_UNAVAILABLE');
    if(typeof module.AgentAdapter!=='function')throw codeError('DEVICE_ADAPTER_UNAVAILABLE','agent-adapter 模块未导出 AgentAdapter');
    const adapter=new module.AgentAdapter({baseUrl:device.baseUrl,token});
    if(typeof adapter.snapshot!=='function')throw codeError('DEVICE_ENGINE_INVALID','AgentAdapter 缺少 snapshot()');
    return adapter;
  };
  const makeAgentAdapter=typeof createAgentAdapter==='function'?createAgentAdapter:defaultAgentAdapter;
  /** Default remote engine: agent uses AgentAdapter.snapshot; http/ssh use HttpGatewayAdapter (+ ssh tunnel). */
  const defaultRemoteEngine=async device=>{
    if(!registryDir)throw codeError('DEVICE_STORE_UNAVAILABLE','设备存储不可用');
    const secret=await getSecret(registryDir,device.id);
    if(typeof secret!=='string'||!secret)throw codeError('DEVICE_SECRET_REQUIRED','设备缺少凭据');
    if(device.kind==='agent'){
      const adapter=await makeAgentAdapter(device,secret);
      return {gateway:adapter,snapshot:()=>adapter.snapshot(),close:()=>adapter.close?.()};
    }
    let baseUrl=device.baseUrl;
    let tunnel=null;
    if(device.kind==='ssh'){
      tunnel=await openTunnel(device);
      baseUrl=tunnel.baseUrl;
      tunnels.set(device.id,tunnel);
    }
    const engine=new Engine({gateway:makeHttpGateway(device,{baseUrl,apiKey:secret}),writeEnabled:false});
    if(tunnel)engine.close=()=>{const stored=tunnels.get(device.id);if(!stored)return;tunnels.delete(device.id);return stored.close?.();};
    return engine;
  };
  const makeRemoteEngine=typeof createRemoteEngine==='function'?createRemoteEngine:defaultRemoteEngine;
  /** One cached read-only Engine per deviceId; failed creations are not cached. */
  const remoteEngine=async device=>{
    const existing=remoteSessions.get(device.id);
    if(existing)return existing;
    const pending=Promise.resolve().then(()=>makeRemoteEngine(device)).then(remote=>{
      if(!remote||typeof remote.snapshot!=='function')throw codeError('DEVICE_ENGINE_INVALID','远程引擎不可用');
      return remote;
    }).catch(error=>{remoteSessions.delete(device.id);throw error;});
    remoteSessions.set(device.id,pending);
    return pending;
  };
  /** Remote snapshot cache: 5s TTL by default, always namespaced by deviceId. */
  const remoteSnapshot=async device=>{
    const cached=remoteSnapshots.get(device.id);
    if(cached&&Date.now()-cached.at<remoteTtl)return cached.value;
    const remote=await remoteEngine(device);
    const snapshot=await remote.snapshot();
    if(!snapshot||typeof snapshot!=='object'||Array.isArray(snapshot))throw codeError('DEVICE_INVALID_RESPONSE','远程快照无效');
    // Only a writable agent device may write, and only when the agent itself runs with --enable-writes.
    const writable=device.kind==='agent'&&device.readOnly===false&&snapshot.writeEnabled===true;
    const value={...snapshot,writeEnabled:writable,device:{id:device.id,name:device.name,kind:device.kind??'http'}};
    remoteSnapshots.set(device.id,{at:Date.now(),value});
    return value;
  };
  /** RISK-02: dropping a session also closes its ssh tunnel / agent adapter, if any. */
  const dropDeviceSession=async id=>{
    const session=remoteSessions.get(id);
    const tunnel=tunnels.get(id);
    remoteSessions.delete(id);
    remoteSnapshots.delete(id);
    tunnels.delete(id);
    if(session){try{const remote=await session;await remote?.close?.();}catch{}}
    if(tunnel){try{await tunnel.close?.();}catch{}}
  };
  const remoteHealth=async device=>{
    const remote=await remoteEngine(device);
    const gateway=remote.gateway;
    if(typeof gateway?.health!=='function')return {reachable:false,error:'DEVICE_HEALTH_UNAVAILABLE'};
    const started=Date.now();
    const result=await gateway.health();
    if(!result||typeof result!=='object')return {reachable:false,error:'DEVICE_HEALTH_UNAVAILABLE'};
    // HttpGatewayAdapter reports {reachable,latencyMs}; AgentAdapter.health reports {status:'ok',version}.
    if(result.reachable===undefined&&result.status==='ok')return {reachable:true,latencyMs:Date.now()-started};
    return result;
  };

  /* ---- Remote write routing (Epic-3): only writable agent devices ---- */
  /** Resolve a device that may be written remotely; everything else is DEVICE_READ_ONLY. */
  const agentWriteDevice=async id=>{
    const device=await findDevice(id);
    if(!device)throw codeError('DEVICE_NOT_FOUND','设备不存在');
    if(device.kind!=='agent'||device.readOnly!==false)throw codeError('DEVICE_READ_ONLY','只有可写 agent 设备支持远程写入');
    return device;
  };
  const agentBackupsDevice=async id=>{
    const device=await findDevice(id);
    if(!device)throw codeError('DEVICE_NOT_FOUND','设备不存在');
    if(device.kind!=='agent')throw codeError('DEVICE_READ_ONLY','只有 agent 设备支持远程备份');
    return device;
  };
  const agentAdapterFor=async device=>{
    const remote=await remoteEngine(device);
    return remote?.gateway&&typeof remote.gateway==='object'?remote.gateway:null;
  };
  const requireAgentMethod=(adapter,method)=>{
    if(!adapter||typeof adapter[method]!=='function')throw codeError('DEVICE_WRITE_UNAVAILABLE',`Agent 不支持远程 ${method}()`);
    return adapter;
  };
  const remoteAgentPlan=async(device,body)=>{
    const adapter=requireAgentMethod(await agentAdapterFor(device),'plan');
    const plan=await adapter.plan({resource:body.resource,changes:body.changes,expectedRevision:body.expectedRevision});
    if(!plan||typeof plan!=='object'||Array.isArray(plan))throw codeError('DEVICE_INVALID_RESPONSE','Agent 返回的计划无效');
    return publicPlan(plan);
  };
  const remoteAgentApply=async(device,body)=>{
    const adapter=requireAgentMethod(await agentAdapterFor(device),'apply');
    const applied=await adapter.apply(body.id);
    if(!applied||typeof applied!=='object'||Array.isArray(applied))throw codeError('DEVICE_INVALID_RESPONSE','Agent 返回的应用结果无效');
    const result=applied.result&&typeof applied.result==='object'&&!Array.isArray(applied.result)?applied.result:applied;
    const view=safeApplyResult(result);
    if(applied.hotLoad!==undefined)view.hotLoad=publicHotLoad(applied.hotLoad);
    return view;
  };
  const remoteAgentBackups=async device=>{
    const adapter=requireAgentMethod(await agentAdapterFor(device),'backups');
    const payload=await adapter.backups();
    const backups=(Array.isArray(payload?.backups)?payload.backups:[]).map(publicBackup).filter(Boolean);
    const stats=payload?.stats&&typeof payload.stats==='object'
      ?{count:Number.isInteger(payload.stats.count)?payload.stats.count:backups.length,bytes:Number.isFinite(payload.stats.bytes)?Math.max(0,Math.floor(payload.stats.bytes)):0}
      :{count:backups.length,bytes:0};
    const remoteLimits=payload?.limits&&typeof payload.limits==='object'?payload.limits:{};
    const keep=Number.isInteger(remoteLimits.keep)&&remoteLimits.keep>0?remoteLimits.keep:DEFAULT_BACKUP_LIMITS.keep;
    const maxBytes=typeof remoteLimits.maxBytes==='number'&&Number.isFinite(remoteLimits.maxBytes)?Math.max(0,Math.floor(remoteLimits.maxBytes)):DEFAULT_BACKUP_LIMITS.maxBytes;
    return {backups,stats,limits:{keep,maxBytes}};
  };

  /** RISK-07: surface the most recent BACKUP_* diagnostics as backup warnings. */
  const backupWarnings=async()=>{
    if(!stateDir)return [];
    const events=await readDiagnostics(stateDir,{limit:200});
    return events
      .filter(event=>typeof event.code==='string'&&event.code.startsWith(BACKUP_WARNING_PREFIX))
      .slice(-5)
      .reverse()
      .map(event=>({code:event.code,time:event.time,message:typeof event.detail==='string'?event.detail:event.code}));
  };

  const server=http.createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const send=(status,body)=>{
      res.writeHead(status);
      res.end(JSON.stringify(body));
      if(status>=400)record(status>=500?'error':'warn',status>=500?'request-failed':'request-rejected',{
        status,
        code:body&&typeof body.error==='string'?body.error:undefined,
        path:pathOf(req),
      });
    };
    if(!trustedRequest(req,server.address().port))return send(403,{error:'ACCESS_DENIED'});
    try{
      const url=new URL(req.url,'http://127.0.0.1');
      const asset=assets.get(url.pathname);
      if(req.method==='GET'&&asset){try{const content=await readFile(join(staticRoot,asset[0]));res.writeHead(200,{'Content-Type':asset[1]+'; charset=utf-8'});return res.end(content);}catch{return send(404,{error:'ASSET_NOT_FOUND'});}}
      if(!authorized(req,token,server.address().port))return send(403,{error:'ACCESS_DENIED'});
      if(req.method==='GET'&&url.pathname==='/health')return send(200,healthPayload());
      if(req.method==='GET'&&url.pathname==='/devices'){
        const devices=[localDevice()];
        if(registryDir)devices.push(...(await listDevices(registryDir)).map(publicDevice));
        return send(200,{devices});
      }
      const deviceHealthRoute=DEVICE_HEALTH_ROUTE.exec(url.pathname);
      if(req.method==='GET'&&deviceHealthRoute){
        const id=decodeSegment(deviceHealthRoute[1]);
        if(!id)return send(400,{error:'INVALID_DEVICE_ID'});
        const device=await findDevice(id);
        if(!device)return send(404,{error:'DEVICE_NOT_FOUND'});
        if(device.kind==='local')return send(200,{reachable:true});
        return send(200,publicHealth(await remoteHealth(device)));
      }
      if(req.method==='GET'&&url.pathname==='/snapshot'){
        const deviceId=url.searchParams.get('device');
        if(!deviceId||deviceId==='local')return send(200,{...await engine.snapshot(),device:{id:'local',name:'本机',kind:'local'}});
        const device=await findDevice(deviceId);
        if(!device)return send(404,{error:'DEVICE_NOT_FOUND'});
        return send(200,await remoteSnapshot(device));
      }
      if(req.method==='GET'&&url.pathname==='/capabilities'){const id=url.searchParams.get('provider_id');if(!id||id.length>512)return send(400,{error:'INVALID_PROVIDER_ID'});const levels=await engine.gateway.efforts(id);return send(200,{levels:Array.isArray(levels)?levels:[],verified:Array.isArray(levels)});}
      if(req.method==='GET'&&url.pathname==='/backups'){
        const backupDevice=url.searchParams.get('device');
        if(backupDevice&&backupDevice!=='local')return send(200,await remoteAgentBackups(await agentBackupsDevice(backupDevice)));
        const backups=await engine.listBackups();
        const stats=await backupStats();
        const keep=Number.isInteger(limits?.keep)&&limits.keep>0?limits.keep:DEFAULT_BACKUP_LIMITS.keep;
        const maxBytes=typeof limits?.maxBytes==='number'&&Number.isFinite(limits.maxBytes)?Math.max(0,Math.floor(limits.maxBytes)):DEFAULT_BACKUP_LIMITS.maxBytes;
        return send(200,{backups:(Array.isArray(backups)?backups:[]).map(publicBackup).filter(Boolean),stats,limits:{keep,maxBytes},warnings:await backupWarnings()});
      }
      const diffRoute=DIFF_ROUTE.exec(url.pathname);
      if(req.method==='GET'&&diffRoute){
        const backupId=backupIdOf(diffRoute[1]);
        if(!backupId)return send(400,{error:'INVALID_BACKUP_ID'});
        const resource=parseResource({kind:url.searchParams.get('kind'),id:url.searchParams.get('id')});
        if(!resource)return send(400,{error:'INVALID_RESOURCE'});
        const result=await engine.backupDiff(backupId,resource);
        return send(200,{backupId,resource:parseResource(result?.resource)??resource,changes:publicChanges(result?.changes),currentRevision:typeof result?.currentRevision==='string'?result.currentRevision:null});
      }
      if(req.method==='GET'&&url.pathname==='/diagnostics/export')return send(200,{events:stateDir?await readDiagnostics(stateDir):[]});
      const deviceRoute=DEVICE_ROUTE.exec(url.pathname);
      if(req.method==='DELETE'&&deviceRoute){
        const id=decodeSegment(deviceRoute[1]);
        if(!id)return send(400,{error:'INVALID_DEVICE_ID'});
        if(id==='local')return send(400,{error:'LOCAL_DEVICE_READONLY'});
        if(!registryDir)throw codeError('DEVICE_STORE_UNAVAILABLE','设备存储不可用');
        await removeDevice(registryDir,id);
        await dropDeviceSession(id);
        return send(200,{removed:true});
      }
      if(req.method==='POST'){
        if(req.headers['content-type']!=='application/json')return send(415,{error:'JSON_REQUIRED'});
        const chunks=[];
        let bytes=0;
        for await(const chunk of req){bytes+=chunk.length;if(bytes>65536)return send(413,{error:'BODY_TOO_LARGE'});chunks.push(chunk);}
        let body;
        try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return send(400,{error:'INVALID_JSON'});}
        if(!body||typeof body!=='object'||Array.isArray(body))return send(400,{error:'INVALID_BODY'});
        if(url.pathname==='/plans'){
          const planDevice=url.searchParams.get('device');
          if(planDevice&&planDevice!=='local')return send(200,await remoteAgentPlan(await agentWriteDevice(planDevice),body));
          return send(200,await engine.plan(body.resource,body.changes,false,body.expectedRevision));
        }
        if(url.pathname==='/apply'){
          const applyDevice=url.searchParams.get('device');
          if(applyDevice&&applyDevice!=='local')return send(200,await remoteAgentApply(await agentWriteDevice(applyDevice),body));
          return send(200,safeApplyResult(await engine.apply(body.id)));
        }
        if(url.pathname==='/backups/prune'){
          let keep;
          if(body.keep!==undefined){
            if(!Number.isInteger(body.keep)||body.keep<1||body.keep>100)return send(400,{error:'INVALID_KEEP'});
            keep=body.keep;
          }
          const runner=typeof engine.pruneBackups==='function'?(value=>engine.pruneBackups(value)):pruneBackups;
          if(typeof runner!=='function')throw Error('BACKUPS_UNAVAILABLE');
          const result=await runner(keep);
          const removed=(Array.isArray(result?.removed)?result.removed:[]).map(backupIdOf).filter(Boolean);
          return send(200,{removed,stats:await backupStats()});
        }
        if(url.pathname==='/restore-plans'){
          const backupId=backupIdOf(body.backupId);
          if(!backupId)return send(400,{error:'INVALID_BACKUP_ID'});
          const resource=parseResource(body.resource);
          if(!resource)return send(400,{error:'INVALID_RESOURCE'});
          if(body.expectedRevision!==undefined&&(typeof body.expectedRevision!=='string'||body.expectedRevision.length>128))return send(400,{error:'INVALID_REVISION'});
          const plan=await engine.planRestore(backupId,resource,body.expectedRevision);
          return send(200,{...publicRestorePlan(plan),backupId:backupIdOf(plan?.backupId)??backupId,changes:publicChanges(plan?.changes)});
        }
        if(url.pathname==='/devices'){
          if(!registryDir)throw codeError('DEVICE_STORE_UNAVAILABLE','设备存储不可用');
          const kind=typeof body.kind==='string'?body.kind:'http';
          // Remote writes are only offered by agent devices; http/ssh always stay read-only.
          const readOnly=kind==='agent'?body.readOnly!==false:true;
          const input={
            name:body.name,
            baseUrl:body.baseUrl,
            kind,
            readOnly,
            ...(kind==='ssh'?{ssh:body.ssh}:{}),
          };
          // Validate and dedupe before pairing: a duplicate agent must not trigger another pair attempt.
          const registry=await loadRegistry(registryDir);
          const prepared=validateDevice(input,{existingIds:registry.devices.map(item=>item.id),existingDevices:registry.devices});
          let credential;
          if(kind==='agent'){
            if(typeof body.pairingCode!=='string'||!body.pairingCode.trim())throw codeError('DEVICE_SECRET_REQUIRED','添加 agent 设备需要 pairingCode');
            const paired=await pairDevice(prepared,body.pairingCode.trim());
            credential=typeof paired==='string'?paired:paired?.token;
            if(typeof credential!=='string'||!credential)throw codeError('DEVICE_AUTH_FAILED','Agent 配对未返回有效 token');
          }else{
            if(typeof body.apiKey!=='string'||!body.apiKey.trim())throw codeError('DEVICE_SECRET_REQUIRED','添加 HTTP/SSH 设备需要 OpenAPI Key（abk_...）');
            credential=body.apiKey;
          }
          const device=await addDevice(registryDir,prepared,credential);
          return send(200,{device:publicDevice(device)});
        }
      }
      return send(404,{error:'NOT_FOUND'});
    }catch(e){
      const deviceStatus=deviceErrorStatus(e);
      if(deviceStatus)return send(deviceStatus,{error:e.code,...sanitizeErrorDetails(e?.details)});
      return send(409,{error:knownError(e),...sanitizeErrorDetails(e?.details)});
    }
  });
  server.requestTimeout=15000;
  server.headersTimeout=10000;
  /** Wait for in-flight diagnostic writes; used by tests and shutdown, never required by requests. */
  server.flushDiagnostics=()=>Promise.all([...pendingDiagnostics]);
  return server;
}

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
 * Best effort: protect legacy plaintext device secrets with DPAPI at startup.
 * Failures keep the plaintext (never deleted) and are recorded as diagnostics only, so startup is never blocked.
 */
async function migrateDeviceSecrets(stateDir){
  try{
    const report=await migrateSecrets(stateDir);
    const migrated=Array.isArray(report?.migrated)?report.migrated:[];
    const failed=Array.isArray(report?.failed)?report.failed:[];
    const remaining=Number.isInteger(report?.plaintextRemaining)?report.plaintextRemaining:0;
    if(migrated.length)await logDiagnostic(stateDir,{level:'info',event:'secrets-migrated',detail:`migrated ${migrated.length} secret(s)`});
    if(failed.length)await logDiagnostic(stateDir,{level:'warn',event:'secrets-migration-failed',code:'SECRETS_MIGRATION_FAILED',detail:`failed ${failed.length}, plaintextRemaining ${remaining}`});
    else if(remaining>0)await logDiagnostic(stateDir,{level:'warn',event:'secrets-migration-failed',code:'SECRETS_MIGRATION_FAILED',detail:`plaintextRemaining ${remaining}`});
  }catch(error){
    await logDiagnostic(stateDir,{level:'warn',event:'secrets-migration-failed',code:'SECRETS_MIGRATION_FAILED',detail:typeof error?.code==='string'?error.code:'OPERATION_FAILED'});
  }
}

/**
 * Start the console: resolve state, acquire the single-instance lock, discover AstrBot data, then listen.
 * Backup list/read functions are injected into the Engine, and backup retention warnings go to the
 * diagnostics journal instead of stderr. Expected configuration failures print a readable message,
 * set exitCode=1 and resolve null. Returns the live http.Server on success; the lock is released on
 * SIGINT/SIGTERM.
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
    await migrateDeviceSecrets(stateDir);
    const data=await resolveData(env);
    const resumeToken=env.MODEL_CONSOLE_SESSION_TOKEN;
    if(resumeToken&&!/^[a-f0-9]{64}$/.test(resumeToken))throw Error('INVALID_SESSION_TOKEN');
    const token=resumeToken??randomBytes(32).toString('hex');
    const gateway=new Gateway(data);
    const backupsDir=join(stateDir,'backups');
    const onWarning=(code,details)=>logDiagnostic(stateDir,{level:'warn',event:'backup-warning',code:typeof code==='string'?code:undefined,detail:typeof details==='string'?details:undefined});
    const backupWiring=typeof backupModule.listBackups==='function'&&typeof backupModule.readBackupResource==='function'
      ?{list:()=>backupModule.listBackups(backupsDir),read:(backupId,resource)=>backupModule.readBackupResource(backupsDir,backupId,resource)}
      :undefined;
    const engine=new Engine({
      gateway,
      writeEnabled:argv.includes('--enable-writes'),
      backup:()=>backupModule.backupState(data,backupsDir,{env,onWarning}),
      ...(backupWiring?{backups:backupWiring}:{}),
      audit:event=>appendFile(join(stateDir,'audit.jsonl'),JSON.stringify({...event,time:new Date().toISOString()})+'\n'),
    });
    const server=createServer(engine,token,{
      health:{dataPath:data,stateDir,readOnly:!engine.writeEnabled},
      limits:backupLimits(env),
      pruneBackups:typeof backupModule.pruneBackups==='function'
        ?keep=>backupModule.pruneBackups(backupsDir,{keep:Number.isInteger(keep)?keep:backupModule.backupKeep(env)})
        :undefined,
    });
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
