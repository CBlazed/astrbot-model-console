/**
 * Epic-1/Epic-2 读侧：/devices 注册表 API + GET /snapshot?device= 远程快照（http/ssh/agent）。
 * 真实 createServer + 临时 stateDir + 注入 fake 工厂；不连真实 AstrBot/ssh/agent，不碰真实 state/。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from '../src/server.mjs';
import {addDevice} from '../src/devices.mjs';

const TOKEN='device-token-do-not-leak';
const auth={Authorization:`Bearer ${TOKEN}`};
const jsonHeaders={...auth,'Content-Type':'application/json'};
const codeError=(code,details)=>{const error=Error(code);error.code=code;if(details)error.details=details;return error;};

async function fixture(run,options={}){
  const dir=await mkdtemp(join(tmpdir(),'model-console-devices-'));
  const stateDir=join(dir,'state');
  const writeEnabled=options.writeEnabled===true;
  const engine={
    writeEnabled,
    gateway:{efforts:async()=>['low']},
    snapshot:async()=>({writeEnabled,models:[],resources:[],configVersion:null}),
    plan:async(resource,changes)=>({id:'plan',resource,changes}),
    apply:async()=>({status:'saved-and-readback-verified'}),
    ...(options.engineOverrides??{}),
  };
  const server=createServer(engine,TOKEN,{
    staticRoot:dir,
    health:{stateDir,dataPath:join(dir,'data'),readOnly:!writeEnabled},
    createRemoteEngine:options.createRemoteEngine,
    createSshTunnel:options.createSshTunnel,
    pairAgentDevice:options.pairAgentDevice,
    createAgentAdapter:options.createAgentAdapter,
    createHttpGateway:options.createHttpGateway,
    remoteSnapshotTtlMs:options.remoteSnapshotTtlMs,
    diagnosticsLimitPerMinute:options.diagnosticsLimitPerMinute,
  });
  await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolveListen();});});
  try{
    await run({base:`http://127.0.0.1:${server.address().port}`,engine,stateDir,dir,server});
  }finally{
    await new Promise(resolveClose=>{server.close(resolveClose);server.closeAllConnections?.();});
    await server.flushDiagnostics();
    await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
}

/** Fake remote factory that records created engines; each engine counts its own snapshot calls. */
function fakeRemoteFactory(overrides={}){
  const created=[];
  const factory=device=>{
    const engine={
      gateway:{health:async()=>({reachable:true,latencyMs:4})},
      snapshots:0,
      async snapshot(){engine.snapshots++;if(overrides.snapshot)return overrides.snapshot(device);return {writeEnabled:true,models:[{id:`model-${device.id}`}],resources:[],deviceIdSeen:device.id};},
      ...(overrides.engine??{}),
    };
    created.push({device,engine});
    return engine;
  };
  return {factory,created};
}

/** Gateway stub good enough for the real Engine used by the http/ssh branches. */
function fakeGateway(){
  return {
    calls:[],
    read:async resource=>resource.kind==='profile'?{provider:[],config_version:2}:{},
    resources:async()=>[],
    efforts:async()=>[],
  };
}

test('GET /devices requires the token and same-host origin, and lists the local device first',()=>fixture(async({base})=>{
  assert.equal((await fetch(base+'/devices')).status,403);
  assert.equal((await fetch(base+'/devices',{headers:{...auth,Origin:'https://evil.test'}})).status,403);
  const body=await (await fetch(base+'/devices',{headers:auth})).json();
  assert.deepEqual(body,{devices:[{id:'local',name:'本机',kind:'local',readOnly:true,hasSecret:false}]});
}));

