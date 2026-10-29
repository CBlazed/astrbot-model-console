/** Real SQLite online backup; fail closed on any missing or invalid backup. Retention keeps the newest N. */
import {mkdir,copyFile,readdir,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync,backup} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';

const UUID_DIRECTORY=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DEFAULT_BACKUP_KEEP=10;

/** Read the retention count from MODEL_CONSOLE_BACKUP_KEEP; invalid or missing values fall back to 10. */
export function backupKeep(env=process.env){
  const raw=env.MODEL_CONSOLE_BACKUP_KEEP;
  if(raw===undefined||raw==='')return DEFAULT_BACKUP_KEEP;
  const value=Number(raw);
  return Number.isInteger(value)&&value>=1?value:DEFAULT_BACKUP_KEEP;
}

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
  const removed=[];
  for(const entry of ordered.slice(keepCount)){await rm(entry.path,{recursive:true,force:true});removed.push(entry.path);}
  return {kept:ordered.slice(0,keepCount).map(entry=>entry.path),removed};
}

export async function backupState(data,dest,{env=process.env}={}){const dir=join(dest,randomUUID());await mkdir(dir,{recursive:true});const names=await readdir(join(data,'config'));const files=['cmd_config.json',...names.filter(n=>n.endsWith('.json')).map(n=>join('config',n))];const manifest=[];for(const name of files){const target=join(dir,name);await mkdir(join(target,'..'),{recursive:true});await copyFile(join(data,name),target);const source=await readFile(join(data,name)),copy=await readFile(target);if(!source.equals(copy))throw Error('BACKUP_CHANGED_DURING_COPY');manifest.push({name,sha256:createHash('sha256').update(copy).digest('hex')});}const db=new DatabaseSync(join(data,'data_v4.db'),{readOnly:true});try{await backup(db,join(dir,'data_v4.db'));}finally{db.close();}const check=new DatabaseSync(join(dir,'data_v4.db'),{readOnly:true});try{if(check.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw Error('BACKUP_SQLITE_INVALID');}finally{check.close();}await writeFile(join(dir,'manifest.json'),JSON.stringify({files:manifest,sqlite:'ok'}));try{await pruneBackups(dest,{keep:backupKeep(env),protect:dir});}catch(error){if(error?.code!=='ENOENT')console.error('备份保留清理失败：',error?.message??error);}return dir;}
