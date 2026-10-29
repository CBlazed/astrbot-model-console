import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  AGENT_INVALID_RESPONSE,
  AGENT_RATE_LIMITED,
  AGENT_READ_ONLY,
  AGENT_TIMEOUT_MS,
  AGENT_UNAUTHORIZED,
  AGENT_UNREACHABLE,
  AgentAdapter,
  pairAgent,
} from '../src/agent-adapter.mjs';
import {startAgent} from '../src/agent.mjs';

const token64='a'.repeat(64);
const snapshot={readAt:'2026-10-29T00:00:00.000Z',writeEnabled:false,models:[],resources:[]};
const jsonResponse=(status,body)=>({ok:status>=200&&status<300,status,json:async()=>{if(body instanceof Error)throw body;return body;}});

async function rejectsWith(promise,code){
  await assert.rejects(promise,error=>{
    assert.equal(error.code,code);
    assert.equal(error.message,code);
    return true;
  });
}

test('pairAgent posts the pairing code and returns {token}',async()=>{
  const calls=[];
  const fetcher=async(url,options)=>{calls.push({url,options});return jsonResponse(200,{token:token64});};
  const result=await pairAgent({baseUrl:'http://127.0.0.1:6000/',pairingCode:'12345678',fetcher});
  assert.deepEqual(result,{token:token64});
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'http://127.0.0.1:6000/agent/v1/pair');
  assert.equal(calls[0].options.method,'POST');
  assert.equal(calls[0].options.headers['Content-Type'],'application/json');
  assert.equal(JSON.parse(calls[0].options.body).code,'12345678');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(AGENT_TIMEOUT_MS,10000);
});

test('AgentAdapter pairs, then sends the bearer token for snapshots but not for health',async()=>{
  const calls=[];
  const fetcher=async(url,options)=>{
    calls.push({url,options});
    if(url.endsWith('/agent/v1/health'))return jsonResponse(200,{status:'ok',version:'0.1.0'});
    if(url.endsWith('/agent/v1/pair'))return jsonResponse(200,{token:token64});
    return jsonResponse(200,snapshot);
  };
  const adapter=new AgentAdapter({baseUrl:'http://127.0.0.1:6000',fetcher});
  assert.deepEqual(await adapter.health(),{status:'ok',version:'0.1.0'});
  assert.equal(calls[0].options.headers.Authorization,undefined);
  assert.equal(await adapter.pair('12345678'),token64);
  assert.equal(adapter.token,token64);
  assert.deepEqual(await adapter.snapshot(),snapshot);
  assert.equal(calls.at(-1).options.headers.Authorization,`Bearer ${token64}`);
  await adapter.close();
  await adapter.close();
});

test('snapshot without a token fails locally as AGENT_UNAUTHORIZED',async()=>{
  let called=0;
  const adapter=new AgentAdapter({baseUrl:'http://127.0.0.1:6000',fetcher:async()=>{called++;return jsonResponse(200,snapshot);}});
  await rejectsWith(adapter.snapshot(),AGENT_UNAUTHORIZED);
  assert.equal(called,0);
  assert.equal(adapter.token,null);
});

test('HTTP failures map to the documented agent error codes',async()=>{
  const make=fetcher=>new AgentAdapter({baseUrl:'http://127.0.0.1:6000',token:token64,fetcher});
  await rejectsWith(make(async()=>{throw Error('ECONNREFUSED');}).snapshot(),AGENT_UNREACHABLE);
  await rejectsWith(make(async()=>jsonResponse(401,{error:'AGENT_UNAUTHORIZED'})).snapshot(),AGENT_UNAUTHORIZED);
  await rejectsWith(make(async()=>jsonResponse(429,{error:'AGENT_RATE_LIMITED'})).snapshot(),AGENT_RATE_LIMITED);
  await rejectsWith(make(async()=>jsonResponse(500,{error:'AGENT_SNAPSHOT_FAILED'})).snapshot(),AGENT_INVALID_RESPONSE);
  await rejectsWith(make(async()=>jsonResponse(200,Error('bad json'))).snapshot(),AGENT_INVALID_RESPONSE);
  await rejectsWith(make(async()=>jsonResponse(200,{status:'degraded',version:'0.1.0'})).health(),AGENT_INVALID_RESPONSE);
  await rejectsWith(make(async()=>jsonResponse(200,{token:'short'})).pair('12345678'),AGENT_INVALID_RESPONSE);
  await rejectsWith(make(async()=>jsonResponse(200,{token:token64})).pair(12345678),AGENT_INVALID_RESPONSE);
});