test('POST /devices stores the apiKey outside responses/devices.json; GET /devices never returns it',()=>fixture(async({base,stateDir})=>{
  const response=await fetch(base+'/devices',{method:'POST',headers:jsonHeaders,body:JSON.stringify({name:'书房主机',baseUrl:'http://192.168.1.20:6185',apiKey:'abk_SECRET_do_not_leak'})});
  assert.equal(response.status,200);
  const {device:created}=await response.json();
  assert.equal(created.kind,'http');
  assert.equal(created.hasSecret,true);
  assert.equal('apiKey' in created,false);
  assert.doesNotMatch(JSON.stringify(created),/abk_SECRET|apiKey/);
  const list=await (await fetch(base+'/devices',{headers:auth})).json();
  assert.equal(list.devices.length,2);
  assert.equal(list.devices[0].id,'local');
  assert.doesNotMatch(JSON.stringify(list),/abk_SECRET|apiKey/);
  assert.doesNotMatch(await readFile(join(stateDir,'devices.json'),'utf8'),/abk_SECRET/);
  const storedSecrets=JSON.parse(await readFile(join(stateDir,'secrets.json'),'utf8'));
  const storedKey=storedSecrets.secrets?.[created.id];
  assert.ok(typeof storedKey==='string'&&storedKey.length>0,'secrets.json 必须保存设备凭据');
  if(storedKey.startsWith('dpapi:'))assert.match(storedKey,/^dpapi:[A-Za-z0-9+/=]+$/,'DPAPI 密文格式');
  else assert.equal(storedKey,'abk_SECRET_do_not_leak','仅 DPAPI 不可用时允许降级明文');
  assert.doesNotMatch(JSON.stringify(await (await fetch(base+'/devices',{headers:auth})).json()),/abk_SECRET_do_not_leak/);
  const journal=await readFile(join(stateDir,'diagnostics.jsonl'),'utf8').catch(()=>'');
  assert.doesNotMatch(journal,/abk_SECRET_do_not_leak/,'诊断不得包含密钥');
}));

test('POST /devices maps validation errors and duplicates: 400 invalid/secret, 409 same kind+baseUrl',()=>fixture(async({base})=>{
  let response=await fetch(base+'/devices',{method:'POST',headers:jsonHeaders,body:JSON.stringify({name:'坏设备',baseUrl:'not-a-url',apiKey:'abk_SECRET_do_not_leak'})});
  assert.equal(response.status,400);
  assert.deepEqual(await response.json(),{error:'DEVICE_INVALID'});
  response=await fetch(base+'/devices',{method:'POST',headers:jsonHeaders,body:JSON.stringify({name:'无密钥',baseUrl:'http://127.0.0.1:6185'})});
  assert.equal(response.status,400);
  assert.deepEqual(await response.json(),{error:'DEVICE_SECRET_REQUIRED'});
  const first=await fetch(base+'/devices',{method:'POST',headers:jsonHeaders,body:JSON.stringify({name:'A',baseUrl:'http://127.0.0.1:6185',apiKey:'abk_one'})});
  assert.equal(first.status,200);
  // 规范化 baseUrl：尾斜杠差异仍视为同一设备。
  response=await fetch(base+'/devices',{method:'POST',headers:jsonHeaders,body:JSON.stringify({name:'A2',baseUrl:'http://127.0.0.1:6185/',apiKey:'abk_two'})});
  assert.equal(response.status,409);
  assert.deepEqual(await response.json(),{error:'DEVICE_EXISTS'});
  response=await fetch(base+'/devices',{method:'POST',headers:{...jsonHeaders,Origin:'https://evil.test'},body:JSON.stringify({name:'x',baseUrl:'http://127.0.0.1:1',apiKey:'abk_SECRET_do_not_leak'})});
  assert.equal(response.status,403);
  assert.equal((await (await fetch(base+'/devices',{headers:auth})).json()).devices.length,2);
}));

