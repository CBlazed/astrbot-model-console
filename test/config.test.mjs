import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {resolveStateDir,ensureWritableStateDir,discoverAstrBotData,findLegacyState,ASTRBOT_DATA_REQUIRED,STATE_DIR_NOT_WRITABLE} from '../src/config.mjs';

const isDirectory=async path=>{try{return (await stat(path)).isDirectory();}catch{return false;}};
async function temp(){return mkdtemp(join(tmpdir(),'model-console-config-'));}

test('state directory defaults to LOCALAPPDATA and honors MODEL_CONSOLE_STATE',()=>{
  const local=join('C:','Users','someone','AppData','Local');
  assert.equal(resolveStateDir({LOCALAPPDATA:local}),join(local,'AstrBotModelConsole','state'));
  assert.equal(resolveStateDir({LOCALAPPDATA:local,MODEL_CONSOLE_STATE:join(local,'custom')}),resolve(join(local,'custom')));
  assert.equal(resolveStateDir({MODEL_CONSOLE_STATE:'relative-state'}),resolve('relative-state'));
  assert.equal(resolveStateDir({}),join(tmpdir(),'AstrBotModelConsole','state'));
});

test('ASTRBOT_DATA wins over discovery without scanning the filesystem',async()=>{
  const root=await temp();
  try{
    const data=join(root,'explicit-data');
    await mkdir(data,{recursive:true});
    const env={ASTRBOT_DATA:data,USERPROFILE:join(root,'missing-profile'),LOCALAPPDATA:join(root,'local')};
    assert.equal(await discoverAstrBotData(env),resolve(data));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('discovery finds one launcher instance or one classic data directory',async()=>{
  const root=await temp();
  try{
    const profile=join(root,'profile');
    const launcherData=join(profile,'.astrbot_launcher','instances','instance-a','core','data');
    await mkdir(launcherData,{recursive:true});
    assert.equal(await discoverAstrBotData({USERPROFILE:profile}),launcherData);
    const classic=join(profile,'.astrbot','data');
    await mkdir(classic,{recursive:true});
    let error;
    try{await discoverAstrBotData({USERPROFILE:profile});}catch(caught){error=caught;}
    assert.equal(error?.code,ASTRBOT_DATA_REQUIRED);
    assert.match(error.message,/发现 2 个/);
    assert.equal(error.candidates,2);
    await rm(join(profile,'.astrbot_launcher'),{recursive:true,force:true});
    assert.equal(await discoverAstrBotData({USERPROFILE:profile}),classic);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('discovery requires ASTRBOT_DATA when nothing or nothing unique is found',async()=>{
  const root=await temp();
  try{
    let error;
    try{await discoverAstrBotData({USERPROFILE:root});}catch(caught){error=caught;}
    assert.equal(error?.code,ASTRBOT_DATA_REQUIRED);
    assert.match(error.message,/ASTRBOT_DATA_REQUIRED/);
    assert.equal(error.candidates,0);
    assert.doesNotMatch(error.message,/secret|token|key/i);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('legacy ./state is reported once, never migrated or deleted',async()=>{
  const root=await temp();
  try{
    assert.equal(await findLegacyState(root),null);
    const legacy=join(root,'state');
    await mkdir(legacy,{recursive:true});
    const hint=await findLegacyState(root);
    assert.equal(typeof hint,'string');
    assert.match(hint,/MODEL_CONSOLE_STATE/);
    assert.ok(hint.includes(legacy));
    assert.equal(await isDirectory(legacy),true);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('writable default state dir is used as-is',async()=>{
  const root=await temp();
  try{
    const local=join(root,'local');
    await mkdir(local,{recursive:true});
    const resolved=await ensureWritableStateDir({LOCALAPPDATA:local},{cwd:join(root,'app')});
    assert.equal(resolved.dir,join(local,'AstrBotModelConsole','state'));
    assert.equal(resolved.fallback,false);
    assert.equal(await isDirectory(resolved.dir),true);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('unwritable default state dir falls back to <cwd>/state (portable state)',async()=>{
  const root=await temp();
  try{
    const local=join(root,'local');
    await mkdir(local,{recursive:true});
    // A file where the parent directory should be makes mkdir(<local>/AstrBotModelConsole/state) fail.
    await writeFile(join(local,'AstrBotModelConsole'),'blocked','utf8');
    const cwd=join(root,'app');
    await mkdir(cwd,{recursive:true});
    const resolved=await ensureWritableStateDir({LOCALAPPDATA:local},{cwd});
    assert.equal(resolved.dir,join(cwd,'state'));
    assert.equal(resolved.fallback,true);
    assert.equal(await isDirectory(resolved.dir),true);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('explicit MODEL_CONSOLE_STATE must be writable and never falls back silently',async()=>{
  const root=await temp();
  try{
    const blocked=join(root,'blocked');
    await writeFile(blocked,'file','utf8');
    await assert.rejects(
      ()=>ensureWritableStateDir({MODEL_CONSOLE_STATE:blocked},{cwd:join(root,'app')}),
      error=>error.code===STATE_DIR_NOT_WRITABLE&&/MODEL_CONSOLE_STATE/.test(error.message),
    );
  }finally{await rm(root,{recursive:true,force:true});}
});

test('no writable state dir reports STATE_DIR_NOT_WRITABLE with the tried paths',async()=>{
  const root=await temp();
  try{
    const local=join(root,'local');
    await mkdir(local,{recursive:true});
    await writeFile(join(local,'AstrBotModelConsole'),'blocked','utf8');
    const cwd=join(root,'blocked-cwd');
    await writeFile(cwd,'file','utf8');
    await assert.rejects(
      ()=>ensureWritableStateDir({LOCALAPPDATA:local},{cwd}),
      error=>error.code===STATE_DIR_NOT_WRITABLE&&/已尝试/.test(error.message)&&/MODEL_CONSOLE_STATE/.test(error.message),
    );
  }finally{await rm(root,{recursive:true,force:true});}
});
