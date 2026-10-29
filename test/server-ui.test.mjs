import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer,start,trustedRequest} from '../src/server.mjs';
import {Engine,revision} from '../src/engine.mjs';
async function fixture(run,{serverOptions={}}={}){const dir=await mkdtemp(join(tmpdir(),'model-console-http-'));await writeFile(join(dir,'index.html'),'<h1>Model Console</h1>');await writeFile(join(dir,'app.mjs'),'export const ui=true;');let applies=0;const engine={gateway:{efforts:async id=>id==='known'?['low','max']:null},snapshot:async()=>({writeEnabled:false,models:[]}),plan:async(resource,changes,_internal,expectedRevision)=>({resource,changes,expectedRevision}),apply:async()=>{applies++;return {status:'saved-and-readback-verified'};}};const stateDir=join(dir,'state');const server=createServer(engine,'secret',{staticRoot:dir,health:{stateDir,dataPath:join(dir,'data'),readOnly:false},...serverOptions});await new Promise(r=>server.listen(0,'127.0.0.1',r));try{await run({base:`http://127.0.0.1:${server.address().port}`,engine,server,stateDir,get applies(){return applies;}});}finally{await new Promise(r=>server.close(r));await server.flushDiagnostics();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});}}
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

const backupUuid='0f8fad5b-d9cb-469f-a165-70867728950e';
const backupUuid2='1f8fad5b-d9cb-469f-a165-70867728950e';

/** Fixture for the Sprint A/B backup/restore/diagnostics routes: fake engine only, temp state. */
async function apiFixture(run){
  const dir=await mkdtemp(join(tmpdir(),'model-console-api-'));
  const stateDir=join(dir,'state');
  const dataDir=join(dir,'data');
  await mkdir(stateDir,{recursive:true});
  await mkdir(dataDir,{recursive:true});
  const calls=[];
  const pruneCalls=[];
  const backups=[
    {id:backupUuid,createdAt:'2026-10-29T10:00:00.000Z',bytes:100,files:8,sqlite:'ok'},
    {id:backupUuid2,createdAt:'2026-10-29T11:00:00.000Z',bytes:200,files:8,sqlite:'ok'},
  ];
  const changes=[{path:'agent_runner.config.model.provider_id',before:'a',value:'b',capability:'llm'}];
  const engine={
    gateway:{efforts:async()=>null},
    snapshot:async()=>({writeEnabled:false,models:[]}),
    plan:async()=>({id:planId}),
    apply:async()=>({status:'saved-and-readback-verified'}),
    listBackups:async()=>{calls.push(['listBackups']);return backups;},
    backupStats:async()=>{calls.push(['backupStats']);return {count:2,bytes:300,items:[{id:backupUuid}]};},
    planRestore:async(backupId,resource,expectedRevision)=>{calls.push(['planRestore',backupId,resource,expectedRevision]);return {id:planId,resource,revision:'rev-1',changes,expiresAt:'2026-10-29T12:10:00.000Z',impact:'this profile',warning:'恢复会覆盖该资源的完整对象'};},
    backupDiff:async(backupId,resource)=>{calls.push(['backupDiff',backupId,resource]);return {backupId,resource,changes,currentRevision:'rev-1'};},
  };
  const server=createServer(engine,'secret',{
    staticRoot:dir,
    health:{stateDir,dataPath:dataDir,readOnly:true},
    limits:{keep:3,maxBytes:4096},
    pruneBackups:async keep=>{
      pruneCalls.push(keep);
      return {removed:[join(dir,'backups',backupUuid2),`C:\\Users\\someone\\backups\\not-a-uuid`],kept:[]};
    },
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{await run({base:`http://127.0.0.1:${server.address().port}`,engine,server,stateDir,dataDir,calls,pruneCalls});}
  finally{await new Promise(r=>server.close(r));await server.flushDiagnostics();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});}
}

test('GET /health requires the token and reports version and local paths only',()=>apiFixture(async({base,stateDir,dataDir})=>{
  assert.equal((await fetch(base+'/health')).status,403);
  const response=await fetch(base+'/health',{headers:auth});
  assert.equal(response.status,200);
  const body=await response.json();
  assert.deepEqual(Object.keys(body).sort(),['dataPath','readOnly','startedAt','stateDir','status','version']);
  assert.equal(body.status,'ok');
  const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  assert.equal(body.version,pkg.version);
  assert.equal(body.dataPath,dataDir);
  assert.equal(body.stateDir,stateDir);
  assert.equal(body.readOnly,true);
  assert.match(body.startedAt,/^\d{4}-\d{2}-\d{2}T/);
}));

