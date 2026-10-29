/** Single-instance lock. One state directory belongs to one live Model Console process. */
import {mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import net from 'node:net';

export const ANOTHER_INSTANCE_RUNNING='ANOTHER_INSTANCE_RUNNING';
export const LOCK_UNAVAILABLE='LOCK_UNAVAILABLE';

const lockFileName='instance.lock';
const delay=ms=>new Promise(resolveDelay=>setTimeout(resolveDelay,ms));
const isAlive=pid=>{
  if(!Number.isInteger(pid)||pid<=0)return false;
  try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}
};
/**
 * Liveness probe for the port recorded in the lock.
 * Windows pid reuse can make process.kill(pid,0) throw EPERM for an unrelated protected process,
 * so a "live" pid is not enough: when the owner recorded a port, it must still accept loopback
 * connections. Returns true/false, or null when no port was recorded (treat as live to be safe).
 */
export function isPortListening(port,timeoutMs=400){
  if(!Number.isInteger(port)||port<=0)return Promise.resolve(null);
  return new Promise(resolve=>{
    const socket=net.connect({host:'127.0.0.1',port});
    let settled=false;
    const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();resolve(value);};
    const timer=setTimeout(()=>finish(false),timeoutMs);
    socket.once('connect',()=>finish(true));
    socket.once('error',()=>finish(false));
  });
}
const readLock=async path=>{
  try{const value=JSON.parse(await readFile(path,'utf8'));return value&&typeof value==='object'?value:null;}catch{return null;}
};
const runningError=(lock,path)=>{
  const error=Error(`ANOTHER_INSTANCE_RUNNING: Model Console 已在运行（pid ${lock.pid}${Number.isInteger(lock.port)&&lock.port>0?`，端口 ${lock.port}`:''}）。请复用已打开的窗口，或先关闭旧实例。锁文件：${path}`);
  error.code=ANOTHER_INSTANCE_RUNNING;
  error.details={pid:lock.pid,port:Number.isInteger(lock.port)?lock.port:null};
  return error;
};
/** A lock is stale when its pid is gone, or its recorded port no longer listens for an old lock
 *  (Windows pid reuse can make process.kill(pid,0) throw EPERM for an unrelated protected process).
 *  A recently written lock keeps the benefit of the doubt while the owner is still starting up. */
async function lockIsStale(lock){
  if(!lock||!isAlive(lock.pid))return true;
  const port=Number(lock.port);
  if(!Number.isInteger(port)||port<=0)return false;
  const reachable=await isPortListening(port);
  if(reachable===true)return false;
  if(reachable===false){
    const started=Date.parse(lock.startedAt);
    return Number.isFinite(started)?Date.now()-started>5000:true;
  }
  return false;
}

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
      if(error.code!=='EEXIST'){
        // EPERM/EACCES/EISDIR here mean the state directory or lock path is not usable, not "already running".
        if(['EPERM','EACCES','EISDIR','ERR_FS_EISDIR'].includes(error.code))throw unavailableError(path,error);
        throw error;
      }
      const current=await readLock(path);
      if(current&&!await lockIsStale(current))throw runningError(current,path);
      // Stale lock: antivirus/indexers can briefly hold the file, so retry the removal before giving up.
      let removed=false;
      for(let retry=0;retry<5&&!removed;retry++){
        try{await rm(path,{force:true});removed=true;}
        catch(removeError){
          if(!['EPERM','EACCES','EBUSY','ERR_FS_EISDIR'].includes(removeError.code))throw removeError;
          await delay(100);
        }
      }
      if(!removed)throw unavailableError(path);
    }
  }
  throw unavailableError(path);
}

function unavailableError(path,cause){
  const error=Error(`LOCK_UNAVAILABLE: 无法获取实例锁 ${path}（可能被杀软/索引服务占用，或状态目录不可写）。请关闭占用进程或手动删除该文件后重试。`);
  error.code=LOCK_UNAVAILABLE;
  if(cause?.code)error.details={cause:cause.code};
  return error;
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
