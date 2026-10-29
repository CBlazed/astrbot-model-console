import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer,start,trustedRequest} from '../src/server.mjs';
import {Engine,revision} from '../src/engine.mjs';
async function fixture(run){const dir=await mkdtemp(join(tmpdir(),'model-console-http-'));await writeFile(join(dir,'index.html'),'<h1>Model Console</h1>');await writeFile(join(dir,'app.mjs'),'export const ui=true;');let applies=0;const engine={gateway:{efforts:async id=>id==='known'?['low','max']:null},snapshot:async()=>({writeEnabled:false,models:[]}),plan:async(resource,changes,_internal,expectedRevision)=>({resource,changes,expectedRevision}),apply:async()=>{applies++;return {status:'saved-and-readback-verified'};}};const server=createServer(engine,'secret',{staticRoot:dir});await new Promise(r=>server.listen(0,'127.0.0.1',r));try{await run({base:`http://127.0.0.1:${server.address().port}`,engine,get applies(){return applies;}});}finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}}
const auth={Authorization:'Bearer secret'};
test('static UI is credential-free, CSP protected and same-host only',()=>fixture(async({base})=>{const page=await fetch(base+'/');assert.equal(page.status,200);assert.match(await page.text(),/Model Console/);assert.match(page.headers.get('content-security-policy'),/script-src 'self'/);assert.equal(page.headers.get('referrer-policy'),'no-referrer');assert.equal((await fetch(base+'/',{headers:{Origin:'https://evil.test'}})).status,403);assert.equal(trustedRequest({headers:{host:'evil.test'}},Number(new URL(base).port)),false);assert.equal((await fetch(base+'/app.mjs')).status,200);}));
test('static whitelist denies code, backups, traversal and API reads without token',()=>fixture(async({base})=>{for(const path of ['/snapshot','/capabilities?provider_id=known','/src/server.mjs','/state/backups/a','/%2e%2e%2fREADME.md'])assert.equal((await fetch(base+path)).status,403);assert.equal((await fetch(base+'/src/server.mjs',{headers:auth})).status,404);}));
test('capability API authenticates, verifies and never fabricates unknown levels',()=>fixture(async({base})=>{let r=await fetch(base+'/capabilities?provider_id=known',{headers:auth});assert.deepEqual(await r.json(),{levels:['low','max'],verified:true});r=await fetch(base+'/capabilities?provider_id=unknown',{headers:auth});assert.deepEqual(await r.json(),{levels:[],verified:false});assert.equal((await fetch(base+'/capabilities',{headers:auth})).status,400);}));
test('JSON plan validates body and passes expectedRevision without writing',()=>fixture(async(f)=>{const headers={...auth,'Content-Type':'application/json'};assert.equal((await fetch(f.base+'/plans',{method:'POST',headers,body:'null'})).status,400);const data={resource:{kind:'profile',id:'a'},changes:[{path:'x',value:'y'}],expectedRevision:'abc'};const response=await fetch(f.base+'/plans',{method:'POST',headers,body:JSON.stringify(data)});assert.equal((await response.json()).expectedRevision,'abc');assert.equal(f.applies,0);assert.equal((await fetch(f.base+'/apply',{method:'POST',headers:{...headers,Origin:'https://evil.test'},body:'{"id":"x"}'})).status,403);assert.equal(f.applies,0);}));
test('HTTP request rejects oversized bodies and raw capability errors',()=>fixture(async({base,engine})=>{assert.equal((await fetch(base+'/plans',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({x:'a'.repeat(66000)})})).status,413);engine.gateway.efforts=async()=>{throw Error('secret=DO_NOT_EXPOSE');};const r=await fetch(base+'/capabilities?provider_id=known',{headers:auth});assert.equal(r.status,409);assert.deepEqual(await r.json(),{error:'OPERATION_FAILED'});}));
test('plan rejects stale snapshot revisions before creating a plan',async()=>{const config={agent_runner:{config:{model:{provider_id:'a'}}},provider:[{id:'a',type:'openai_chat_completion'}]};const engine=new Engine({gateway:{read:async()=>config},backup:async()=>{}});await assert.rejects(()=>engine.plan({kind:'profile',id:'default'},[{path:'agent_runner.config.model.provider_id',value:'a'}],false,'stale'),/CONCURRENT_CHANGE/);assert.equal(engine.plans.size,0);const p=await engine.plan({kind:'profile',id:'default'},[{path:'agent_runner.config.model.provider_id',value:'a'}],false,revision(config));assert.ok(p.id);});