test('GET /backups requires the token, normalizes ids and drops engine extras',()=>apiFixture(async({base,calls})=>{
  assert.equal((await fetch(base+'/backups')).status,403);
  const response=await fetch(base+'/backups',{headers:auth});
  assert.equal(response.status,200);
  const body=await response.json();
  assert.deepEqual(body.backups,[
    {id:backupUuid,createdAt:'2026-10-29T10:00:00.000Z',bytes:100,files:8,sqlite:'ok'},
    {id:backupUuid2,createdAt:'2026-10-29T11:00:00.000Z',bytes:200,files:8,sqlite:'ok'},
  ]);
  assert.deepEqual(body.stats,{count:2,bytes:300});
  assert.deepEqual(body.limits,{keep:3,maxBytes:4096});
  assert.ok(calls.some(call=>call[0]==='listBackups'));
  assert.ok(calls.some(call=>call[0]==='backupStats'));
  assert.doesNotMatch(JSON.stringify(body),/items|[A-Za-z]:\\\\|model-console-api-/);
}));

test('GET /backups/:id/diff validates kind/id and passes a safe backup id to the engine',()=>apiFixture(async({base,calls})=>{
  assert.equal((await fetch(`${base}/backups/${backupUuid}/diff?kind=profile&id=default`)).status,403);
  let response=await fetch(`${base}/backups/${backupUuid}/diff?kind=profile&id=default`,{headers:auth});
  assert.equal(response.status,200);
  let body=await response.json();
  assert.equal(body.backupId,backupUuid);
  assert.deepEqual(body.resource,{kind:'profile',id:'default'});
  assert.deepEqual(body.changes,[{path:'agent_runner.config.model.provider_id',before:'a',value:'b',capability:'llm'}]);
  assert.equal(body.currentRevision,'rev-1');
  const call=calls.find(entry=>entry[0]==='backupDiff');
  assert.deepEqual(call,[ 'backupDiff',backupUuid,{kind:'profile',id:'default'}]);
  response=await fetch(`${base}/backups/${backupUuid}/diff?kind=secret&id=default`,{headers:auth});
  assert.equal(response.status,400);
  assert.deepEqual(await response.json(),{error:'INVALID_RESOURCE'});
  response=await fetch(`${base}/backups/${backupUuid}/diff?kind=profile`,{headers:auth});
  assert.deepEqual(await response.json(),{error:'INVALID_RESOURCE'});
  response=await fetch(`${base}/backups/not-a-uuid/diff?kind=profile&id=default`,{headers:auth});
  assert.equal(response.status,400);
  assert.deepEqual(await response.json(),{error:'INVALID_BACKUP_ID'});
}));