test('constructors reject malformed base URLs and keep a safe token',()=>{
  assert.throws(()=>new AgentAdapter({baseUrl:''}),error=>error.code==='AGENT_INVALID_BASE_URL');
  assert.throws(()=>new AgentAdapter({baseUrl:'ftp://127.0.0.1:1'}),error=>error.code==='AGENT_INVALID_BASE_URL');
  const adapter=new AgentAdapter({baseUrl:'http://127.0.0.1:6000/',token:'not-a-token'});
  assert.equal(adapter.baseUrl,'http://127.0.0.1:6000');
  assert.equal(adapter.token,null);
});

test('AgentAdapter and pairAgent work end-to-end against a real startAgent',async()=>{
  const root=await mkdtemp(join(tmpdir(),'model-console-agent-adapter-'));
  const stateDir=join(root,'state');
  const agent=await startAgent({stateDir,engine:{snapshot:async()=>snapshot}});
  const paired=new AgentAdapter({baseUrl:agent.url,timeoutMs:2000});
  try{
    const health=await paired.health();
    assert.equal(health.status,'ok');
    assert.equal(typeof health.version,'string');
    const {token}=await pairAgent({baseUrl:agent.url,pairingCode:agent.pairingCode});
    assert.match(token,/^[a-f0-9]{64}$/);
    const adapter=new AgentAdapter({baseUrl:agent.url,token});
    assert.deepEqual(await adapter.snapshot(),snapshot);
    const wrong=new AgentAdapter({baseUrl:agent.url,token:'0'.repeat(64)});
    await rejectsWith(wrong.snapshot(),AGENT_UNAUTHORIZED);
    await rejectsWith(pairAgent({baseUrl:agent.url,pairingCode:agent.pairingCode}),AGENT_UNAUTHORIZED);
    await adapter.close();
  }finally{
    await agent.close();
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
});

const planId='0f8fad5b-d9cb-469f-a165-70867728950e';
const writeHotLoad={verified:true,checked:true,marker:'配置已更新'};

test('adapter plan/apply/backups send the token and pass hotLoad through',async()=>{
  const planBody={id:planId,resource:{kind:'profile',id:'default'},changes:[{path:'x',value:'y'}],warning:'warn',expiresAt:'2026-10-29T22:10:00.000Z'};
  const applyBody={result:{status:'saved-and-readback-verified',id:planId},hotLoad:writeHotLoad};
  const backupsBody={backups:[{id:planId,bytes:1,files:1,sqlite:'ok'}],stats:{count:1,bytes:1},limits:{keep:10,maxBytes:1}};
  const calls=[];
  const fetcher=async(url,options)=>{
    calls.push({url,options});
    if(url.endsWith('/agent/v1/plans'))return jsonResponse(200,planBody);
    if(url.endsWith('/agent/v1/apply'))return jsonResponse(200,applyBody);
    if(url.endsWith('/agent/v1/backups'))return jsonResponse(200,backupsBody);
    throw Error(`unexpected ${url}`);
  };
  const adapter=new AgentAdapter({baseUrl:'http://127.0.0.1:6000',token:token64,fetcher});
  assert.deepEqual(await adapter.plan({resource:{kind:'profile',id:'default'},changes:[{path:'x',value:'y'}],expectedRevision:'rev-1'}),planBody);
  assert.equal(calls[0].options.method,'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body),{resource:{kind:'profile',id:'default'},changes:[{path:'x',value:'y'}],expectedRevision:'rev-1'});
  assert.equal(calls[0].options.headers.Authorization,`Bearer ${token64}`);
  const applied=await adapter.apply(planId);
  assert.deepEqual(applied,applyBody);
  assert.equal(applied.hotLoad.verified,true);
  assert.deepEqual(await adapter.backups(),backupsBody);
  assert.ok(calls.every(call=>call.options.headers.Authorization===`Bearer ${token64}`));
});

test('read-only agents surface AGENT_READ_ONLY for plan/apply/backups',async()=>{
  const fetcher=async()=>jsonResponse(403,{error:'AGENT_READ_ONLY'});
  const adapter=new AgentAdapter({baseUrl:'http://127.0.0.1:6000',token:token64,fetcher});
  await rejectsWith(adapter.plan({resource:{kind:'profile',id:'default'},changes:[]}),AGENT_READ_ONLY);
  await rejectsWith(adapter.apply(planId),AGENT_READ_ONLY);
  await rejectsWith(adapter.backups(),AGENT_READ_ONLY);
});

test('write-side 409 errors relay the agent code and whitelisted details',async()=>{
  const fetcher=async()=>jsonResponse(409,{error:'CONCURRENT_CHANGE',id:planId,details:{id:planId,outcome:'not-written'},token:'abc'});
  const adapter=new AgentAdapter({baseUrl:'http://127.0.0.1:6000',token:token64,fetcher});
  await assert.rejects(adapter.apply(planId),error=>{
    assert.equal(error.code,'CONCURRENT_CHANGE');
    assert.equal(error.status,409);
    assert.deepEqual(error.details,{id:planId,outcome:'not-written'});
    return true;
  });
  const broken=async()=>jsonResponse(200,{result:null,hotLoad:null});
  await rejectsWith(new AgentAdapter({baseUrl:'http://127.0.0.1:6000',token:token64,fetcher:broken}).apply(planId),AGENT_INVALID_RESPONSE);
  const malformed=async()=>jsonResponse(200,{backups:'nope',stats:null,limits:null});
  await rejectsWith(new AgentAdapter({baseUrl:'http://127.0.0.1:6000',token:token64,fetcher:malformed}).backups(),AGENT_INVALID_RESPONSE);
});

test('adapter write path works end-to-end and a read-only agent is reported as such',async()=>{
  const root=await mkdtemp(join(tmpdir(),'model-console-agent-adapter-write-'));
  const stateDir=join(root,'state');
  const dataDir=join(root,'data');
  await mkdir(dataDir,{recursive:true});
  const engine={
    snapshot:async()=>({...snapshot,writeEnabled:true}),
    plan:async(resource,changes)=>({id:planId,resource,changes,warning:'warn',expiresAt:'2026-10-29T22:10:00.000Z'}),
    apply:async id=>({status:'saved-and-readback-verified',id}),
    listBackups:async()=>[],
    backupStats:async()=>({count:0,bytes:0}),
  };
  const writable=await startAgent({stateDir,dataDir,writeEnabled:true,engine});
  const readonly=await startAgent({stateDir:join(root,'readonly-state'),dataDir,writeEnabled:false,engine:{snapshot:async()=>snapshot}});
  try{
    const paired=new AgentAdapter({baseUrl:writable.url,timeoutMs:2000});
    await paired.pair(writable.pairingCode);
    const plan=await paired.plan({resource:{kind:'profile',id:'default'},changes:[{path:'x',value:'y'}]});
    assert.equal(plan.id,planId);
    const applied=await paired.apply(planId);
    assert.equal(applied.result.status,'saved-and-readback-verified');
    assert.equal(applied.hotLoad.checked,true);
    assert.equal(applied.hotLoad.verified,false);
    const backups=await paired.backups();
    assert.deepEqual(backups,{backups:[],stats:{count:0,bytes:0},limits:{keep:10,maxBytes:2048*1024*1024}});
    const readOnlyAdapter=new AgentAdapter({baseUrl:readonly.url,timeoutMs:2000});
    await readOnlyAdapter.pair(readonly.pairingCode);
    await rejectsWith(readOnlyAdapter.apply(planId),AGENT_READ_ONLY);
    await rejectsWith(readOnlyAdapter.backups(),AGENT_READ_ONLY);
    await paired.close();
    await readOnlyAdapter.close();
  }finally{
    await writable.close();
    await readonly.close();
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
});
