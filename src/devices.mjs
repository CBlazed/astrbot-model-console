/** Device registry for remote AstrBot consoles. Secrets live in a separate file, never in devices.json. */
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export const DEVICE_KINDS=['http'];
export const DEVICE_AUTH_TYPES=['api-key'];

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

/** Normalize and validate a device record. Throws DEVICE_INVALID with a readable message. */
export function validateDevice(input,{existingIds=[]}={}){
  if(!input||typeof input!=='object')throw deviceError('DEVICE_INVALID','设备信息必须是对象');
  const name=typeof input.name==='string'?input.name.trim():'';
  if(!name||name.length>80)throw deviceError('DEVICE_INVALID','设备名称必须为 1-80 个字符');
  const kind=input.kind??'http';
  if(!DEVICE_KINDS.includes(kind))throw deviceError('DEVICE_INVALID',`不支持的设备类型：${kind}`);
  let baseUrl;
  try{baseUrl=new URL(String(input.baseUrl??''));}catch{throw deviceError('DEVICE_INVALID','baseUrl 不是合法 URL');}
  if(!['http:','https:'].includes(baseUrl.protocol))throw deviceError('DEVICE_INVALID','baseUrl 只支持 http/https');
  if(baseUrl.username||baseUrl.password)throw deviceError('DEVICE_INVALID','baseUrl 不能包含账号密码');
  const auth=input.auth??{type:'api-key'};
  if(!DEVICE_AUTH_TYPES.includes(auth.type))throw deviceError('DEVICE_INVALID',`不支持的认证类型：${auth.type}`);
  const id=typeof input.id==='string'&&input.id?input.id:randomUUID();
  if(existingIds.includes(id))throw deviceError('DEVICE_EXISTS','设备 ID 已存在');
  return {
    id,
    name,
    kind,
    baseUrl:baseUrl.href.replace(/\/$/,''),
    readOnly:input.readOnly!==false,
    auth:{type:auth.type},
    createdAt:input.createdAt??new Date().toISOString(),
  };
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

/** Public view: never returns the API key, only whether one is stored. */
export async function listDevices(stateDir){
  const registry=await loadRegistry(stateDir);
  return Promise.all(registry.devices.map(async device=>({...device,hasSecret:Boolean(await getSecret(stateDir,device.id))})));
}

export async function addDevice(stateDir,input,apiKey){
  const registry=await loadRegistry(stateDir);
  const device=validateDevice(input,{existingIds:registry.devices.map(x=>x.id)});
  if(typeof apiKey!=='string'||!apiKey.trim())throw deviceError('DEVICE_SECRET_REQUIRED','添加 HTTP 设备需要 OpenAPI Key（abk_...）');
  await saveRegistry(stateDir,{devices:[...registry.devices,device]});
  await setSecret(stateDir,device.id,apiKey.trim());
  return {...device,hasSecret:true};
}

export async function updateDevice(stateDir,id,patch){
  const registry=await loadRegistry(stateDir);
  const index=registry.devices.findIndex(x=>x.id===id);
  if(index<0)throw deviceError('DEVICE_NOT_FOUND','设备不存在');
  const current=registry.devices[index];
  const next=validateDevice({...current,...patch,id},{existingIds:registry.devices.filter(x=>x.id!==id).map(x=>x.id)});
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