test('POST /devices ssh needs host/user and keeps keyPath/dataPath out of public views',()=>fixture(async({base,stateDir})=>{
  let response=await fetch(base+'/devices',{method:'POST',headers:jsonHeaders,body:JSON.stringify({name:'云主机',kind:'ssh',baseUrl:'http://127.0.0.1:6185',ssh:{host:'',user:'root'},apiKey:'abk_ssh'})});
  assert.equal(response.status,400);
  assert.deepEqual(await response.json(),{error:'DEVICE_INVALID'});
  response=await fetch(base+'/devices',{method:'POST',headers:jsonHeaders,body:JSON.stringify({name:'云主机',kind:'ssh',baseUrl:'http://127.0.0.1:6185',ssh:{host:'10.0.0.2',user:'root',keyPath:'C:\\keys\\id_ed25519',dataPath:'C:\\AstrBot\\data'}})});
  assert.equal(response.status,400);
  assert.deepEqual(await response.json(),{error:'DEVICE_SECRET_REQUIRED'});
  response=await fetch(base+'/devices',{method:'POST',headers:jsonHeaders,body:JSON.stringify({name:'云主机',kind:'ssh',baseUrl:'http://127.0.0.1:6185',ssh:{host:'10.0.0.2',user:'root',keyPath:'C:\\keys\\id_ed25519',dataPath:'C:\\AstrBot\\data'},apiKey:'abk_ssh'})});
  assert.equal(response.status,200);
  const {device}=await response.json();
  assert.equal(device.kind,'ssh');
  assert.deepEqual(device.ssh,{host:'10.0.0.2',user:'root'});
  assert.doesNotMatch(JSON.stringify(device),/keys\\\\id_ed25519|AstrBot\\\\data|abk_ssh/);
  const registry=await readFile(join(stateDir,'devices.json'),'utf8');
  assert.match(registry,/keys\\\\id_ed25519/,'devices.json 仍保留内部 ssh 配置供连接使用');
  assert.doesNotMatch(registry,/abk_ssh/);
}));

test('ssh snapshot uses the injected tunnel, forces read-only, tags the device and closes the tunnel on DELETE',()=>{
  const opened=[],closed=[],gateways=[];
  const options={
    createSshTunnel:async device=>{opened.push(device);return {baseUrl:'http://127.0.0.1:4567',close:async()=>{closed.push(device.id);}};},
    createHttpGateway:(device,{baseUrl,apiKey})=>{gateways.push({deviceId:device.id,baseUrl,apiKey});return fakeGateway();},
  };
  return fixture(async({base})=>{
    const created=await (await fetch(base+'/devices',{method:'POST',headers:jsonHeaders,body:JSON.stringify({name:'云主机',kind:'ssh',baseUrl:'http://127.0.0.1:6185',ssh:{host:'10.0.0.2',user:'root',dataPath:'C:\\AstrBot\\data'},apiKey:'abk_ssh'})})).json();
    const id=created.device.id;
    const response=await fetch(`${base}/snapshot?device=${encodeURIComponent(id)}`,{headers:auth});
    assert.equal(response.status,200);
    const snapshot=await response.json();
    assert.equal(snapshot.writeEnabled,false);
    assert.equal(snapshot.configVersion,2);
    assert.deepEqual(snapshot.device,{id,name:'云主机',kind:'ssh'});
    assert.equal(opened.length,1);
    assert.equal(opened[0].ssh.dataPath,'C:\\AstrBot\\data');
    assert.equal(gateways.length,1);
    assert.equal(gateways[0].baseUrl,'http://127.0.0.1:4567');
    assert.equal(gateways[0].apiKey,'abk_ssh');
    // 5 秒缓存：同一设备第二次快照不会新建隧道/网关。
    await fetch(`${base}/snapshot?device=${encodeURIComponent(id)}`,{headers:auth});
    assert.equal(opened.length,1);
    assert.equal(gateways.length,1);
    const removed=await fetch(`${base}/devices/${encodeURIComponent(id)}`,{method:'DELETE',headers:auth});
    assert.equal(removed.status,200);
    assert.deepEqual(await removed.json(),{removed:true});
    assert.deepEqual(closed,[id]);
  },options);
});

