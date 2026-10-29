import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  AGENT_INVALID_RESPONSE,
  AGENT_RATE_LIMITED,
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
