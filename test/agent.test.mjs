import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PAIRING_TTL_MS,main,startAgent} from '../src/agent.mjs';
import {Engine} from '../src/engine.mjs';

const sleep=ms=>new Promise(resolveSleep=>setTimeout(resolveSleep,ms));
const sha256=value=>createHash('sha256').update(value,'utf8').digest('hex');
const snapshot={readAt:'2026-10-29T00:00:00.000Z',writeEnabled:false,models:[],resources:[]};
const fakeEngine={snapshot:async()=>snapshot};

const pair=(base,code)=>fetch(`${base}/agent/v1/pair`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});

async function withAgent(options,run){
  const root=await mkdtemp(join(tmpdir(),'model-console-agent-'));
  const stateDir=join(root,'state');
  const engine=options.engine??fakeEngine;
  const agent=await startAgent({stateDir,engine,...options});
  try{return await run({agent,engine,base:agent.url,stateDir,root});}
  finally{await agent.close();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
}

test('health is public, minimal and the listener is loopback-only',()=>withAgent({},async({base,agent})=>{
  assert.equal(agent.server.address().address,'127.0.0.1');
  const response=await fetch(`${base}/agent/v1/health`);
  assert.equal(response.status,200);
  const body=await response.json();
  assert.deepEqual(Object.keys(body).sort(),['status','version']);
  assert.equal(body.status,'ok');
  const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(body.version,pkg.version);
  assert.equal((await fetch(`${base}/agent/v1/nope`)).status,404);
  assert.equal((await fetch(`${base}/agent/v1/snapshot`)).status,401);
}));

test('state file keeps only hashes; pairing issues one 64-hex token and burns the code',()=>withAgent({},async({base,stateDir,agent})=>{
  assert.match(agent.pairingCode,/^\d{8}$/);
  assert.equal(Date.parse(agent.expiresAt)-Date.now()>PAIRING_TTL_MS-60000,true);
  const beforeText=await readFile(join(stateDir,'agent.json'),'utf8');
  const before=JSON.parse(beforeText);
  assert.equal(before.tokenHash,null);
  assert.equal(before.pairing.hash,sha256(agent.pairingCode));
  assert.equal(before.pairing.expiresAt,agent.expiresAt);
  assert.doesNotMatch(beforeText,new RegExp(agent.pairingCode));

  const response=await pair(base,agent.pairingCode);
  assert.equal(response.status,200);
  const {token}=await response.json();
  assert.match(token,/^[a-f0-9]{64}$/i);

  const afterText=await readFile(join(stateDir,'agent.json'),'utf8');
  const after=JSON.parse(afterText);
  assert.equal(after.tokenHash,sha256(token));
  assert.equal(after.pairing,null);
  assert.doesNotMatch(afterText,new RegExp(token));
  assert.doesNotMatch(afterText,new RegExp(agent.pairingCode));

  const authorized=await fetch(`${base}/agent/v1/snapshot`,{headers:{Authorization:`Bearer ${token}`}});
  assert.equal(authorized.status,200);
  assert.deepEqual(await authorized.json(),snapshot);

  const replay=await pair(base,agent.pairingCode);
  assert.equal(replay.status,401);
  assert.deepEqual(await replay.json(),{error:'AGENT_UNAUTHORIZED'});
  assert.equal((await fetch(`${base}/agent/v1/snapshot`,{headers:{Authorization:`Bearer ${'0'.repeat(64)}`}})).status,401);
}));

test('pair rejects wrong codes and malformed requests',()=>withAgent({},async({base,agent})=>{
  const wrong=String((Number(agent.pairingCode)+1)%100000000).padStart(8,'0');
  const rejected=await pair(base,wrong);
  assert.equal(rejected.status,401);
  assert.deepEqual(await rejected.json(),{error:'AGENT_UNAUTHORIZED'});
  assert.equal((await fetch(`${base}/agent/v1/pair`,{method:'POST',headers:{'Content-Type':'application/json'},body:'not json'})).status,400);
  assert.equal((await fetch(`${base}/agent/v1/pair`,{method:'POST',body:'{}'})).status,415);
  assert.equal((await fetch(`${base}/agent/v1/pair`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,400);
  assert.equal((await pair(base,agent.pairingCode)).status,200);
}));

test('five failed pairing attempts per window are rate limited, then recover',()=>withAgent({},async({base,agent})=>{
  const wrong=String((Number(agent.pairingCode)+1)%100000000).padStart(8,'0');
  for(let attempt=0;attempt<5;attempt++){
    const response=await pair(base,wrong);
    assert.equal(response.status,401,`attempt ${attempt+1}`);
  }
  const limited=await pair(base,agent.pairingCode);
  assert.equal(limited.status,429);
  assert.deepEqual(await limited.json(),{error:'AGENT_RATE_LIMITED'});
}));

test('the pairing rate limit window expires',()=>withAgent({pairFailLimit:2,pairFailWindowMs:80},async({base,agent})=>{
  const wrong=String((Number(agent.pairingCode)+1)%100000000).padStart(8,'0');
  assert.equal((await pair(base,wrong)).status,401);
  assert.equal((await pair(base,wrong)).status,401);
  assert.equal((await pair(base,agent.pairingCode)).status,429);
  await sleep(130);
  assert.equal((await pair(base,agent.pairingCode)).status,200);
}));

test('an expired pairing code is rejected while health keeps working',()=>withAgent({pairingTtlMs:40},async({base,agent})=>{
  await sleep(90);
  assert.equal((await pair(base,agent.pairingCode)).status,401);
  assert.equal((await fetch(`${base}/agent/v1/health`)).status,200);
}));

test('the device token survives an agent restart while the code is regenerated',async()=>{
  const root=await mkdtemp(join(tmpdir(),'model-console-agent-'));
  const stateDir=join(root,'state');
  let agent;
  try{
    agent=await startAgent({stateDir,engine:fakeEngine});
    const firstCode=agent.pairingCode;
    const token=(await (await pair(agent.url,firstCode)).json()).token;
    await agent.close();

    agent=await startAgent({stateDir,engine:fakeEngine});
    assert.notEqual(agent.pairingCode,'');
    const persisted=JSON.parse(await readFile(join(stateDir,'agent.json'),'utf8'));
    assert.equal(persisted.tokenHash,sha256(token));
    assert.equal(persisted.pairing.hash,sha256(agent.pairingCode));
    assert.notEqual(agent.pairingCode,firstCode);
    const authorized=await fetch(`${agent.url}/agent/v1/snapshot`,{headers:{Authorization:`Bearer ${token}`}});
    assert.equal(authorized.status,200);
    assert.deepEqual(await authorized.json(),snapshot);
    const oldCode=await fetch(`${agent.url}/agent/v1/pair`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:firstCode})});
    assert.equal(oldCode.status,401);
  }finally{
    if(agent)await agent.close();
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
});

test('without an injected engine the agent serves a real Engine and reports snapshot failure',async()=>{
  const root=await mkdtemp(join(tmpdir(),'model-console-agent-'));
  const stateDir=join(root,'state');
  const dataDir=join(root,'data');
  await mkdir(join(dataDir,'config'),{recursive:true});
  await writeFile(join(dataDir,'cmd_config.json'),'{}','utf8');
  const agent=await startAgent({stateDir,dataDir});
  try{
    assert.equal((await fetch(`${agent.url}/agent/v1/health`)).status,200);
    const paired=await pair(agent.url,agent.pairingCode);
    assert.equal(paired.status,200);
    const token=(await paired.json()).token;
    const snapshotResponse=await fetch(`${agent.url}/agent/v1/snapshot`,{headers:{Authorization:`Bearer ${token}`}});
    assert.equal(snapshotResponse.status,500);
    assert.deepEqual(await snapshotResponse.json(),{error:'AGENT_SNAPSHOT_FAILED'});
  }finally{
    await agent.close();
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
});

test('CLI refuses to start when AstrBot data cannot be discovered',async()=>{
  const root=await mkdtemp(join(tmpdir(),'model-console-agent-cli-'));
  const originalError=console.error;
  const logged=[];
  console.error=(...args)=>logged.push(args.join(' '));
  const savedExit=process.exitCode;
  try{
    const result=await main({env:{LOCALAPPDATA:root,USERPROFILE:join(root,'profile')},argv:[]});
    assert.equal(result,null);
    assert.equal(process.exitCode,1);
    assert.ok(logged.some(line=>line.includes('ASTRBOT_DATA_REQUIRED')));
  }finally{
    console.error=originalError;
    process.exitCode=savedExit;
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
});

test('CLI starts on 127.0.0.1 and prints url, pairingCode and expiresAt',async()=>{
  const root=await mkdtemp(join(tmpdir(),'model-console-agent-cli-'));
  const state=join(root,'state');
  const data=join(root,'data');
  await mkdir(join(data,'config'),{recursive:true});
  await writeFile(join(data,'cmd_config.json'),'{}','utf8');
  const originalLog=console.log;
  const printed=[];
  console.log=(...args)=>printed.push(args.join(' '));
  const savedExit=process.exitCode;
  let agent;
  try{
    agent=await main({env:{ASTRBOT_DATA:data,MODEL_CONSOLE_STATE:state,USERPROFILE:join(root,'profile'),LOCALAPPDATA:root},argv:['--port=0']});
    assert.ok(agent);
    assert.equal(process.exitCode,savedExit);
    const line=JSON.parse(printed.at(-1));
    assert.deepEqual(Object.keys(line).sort(),['expiresAt','pairingCode','url']);
    assert.match(line.url,/^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(line.pairingCode,/^\d{8}$/);
    assert.match(line.expiresAt,/^\d{4}-\d{2}-\d{2}T/);
    assert.equal((await fetch(`${line.url}/agent/v1/health`)).status,200);
  }finally{
    console.log=originalLog;
    process.exitCode=savedExit;
    if(agent)await agent.close();
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
});

const planId='0f8fad5b-d9cb-469f-a165-70867728950e';
const backupUuid='0f8fad5b-d9cb-469f-a165-70867728950e';

async function pairedToken(base,agent){
  const response=await pair(base,agent.pairingCode);
  assert.equal(response.status,200);
  return (await response.json()).token;
}

function jsonRequest(base,path,{method='GET',token,body}={}){
  const headers={};
  if(token)headers.Authorization=`Bearer ${token}`;
  if(body!==undefined)headers['Content-Type']='application/json';
  return fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
}

/** Fake Engine for write-side tests: records calls, lets tests override failures. */
function fakeWriteEngine(){
  const calls=[];
  const engine={
    calls,
    snapshot:async()=>({...snapshot,writeEnabled:true}),
    plan:async(resource,changes,_internal,expectedRevision)=>{calls.push(['plan',resource,changes,expectedRevision]);return {id:planId,resource,revision:'rev-1',changes,warning:'warn',expiresAt:'2026-10-29T22:10:00.000Z',impact:'this profile'};},
    apply:async id=>{calls.push(['apply',id]);return {status:'saved-and-readback-verified',id};},
    listBackups:async()=>{calls.push(['listBackups']);return [{id:backupUuid,createdAt:'2026-10-29T10:00:00.000Z',bytes:10,files:2,sqlite:'ok'}];},
    backupStats:async()=>{calls.push(['backupStats']);return {count:1,bytes:10,items:[{id:backupUuid}]};},
  };
  return engine;
}

test('write endpoints are 403 AGENT_READ_ONLY on a read-only agent and 401 without a token',()=>withAgent({},async({base,agent})=>{
  const token=await pairedToken(base,agent);
  const calls=[
    ['POST','/agent/v1/plans',{resource:{kind:'profile',id:'default'},changes:[{path:'x',value:'y'}]}],
    ['POST','/agent/v1/apply',{id:planId}],
    ['GET','/agent/v1/backups',undefined],
  ];
  for(const [method,path,body] of calls){
    const response=await jsonRequest(base,path,{method,token,body});
    assert.equal(response.status,403,path);
    assert.deepEqual(await response.json(),{error:'AGENT_READ_ONLY'},path);
  }
  for(const [method,path,body] of calls){
    const response=await jsonRequest(base,path,{method,body});
    assert.equal(response.status,401,path);
    assert.deepEqual(await response.json(),{error:'AGENT_UNAUTHORIZED'},path);
  }
}));

test('write mode plans, applies and verifies readback with a real Engine',async()=>{
  const root=await mkdtemp(join(tmpdir(),'model-console-agent-write-'));
  const stateDir=join(root,'state');
  const dataDir=join(root,'data');
  await mkdir(join(dataDir,'config'),{recursive:true});
  await writeFile(join(dataDir,'cmd_config.json'),'{}','utf8');
  let current={agent_runner:{config:{model:{provider_id:'a'}}},provider:[{id:'a',type:'openai_chat_completion'},{id:'b',type:'openai_chat_completion'}]};
  let writes=0;
  const gateway={read:async()=>structuredClone(current),write:async(_resource,next)=>{writes++;current=structuredClone(next);},resources:async()=>[],efforts:async()=>['low']};
  const engine=new Engine({gateway,writeEnabled:true,backup:async()=>`/tmp/backups/${backupUuid}`});
  const agent=await startAgent({stateDir,dataDir,writeEnabled:true,engine});
  try{
    const token=await pairedToken(agent.url,agent);
    const planResponse=await jsonRequest(agent.url,'/agent/v1/plans',{method:'POST',token,body:{resource:{kind:'profile',id:'default'},changes:[{path:'agent_runner.config.model.provider_id',value:'b'}]}});
    assert.equal(planResponse.status,200);
    const plan=await planResponse.json();
    assert.match(plan.id,/^[0-9a-f-]{36}$/);
    assert.deepEqual(plan.changes,[{path:'agent_runner.config.model.provider_id',value:'b'}]);
    assert.ok(plan.warning);
    const applyResponse=await jsonRequest(agent.url,'/agent/v1/apply',{method:'POST',token,body:{id:plan.id}});
    assert.equal(applyResponse.status,200);
    const applied=await applyResponse.json();
    assert.equal(applied.result.status,'saved-and-readback-verified');
    assert.equal(applied.result.id,plan.id);
    assert.equal(writes,1);
    assert.equal(current.agent_runner.config.model.provider_id,'b');
    const snapshotResponse=await jsonRequest(agent.url,'/agent/v1/snapshot',{token});
    assert.equal(snapshotResponse.status,200);
    assert.equal((await snapshotResponse.json()).writeEnabled,true);
    assert.equal(typeof applied.hotLoad,'object');
    assert.equal(applied.hotLoad.checked,true);
    assert.equal(applied.hotLoad.verified,false);
    const replay=await jsonRequest(agent.url,'/agent/v1/apply',{method:'POST',token,body:{id:plan.id}});
    assert.equal(replay.status,409);
    assert.equal((await replay.json()).error,'PLAN_EXPIRED');
  }finally{
    await agent.close();
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
});

test('hotLoad evidence reports missing-log, miss and hit from the AstrBot log tail',async()=>{
  const root=await mkdtemp(join(tmpdir(),'model-console-agent-hotload-'));
  const stateDir=join(root,'state');
  const dataDir=join(root,'data');
  await mkdir(dataDir,{recursive:true});
  const engine=fakeWriteEngine();
  const agent=await startAgent({stateDir,dataDir,writeEnabled:true,engine});
  const logPath=join(dataDir,'logs','astrbot.log');
  const applyOnce=async token=>{
    const response=await jsonRequest(agent.url,'/agent/v1/apply',{method:'POST',token,body:{id:planId}});
    assert.equal(response.status,200);
    return (await response.json()).hotLoad;
  };
  try{
    const token=await pairedToken(agent.url,agent);
    const missing=await applyOnce(token);
    assert.equal(missing.checked,true);
    assert.equal(missing.verified,false);
    assert.match(missing.note,/无法读取/);

    await mkdir(join(dataDir,'logs'),{recursive:true});
    await writeFile(logPath,'[INFO] started\n[INFO] http server ready\n','utf8');
    const miss=await applyOnce(token);
    assert.equal(miss.checked,true);
    assert.equal(miss.verified,false);
    assert.match(miss.note,/未发现/);
    assert.equal('marker' in miss,false);

    await writeFile(logPath,'[INFO] started\n[INFO] 配置已更新，热重载完成\n','utf8');
    const hit=await applyOnce(token);
    assert.equal(hit.verified,true);
    assert.equal(hit.checked,true);
    assert.match(hit.marker,/热重载/);
  }finally{
    await agent.close();
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
});

test('GET /agent/v1/backups returns contract fields and environment limits',()=>withAgent({writeEnabled:true,engine:fakeWriteEngine(),env:{...process.env,MODEL_CONSOLE_BACKUP_KEEP:'4',MODEL_CONSOLE_BACKUP_MAX_MB:'16'}},async({base,agent})=>{
  const token=await pairedToken(base,agent);
  const response=await jsonRequest(base,'/agent/v1/backups',{token});
  assert.equal(response.status,200);
  const body=await response.json();
  assert.deepEqual(body.backups,[{id:backupUuid,createdAt:'2026-10-29T10:00:00.000Z',bytes:10,files:2,sqlite:'ok'}]);
  assert.deepEqual(body.stats,{count:1,bytes:10});
  assert.deepEqual(body.limits,{keep:4,maxBytes:16*1024*1024});
  assert.doesNotMatch(JSON.stringify(body),/items|AstrBotModelConsole/);
}));

test('plan/apply engine errors are 409 with whitelisted details only',()=>withAgent({writeEnabled:true,engine:fakeWriteEngine()},async({base,agent,engine})=>{
  const token=await pairedToken(base,agent);
  const failure=Error('CONCURRENT_CHANGE');
  failure.details={id:planId,backupId:'/abs/backups/0f8fad5b',token:'abc',path:'C:\\Users\\someone\\state',code:'CONCURRENT_CHANGE'};
  engine.apply=async()=>{throw failure;};
  const response=await jsonRequest(base,'/agent/v1/apply',{method:'POST',token,body:{id:planId}});
  assert.equal(response.status,409);
  const body=await response.json();
  assert.deepEqual(body,{error:'CONCURRENT_CHANGE',id:planId,code:'CONCURRENT_CHANGE'});
  assert.doesNotMatch(JSON.stringify(body),/[A-Za-z]:\\\\|abs\/backups|someone|abc/);
  engine.plan=async()=>{throw Error('INVALID_PLAN');};
  const planResponse=await jsonRequest(base,'/agent/v1/plans',{method:'POST',token,body:{resource:{kind:'profile',id:'default'},changes:[]}});
  assert.equal(planResponse.status,409);
  assert.deepEqual(await planResponse.json(),{error:'INVALID_PLAN'});
}));

test('a write-enabled agent without an injected engine wires the real backup listing',async()=>{
  const root=await mkdtemp(join(tmpdir(),'model-console-agent-backups-'));
  const stateDir=join(root,'state');
  const dataDir=join(root,'data');
  await mkdir(join(dataDir,'config'),{recursive:true});
  await writeFile(join(dataDir,'cmd_config.json'),'{}','utf8');
  const agent=await startAgent({stateDir,dataDir,writeEnabled:true});
  try{
    const token=await pairedToken(agent.url,agent);
    const response=await jsonRequest(agent.url,'/agent/v1/backups',{token});
    assert.equal(response.status,200);
    const body=await response.json();
    assert.deepEqual(body.backups,[]);
    assert.deepEqual(body.stats,{count:0,bytes:0});
    assert.deepEqual(body.limits,{keep:10,maxBytes:2048*1024*1024});
  }finally{
    await agent.close();
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
});