test('ssh failures map to stable 409 codes (port discovery / unavailable tunnel)',()=>{
  const options={createSshTunnel:async device=>{if(device.ssh.host==='bad')throw codeError('DEVICE_PORT_UNKNOWN');throw codeError('DEVICE_SSH_FAILED');}};
  return fixture(async({base,stateDir})=>{
    const bad=await addDevice(stateDir,{id:'ssh-bad',name:'bad',kind:'ssh',baseUrl:'http://127.0.0.1:1',ssh:{host:'bad',user:'root'}},'abk_ssh');
    let response=await fetch(`${base}/snapshot?device=${bad.id}`,{headers:auth});
    assert.equal(response.status,409);
    assert.deepEqual(await response.json(),{error:'DEVICE_PORT_UNKNOWN'});
    const broken=await addDevice(stateDir,{id:'ssh-broken',name:'broken',kind:'ssh',baseUrl:'http://127.0.0.1:2',ssh:{host:'ok',user:'root'}},'abk_ssh');
    response=await fetch(`${base}/snapshot?device=${broken.id}`,{headers:auth});
    assert.equal(response.status,409);
    assert.deepEqual(await response.json(),{error:'DEVICE_SSH_FAILED'});
  },options);
});

test('agent devices pair on POST, reuse a cached adapter snapshot read-only, and drop it on DELETE',()=>{
  const paired=[],adapters=[];
  const options={
    pairAgentDevice:async(device,pairingCode)=>{paired.push({device,pairingCode});return {token:'a'.repeat(64)};},
    createAgentAdapter:(device,token)=>{const adapter={snapshots:0,closed:false,async snapshot(){adapter.snapshots++;return {writeEnabled:true,models:[{id:'agent-model'}],resources:[],configVersion:null};},async health(){return {reachable:true,latencyMs:9,extra:'drop-me'};},async close(){adapter.closed=true;}};adapters.push({device,token,adapter});return adapter;},
  };
  return fixture(async({base,stateDir})=>{
    let response=await fetch(base+'/devices',{method:'POST',headers:jsonHeaders,body:JSON.stringify({name:'Agent',kind:'agent',baseUrl:'http://127.0.0.1:9100'})});
    assert.equal(response.status,400);
    assert.deepEqual(await response.json(),{error:'DEVICE_SECRET_REQUIRED'});
    assert.equal(paired.length,0);
    response=await fetch(base+'/devices',{method:'POST',headers:jsonHeaders,body:JSON.stringify({name:'Agent',kind:'agent',baseUrl:'http://127.0.0.1:9100',pairingCode:'12345678'})});
    assert.equal(response.status,200);
    const {device}=await response.json();
    assert.equal(device.kind,'agent');
    assert.equal(device.hasSecret,true);
    assert.equal('pairingCode' in device,false);
    assert.doesNotMatch(JSON.stringify(device),/12345678|a{64}|token/i);
    assert.equal(paired.length,1);
    assert.equal(paired[0].pairingCode,'12345678');
    assert.equal(paired[0].device.baseUrl,'http://127.0.0.1:9100');
    const agentSecrets=JSON.parse(await readFile(join(stateDir,'secrets.json'),'utf8'));
    const storedToken=agentSecrets.secrets?.[device.id];
    assert.ok(typeof storedToken==='string'&&storedToken.length>0,'secrets.json 必须保存 agent token');
    if(storedToken.startsWith('dpapi:'))assert.match(storedToken,/^dpapi:[A-Za-z0-9+/=]+$/,'DPAPI 密文格式');
    else assert.equal(storedToken,'a'.repeat(64),'仅 DPAPI 不可用时允许降级明文');
    const journal=await readFile(join(stateDir,'diagnostics.jsonl'),'utf8').catch(()=>'');
    assert.doesNotMatch(journal,/a{64}/,'诊断不得包含 token');
    const registry=await readFile(join(stateDir,'devices.json'),'utf8');
    assert.equal(registry.includes('12345678')||registry.includes('a'.repeat(64)),false);
    const snapshot=await (await fetch(`${base}/snapshot?device=${encodeURIComponent(device.id)}`,{headers:auth})).json();
    assert.equal(snapshot.writeEnabled,false,'远程快照必须强制只读');
    assert.equal(snapshot.device.kind,'agent');
    assert.equal(snapshot.models[0].id,'agent-model');
    await fetch(`${base}/snapshot?device=${encodeURIComponent(device.id)}`,{headers:auth});
    assert.equal(adapters[0].adapter.snapshots,1,'5 秒缓存内只读一次');
    const health=await (await fetch(`${base}/devices/${encodeURIComponent(device.id)}/health`,{headers:auth})).json();
    assert.deepEqual(health,{reachable:true,latencyMs:9});
    const removed=await fetch(`${base}/devices/${encodeURIComponent(device.id)}`,{method:'DELETE',headers:auth});
    assert.deepEqual(await removed.json(),{removed:true});
    assert.equal(adapters[0].adapter.closed,true);
  },options);
});

