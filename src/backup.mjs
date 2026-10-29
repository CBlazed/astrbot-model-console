/** Real SQLite online backup; fail closed on any missing or invalid backup. Retention keeps the newest N and enforces a total byte cap. */
import {mkdir,copyFile,readdir,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync,backup} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';

const UUID_DIRECTORY=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_RESOURCE_ID=/^[A-Za-z0-9._-]{1,128}$/;
const MEBIBYTE=1024*1024;
export const DEFAULT_BACKUP_KEEP=10;
export const DEFAULT_BACKUP_MAX_MB=2048;
export const BACKUP_PRUNE_FAILED='BACKUP_PRUNE_FAILED';
export const BACKUP_SIZE_LIMIT_EXCEEDED='BACKUP_SIZE_LIMIT_EXCEEDED';
export const RESTORE_BACKUP_NOT_FOUND='RESTORE_BACKUP_NOT_FOUND';
export const RESTORE_BACKUP_INVALID='RESTORE_BACKUP_INVALID';

const errorCode=error=>typeof error?.code==='string'?error.code:'UNKNOWN';
const coded=(code,message=code)=>{const error=Error(message);error.code=code;return error;};
/** Warning delivery can never fail the backup that triggered it. */
const warn=(onWarning,code,details)=>{try{onWarning?.(code,details);}catch{}};
const basename=path=>path.split(/[\\/]+/).filter(Boolean).at(-1)??'';

/** Read the retention count from MODEL_CONSOLE_BACKUP_KEEP; invalid or missing values fall back to 10. */
export function backupKeep(env=process.env){
  const raw=env.MODEL_CONSOLE_BACKUP_KEEP;
  if(raw===undefined||raw==='')return DEFAULT_BACKUP_KEEP;
  const value=Number(raw);
  return Number.isInteger(value)&&value>=1?value:DEFAULT_BACKUP_KEEP;
}

/** Total backup-size cap in bytes from MODEL_CONSOLE_BACKUP_MAX_MB; default 2048 MB, invalid values fall back. */
export function backupMaxBytes(env=process.env){
  const raw=env.MODEL_CONSOLE_BACKUP_MAX_MB;
  if(raw===undefined||raw==='')return DEFAULT_BACKUP_MAX_MB*MEBIBYTE;
  const value=Number(raw);
  return Number.isFinite(value)&&value>0?Math.floor(value*MEBIBYTE):DEFAULT_BACKUP_MAX_MB*MEBIBYTE;
}

async function directoryBytes(path){
  let total=0,entries;
  try{entries=await readdir(path,{withFileTypes:true});}catch{return total;}
  for(const entry of entries){
    const child=join(path,entry.name);
    if(entry.isDirectory())total+=await directoryBytes(child);
    else if(entry.isFile()){try{total+=(await stat(child)).size;}catch{}}
  }
  return total;
}

