/**
 * Epic-1 读侧：/devices 注册表 API 与 GET /snapshot?device= 远程快照。
 * 真实 createServer + 临时 stateDir + 注入 fake createRemoteEngine；不连真实 AstrBot、不碰真实 state/。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from '../src/server.mjs';
import {addDevice} from '../src/devices.mjs';

const TOKEN='device-token-do-not-leak';
const auth={Authorization:`Bearer ${TOKEN}`};
const jsonHeaders={...auth,'Content-Type':'application/json'};

async function fixture(run,{createRemoteEngine,remoteSnapshotTtlMs,writeEnabled=false,engineOverrides={}}={}){
  const dir=await mkdtemp(join(tmpdir(),'model-console-devices-'));
  const stateDir=join(dir,'state');
  const engine={
    writeEnabled,
    gateway:{efforts:async()=>['low']},
    snapshot:async()=>({writeEnabled,models:[],resources:[]}),
    plan:async(resource,changes)=>({id:'plan',resource,changes}),
    apply:async()=>({status:'saved-and-readback-verified'}),
    ...engineOverrides,
  };
  const server=createServer(engine,TOKEN,{staticRoot:dir,health:{stateDir,dataPath:join(dir,'data'),readOnly:!writeEnabled},createRemoteEngine,remoteSnapshotTtlMs});
  await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolveListen();});});
  try{
    await run({base:`http://127.0.0.1:${server.address().port}`,engine,stateDir,dir,server});
  }finally{
    await new Promise(resolveClose=>{server.close(resolveClose);server.closeAllConnections?.();});
    await server.flushDiagnostics();
    await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
}

/** Fake remote factory that records each created engine; each engine counts its own snapshot calls. */
function fakeRemoteFactory(overrides={}){
  const created=[];
  const factory=device=>{
    const engine={
      gateway:{health:async()=>({reachable:true,latencyMs:4})},
      snapshots:0,
      async snapshot(){engine.snapshots++;if(overrides.snapshot)return overrides.snapshot(device);return {writeEnabled:false,models:[{id:`model-${device.id}`}],resources:[],deviceIdSeen:device.id};},
      ...(overrides.engine??{}),
    };
    created.push({device,engine});
    return engine;
  };
  return {factory,created};
}

const codeError=(code,details)=>{const error=Error(code);error.code=code;if(details)error.details=details;return error;};

test('GET /devices requires the token and same-host origin, and lists the local device first',()=>fixture(async({base})=>{
  assert.equal((await fetch(base+'/devices')).status,403);
  assert.equal((await fetch(base+'/devices',{headers:{...auth,Origin:'https://evil.test'}})).status,403);
  const response=await fetch(base+'/devices',{headers:auth});
  assert.equal(response.status,200);
  const body=await response.json();
  assert.deepEqual(body,{devices:[{id:'local',name:'本机',kind:'local',readOnly:true,hasSecret:false}]});
}));

test('POST /devices stores the apiKey outside responses/devices.json; GET /devices never returns it',()=>fixture(async({base,stateDir})=>{
  const response=await fetch(base+'/devices',{method:'POST',headers:jsonHeaders,body:JSON.stringify({name:'书房主机',baseUrl:'http://192.168.1.20:6185',apiKey:'abk_SECRET_do_not_leak'})});
  assert.equal(response.status,200);
  const {device:created}=await response.json();
  assert.equal(created.name,'书房主机');
  assert.equal(created.kind,'http');
  assert.equal(created.readOnly,true);
  assert.equal(created.hasSecret,true);
  assert.equal(typeof created.id,'string');
  assert.equal('apiKey' in created,false);
  assert.doesNotMatch(JSON.stringify(created),/abk_SECRET|apiKey/);
  const list=await (await fetch(base+'/devices',{headers:auth})).json();
  assert.equal(list.devices.length,2);
  assert.equal(list.devices[0].id,'local');
  const remote=list.devices.find(device=>device.id===created.id);
  assert.equal(remote.baseUrl,'http://192.168.1.20:6185');
  assert.equal(remote.hasSecret,true);
  assert.doesNotMatch(JSON.stringify(list),/abk_SECRET|apiKey/);
  assert.doesNotMatch(await readFile(join(stateDir,'devices.json'),'utf8'),/abk_SECRET/);
  assert.match(await readFile(join(stateDir,'secrets.json'),'utf8'),/abk_SECRET_do_not_leak/);
}));

