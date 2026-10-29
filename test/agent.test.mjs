import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PAIRING_TTL_MS,main,startAgent} from '../src/agent.mjs';

const sleep=ms=>new Promise(resolveSleep=>setTimeout(resolveSleep,ms));
const sha256=value=>createHash('sha256').update(value,'utf8').digest('hex');
const snapshot={readAt:'2026-10-29T00:00:00.000Z',writeEnabled:false,models:[],resources:[]};
const fakeEngine={snapshot:async()=>snapshot};

const pair=(base,code)=>fetch(`${base}/agent/v1/pair`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});

async function withAgent(options,run){
  const root=await mkdtemp(join(tmpdir(),'model-console-agent-'));
  const stateDir=join(root,'state');
  const agent=await startAgent({stateDir,engine:fakeEngine,...options});
  try{return await run({agent,base:agent.url,stateDir,root});}
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