test('GET /devices/:id/health returns only reachable/latencyMs/error; unknown is 404',()=>{
  const {factory}=fakeRemoteFactory();
  return fixture(async({base,stateDir})=>{
    assert.equal((await fetch(base+'/devices/missing/health',{headers:auth})).status,404);
    assert.deepEqual(await (await fetch(base+'/devices/local/health',{headers:auth})).json(),{reachable:true});
    const device=await addDevice(stateDir,{id:'remote-health',name:'书房',baseUrl:'http://127.0.0.1:8'},'abk_secret');
    const remote=await (await fetch(`${base}/devices/${device.id}/health`,{headers:auth})).json();
    assert.deepEqual(remote,{reachable:true,latencyMs:4});
  },{createRemoteEngine:factory});
});

test('GET /snapshot is unchanged for local, and remote snapshots are cached per deviceId with a device tag',()=>{
  const {factory,created}=fakeRemoteFactory();
  return fixture(async({base,stateDir})=>{
    const local=await (await fetch(base+'/snapshot',{headers:auth})).json();
    assert.deepEqual(local.device,{id:'local',name:'本机',kind:'local'});
    assert.equal(local.writeEnabled,false);
    const a=await addDevice(stateDir,{id:'remote-a',name:'A 主机',baseUrl:'http://127.0.0.1:7'},'abk_a');
    const b=await addDevice(stateDir,{id:'remote-b',name:'B 主机',baseUrl:'http://127.0.0.1:6'},'abk_b');
    const first=await (await fetch(base+'/snapshot?device=remote-a',{headers:auth})).json();
    assert.deepEqual(first.device,{id:'remote-a',name:'A 主机',kind:'http'});
    assert.equal(first.writeEnabled,false,'远程快照必须强制只读');
    assert.equal(created.length,1);
    assert.equal(created[0].engine.snapshots,1);
    await fetch(base+'/snapshot?device=remote-a',{headers:auth});
    assert.equal(created.length,1);
    assert.equal(created[0].engine.snapshots,1);
    const other=await (await fetch(base+`/snapshot?device=${encodeURIComponent(b.id)}`,{headers:auth})).json();
    assert.deepEqual(other.device,{id:'remote-b',name:'B 主机',kind:'http'});
    assert.equal(created.length,2);
    assert.equal((await fetch(base+'/snapshot?device=unknown',{headers:auth})).status,404);
    assert.equal((await fetch(base+`/snapshot?device=${encodeURIComponent(a.id)}`)).status,403);
  },{createRemoteEngine:factory});
});

test('remote snapshot cache expires after the configured TTL',()=>{
  const {factory,created}=fakeRemoteFactory();
  return fixture(async({base,stateDir})=>{
    const device=await addDevice(stateDir,{id:'remote-ttl',name:'TTL',baseUrl:'http://127.0.0.1:5'},'abk_secret');
    await fetch(`${base}/snapshot?device=${device.id}`,{headers:auth});
    assert.equal(created[0].engine.snapshots,1);
    await new Promise(resolve=>setTimeout(resolve,45));
    await fetch(`${base}/snapshot?device=${device.id}`,{headers:auth});
    assert.equal(created[0].engine.snapshots,2);
    assert.equal(created.length,1);
  },{createRemoteEngine:factory,remoteSnapshotTtlMs:20});
});