test('POST /devices maps DEVICE_INVALID / DEVICE_SECRET_REQUIRED to 400 without echoing the key',()=>fixture(async({base})=>{
  let response=await fetch(base+'/devices',{method:'POST',headers:jsonHeaders,body:JSON.stringify({name:'坏设备',baseUrl:'not-a-url',apiKey:'abk_SECRET_do_not_leak'})});
  assert.equal(response.status,400);
  assert.deepEqual(await response.json(),{error:'DEVICE_INVALID'});
  response=await fetch(base+'/devices',{method:'POST',headers:jsonHeaders,body:JSON.stringify({name:'无密钥',baseUrl:'http://127.0.0.1:6185'})});
  assert.equal(response.status,400);
  assert.deepEqual(await response.json(),{error:'DEVICE_SECRET_REQUIRED'});
  response=await fetch(base+'/devices',{method:'POST',headers:{...jsonHeaders,Origin:'https://evil.test'},body:JSON.stringify({name:'x',baseUrl:'http://127.0.0.1:1',apiKey:'abk_SECRET_do_not_leak'})});
  assert.equal(response.status,403);
  const list=await (await fetch(base+'/devices',{headers:auth})).json();
  assert.equal(list.devices.length,1);
}));

test('DELETE /devices/:id removes the device, rejects the local device and reports unknown ids',()=>fixture(async({base,stateDir})=>{
  const device=await addDevice(stateDir,{name:'remote',baseUrl:'http://127.0.0.1:9'},'abk_secret');
  let response=await fetch(`${base}/devices/${encodeURIComponent(device.id)}`,{method:'DELETE',headers:auth});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{removed:device.id});
  assert.equal((await (await fetch(base+'/devices',{headers:auth})).json()).devices.length,1);
  response=await fetch(`${base}/devices/${encodeURIComponent(device.id)}`,{method:'DELETE',headers:auth});
  assert.equal(response.status,404);
  assert.deepEqual(await response.json(),{error:'DEVICE_NOT_FOUND'});
  assert.equal((await fetch(base+'/devices/local',{method:'DELETE',headers:auth})).status,400);
  assert.equal((await fetch(base+'/devices/x',{method:'DELETE'})).status,403);
}));

test('GET /devices/:id/health: local reachable, remote uses adapter health, unknown is 404',async()=>{
  const {factory,created}=fakeRemoteFactory();
  await fixture(async({base,stateDir})=>{
    assert.equal((await fetch(base+'/devices/missing/health',{headers:auth})).status,404);
    const local=await (await fetch(base+'/devices/local/health',{headers:auth})).json();
    assert.deepEqual(local,{id:'local',name:'本机',kind:'local',readOnly:true,hasSecret:false,reachable:true});
    const device=await addDevice(stateDir,{id:'remote-health',name:'书房',baseUrl:'http://127.0.0.1:8'},'abk_secret');
    const remote=await (await fetch(`${base}/devices/${device.id}/health`,{headers:auth})).json();
    assert.equal(remote.id,'remote-health');
    assert.equal(remote.name,'书房');
    assert.equal(remote.kind,'http');
    assert.equal(remote.reachable,true);
    assert.equal(remote.latencyMs,4);
    assert.equal(created.length,1);
  },{createRemoteEngine:factory});
});

test('GET /snapshot is unchanged for local, and remote snapshots are cached per deviceId with a device tag',async()=>{
  const {factory,created}=fakeRemoteFactory();
  await fixture(async({base,stateDir})=>{
    const local=await (await fetch(base+'/snapshot',{headers:auth})).json();
    assert.deepEqual(local.device,{id:'local',name:'本机',kind:'local'});
    assert.equal(local.writeEnabled,false);
    const a=await addDevice(stateDir,{id:'remote-a',name:'A 主机',baseUrl:'http://127.0.0.1:7'},'abk_a');
    const b=await addDevice(stateDir,{id:'remote-b',name:'B 主机',baseUrl:'http://127.0.0.1:6'},'abk_b');
    const first=await (await fetch(base+'/snapshot?device=remote-a',{headers:auth})).json();
    assert.deepEqual(first.device,{id:'remote-a',name:'A 主机',kind:'http'});
    assert.equal(first.writeEnabled,false);
    assert.equal(first.models[0].id,'model-remote-a');
    assert.equal(created.length,1);
    assert.equal(created[0].engine.snapshots,1);
    // 5 秒内重复请求命中缓存：不重建引擎、不再快照。
    const second=await (await fetch(base+'/snapshot?device=remote-a',{headers:auth})).json();
    assert.deepEqual(second,first);
    assert.equal(created.length,1);
    assert.equal(created[0].engine.snapshots,1);
    // 不同 deviceId 隔离，各自建引擎、各自计数。
    const other=await (await fetch(base+`/snapshot?device=${encodeURIComponent(b.id)}`,{headers:auth})).json();
    assert.deepEqual(other.device,{id:'remote-b',name:'B 主机',kind:'http'});
    assert.equal(other.models[0].id,'model-remote-b');
    assert.equal(created.length,2);
    assert.equal(created[0].engine.snapshots,1);
    // 未知设备 404，不触达工厂。
    assert.equal((await fetch(base+'/snapshot?device=unknown',{headers:auth})).status,404);
    assert.equal((await fetch(base+`/snapshot?device=${encodeURIComponent(a.id)}`)).status,403);
  },{createRemoteEngine:factory});
});

