import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {acquireLock,ANOTHER_INSTANCE_RUNNING,LOCK_UNAVAILABLE} from '../src/lock.mjs';

const readLock=async state=>JSON.parse(await readFile(join(state,'instance.lock'),'utf8'));
async function temp(){return mkdtemp(join(tmpdir(),'model-console-lock-'));}
const deadPid=()=>spawnSync(process.execPath,['-e',''],{stdio:'ignore'}).pid;

test('lock records pid/port/startedAt and release removes it',async()=>{
  const state=await temp();
  try{
    const lock=await acquireLock(state,{port:4321});
    const written=await readLock(state);
    assert.equal(written.pid,process.pid);
    assert.equal(written.port,4321);
    assert.match(written.startedAt,/^\d{4}-\d{2}-\d{2}T/);
    await lock.update({port:6789});
    assert.equal((await readLock(state)).port,6789);
    await lock.release();
    await assert.rejects(()=>readFile(join(state,'instance.lock')),error=>error.code==='ENOENT');
    await lock.release();
  }finally{await rm(state,{recursive:true,force:true});}
});

test('live owner raises ANOTHER_INSTANCE_RUNNING with pid/port details',async()=>{
  const state=await temp();
  try{
    await writeFile(join(state,'instance.lock'),JSON.stringify({pid:process.pid,port:7777,startedAt:new Date().toISOString()}),'utf8');
    let error;
    try{await acquireLock(state,{port:0});}catch(caught){error=caught;}
    assert.equal(error?.code,ANOTHER_INSTANCE_RUNNING);
    assert.equal(error.details.pid,process.pid);
    assert.equal(error.details.port,7777);
    assert.match(error.message,/pid \d+/);
    assert.equal((await readLock(state)).pid,process.pid);
  }finally{await rm(state,{recursive:true,force:true});}
});

test('dead or corrupt lock files are replaced instead of blocking startup',async()=>{
  const state=await temp();
  try{
    await writeFile(join(state,'instance.lock'),JSON.stringify({pid:deadPid(),port:1234,startedAt:new Date().toISOString()}),'utf8');
    const lock=await acquireLock(state,{port:5000});
    assert.equal((await readLock(state)).pid,process.pid);
    await lock.release();
    await writeFile(join(state,'instance.lock'),'not json','utf8');
    const replaced=await acquireLock(state,{port:5000});
    assert.equal((await readLock(state)).pid,process.pid);
    await replaced.release();
  }finally{await rm(state,{recursive:true,force:true});}
});

test('release never deletes a lock owned by a different live process',async()=>{
  const state=await temp();
  try{
    const lock=await acquireLock(state,{port:5000});
    const foreign={pid:process.pid,port:9999,startedAt:'2000-01-01T00:00:00.000Z'};
    await writeFile(join(state,'instance.lock'),JSON.stringify(foreign),'utf8');
    await lock.release();
    assert.equal((await readLock(state)).port,9999);
  }finally{await rm(state,{recursive:true,force:true});}
});

test('unusable lock path raises LOCK_UNAVAILABLE instead of a raw filesystem error',async()=>{
  const state=await temp();
  try{
    await mkdir(join(state,'instance.lock'),{recursive:true});
    await assert.rejects(
      ()=>acquireLock(state,{port:0}),
      error=>error.code===LOCK_UNAVAILABLE&&/LOCK_UNAVAILABLE/.test(error.message)&&/状态目录不可写|占用/.test(error.message),
    );
  }finally{await rm(state,{recursive:true,force:true});}
});
