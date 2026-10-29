/** Single-instance lock. One state directory belongs to one live Model Console process. */
import {mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

export const ANOTHER_INSTANCE_RUNNING='ANOTHER_INSTANCE_RUNNING';

const lockFileName='instance.lock';
const isAlive=pid=>{
  if(!Number.isInteger(pid)||pid<=0)return false;
  try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}
};
const readLock=async path=>{
  try{const value=JSON.parse(await readFile(path,'utf8'));return value&&typeof value==='object'?value:null;}catch{return null;}
};
const runningError=(lock,path)=>{
  const error=Error(`ANOTHER_INSTANCE_RUNNING: Model Console 已在运行（pid ${lock.pid}${Number.isInteger(lock.port)&&lock.port>0?`，端口 ${lock.port}`:''}）。请复用已打开的窗口，或先关闭旧实例。锁文件：${path}`);
  error.code=ANOTHER_INSTANCE_RUNNING;
  error.details={pid:lock.pid,port:Number.isInteger(lock.port)?lock.port:null};
  return error;
};

/**
 * Acquire the single-instance lock in stateDir.
 * A live owner raises ANOTHER_INSTANCE_RUNNING (details: pid/port); a dead owner's stale lock is replaced.
 * Returns {release, update}: release deletes the lock, update({port}) rewrites it with the real listening port.
 */
export async function acquireLock(stateDir,{port=0}={}){
  await mkdir(stateDir,{recursive:true});
  const path=join(stateDir,lockFileName);
  const startedAt=new Date().toISOString();
  const content=()=>JSON.stringify({pid:process.pid,port:Number.isInteger(port)?port:0,startedAt});
  for(let attempt=0;attempt<3;attempt++){
    try{
      await writeFile(path,content(),{encoding:'utf8',flag:'wx'});
      return makeHandle(path,startedAt);
    }catch(error){
      if(error.code!=='EEXIST')throw error;
      const current=await readLock(path);
      if(current&&isAlive(current.pid))throw runningError(current,path);
      await rm(path,{force:true});
    }
  }
  const error=Error('LOCK_UNAVAILABLE: 无法获取实例锁，请重试。');
  error.code='LOCK_UNAVAILABLE';
  throw error;
}

function makeHandle(path,startedAt){
  const owned=async()=>{
    const current=await readLock(path);
    return current?.pid===process.pid&&current?.startedAt===startedAt;
  };
  return {
    async release(){
      let current;
      try{current=JSON.parse(await readFile(path,'utf8'));}catch(error){
        if(error.code==='ENOENT')return;
        await rm(path,{force:true});
        return;
      }
      if(current?.pid===process.pid&&current?.startedAt===startedAt)await rm(path,{force:true});
    },
    async update({port:actualPort}={}){
      if(!Number.isInteger(actualPort)||actualPort<=0)return;
      if(!(await owned()))return;
      const target=JSON.stringify({pid:process.pid,port:actualPort,startedAt});
      const temporary=`${path}.${process.pid}.tmp`;
      await writeFile(temporary,target,'utf8');
      await rename(temporary,path);
    },
  };
}