const planId='0f8fad5b-d9cb-469f-a165-70867728950e';
test('409 error details are whitelisted and absolute backup paths never leave the server',()=>fixture(async({base,engine})=>{
  const secretRoot=join(tmpdir(),'model-console-secret-path');
  const error=Error('BACKUP_FAILED');
  error.details={id:planId,backupId:join(secretRoot,planId),outcome:'not-written',code:'BACKUP_FAILED',path:`C:\\Users\\someone\\${planId}`,token:'abc',authorization:'Bearer secret'};
  engine.apply=async()=>{throw error;};
  const response=await fetch(base+'/apply',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({id:planId})});
  assert.equal(response.status,409);
  const body=await response.json();
  assert.deepEqual(body,{error:'BACKUP_FAILED',id:planId,outcome:'not-written',code:'BACKUP_FAILED'});
  const text=JSON.stringify(body);
  assert.doesNotMatch(text,/C:\\\\|AppData|model-console-secret-path|Bearer|secret/);
  assert.ok(Object.keys(body).every(key=>['error','id','backupId','outcome','code'].includes(key)));
}));

test('409 accepts a UUID short backup id but rejects path-like or oversized values',()=>fixture(async({base,engine})=>{
  const valid=Error('WRITE_FAILED');
  valid.details={id:planId,backupId:'a1b2c3d4',outcome:'possibly-written'};
  engine.apply=async()=>{throw valid;};
  let response=await fetch(base+'/apply',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({id:planId})});
  assert.deepEqual(await response.json(),{error:'WRITE_FAILED',id:planId,backupId:'a1b2c3d4',outcome:'possibly-written'});
  const rejected=Error('WRITE_FAILED');
  rejected.details={id:'not-a-plan-id',backupId:'/var/backups/0f8fad5b',outcome:'../escape',code:'lower-case'};
  engine.apply=async()=>{throw rejected;};
  response=await fetch(base+'/apply',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({id:planId})});
  assert.deepEqual(await response.json(),{error:'WRITE_FAILED'});
}));

test('apply success exposes only the UUID backup directory name, never an absolute path',()=>fixture(async({base,engine})=>{
  const uuid='0f8fad5b-d9cb-469f-a165-70867728950e';
  engine.apply=async()=>({status:'saved-and-readback-verified',id:planId,backupId:join(tmpdir(),'some-user','backups',uuid),generationVerified:false});
  let response=await fetch(base+'/apply',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({id:planId})});
  assert.equal(response.status,200);
  let body=await response.json();
  assert.equal(body.backupId,uuid);
  assert.doesNotMatch(JSON.stringify(body),/some-user|backups/);
  engine.apply=async()=>({status:'saved-and-readback-verified',id:planId,backupId:`C:\\Users\\someone\\backups\\not-a-uuid`,generationVerified:false});
  response=await fetch(base+'/apply',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify({id:planId})});
  body=await response.json();
  assert.equal('backupId' in body,false);
  assert.doesNotMatch(JSON.stringify(body),/C:\\\\|someone/);
}));

test('start reports ANOTHER_INSTANCE_RUNNING readably and exits without touching data',async()=>{const root=await mkdtemp(join(tmpdir(),'model-console-start-'));const state=join(root,'state');const savedExit=process.exitCode;const originalError=console.error;const logged=[];console.error=(...args)=>logged.push(args.join(' '));try{await mkdir(state,{recursive:true});await writeFile(join(state,'instance.lock'),JSON.stringify({pid:process.pid,port:4321,startedAt:new Date().toISOString()}),'utf8');const server=await start({env:{LOCALAPPDATA:root,MODEL_CONSOLE_STATE:state,USERPROFILE:join(root,'profile')},cwd:root,argv:[]});assert.equal(server,null);assert.equal(process.exitCode,1);assert.ok(logged.some(line=>line.includes('ANOTHER_INSTANCE_RUNNING')));assert.ok(logged.some(line=>line.includes('4321')));}finally{console.error=originalError;process.exitCode=savedExit;await rm(root,{recursive:true,force:true});}});

test('start reports missing AstrBot data as ASTRBOT_DATA_REQUIRED and releases its lock',async()=>{const root=await mkdtemp(join(tmpdir(),'model-console-start-'));const state=join(root,'state');const savedExit=process.exitCode;const originalError=console.error;const logged=[];console.error=(...args)=>logged.push(args.join(' '));try{const server=await start({env:{LOCALAPPDATA:root,MODEL_CONSOLE_STATE:state,USERPROFILE:join(root,'profile')},cwd:root,argv:[]});assert.equal(server,null);assert.equal(process.exitCode,1);assert.ok(logged.some(line=>line.includes('ASTRBOT_DATA_REQUIRED')));await assert.rejects(()=>readFile(join(state,'instance.lock')),error=>error.code==='ENOENT');assert.ok(logged.every(line=>!/ENOENT/.test(line)));}finally{console.error=originalError;process.exitCode=savedExit;await rm(root,{recursive:true,force:true});}});