test('remote snapshot cache expires after the configured TTL',async()=>{
  const {factory,created}=fakeRemoteFactory();
  await fixture(async({base,stateDir})=>{
    const device=await addDevice(stateDir,{id:'remote-ttl',name:'TTL',baseUrl:'http://127.0.0.1:5'},'abk_secret');
    await fetch(`${base}/snapshot?device=${device.id}`,{headers:auth});
    assert.equal(created[0].engine.snapshots,1);
    await new Promise(resolve=>setTimeout(resolve,45));
    await fetch(`${base}/snapshot?device=${device.id}`,{headers:auth});
    assert.equal(created[0].engine.snapshots,2);
    assert.equal(created.length,1);
  },{createRemoteEngine:factory,remoteSnapshotTtlMs:20});
});

test('remote snapshot errors map to 409 with whitelisted details and no paths/keys',async()=>{
  const createRemoteEngine=device=>{
    if(device.id==='auth')throw codeError('DEVICE_AUTH_FAILED',{path:'C:\\Users\\alice\\secret',token:'abk_DO_NOT_LEAK'});
    if(device.id==='forbidden')throw codeError('DEVICE_FORBIDDEN');
    return {gateway:{},snapshot:async()=>{throw codeError('DEVICE_UNREACHABLE',{backupId:'C:\\Users\\alice\\backups'});}};
  };
  await fixture(async({base,stateDir})=>{
    for(const [id,code] of [['auth','DEVICE_AUTH_FAILED'],['forbidden','DEVICE_FORBIDDEN'],['unreachable','DEVICE_UNREACHABLE']]){
      await addDevice(stateDir,{id,name:id,baseUrl:`http://127.0.0.1:${id.length}`},'abk_secret');
      const response=await fetch(`${base}/snapshot?device=${id}`,{headers:auth});
      assert.equal(response.status,409);
      assert.deepEqual(await response.json(),{error:code});
    }
    const serialized=JSON.stringify(await (await fetch(base+'/snapshot?device=auth',{headers:auth})).json());
    assert.doesNotMatch(serialized,/C:\\\\|alice|abk_DO_NOT_LEAK|secret/i);
  },{createRemoteEngine});
});

test('DELETE /devices/:id drops the cached remote session so a re-added device reconnects',async()=>{
  const {factory,created}=fakeRemoteFactory();
  await fixture(async({base,stateDir})=>{
    const device=await addDevice(stateDir,{id:'remote-cache',name:'缓存',baseUrl:'http://127.0.0.1:4'},'abk_secret');
    await fetch(`${base}/snapshot?device=${device.id}`,{headers:auth});
    assert.equal(created.length,1);
    assert.equal((await fetch(`${base}/devices/${device.id}`,{method:'DELETE',headers:auth})).status,200);
    assert.equal((await fetch(`${base}/snapshot?device=${device.id}`,{headers:auth})).status,404);
    await addDevice(stateDir,{id:'remote-cache',name:'缓存',baseUrl:'http://127.0.0.1:4'},'abk_secret');
    await fetch(`${base}/snapshot?device=${device.id}`,{headers:auth});
    assert.equal(created.length,2);
  },{createRemoteEngine:factory});
});

test('default factory uses HttpGatewayAdapter+Engine and maps a dead remote to 409 DEVICE_UNREACHABLE',()=>fixture(async({base,stateDir})=>{
  const device=await addDevice(stateDir,{id:'remote-dead',name:'离线',baseUrl:'http://127.0.0.1:1'},'abk_secret');
  const response=await fetch(`${base}/snapshot?device=${device.id}`,{headers:auth});
  assert.equal(response.status,409);
  assert.deepEqual(await response.json(),{error:'DEVICE_UNREACHABLE'});
}));

test('device routes never write the apiKey into the diagnostics journal',()=>fixture(async({base,stateDir,server})=>{
  const response=await fetch(base+'/devices',{method:'POST',headers:jsonHeaders,body:JSON.stringify({name:'诊断',baseUrl:'http://127.0.0.1:3',apiKey:'abk_DIAG_do_not_leak'})});
  assert.equal(response.status,200);
  assert.equal((await fetch(base+'/devices/nope/health',{headers:auth})).status,404);
  await server.flushDiagnostics();
  const journal=await readFile(join(stateDir,'diagnostics.jsonl'),'utf8');
  assert.match(journal,/DEVICE_NOT_FOUND/);
  assert.doesNotMatch(journal,/abk_DIAG|apiKey/i);
  assert.doesNotMatch(journal,/C:\\\\/);
}));