test('POST /backups/prune validates keep, folds removed paths to UUID basenames and refreshes stats',()=>apiFixture(async({base,pruneCalls,calls})=>{
  const headers={...auth,'Content-Type':'application/json'};
  assert.equal((await fetch(base+'/backups/prune',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"keep":2}'})).status,403);
  let response=await fetch(base+'/backups/prune',{method:'POST',headers,body:JSON.stringify({keep:2})});
  assert.equal(response.status,200);
  let body=await response.json();
  assert.deepEqual(body.removed,[backupUuid2]);
  assert.deepEqual(body.stats,{count:2,bytes:300});
  assert.doesNotMatch(JSON.stringify(body),/[A-Za-z]:\\\\|model-console-api-|not-a-uuid/);
  assert.deepEqual(pruneCalls,[2]);
  response=await fetch(base+'/backups/prune',{method:'POST',headers,body:'{}'});
  assert.equal(response.status,200);
  assert.deepEqual(pruneCalls,[2,undefined]);
  assert.ok(calls.filter(call=>call[0]==='backupStats').length>=2);
  for(const invalid of ['{"keep":0}','{"keep":101}','{"keep":"5"}','{"keep":2.5}']){
    response=await fetch(base+'/backups/prune',{method:'POST',headers,body:invalid});
    assert.equal(response.status,400,invalid);
    assert.deepEqual(await response.json(),{error:'INVALID_KEEP'});
  }
  assert.deepEqual(pruneCalls,[2,undefined]);
  assert.equal((await fetch(base+'/backups/prune',{method:'POST',headers:{...auth,'Content-Type':'text/plain'},body:'{}'})).status,415);
}));

test('POST /restore-plans validates the body, returns a restore plan and whitelists engine errors',()=>apiFixture(async({base,engine,calls})=>{
  const headers={...auth,'Content-Type':'application/json'};
  const payload={backupId:backupUuid,resource:{kind:'profile',id:'default'},expectedRevision:'rev-1'};
  assert.equal((await fetch(base+'/restore-plans',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})).status,403);
  let response=await fetch(base+'/restore-plans',{method:'POST',headers,body:JSON.stringify(payload)});
  assert.equal(response.status,200);
  let body=await response.json();
  assert.equal(body.mode,'restore');
  assert.equal(body.backupId,backupUuid);
  assert.equal(body.id,planId);
  assert.match(body.warning,/覆盖/);
  assert.deepEqual(body.changes,[{path:'agent_runner.config.model.provider_id',before:'a',value:'b',capability:'llm'}]);
  const call=calls.find(entry=>entry[0]==='planRestore');
  assert.deepEqual(call,['planRestore',backupUuid,{kind:'profile',id:'default'},'rev-1']);
  for(const badBody of [
    {resource:{kind:'profile',id:'default'}},
    {backupId:'../escape',resource:{kind:'profile',id:'default'}},
    {backupId:backupUuid,resource:{kind:'workspace',id:'default'}},
    {backupId:backupUuid,resource:{kind:'plugin',id:'a/b'}},
    {backupId:backupUuid,resource:{kind:'provider',id:'x'},expectedRevision:12},
  ]){
    response=await fetch(base+'/restore-plans',{method:'POST',headers,body:JSON.stringify(badBody)});
    assert.equal(response.status,400,JSON.stringify(badBody));
  }
  const failure=Error('RESTORE_BACKUP_NOT_FOUND');
  failure.details={backupId:`C:\\Users\\someone\\backups\\${backupUuid}`,code:'RESTORE_BACKUP_NOT_FOUND',token:'abc',path:'/secret/path'};
  engine.planRestore=async()=>{throw failure;};
  response=await fetch(base+'/restore-plans',{method:'POST',headers,body:JSON.stringify(payload)});
  assert.equal(response.status,409);
  body=await response.json();
  assert.deepEqual(body,{error:'RESTORE_BACKUP_NOT_FOUND',code:'RESTORE_BACKUP_NOT_FOUND'});
  assert.doesNotMatch(JSON.stringify(body),/[A-Za-z]:\\\\|someone|token|abc/);
}));

test('4xx diagnostics are recorded sanitized and exported only with a token',()=>apiFixture(async({base,server,stateDir})=>{
  await fetch(base+'/backups');
  await fetch(base+'/backups/not-a-uuid/diff?kind=profile&id=default',{headers:auth});
  await server.flushDiagnostics();
  const text=await readFile(join(stateDir,'diagnostics.jsonl'),'utf8');
  assert.doesNotMatch(text,/Bearer|secret|abc123|[A-Za-z]:\\\\|model-console-api-|"token"/);
  const events=text.trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(events.length>=2);
  assert.ok(events.every(event=>['info','warn','error'].includes(event.level)));
  assert.ok(events.every(event=>/^\d{4}-\d{2}-\d{2}T/.test(event.time)));
  assert.ok(events.some(event=>event.status===403&&event.path==='/backups'&&event.code==='ACCESS_DENIED'));
  assert.ok(events.some(event=>event.status===400&&event.code==='INVALID_BACKUP_ID'));
  assert.equal((await fetch(base+'/diagnostics/export')).status,403);
  const exported=await fetch(base+'/diagnostics/export',{headers:auth});
  assert.equal(exported.status,200);
  const body=await exported.json();
  assert.ok(Array.isArray(body.events));
  assert.deepEqual(body.events.at(-1),events.at(-1));
  assert.doesNotMatch(JSON.stringify(body),/[A-Za-z]:\\\\|Bearer|secret/);
}));

test('start() wires diagnostics, backup functions and health paths from a temporary data dir',async()=>{
  const root=await mkdtemp(join(tmpdir(),'model-console-start-'));
  const state=join(root,'state');
  const data=join(root,'data');
  const savedExit=process.exitCode;
  const originalLog=console.log;
  const printed=[];
  console.log=(...args)=>printed.push(args.join(' '));
  let server;
  try{
    await mkdir(join(data,'config'),{recursive:true});
    await writeFile(join(data,'cmd_config.json'),'{}','utf8');
    server=await start({env:{LOCALAPPDATA:root,MODEL_CONSOLE_STATE:state,ASTRBOT_DATA:data,USERPROFILE:join(root,'profile')},cwd:root,argv:[]});
    assert.ok(server);
    const line=JSON.parse(printed.at(-1));
    const match=/^http:\/\/127\.0\.0\.1:(\d+)\/#token=([a-f0-9]{64})$/.exec(line.url);
    assert.ok(match,line.url);
    const response=await fetch(`http://127.0.0.1:${match[1]}/health`,{headers:{Authorization:`Bearer ${match[2]}`}});
    assert.equal(response.status,200);
    const body=await response.json();
    assert.equal(body.status,'ok');
    assert.equal(body.dataPath,data);
    assert.equal(body.stateDir,state);
    assert.equal(body.readOnly,true);
    assert.ok(body.version);
    assert.match(body.startedAt,/^\d{4}-\d{2}-\d{2}T/);
    const backupsResponse=await fetch(`http://127.0.0.1:${match[1]}/backups`,{headers:{Authorization:`Bearer ${match[2]}`}});
    assert.equal(backupsResponse.status,200);
    const backupsBody=await backupsResponse.json();
    assert.deepEqual(backupsBody.backups,[]);
    assert.deepEqual(backupsBody.stats,{count:0,bytes:0});
    assert.deepEqual(backupsBody.limits,{keep:10,maxBytes:2048*1024*1024});
  }finally{
    if(server)await new Promise(resolve=>server.close(resolve));
    console.log=originalLog;
    process.exitCode=savedExit;
    await rm(root,{recursive:true,force:true});
  }
});

const BACKUP_UUID='0243f684-e8ed-44ac-8c95-657df32890aa';
const RESOURCE_PLAN_ID='0f8fad5b-d9cb-469f-a165-70867728950e';
test('provider resource ids may contain "/" while traversal and path-like ids stay 400',()=>fixture(async({base,engine})=>{
  engine.backupDiff=async(backupId,resource)=>({resource,changes:[],currentRevision:'rev'});
  engine.planRestore=async(backupId,resource,expectedRevision)=>({id:RESOURCE_PLAN_ID,resource,changes:[],backupId,expectedRevision});
  const diffUrl=id=>`${base}/backups/${BACKUP_UUID}/diff?kind=provider&id=${encodeURIComponent(id)}`;
  let response=await fetch(diffUrl('<provider>/<model>'),{headers:auth});
  assert.equal(response.status,200);
  let body=await response.json();
  assert.equal(body.resource.id,'<provider>/<model>');
  assert.equal(body.backupId,BACKUP_UUID);
  assert.doesNotMatch(JSON.stringify(body),/C:\\|AppData|Users|backups\//i);
  // profile/plugin 维持严格字符集：斜杠仍然拒绝。
  assert.equal((await fetch(`${base}/backups/${BACKUP_UUID}/diff?kind=profile&id=<provider>%2F<model>`,{headers:auth})).status,400);
  for(const id of ['../x','a/../../b','a\b','C:/x','/leading','trailing/','a//b','x'.repeat(201)]){
    const invalid=await fetch(diffUrl(id),{headers:auth});
    assert.equal(invalid.status,400,id);
    assert.deepEqual(await invalid.json(),{error:'INVALID_RESOURCE'});
  }
  const restoreHeaders={...auth,'Content-Type':'application/json'};
  const validRestore=await fetch(base+'/restore-plans',{method:'POST',headers:restoreHeaders,body:JSON.stringify({backupId:BACKUP_UUID,resource:{kind:'provider',id:'<provider>/<model>'},expectedRevision:'rev'})});
  assert.equal(validRestore.status,200);
  body=await validRestore.json();
  assert.equal(body.mode,'restore');
  assert.equal(body.backupId,BACKUP_UUID);
  assert.equal(body.resource.id,'<provider>/<model>');
  for(const id of ['../x','a/../../b','a\b','C:/x']){
    const invalid=await fetch(base+'/restore-plans',{method:'POST',headers:restoreHeaders,body:JSON.stringify({backupId:BACKUP_UUID,resource:{kind:'provider',id}})});
    assert.equal(invalid.status,400,id);
    assert.deepEqual(await invalid.json(),{error:'INVALID_RESOURCE'});
  }
  // 单个 provider id 长度上限 200（profile/plugin 仍是 128）。
  assert.equal((await fetch(diffUrl('a'.repeat(200)),{headers:auth})).status,200);
  assert.equal((await fetch(diffUrl('a'.repeat(201)),{headers:auth})).status,400);
}));