test('remote snapshot errors map to 409 with whitelisted details and no paths/keys',()=>{
  const createRemoteEngine=device=>{
    if(device.id==='auth')throw codeError('DEVICE_AUTH_FAILED',{path:'C:\\Users\\alice\\secret',token:'abk_DO_NOT_LEAK'});
    if(device.id==='forbidden')throw codeError('DEVICE_FORBIDDEN');
    return {gateway:{},snapshot:async()=>{throw codeError('DEVICE_UNREACHABLE',{backupId:'C:\\Users\\alice\\backups'});}};
  };
  return fixture(async({base,stateDir})=>{
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

test('DELETE /devices/:id drops the cached remote session so a re-added device reconnects',()=>{
  const {factory,created}=fakeRemoteFactory();
  return fixture(async({base,stateDir})=>{
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

test('device routes never write the apiKey/pairing code into the diagnostics journal',()=>fixture(async({base,stateDir,server})=>{
  const response=await fetch(base+'/devices',{method:'POST',headers:jsonHeaders,body:JSON.stringify({name:'诊断',baseUrl:'http://127.0.0.1:3',apiKey:'abk_DIAG_do_not_leak'})});
  assert.equal(response.status,200);
  assert.equal((await fetch(base+'/devices/nope/health',{headers:auth})).status,404);
  await server.flushDiagnostics();
  const journal=await readFile(join(stateDir,'diagnostics.jsonl'),'utf8');
  assert.match(journal,/DEVICE_NOT_FOUND/);
  assert.doesNotMatch(journal,/abk_DIAG|apiKey|pairingCode/i);
}));

const WRITE_PLAN_ID='0f8fad5b-d9cb-469f-a165-70867728950e';
const WRITE_BACKUP_ID='0243f684-e8ed-44ac-8c95-657df32890aa';
const BACKSLASH=String.fromCharCode(92);
/** Fake AgentAdapter used for Hub remote-write routes (plan/apply/backups). */
function writableAgentAdapter(options={}){
  const adapter={
    calls:[],
    closed:false,
    snapshots:0,
    async snapshot(){adapter.snapshots++;return {writeEnabled:options.snapshotWriteEnabled!==false,models:[],resources:[],configVersion:null};},
    async health(){return {reachable:true,latencyMs:2};},
    async plan(payload){adapter.calls.push(['plan',payload]);if(payload?.resource?.id==='readonly')throw codeError('AGENT_READ_ONLY');return {id:WRITE_PLAN_ID,resource:payload.resource,changes:payload.changes,expiresAt:'2026-10-29T12:00:00.000Z',impact:'this profile',warning:'no cross-resource atomicity'};},
    async apply(id){adapter.calls.push(['apply',id]);return {result:{status:'saved-and-readback-verified',id,backupId:['C:','Users','alice','backups',WRITE_BACKUP_ID].join(BACKSLASH),generationVerified:false},hotLoad:{verified:true,checked:true,marker:'reload at '+['C:','secret','path'].join(BACKSLASH),note:'hot reload detected'}};},
    async backups(){adapter.calls.push(['backups']);return {backups:[{id:WRITE_BACKUP_ID,createdAt:'2026-10-29T10:00:00.000Z',bytes:100,files:8,sqlite:'ok',internal:'drop-me'}],stats:{count:1,bytes:100,items:[{internal:true}]},limits:{keep:5,maxBytes:1024}};},
    async close(){adapter.closed=true;},
  };
  return adapter;
}

test('POST /devices keeps remote writes only for agent devices; http/ssh readOnly is forced true',()=>{
  const adapters=[];
  const options={
    pairAgentDevice:async()=>({token:'a'.repeat(64)}),
    createAgentAdapter:(device,token)=>{const adapter=writableAgentAdapter();adapters.push({device,token,adapter});return adapter;},
  };
  return fixture(async({base})=>{
    const create=async body=>{const response=await fetch(base+'/devices',{method:'POST',headers:jsonHeaders,body:JSON.stringify(body)});assert.equal(response.status,200,JSON.stringify(body));return (await response.json()).device;};
    const http=await create({name:'http',baseUrl:'http://127.0.0.1:6200',apiKey:'abk_http',readOnly:false});
    assert.equal(http.readOnly,true,'http 设备必须强制只读');
    const ssh=await create({name:'ssh',kind:'ssh',baseUrl:'http://127.0.0.1:6201',ssh:{host:'10.0.0.2',user:'root'},apiKey:'abk_ssh',readOnly:false});
    assert.equal(ssh.readOnly,true,'ssh 设备必须强制只读');
    const agent=await create({name:'agent',kind:'agent',baseUrl:'http://127.0.0.1:6202',pairingCode:'12345678',readOnly:false});
    assert.equal(agent.readOnly,false,'agent 设备允许 readOnly:false');
    const agentDefault=await create({name:'agent-default',kind:'agent',baseUrl:'http://127.0.0.1:6203',pairingCode:'12345678'});
    assert.equal(agentDefault.readOnly,true,'agent 默认仍只读');
  },options);
});

test('writable agent routes: snapshot flag, plan/apply/backups proxies, permissions and error mapping',()=>{
  const adapters=[];
  const options={
    pairAgentDevice:async()=>({token:'a'.repeat(64)}),
    createAgentAdapter:device=>{const adapter=writableAgentAdapter({snapshotWriteEnabled:device.baseUrl.endsWith('6202')});adapters.push({device,adapter});return adapter;},
  };
  return fixture(async({base,stateDir})=>{
    const create=async body=>{const response=await fetch(base+'/devices',{method:'POST',headers:jsonHeaders,body:JSON.stringify(body)});assert.equal(response.status,200,JSON.stringify(body));return (await response.json()).device;};
    const writable=await create({name:'可写 agent',kind:'agent',baseUrl:'http://127.0.0.1:6202',pairingCode:'12345678',readOnly:false});
    const readOnly=await create({name:'只读 agent',kind:'agent',baseUrl:'http://127.0.0.1:6204',pairingCode:'12345678',readOnly:true});
    const agentButReadOnlyServer=await create({name:'agent 端只读',kind:'agent',baseUrl:'http://127.0.0.1:6205',pairingCode:'12345678',readOnly:false});
    const http=await create({name:'http',baseUrl:'http://127.0.0.1:6200',apiKey:'abk_http'});
    const ssh=await create({name:'ssh',kind:'ssh',baseUrl:'http://127.0.0.1:6201',ssh:{host:'10.0.0.2',user:'root'},apiKey:'abk_ssh'});

    // 快照写标志：设备可写 + Agent 可写 → true；设备只读或 Agent 只读 → false；http 恒 false。
    const writableSnapshot=await (await fetch(`${base}/snapshot?device=${writable.id}`,{headers:auth})).json();
    assert.equal(writableSnapshot.writeEnabled,true);
    assert.equal(writableSnapshot.device.kind,'agent');
    assert.equal((await (await fetch(`${base}/snapshot?device=${readOnly.id}`,{headers:auth})).json()).writeEnabled,false);
    assert.equal((await (await fetch(`${base}/snapshot?device=${agentButReadOnlyServer.id}`,{headers:auth})).json()).writeEnabled,false,'Agent 自身只读时 Hub 不得放开写');

    const headers={...auth,'Content-Type':'application/json'};
    const planPayload={resource:{kind:'profile',id:'default'},changes:[{path:'agent_runner.config.model.provider_id',value:'a'}],expectedRevision:'rev-1'};
    let response=await fetch(`${base}/plans?device=${writable.id}`,{method:'POST',headers,body:JSON.stringify(planPayload)});
    assert.equal(response.status,200);
    let body=await response.json();
    assert.equal(body.id,WRITE_PLAN_ID);
    assert.deepEqual(body.changes,[{path:'agent_runner.config.model.provider_id',before:null,value:'a',capability:null}]);
    assert.equal(body.warning,'no cross-resource atomicity');
    const adapter=adapters.find(entry=>entry.device.id===writable.id).adapter;
    assert.deepEqual(adapter.calls.find(call=>call[0]==='plan'),['plan',{resource:planPayload.resource,changes:planPayload.changes,expectedRevision:'rev-1'}]);

    response=await fetch(`${base}/apply?device=${writable.id}`,{method:'POST',headers,body:JSON.stringify({id:WRITE_PLAN_ID})});
    assert.equal(response.status,200);
    body=await response.json();
    assert.equal(body.status,'saved-and-readback-verified');
    assert.equal(body.id,WRITE_PLAN_ID);
    assert.equal(body.backupId,WRITE_BACKUP_ID,'远程 apply 的 backupId 只能是 UUID basename');
    assert.deepEqual(body.hotLoad,{verified:true,checked:true,marker:'reload at [path]',note:'hot reload detected'});
    assert.doesNotMatch(JSON.stringify(body),/C:\\|alice|secret/);
    assert.deepEqual(adapter.calls.find(call=>call[0]==='apply'),['apply',WRITE_PLAN_ID]);

    response=await fetch(`${base}/backups?device=${writable.id}`,{headers:auth});
    assert.equal(response.status,200);
    body=await response.json();
    assert.deepEqual(body,{backups:[{id:WRITE_BACKUP_ID,createdAt:'2026-10-29T10:00:00.000Z',bytes:100,files:8,sqlite:'ok'}],stats:{count:1,bytes:100},limits:{keep:5,maxBytes:1024}});
    assert.doesNotMatch(JSON.stringify(body),/internal|drop-me/);
    // 只读 agent 也可查看远程备份（是否开放由 Agent 决定）。
    assert.equal((await fetch(`${base}/backups?device=${readOnly.id}`,{headers:auth})).status,200);

    // 权限：http/ssh 与只读 agent 一律 403 DEVICE_READ_ONLY。
    for(const device of [http,ssh,readOnly]){
      for(const [path,payload] of [['/plans',planPayload],['/apply',{id:WRITE_PLAN_ID}]]){
        response=await fetch(`${base}${path}?device=${device.id}`,{method:'POST',headers,body:JSON.stringify(payload)});
        assert.equal(response.status,403,`${path} ${device.kind}`);
        assert.deepEqual(await response.json(),{error:'DEVICE_READ_ONLY'});
      }
    }
    for(const device of [http,ssh]){
      response=await fetch(`${base}/backups?device=${device.id}`,{headers:auth});
      assert.equal(response.status,403,device.kind);
      assert.deepEqual(await response.json(),{error:'DEVICE_READ_ONLY'});
    }
    // 未知设备：写路由与远程备份都 404。
    for(const path of [`/plans?device=${'missing'}`,`/apply?device=${'missing'}`,`/backups?device=${'missing'}`]){
      response=path.includes('/backups')?await fetch(base+path,{headers:auth}):await fetch(base+path,{method:'POST',headers,body:JSON.stringify(planPayload)});
      assert.equal(response.status,404,path);
      assert.deepEqual(await response.json(),{error:'DEVICE_NOT_FOUND'});
    }
    // 错误映射：Agent 403 → Hub 403 AGENT_READ_ONLY；Agent 不可达 → 409 AGENT_UNREACHABLE。
    response=await fetch(
`${base}/plans?device=${writable.id}`,{method:'POST',headers,body:JSON.stringify({...planPayload,resource:{kind:'profile',id:'readonly'}})});
    assert.equal(response.status,403);
    assert.deepEqual(await response.json(),{error:'AGENT_READ_ONLY'});
    adapter.apply=async()=>{throw codeError('AGENT_UNREACHABLE');};
    response=await fetch(`${base}/apply?device=${writable.id}`,{method:'POST',headers,body:JSON.stringify({id:WRITE_PLAN_ID})});
    assert.equal(response.status,409);
    assert.deepEqual(await response.json(),{error:'AGENT_UNREACHABLE'});
    // 密钥不泄露：响应里没有设备 token/apiKey。
    assert.doesNotMatch(JSON.stringify(body),/a{64}|abk_/);
  },options);
});
