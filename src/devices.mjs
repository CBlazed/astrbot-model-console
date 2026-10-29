/** Device registry for local/remote AstrBot consoles. Secrets (apiKey / agent token) live in a separate
 *  file, never in devices.json; pairing codes are consumed at pairing time and never persisted. */
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export const DEVICE_KINDS=['http','ssh','agent'];
export const DEVICE_AUTH_TYPES=['api-key','agent-token'];
const AUTH_FOR_KIND={http:'api-key',ssh:'api-key',agent:'agent-token'};

const devicesPath=stateDir=>join(stateDir,'devices.json');
const secretsPath=stateDir=>join(stateDir,'secrets.json');

const blank=()=>({version:1,devices:[]});

async function readJSON(path,fallback){
  try{return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}
}

async function atomicWrite(path,value){
  const temp=`${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp,JSON.stringify(value,null,2),'utf8');
  await rename(temp,path);
}

/** Parse + normalize baseUrl once, so duplicate detection and stored records share the same form. */
function normalizeBaseUrl(value){
  let url;
  try{url=new URL(String(value??''));}catch{throw deviceError('DEVICE_INVALID','baseUrl 不是合法 URL');}
  if(!['http:','https:'].includes(url.protocol))throw deviceError('DEVICE_INVALID','baseUrl 只支持 http/https');
  if(url.username||url.password)throw deviceError('DEVICE_INVALID','baseUrl 不能包含账号密码');
  return url.href.replace(/\/$/,'');
}

function optionalPath(value,label){
  if(value===undefined||value===null||value==='')return undefined;
  if(typeof value!=='string'||value.length>1024||value.includes('\u0000'))throw deviceError('DEVICE_INVALID',`${label} 不是合法路径字符串`);
  return value;
}

/** Validate/normalize the ssh block; host and user are required, port/keyPath/dataPath optional. */
function normalizeSsh(input){
  const ssh=input&&typeof input==='object'&&!Array.isArray(input)?input:null;
  if(!ssh)throw deviceError('DEVICE_INVALID','ssh 设备需要 ssh 配置对象');
  const host=typeof ssh.host==='string'?ssh.host.trim():'';
  if(!host||host.length>255||/[\s\\/]/.test(host))throw deviceError('DEVICE_INVALID','ssh.host 必须是 1-255 个字符的主机名或 IP');
  const user=typeof ssh.user==='string'?ssh.user.trim():'';
  if(!user||user.length>64||/[\s]/.test(user))throw deviceError('DEVICE_INVALID','ssh.user 必须是 1-64 个字符');
  const record={host,user};
  if(ssh.port!==undefined&&ssh.port!==null){
    if(!Number.isInteger(ssh.port)||ssh.port<1||ssh.port>65535)throw deviceError('DEVICE_INVALID','ssh.port 必须是 1-65535 的整数');
    record.port=ssh.port;
  }
  const keyPath=optionalPath(ssh.keyPath,'ssh.keyPath');
  if(keyPath)record.keyPath=keyPath;
  const dataPath=optionalPath(ssh.dataPath,'ssh.dataPath');
  if(dataPath)record.dataPath=dataPath;
  return record;
}

function secretMessage(kind){
  return kind==='agent'?'添加 agent 设备需要配对码换取的设备 token':'添加 HTTP/SSH 设备需要 OpenAPI Key（abk_...）';
}

/**
 * Normalize and validate a device record. Throws DEVICE_INVALID with a readable message.
 * Duplicate detection compares kind + normalized baseUrl (and legacy duplicate ids).
 * pairingCode is accepted in the POST body but never returned or persisted (server pairs first).
 */
export function validateDevice(input,{existingIds=[],existingDevices=[]}={}){
  if(!input||typeof input!=='object')throw deviceError('DEVICE_INVALID','设备信息必须是对象');
  const name=typeof input.name==='string'?input.name.trim():'';
  if(!name||name.length>80)throw deviceError('DEVICE_INVALID','设备名称必须为 1-80 个字符');
  const kind=input.kind??'http';
  if(!DEVICE_KINDS.includes(kind))throw deviceError('DEVICE_INVALID',`不支持的设备类型：${kind}`);
  const baseUrl=normalizeBaseUrl(input.baseUrl);
  if(existingDevices.some(device=>device?.kind===kind&&(()=>{try{return normalizeBaseUrl(device.baseUrl)===baseUrl;}catch{return false;}})()))throw deviceError('DEVICE_EXISTS','同类型、同地址的设备已存在');
  const id=typeof input.id==='string'&&input.id?input.id:randomUUID();
  if(existingIds.includes(id))throw deviceError('DEVICE_EXISTS','设备 ID 已存在');
  const record={
    id,
    name,
    kind,
    baseUrl,
    readOnly:input.readOnly!==false,
    auth:{type:AUTH_FOR_KIND[kind]},
    createdAt:input.createdAt??new Date().toISOString(),
  };
  if(kind==='ssh')record.ssh=normalizeSsh(input.ssh);
  return record;
}

export async function loadRegistry(stateDir){
  const raw=await readJSON(devicesPath(stateDir),blank());
  if(!raw||typeof raw!=='object'||!Array.isArray(raw.devices))return blank();
  return {version:1,devices:raw.devices.filter(device=>device&&typeof device==='object'&&typeof device.id==='string')};
}

export async function saveRegistry(stateDir,registry){
  await mkdir(stateDir,{recursive:true});
  await atomicWrite(devicesPath(stateDir),{version:1,devices:registry.devices});
}

/** Public view: never returns the API key or pairing code, only whether a secret is stored. */
export async function listDevices(stateDir){
  const registry=await loadRegistry(stateDir);
  return Promise.all(registry.devices.map(async device=>({...device,hasSecret:Boolean(await getSecret(stateDir,device.id))})));
}

export async function addDevice(stateDir,input,credential){
  const registry=await loadRegistry(stateDir);
  const device=validateDevice(input,{existingIds:registry.devices.map(x=>x.id),existingDevices:registry.devices});
  if(typeof credential!=='string'||!credential.trim())throw deviceError('DEVICE_SECRET_REQUIRED',secretMessage(device.kind));
  await saveRegistry(stateDir,{devices:[...registry.devices,device]});
  await setSecret(stateDir,device.id,credential.trim());
  return {...device,hasSecret:true};
}

export async function updateDevice(stateDir,id,patch){
  const registry=await loadRegistry(stateDir);
  const index=registry.devices.findIndex(x=>x.id===id);
  if(index<0)throw deviceError('DEVICE_NOT_FOUND','设备不存在');
  const current=registry.devices[index];
  const next=validateDevice({...current,...patch,id},{existingIds:registry.devices.filter(x=>x.id!==id).map(x=>x.id),existingDevices:registry.devices.filter(x=>x.id!==id)});
  const devices=[...registry.devices];devices[index]=next;
  await saveRegistry(stateDir,{devices});
  if(typeof patch?.apiKey==='string'&&patch.apiKey.trim())await setSecret(stateDir,id,patch.apiKey.trim());
  return next;
}

export async function removeDevice(stateDir,id){
  const registry=await loadRegistry(stateDir);
  const next=registry.devices.filter(x=>x.id!==id);
  if(next.length===registry.devices.length)throw deviceError('DEVICE_NOT_FOUND','设备不存在');
  await saveRegistry(stateDir,{devices:next});
  await removeSecret(stateDir,id);
}

async function readSecrets(stateDir){
  return readJSON(secretsPath(stateDir),{version:1,secrets:{}});
}

export async function getSecret(stateDir,deviceId){
  const secrets=await readSecrets(stateDir);
  const value=secrets?.secrets?.[deviceId];
  return typeof value==='string'?value:null;
}

export async function setSecret(stateDir,deviceId,value){
  await mkdir(stateDir,{recursive:true});
  const secrets=await readSecrets(stateDir);
  if(!secrets.secrets||typeof secrets.secrets!=='object')secrets.secrets={};
  secrets.secrets[deviceId]=value;
  await atomicWrite(secretsPath(stateDir),secrets);
}

export async function removeSecret(stateDir,deviceId){
  const secrets=await readSecrets(stateDir);
  if(!secrets?.secrets||!(deviceId in secrets.secrets))return;
  delete secrets.secrets[deviceId];
  await atomicWrite(secretsPath(stateDir),secrets);
}

export function deviceError(code,message){
  const error=Error(message);error.code=code;return error;
}