/** UUID-named directories containing manifest.json, with their mtime for retention ordering. */
async function backupDirectories(dest){
  let entries;
  try{entries=await readdir(dest,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return [];throw error;}
  const found=[];
  for(const entry of entries){
    if(!entry.isDirectory()||!UUID_DIRECTORY.test(entry.name))continue;
    const path=join(dest,entry.name);
    try{const manifest=await stat(join(path,'manifest.json'));if(!manifest.isFile())continue;}catch{continue;}
    const info=await stat(path);
    found.push({path,mtime:info.mtimeMs});
  }
  return found;
}

/** Read one backup's manifest summary. Missing manifest means "not a backup"; a corrupt manifest is surfaced as invalid. */
async function manifestInfo(path,fallbackTime){
  let manifest=null,corrupt=false;
  try{manifest=JSON.parse((await readFile(join(path,'manifest.json'),'utf8')).replace(/^\uFEFF/,''));}
  catch(error){if(error.code==='ENOENT')return null;corrupt=true;}
  if(!manifest||typeof manifest!=='object'||Array.isArray(manifest)){corrupt=true;manifest=null;}
  const createdAt=typeof manifest?.createdAt==='string'&&!Number.isNaN(Date.parse(manifest.createdAt))?manifest.createdAt:new Date(fallbackTime).toISOString();
  return {createdAt,files:Array.isArray(manifest?.files)?manifest.files.length:null,sqlite:typeof manifest?.sqlite==='string'?manifest.sqlite:corrupt?'invalid':'unknown'};
}

async function backupEntries(dest){
  const found=[];
  for(const entry of await backupDirectories(dest)){
    const info=await manifestInfo(entry.path,entry.mtime);
    if(!info)continue;
    found.push({id:basename(entry.path),createdAt:info.createdAt,bytes:await directoryBytes(entry.path),files:info.files,sqlite:info.sqlite,mtime:entry.mtime});
  }
  return found;
}

const newestFirst=(a,b)=>(Date.parse(b.createdAt)-Date.parse(a.createdAt))||(b.mtime-a.mtime);

/** All usable backups, newest first: {id,createdAt,bytes,files,sqlite}. */
export async function listBackups(dest){
  const entries=await backupEntries(dest);
  return entries.sort(newestFirst).map(({id,createdAt,bytes,files,sqlite})=>({id,createdAt,bytes,files,sqlite}));
}

/** Backup count/占用: {count,bytes,items:[{id,bytes,createdAt}]}. */
export async function backupStats(dest){
  const entries=await backupEntries(dest);
  return {count:entries.length,bytes:entries.reduce((total,entry)=>total+entry.bytes,0),items:entries.sort(newestFirst).map(({id,bytes,createdAt})=>({id,bytes,createdAt}))};
}

/**
 * Keep the newest `keep` backups in dest. Only UUID-named directories that contain manifest.json are
 * candidates, and `protect` (the backup just created) is never removed.
 */
export async function pruneBackups(dest,{keep=backupKeep(),protect}={}){
  const backups=await backupDirectories(dest);
  backups.sort((a,b)=>b.mtime-a.mtime);
  let ordered=backups;
  if(protect){
    const created=backups.find(entry=>entry.path===protect);
    if(created)ordered=[created,...backups.filter(entry=>entry!==created)];
  }
  const keepCount=Math.max(1,Number.isInteger(keep)?keep:DEFAULT_BACKUP_KEEP);
  const kept=ordered.slice(0,keepCount),removed=[];
  for(const entry of ordered.slice(keepCount)){await rm(entry.path,{recursive:true,force:true});removed.push(entry.path);}
  let bytes=0;for(const entry of kept)bytes+=await directoryBytes(entry.path);
  return {kept:kept.map(entry=>entry.path),removed,bytes};
}

/** Delete the oldest removable backups until the total fits maxBytes; never touches the newest or `protect`. */
async function enforceByteLimit(dest,{protect,maxBytes,onWarning}){
  let entries=(await backupDirectories(dest)).sort((a,b)=>b.mtime-a.mtime);
  let bytes=0;for(const entry of entries)bytes+=await directoryBytes(entry.path);
  if(bytes<=maxBytes)return {kept:entries.map(entry=>entry.path),removed:[],bytes};
  const removed=[];
  const removable=entries.filter(entry=>entry.path!==protect&&entry.path!==entries[0]?.path);
  for(const victim of removable.reverse()){
    try{await rm(victim.path,{recursive:true,force:true});}
    catch(error){warn(onWarning,BACKUP_PRUNE_FAILED,{code:errorCode(error),maxBytes,bytes});break;}
    removed.push(victim.path);
    entries=(await backupDirectories(dest)).sort((a,b)=>b.mtime-a.mtime);
    bytes=0;for(const entry of entries)bytes+=await directoryBytes(entry.path);
    if(bytes<=maxBytes)break;
  }
  warn(onWarning,BACKUP_SIZE_LIMIT_EXCEEDED,{maxBytes,bytes,removed:removed.length});
  return {kept:entries.map(entry=>entry.path),removed,bytes};
}

/**
 * AstrBot provider ids may contain "/" (e.g. <provider>/<model>), so provider ids are validated as
 * a logical id, never as a path: no traversal/drive/backslash/empty segments, bounded length. Providers are
 * still looked up inside cmd_config.json's provider array, so no user input is joined into a file path.
 */
const PROVIDER_ID_MAX_LENGTH=200;
function validProviderId(id){
  return typeof id==='string'&&id.length>0&&id.length<=PROVIDER_ID_MAX_LENGTH
    &&!id.includes('..')&&!id.includes('\\')&&!id.includes(':')
    &&!id.startsWith('/')&&!id.endsWith('/')&&!id.includes('//');
}

/** Map a reviewed resource to its file inside a backup. Default profile and providers live in cmd_config.json. */
function backupResourceFile(resource){
  if(!resource||typeof resource!=='object'||typeof resource.kind!=='string'||typeof resource.id!=='string')throw coded(RESTORE_BACKUP_INVALID);
  if(resource.kind==='provider'){
    if(!validProviderId(resource.id))throw coded(RESTORE_BACKUP_INVALID);
    return 'cmd_config.json';
  }
  if(!['profile','plugin'].includes(resource.kind)||!SAFE_RESOURCE_ID.test(resource.id)||resource.id.includes('..'))throw coded(RESTORE_BACKUP_INVALID);
  if(resource.kind==='profile')return resource.id==='default'?'cmd_config.json':`config/abconf_${resource.id}.json`;
  return `config/${resource.id}_config.json`;
}

/**
 * Read the backed-up config object for one resource.
 * Missing backup/file/provider throws RESTORE_BACKUP_NOT_FOUND; unreadable JSON throws RESTORE_BACKUP_INVALID.
 */
export async function readBackupResource(dest,backupId,resource){
  if(typeof backupId!=='string'||!UUID_DIRECTORY.test(backupId))throw coded(RESTORE_BACKUP_NOT_FOUND);
  const file=backupResourceFile(resource),dir=join(dest,backupId);
  try{const manifest=await stat(join(dir,'manifest.json'));if(!manifest.isFile())throw coded(RESTORE_BACKUP_NOT_FOUND);}
  catch{throw coded(RESTORE_BACKUP_NOT_FOUND);}
  let config;
  try{config=JSON.parse((await readFile(join(dir,file),'utf8')).replace(/^\uFEFF/,''));}
  catch(error){throw coded(errorCode(error)==='ENOENT'?RESTORE_BACKUP_NOT_FOUND:RESTORE_BACKUP_INVALID);}
  if(!config||typeof config!=='object'||Array.isArray(config))throw coded(RESTORE_BACKUP_INVALID);
  if(resource.kind==='provider'){
    const providers=Array.isArray(config.provider)?config.provider:[];
    const provider=providers.find(item=>item&&typeof item==='object'&&item.id===resource.id);
    if(!provider)throw coded(RESTORE_BACKUP_NOT_FOUND);
    return {config:provider,file};
  }
  return {config,file};
}

/** Create a verified backup, then apply retention and the total-size cap. Warnings are delivered, never thrown. */
export async function backupState(data,dest,{env=process.env,onWarning}={}){
  const dir=join(dest,randomUUID());
  await mkdir(dir,{recursive:true});
  const names=await readdir(join(data,'config'));
  const files=['cmd_config.json',...names.filter(n=>n.endsWith('.json')).map(n=>join('config',n))];
  const manifest=[];
  for(const name of files){
    const target=join(dir,name);
    await mkdir(join(target,'..'),{recursive:true});
    await copyFile(join(data,name),target);
    const source=await readFile(join(data,name)),copy=await readFile(target);
    if(!source.equals(copy))throw Error('BACKUP_CHANGED_DURING_COPY');
    manifest.push({name,sha256:createHash('sha256').update(copy).digest('hex')});
  }
  const db=new DatabaseSync(join(data,'data_v4.db'),{readOnly:true});
  try{await backup(db,join(dir,'data_v4.db'));}finally{db.close();}
  const check=new DatabaseSync(join(dir,'data_v4.db'),{readOnly:true});
  try{if(check.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('BACKUP_SQLITE_INVALID');}finally{check.close();}
  await writeFile(join(dir,'manifest.json'),JSON.stringify({files:manifest,sqlite:'ok',createdAt:new Date().toISOString()}));
  try{await pruneBackups(dest,{keep:backupKeep(env),protect:dir});}catch(error){warn(onWarning,BACKUP_PRUNE_FAILED,{code:errorCode(error)});}
  try{await enforceByteLimit(dest,{protect:dir,maxBytes:backupMaxBytes(env),onWarning});}catch(error){warn(onWarning,BACKUP_PRUNE_FAILED,{code:errorCode(error)});}
  return dir;
}
