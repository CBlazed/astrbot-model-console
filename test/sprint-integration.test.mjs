/**
 * Sprint A/B/C 独立集成回归（task-13）。
 *
 * 独立于 worker 自测：真实 createServer + fake engine / 真实 Engine + fake gateway / 真实模块，
 * 对照 docs/SPRINT-CONTRACT.zh-CN.md 验证 P1-01/03/04/05/06/07/08/10 与 Epic-1 读侧。
 * 真实数据只读核对：本机 AstrBot 配置 → bindingRows；model-console/state/backups → listBackups/
 * readBackupResource。全部临时 state 用 mkdtemp，不写真实 state/、不连真实 AstrBot。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,createHmac} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createServer} from '../src/server.mjs';
import {Engine,bindingRows,revision} from '../src/engine.mjs';
import {Gateway} from '../src/gateway.mjs';
import {discoverAstrBotData} from '../src/config.mjs';
import {backupState,backupStats,listBackups,pruneBackups,readBackupResource,backupMaxBytes,backupKeep,BACKUP_SIZE_LIMIT_EXCEEDED} from '../src/backup.mjs';
import {logDiagnostic,readDiagnostics,normalizeEvent,redactDetail,sanitizePath} from '../src/diagnostics.mjs';
import {addDevice} from '../src/devices.mjs';
import {buildConflictRows,bindingStatus,isIssue,routingNoticeText,deviceOptions,isRemoteSnapshot,snapshotPath} from '../public/ui-state.mjs';

const TOKEN='sprint-token-do-not-leak';
const AUTH={Authorization:`Bearer ${TOKEN}`};
const JSON_HEADERS={...AUTH,'Content-Type':'application/json'};
const PLAN_ID='0f8fad5b-d9cb-469f-a165-70867728950e';
const BACKUP_1='bc1257f4-c25a-48a5-b74c-8e5246c0664a';
const BACKUP_2='a001aae2-01df-4519-a559-97dcb242150f';
const BACKUP_3='4eac7a08-5a0e-4c31-8a94-9da120e22e15';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let tempSeq=0;
const tempDir=async()=>mkdtemp(join(tmpdir(),`model-console-sprint-${++tempSeq}-`));

/** Real createServer around a fake engine; temp stateDir so diagnostics/devices never touch real state. */
async function apiFixture(options,run){
  const root=await tempDir();
  const stateDir=options.stateDir??join(root,'state');
  const dataPath=options.dataPath??join(root,'data');
  const server=createServer(options.engine,TOKEN,{
    staticRoot:root,
    health:{stateDir,dataPath,readOnly:options.readOnly!==false},
    ...(options.limits?{limits:options.limits}:{}),
    ...(options.pruneBackups?{pruneBackups:options.pruneBackups}:{}),
    ...(options.createRemoteEngine?{createRemoteEngine:options.createRemoteEngine}:{}),
    ...(options.remoteSnapshotTtlMs!==undefined?{remoteSnapshotTtlMs:options.remoteSnapshotTtlMs}:{}),
  });
  await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolveListen();});});
  try{
    return await run({base:`http://127.0.0.1:${server.address().port}`,server,stateDir,dataPath,root});
  }finally{
    await new Promise(resolveClose=>{server.close(resolveClose);server.closeAllConnections?.();});
    await server.flushDiagnostics();
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
}

/** Contract-shaped fake engine; every call is recorded so tests can prove the server passes values through. */
function fakeEngine(overrides={}){
  const calls=[];
  const engine={
    writeEnabled:false,
    gateway:{efforts:async()=>['low','max']},
    snapshot:async()=>({readAt:new Date().toISOString(),writeEnabled:false,models:[],resources:[],routing:{total:0,platformLevel:0,granular:0}}),
    plan:async(resource,changes,_internal,expectedRevision)=>({id:PLAN_ID,resource,changes,expectedRevision}),
    apply:async id=>({status:'saved-and-readback-verified',id}),
    listBackups:async()=>{calls.push(['listBackups']);return [];},
    backupStats:async()=>{calls.push(['backupStats']);return {count:0,bytes:0,items:[]};},
    backupDiff:async()=>{calls.push(['backupDiff']);return {changes:[],currentRevision:null};},
    planRestore:async()=>{calls.push(['planRestore']);return {id:PLAN_ID,resource:{kind:'profile',id:'default'},revision:'rev',changes:[],warning:'恢复会覆盖完整对象'};},
    pruneBackups:async keep=>{calls.push(['pruneBackups',keep]);return {removed:[],kept:[],bytes:0};},
    ...overrides,
  };
  return {engine,calls};
}

/** Write a BOM-less JSON config, matching what AstrBot's API returns after parsing. */
const writeJSON=async(path,value)=>{await writeFile(path,JSON.stringify(value),'utf8');};

/* ------------------------------------------------------------------ P1-08 /health */

test('P1-08 /health：要求 token/同源，返回契约字段且只含本机路径信息',async()=>{
  const {engine}=fakeEngine();
  await apiFixture({engine,readOnly:true},async({base,stateDir,dataPath})=>{
    assert.equal((await fetch(base+'/health')).status,403);
    assert.equal((await fetch(base+'/health',{headers:{...AUTH,Origin:'https://evil.test'}})).status,403);
    const response=await fetch(base+'/health',{headers:AUTH});
    assert.equal(response.status,200);
    const body=await response.json();
    assert.deepEqual(Object.keys(body).sort(),['dataPath','readOnly','startedAt','stateDir','status','version']);
    assert.equal(body.status,'ok');
    const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
    assert.equal(body.version,pkg.version);
    assert.equal(body.dataPath,dataPath);
    assert.equal(body.stateDir,stateDir);
    assert.equal(body.readOnly,true);
    assert.match(body.startedAt,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.doesNotMatch(JSON.stringify(body),new RegExp(TOKEN));
  });
});

/* -------------------------------------------------------------- P1-04 backups 契约 */

test('P1-04 GET /backups：UUID basename、stats、limits，绝对路径与 engine 内部字段不外泄',async()=>{
  const {engine,calls}=fakeEngine({
    listBackups:async()=>[
      {id:join('C:\\Users\\alice','backups',BACKUP_1),createdAt:'2026-10-29T02:38:11.055Z',bytes:100,files:9,sqlite:'ok',internal:'drop-me'},
      {id:BACKUP_2,createdAt:'2026-10-29T02:38:10.989Z',bytes:200,files:8,sqlite:'ok'},
      {id:'not-a-uuid',createdAt:'2026-10-29T02:38:10.000Z',bytes:1,files:1,sqlite:'ok'},
    ],
    backupStats:async()=>({count:2,bytes:300,items:[{id:BACKUP_1,bytes:100},{id:BACKUP_2,bytes:200}]}),
  });
  await apiFixture({engine,limits:{keep:4,maxBytes:12345}},async({base})=>{
    assert.equal((await fetch(base+'/backups')).status,403);
    const body=await (await fetch(base+'/backups',{headers:AUTH})).json();
    assert.deepEqual(body,{
      backups:[
        {id:BACKUP_1,createdAt:'2026-10-29T02:38:11.055Z',bytes:100,files:9,sqlite:'ok'},
        {id:BACKUP_2,createdAt:'2026-10-29T02:38:10.989Z',bytes:200,files:8,sqlite:'ok'},
      ],
      stats:{count:2,bytes:300},
      limits:{keep:4,maxBytes:12345},
      warnings:[],
    });
    assert.doesNotMatch(JSON.stringify(body),/alice|internal|not-a-uuid|[A-Za-z]:\\\\/);
    assert.equal(calls.length,0,'GET /backups 应为只读，engine 不记录写调用');
  });
});

test('P1-10 POST /backups/prune：keep 校验、removed 折回 UUID、stats 刷新、只读模式也可清理',async()=>{
  const {engine,calls}=fakeEngine({
    pruneBackups:async keep=>{
      calls.push(['engine-prune',keep]);
      return {removed:[join('C:\\Users\\alice','backups',BACKUP_1),BACKUP_2,`C:\\x\\not-a-uuid`],kept:[],bytes:0};
    },
    backupStats:async()=>({count:1,bytes:50}),
  });
  await apiFixture({engine},async({base})=>{
    assert.equal((await fetch(base+'/backups/prune',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"keep":2}'})).status,403);
    let response=await fetch(base+'/backups/prune',{method:'POST',headers:JSON_HEADERS,body:JSON.stringify({keep:2})});
    assert.equal(response.status,200);
    let body=await response.json();
    assert.deepEqual(body,{removed:[BACKUP_1,BACKUP_2],stats:{count:1,bytes:50}});
    assert.doesNotMatch(JSON.stringify(body),/alice|not-a-uuid|[A-Za-z]:\\\\/);
    response=await fetch(base+'/backups/prune',{method:'POST',headers:JSON_HEADERS,body:'{}'});
    assert.equal(response.status,200);
    assert.deepEqual(calls.filter(call=>call[0]==='engine-prune'),[['engine-prune',2],['engine-prune',undefined]]);
    for(const invalid of ['{"keep":0}','{"keep":101}','{"keep":"5"}','{"keep":2.5}']){
      response=await fetch(base+'/backups/prune',{method:'POST',headers:JSON_HEADERS,body:invalid});
      assert.equal(response.status,400,invalid);
      assert.deepEqual(await response.json(),{error:'INVALID_KEEP'});
    }
  });
});

test('P1-04 GET /backups/:id/diff：只读、字段白名单、非法参数 400、引擎错误 409 脱敏',async()=>{
  const {engine,calls}=fakeEngine({
    backupDiff:async(backupId,resource)=>{
      calls.push(['backupDiff',backupId,resource]);
      return {
        backupId,
        resource,
        changes:[{path:'agent_runner.config.model.provider_id',before:'a',value:'b',capability:'llm',secret:'drop'}],
        currentRevision:'rev-1',
        extra:'drop',
      };
    },
  });
  await apiFixture({engine},async({base})=>{
    assert.equal((await fetch(`${base}/backups/${BACKUP_1}/diff?kind=profile&id=default`)).status,403);
    let response=await fetch(`${base}/backups/${BACKUP_1}/diff?kind=profile&id=default`,{headers:AUTH});
    assert.equal(response.status,200);
    let body=await response.json();
    assert.deepEqual(body,{backupId:BACKUP_1,resource:{kind:'profile',id:'default'},changes:[{path:'agent_runner.config.model.provider_id',before:'a',value:'b',capability:'llm'}],currentRevision:'rev-1'});
    assert.equal(calls.find(call=>call[0]==='backupDiff')[1],BACKUP_1);
    for(const bad of [
      '/backups/not-a-uuid/diff?kind=profile&id=default',
      `/backups/${encodeURIComponent(join('C:\\Users\\alice',BACKUP_1))}/diff?kind=profile&id=default`,
      `/backups/${BACKUP_1}/diff?kind=workspace&id=default`,
      `/backups/${BACKUP_1}/diff?kind=plugin&id=a%2Fb`,
    ]){
      response=await fetch(base+bad,{headers:AUTH});
      assert.equal(response.status,400,bad);
      assert.ok(['INVALID_BACKUP_ID','INVALID_RESOURCE'].includes((await response.json()).error),bad);
    }
    // provider id 允许 "/"（真实 id 形如 <provider>/<model>），但拒绝路径穿越/反斜杠/盘符/空段。
    response=await fetch(`${base}/backups/${BACKUP_1}/diff?kind=provider&id=${encodeURIComponent('<provider>/<model>')}`,{headers:AUTH});
    assert.equal(response.status,200);
    for(const badProvider of ['../x','a/../../b','a\\b','C:/x','a//b','/abs','abs/']){
      response=await fetch(`${base}/backups/${BACKUP_1}/diff?kind=provider&id=${encodeURIComponent(badProvider)}`,{headers:AUTH});
      assert.equal(response.status,400,badProvider);
    }
    const failure=Error('RESTORE_BACKUP_INVALID');
    failure.details={backupId:`C:\\Users\\alice\\backups\\${BACKUP_1}`,path:'C:\\secret',token:'abc'};
    engine.backupDiff=async()=>{throw failure;};
    response=await fetch(`${base}/backups/${BACKUP_1}/diff?kind=profile&id=default`,{headers:AUTH});
    assert.equal(response.status,409);
    body=await response.json();
    assert.deepEqual(body,{error:'RESTORE_BACKUP_INVALID'});
    assert.doesNotMatch(JSON.stringify(body),/C:\\\\|alice|secret|abc/i);
  });
});

test('P1-04 POST /restore-plans：契约形状、参数校验、409 白名单',async()=>{
  const restorePlan={
    id:PLAN_ID,
    resource:{kind:'profile',id:'default'},
    revision:'rev-1',
    changes:[{path:'agent_runner.config.model.provider_id',before:'a',value:'b',capability:'llm',secret:'drop'}],
    expiresAt:'2026-10-29T12:00:00.000Z',
    warning:'恢复会覆盖该资源完整对象',
    backupId:`C:\\Users\\alice\\backups\\${BACKUP_1}`,
    internal:'drop-me',
    enginePath:'C:\\Users\\alice\\secret',
  };
  const {engine,calls}=fakeEngine({planRestore:async(backupId,resource,expectedRevision)=>{calls.push(['planRestore',backupId,resource,expectedRevision]);return restorePlan;}});
  await apiFixture({engine},async({base})=>{
    const payload={backupId:join('C:\\Users\\alice','backups',BACKUP_1),resource:{kind:'profile',id:'default'},expectedRevision:'rev-1'};
    assert.equal((await fetch(base+'/restore-plans',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})).status,403);
    let response=await fetch(base+'/restore-plans',{method:'POST',headers:JSON_HEADERS,body:JSON.stringify(payload)});
    assert.equal(response.status,200);
    const body=await response.json();
    assert.equal(body.mode,'restore');
    assert.equal(body.backupId,BACKUP_1);
    assert.equal(body.id,PLAN_ID);
    assert.match(body.warning,/覆盖/);
    assert.deepEqual(body.changes,[{path:'agent_runner.config.model.provider_id',before:'a',value:'b',capability:'llm'}]);
    assert.doesNotMatch(JSON.stringify(body),/C:\\\\|alice|internal|drop-me|enginePath/);
    assert.ok(Object.keys(body).every(key=>['mode','id','resource','revision','expiresAt','impact','warning','backupId','changes'].includes(key)),JSON.stringify(Object.keys(body)));
    assert.deepEqual(calls.find(call=>call[0]==='planRestore'),['planRestore',BACKUP_1,{kind:'profile',id:'default'},'rev-1']);
    for(const badBody of [
      {resource:{kind:'profile',id:'default'}},
      {backupId:'../escape',resource:{kind:'profile',id:'default'}},
      {backupId:BACKUP_1,resource:{kind:'workspace',id:'default'}},
      {backupId:BACKUP_1,resource:{kind:'plugin',id:'a/b'}},
      {backupId:BACKUP_1,resource:{kind:'provider',id:'x'},expectedRevision:12},
      {backupId:BACKUP_1,resource:{kind:'provider',id:'x'},expectedRevision:'a'.repeat(129)},
      // provider 允许 "/"，但路径穿越/反斜杠/盘符/空段仍必须 400。
      {backupId:BACKUP_1,resource:{kind:'provider',id:'../x'}},
      {backupId:BACKUP_1,resource:{kind:'provider',id:'a/../../b'}},
      {backupId:BACKUP_1,resource:{kind:'provider',id:'a\\b'}},
      {backupId:BACKUP_1,resource:{kind:'provider',id:'C:/x'}},
      {backupId:BACKUP_1,resource:{kind:'provider',id:'a//b'}},
    ]){
      response=await fetch(base+'/restore-plans',{method:'POST',headers:JSON_HEADERS,body:JSON.stringify(badBody)});
      assert.equal(response.status,400,JSON.stringify(badBody));
    }
    // 真实 provider id 含 "/"：restore-plans 必须 200，且引擎收到原始 id。
    const providerPayload={backupId:BACKUP_1,resource:{kind:'provider',id:'<provider>/<model>'},expectedRevision:'rev-1'};
    response=await fetch(base+'/restore-plans',{method:'POST',headers:JSON_HEADERS,body:JSON.stringify(providerPayload)});
    assert.equal(response.status,200);
    assert.equal(calls.find(call=>call[0]==='planRestore'&&call[2]?.kind==='provider')[2].id,'<provider>/<model>');
    const failure=Error('RESTORE_BACKUP_NOT_FOUND');
    failure.details={backupId:`C:\\Users\\alice\\backups\\${BACKUP_1}`,token:'abc',path:'/secret'};
    engine.planRestore=async()=>{throw failure;};
    response=await fetch(base+'/restore-plans',{method:'POST',headers:JSON_HEADERS,body:JSON.stringify(payload)});
    assert.equal(response.status,409);
    assert.deepEqual(await response.json(),{error:'RESTORE_BACKUP_NOT_FOUND'});
  });
});

test('P1-04 真实 Engine：planRestore 只列已审查差异、apply 恢复完整对象并保留审计',async()=>{
  const resource={kind:'plugin',id:'astrbot_plugin_group_chat_plus'};
  let current={decision_ai_provider_id:'llm-a',unrelated:{keep:true},other:'x'};
  const backupConfig={decision_ai_provider_id:'llm-b',unrelated:{keep:true}};
  const providerId='<provider>/<model>';
  let providerCurrent={id:providerId,custom_extra_body:{reasoning_effort:'low'}};
  const providerBackup={id:providerId,custom_extra_body:{reasoning_effort:'max'}};
  const writes=[],events=[];
  const gateway={
    read:async r=>r.kind==='profile'
      ?{provider:[{id:'llm-a',type:'openai_chat_completion',enable:true},{id:'llm-b',type:'openai_chat_completion',enable:true}]}
      :r.kind==='provider'?structuredClone(providerCurrent):structuredClone(current),
    resources:async()=>[],
    efforts:async()=>['low','max'],
    write:async(r,next)=>{writes.push({resource:r,config:structuredClone(next)});if(r.kind==='provider')providerCurrent=structuredClone(next);else current=structuredClone(next);},
  };
  const backups={list:async()=>[],read:async(backupId,res)=>res.kind==='provider'
    ?{config:structuredClone(providerBackup),file:'cmd_config.json'}
    :{config:structuredClone(backupConfig),file:`config/${res.id}_config.json`}};
  const engine=new Engine({gateway,writeEnabled:true,backups,backup:async()=>`C:\\state\\backups\\${BACKUP_1}`,audit:async event=>events.push(event)});
  const diff=await engine.backupDiff(BACKUP_1,resource);
  assert.equal(diff.backupId,BACKUP_1);
  assert.equal(diff.currentRevision,revision(current));
  assert.deepEqual(diff.changes,[{path:'decision_ai_provider_id',before:'llm-a',value:'llm-b',capability:'llm'}]);
  await assert.rejects(()=>engine.planRestore(BACKUP_1,resource,'stale-revision'),/CONCURRENT_CHANGE/);
  const plan=await engine.planRestore(BACKUP_1,resource,diff.currentRevision);
  assert.equal(plan.mode,'restore');
  assert.equal(plan.backupId,BACKUP_1);
  assert.match(plan.warning,/覆盖/);
  const result=await engine.apply(plan.id);
  assert.equal(result.status,'saved-and-readback-verified');
  assert.equal(result.backupId,BACKUP_1);
  // 恢复写入的是备份的完整对象（不只是差异字段），且回读校验通过。
  assert.deepEqual(writes,[{resource,config:backupConfig}]);
  assert.deepEqual(current,backupConfig);
  assert.equal(events.filter(event=>event.event==='applied').length,1);
  // 真实 provider id 含 "/"（<provider>/<model>）：engine 级 planRestore + apply 必须可用。
  const providerResource={kind:'provider',id:providerId};
  const providerPlan=await engine.planRestore(BACKUP_1,providerResource);
  assert.equal(providerPlan.mode,'restore');
  assert.deepEqual(providerPlan.changes,[{path:'custom_extra_body.reasoning_effort',before:'low',value:'max',capability:'llm'}]);
  const providerResult=await engine.apply(providerPlan.id);
  assert.equal(providerResult.status,'saved-and-readback-verified');
  assert.deepEqual(providerCurrent,providerBackup);
  assert.deepEqual(writes.at(-1),{resource:providerResource,config:providerBackup});
});

/* --------------------------------------------------- P1-01 gateway 缓存与 routing */

async function gatewayFixture({logLines=[],cmdConfig}={}){
  const data=await tempDir();
  await mkdir(join(data,'logs'),{recursive:true});
  await mkdir(join(data,'config'),{recursive:true});
  const logPath=join(data,'logs','astrbot.log');
  await writeFile(logPath,logLines.join('\n')+'\n','utf8');
  const configPath=join(data,'cmd_config.json');
  await writeJSON(configPath,cmdConfig??{dashboard:{username:'astrbot',jwt_secret:'first-secret'}});
  const requests=[];
  const response=body=>({ok:true,status:200,async json(){return body;}});
  const fetcher=async(url,options)=>{
    const path=new URL(url).pathname;
    requests.push({url,path,method:options?.method??'GET',authorization:options?.headers?.Authorization});
    if(path==='/api/v1/config-profiles/default')return response({status:'ok',data:{config:{agent_runner:{config:{model:{provider_id:'llm-a'}}}}}});
    if(path==='/api/v1/config-profiles/other')return response({status:'ok',data:{config:{x:1}}});
    if(path==='/api/v1/config-routes')return response({status:'ok',data:{routing:['qq_official::','onebot::','qq_official:123::456']}});
    return response({status:'ok',data:{}});
  };
  return {data,logPath,configPath,fetcher,requests,cleanup:()=>rm(data,{recursive:true,force:true})};
}

test('P1-01 Gateway 缓存：多次 API 调用只读一次日志/配置，文件变化后失效重读，invalidate 清空',async()=>{
  const fixture=await gatewayFixture({logLines:['Starting WebUI at http://127.0.0.1:6185']});
  try{
    const gateway=new Gateway(fixture.data,fixture.fetcher);
    await gateway.read({kind:'profile',id:'default'});
    await gateway.read({kind:'profile',id:'default'});
    await gateway.call('GET','/api/v1/config-profiles');
    assert.deepEqual(gateway.reads,{log:1,config:1});
    assert.ok(fixture.requests.every(request=>request.url.includes(':6185')));
    // cmd_config.json 变化（长度/mtime）→ 下一次调用重读，并使用新的 jwt secret 重新签名。
    await writeJSON(fixture.configPath,{dashboard:{username:'astrbot',jwt_secret:'second-secret-much-longer'}});
    await gateway.read({kind:'profile',id:'default'});
    assert.deepEqual(gateway.reads,{log:1,config:2});
    const authorization=fixture.requests.at(-1).authorization;
    const [header,payload]=authorization.slice('Bearer '.length).split('.');
    const expected=createHmac('sha256','second-secret-much-longer').update(`${header}.${payload}`).digest('base64url');
    assert.equal(authorization.split('.').at(-1),expected);
    // 日志增长 → 重新选端口，但配置不重读。
    await writeFile(fixture.logPath,'Starting WebUI at http://127.0.0.1:6185\nStarting WebUI at http://127.0.0.1:6199\n','utf8');
    await gateway.read({kind:'profile',id:'default'});
    assert.deepEqual(gateway.reads,{log:2,config:2});
    assert.ok(fixture.requests.at(-1).url.includes(':6199'));
    gateway.invalidate();
    await gateway.read({kind:'profile',id:'default'});
    assert.deepEqual(gateway.reads,{log:3,config:3});
  }finally{await fixture.cleanup();}
});

test('P1-01 Gateway 缓存：同一快照的并发调用共享一次日志扫描/配置解析',async()=>{
  const fixture=await gatewayFixture({logLines:['Starting WebUI at http://127.0.0.1:6185']});
  try{
    const gateway=new Gateway(fixture.data,fixture.fetcher);
    await Promise.all([gateway.read({kind:'profile',id:'default'}),gateway.read({kind:'profile',id:'default'}),gateway.call('GET','/api/v1/config-profiles')]);
    assert.deepEqual(gateway.reads,{log:1,config:1});
  }finally{await fixture.cleanup();}
});

test('P1-01/P1-07 routingSummary：区分平台级与细分路由，失败降级为零且不抛错',async()=>{
  const fixture=await gatewayFixture({logLines:['Starting WebUI at http://127.0.0.1:6185']});
  try{
    const gateway=new Gateway(fixture.data,fixture.fetcher);
    assert.deepEqual(await gateway.routingSummary(),{total:3,platformLevel:2,granular:1});
    const failing=new Gateway(fixture.data,async()=>{throw Error('network down');});
    assert.deepEqual(await failing.routingSummary(),{total:0,platformLevel:0,granular:0});
    const engine=new Engine({gateway:new Gateway(fixture.data,fixture.fetcher)});
    assert.deepEqual(await engine.routingSummary(),{total:3,platformLevel:2,granular:1});
    const noCapability=new Engine({gateway:{}});
    assert.deepEqual(await noCapability.routingSummary(),{total:0,platformLevel:0,granular:0});
  }finally{await fixture.cleanup();}
});

/* ------------------------------------------------- P1-03 / P1-06 / P1-07 纯函数 */

test('P1-03 冲突 diff：对齐本地草稿与服务器当前值，缺失字段标记为“字段不存在”',()=>{
  const pending=[
    {path:'decision_ai_provider_id',value:'llm-b'},
    {path:'image_to_text_provider_id',value:''},
  ];
  const current=[
    {path:'decision_ai_provider_id',value:'llm-c'},
    {path:'image_to_text_provider_id',value:''},
  ];
  const labels={decision_ai_provider_id:'读空气决策'};
  const rows=buildConflictRows(pending,current,labels);
  assert.deepEqual(rows,[
    {path:'decision_ai_provider_id',label:'读空气决策',mine:'llm-b',server:'llm-c',changed:true},
    {path:'image_to_text_provider_id',label:'image_to_text_provider_id',mine:'空值 / 跟随默认',server:'空值 / 跟随默认',changed:false},
  ]);
  const missing=buildConflictRows([{path:'provider_settings.embedding_provider_id',value:''}],{});
  assert.deepEqual(missing,[{path:'provider_settings.embedding_provider_id',label:'provider_settings.embedding_provider_id',mine:'空值 / 跟随默认',server:'字段不存在',changed:true}]);
  assert.deepEqual(buildConflictRows([],null),[]);
  assert.deepEqual(buildConflictRows(null,{}),[]);
});

test('P1-06/P1-07 状态与提示：field-missing 进入异常口径，细分路由提示带数量',()=>{
  assert.deepEqual(bindingStatus('field-missing'),{label:'字段不存在',kind:'bad'});
  assert.equal(isIssue({status:'field-missing'}),true);
  assert.equal(isIssue({status:'empty-semantics-unverified'}),false);
  assert.equal(routingNoticeText({total:5,platformLevel:1,granular:4}),'本设备存在会话级/通配符路由（共 5 条路由，其中细分路由 4 条），卡片仅代表平台级视图。');
  assert.equal(routingNoticeText({total:1,platformLevel:1,granular:0}),'');
  assert.equal(routingNoticeText({}),'');
  // Epic-1 读侧纯函数：本地永远排第一；远程只读时选择器可见只读标签；快照缺 device 视作本机。
  const options=deviceOptions([{id:'local',kind:'local',readOnly:false},{id:'r1',name:'书房',kind:'http',readOnly:true}]);
  assert.equal(options[0].value,'local');
  assert.equal(options.find(option=>option.value==='r1').readOnly,true);
  assert.equal(snapshotPath(''),'/snapshot');
  assert.equal(snapshotPath('local'),'/snapshot');
  assert.equal(snapshotPath('r1'),'/snapshot?device=r1');
  assert.equal(isRemoteSnapshot({device:{kind:'http'}}),true);
  assert.equal(isRemoteSnapshot({device:{kind:'local'}}),false);
  assert.equal(isRemoteSnapshot({models:[]}),false);
});

/* ------------------------------------------------------------ P1-05 diagnostics */

test('P1-05 diagnostics：事件白名单、路径/密钥脱敏、滚动上限、篡改行重读仍安全',async()=>{
  assert.equal(normalizeEvent(null),null);
  assert.equal(normalizeEvent([]),null);
  assert.equal(normalizeEvent({event:'Bad Event'}),null);
  assert.equal(normalizeEvent({event:'ok',level:'nonsense',status:42,secret:'drop'}).level,'info');
  assert.equal(normalizeEvent({event:'ok',status:42}).status,undefined);
  assert.match(normalizeEvent({event:'ok',detail:'failed C:\\Users\\alice\\AppData token=abc'}).detail,/\[path\]/);
  assert.doesNotMatch(normalizeEvent({event:'ok',detail:'failed C:\\Users\\alice\\AppData token=abc'}).detail,/alice|token=abc/);
  assert.doesNotMatch(redactDetail('C:\\Users\\alice\\x'),/alice/);
  assert.doesNotMatch(redactDetail('api_key=abk_123'),/abk_123/);
  assert.doesNotMatch(redactDetail('Bearer abcdef'),/abcdef/);
  assert.equal(redactDetail('x'.repeat(500)).length,200);
  assert.equal(sanitizePath('/backups/x?token=abc'),'/backups/x');
  assert.equal(sanitizePath('/../etc/passwd'),null);
  assert.equal(sanitizePath('http://evil.test/x'),null);
  assert.equal(sanitizePath('/ok/path'),'/ok/path');
  const dir=await tempDir();
  try{
    assert.equal(await logDiagnostic(dir,null),false);
    assert.equal(await logDiagnostic('',{event:'ok'}),false);
    for(let index=0;index<8;index++){
      const ok=await logDiagnostic(dir,{event:'request-rejected',level:'warn',status:409,code:'WRITE_FAILED',path:'/apply',detail:`C:\\Users\\alice\\secret-${index} token=abc-${index}`},{maxBytes:260,keep:2});
      assert.equal(ok,true);
    }
    const files=(await readdir(dir)).sort();
    assert.ok(files.includes('diagnostics.jsonl'));
    assert.ok(files.includes('diagnostics.1.jsonl'));
    assert.ok(!files.includes('diagnostics.3.jsonl'),files.join(','));
    for(const name of files){
      const info=await stat(join(dir,name));
      assert.ok(info.size<=260+260,name);
    }
    const events=await readDiagnostics(dir);
    assert.ok(events.length>=1);
    assert.ok(events.every(event=>/^\d{4}-\d{2}-\d{2}T/.test(event.time)&&['info','warn','error'].includes(event.level)));
    assert.ok(events.every(event=>Object.keys(event).every(key=>['time','level','event','code','path','status','device','detail'].includes(key))));
    const rawText=(await Promise.all(files.map(name=>readFile(join(dir,name),'utf8')))).join('');
    assert.doesNotMatch(rawText,/alice|abc-\d|C:\\\\/);
    // 人为写入带密钥/路径的“合法形状”行，readDiagnostics 重新归一化后仍不泄露。
    await writeFile(join(dir,'diagnostics.jsonl'),JSON.stringify({time:new Date().toISOString(),event:'tampered',detail:'C:\\Users\\alice token=xyz',secret:'leak'})+'\n','utf8');
    const reread=await readDiagnostics(dir);
    const tampered=reread.find(event=>event.event==='tampered');
    assert.ok(tampered);
    assert.doesNotMatch(JSON.stringify(tampered),/alice|xyz|leak|C:\\\\/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

/* --------------------------------------- P1-06 真实 AstrBot 配置只读核对 bindingRows */

test('P1-06 真实配置只读核对：present 字段绝不误报 field-missing，present+空值保持“待核实”',async t=>{
  let data;
  try{data=await discoverAstrBotData(process.env);}catch(error){t.skip(`本机没有唯一 AstrBot data 目录（${error.code}），跳过真实数据只读核对`);return;}
  const readJSON=async path=>JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
  const hasPath=(object,path)=>{let current=object;for(const key of path.split('.')){if(current===null||typeof current!=='object'||!Object.hasOwn(current,key))return false;current=current[key];}return true;};
  const resources=[
    {kind:'profile',id:'default',config:await readJSON(join(data,'cmd_config.json'))},
    ...(await Promise.all(['astrbot_plugin_group_chat_plus','astrbot_plugin_livingmemory','astrbot_plugin_self_learning','meme_manager'].map(async id=>{
      const config=await readJSON(join(data,'config',`${id}_config.json`));
      return {kind:'plugin',id,config};
    }))),
  ];
  let presentCount=0,presentEmpty=0,absentCount=0;
  for(const {kind,id,config} of resources){
    const rows=bindingRows({kind,id},config,[]);
    for(const row of rows){
      const present=hasPath(config,row.path);
      if(present){
        presentCount++;
        assert.notEqual(row.status,'field-missing',`${kind}:${id} 的 present 字段 ${row.path} 被误报 field-missing`);
        if(row.value===''&&row.inherit!=='session'){presentEmpty++;assert.equal(row.status,'empty-semantics-unverified',`${id} ${row.path}`);}
      }else{
        absentCount++;
        assert.equal(row.status,'field-missing',`${kind}:${id} 的缺失字段 ${row.path} 应为 field-missing`);
      }
    }
  }
  assert.ok(presentCount>0,'真实配置应至少命中一个已审查字段');
  assert.ok(presentEmpty>0,'真实配置当前存在 present+空值字段（stt/tts 等），用于验证“待核实”不被误报');
  // 合成对照：完全缺失的配置全部是 field-missing，空对象里的空字符串才是 empty-semantics-unverified。
  const living={kind:'plugin',id:'astrbot_plugin_livingmemory'};
  assert.ok(bindingRows(living,{},[]).every(row=>row.status==='field-missing'));
  const presentEmptyRow=bindingRows(living,{provider_settings:{embedding_provider_id:''}},[])[0];
  assert.equal(presentEmptyRow.status,'empty-semantics-unverified');
  assert.ok(absentCount>=0,'交叉核对计数仅用于证据（present/absent 分布见审计报告）');
});

/* ----------------------------- P1-10 真实备份目录只读核对 listBackups/readBackupResource */

test('P1-10/只读核对：旧 state/backups 可列出并可读单个资源，且不修改目录 mtime',async t=>{
  const backupsDir=fileURLToPath(new URL('../state/backups',import.meta.url));
  let before;
  try{before=(await stat(backupsDir)).mtimeMs;}catch{t.skip('项目内没有旧的 state/backups 目录，跳过真实备份只读核对');return;}
  const list=await listBackups(backupsDir);
  assert.ok(Array.isArray(list));
  assert.ok(list.length>=1,'旧 state/backups 应至少有一份备份');
  for(const item of list){
    assert.match(item.id,UUID);
    assert.ok(!Number.isNaN(Date.parse(item.createdAt)));
    assert.ok(Number.isInteger(item.bytes)&&item.bytes>0);
    assert.ok(Number.isInteger(item.files)&&item.files>0);
    assert.equal(item.sqlite,'ok');
  }
  const newest=list[0];
  const profile=await readBackupResource(backupsDir,newest.id,{kind:'profile',id:'default'});
  assert.equal(profile.file,'cmd_config.json');
  assert.equal(typeof profile.config,'object');
  const plugin=await readBackupResource(backupsDir,newest.id,{kind:'plugin',id:'astrbot_plugin_livingmemory'});
  assert.equal(plugin.file,'config/astrbot_plugin_livingmemory_config.json');
  assert.equal(typeof plugin.config,'object');
  // 真实 AstrBot 的 provider id 含 "/"（如 <provider>/<model>）：修复后必须可读取；
  // 但路径穿越/反斜杠/盘符/空段仍按 RESTORE_BACKUP_INVALID 拒绝，profile/plugin 保持严格字符集。
  const realProviderId=(profile.config.provider??[])[0]?.id;
  assert.ok(typeof realProviderId==='string'&&realProviderId.length>0,'真实备份应包含 provider');
  assert.match(realProviderId,/\//,'真实 provider id 应含 "/" 以验证本次修复');
  const provider=await readBackupResource(backupsDir,newest.id,{kind:'provider',id:realProviderId});
  assert.equal(provider.file,'cmd_config.json');
  assert.equal(provider.config.id,realProviderId);
  for(const badProvider of ['../x','a/../../b','a\\b','C:/x','a//b','/abs','abs/','x'.repeat(201)]){
    await assert.rejects(()=>readBackupResource(backupsDir,newest.id,{kind:'provider',id:badProvider}),error=>{
      assert.equal(error.message,'RESTORE_BACKUP_INVALID',badProvider);
      return true;
    });
  }
  await assert.rejects(()=>readBackupResource(backupsDir,newest.id,{kind:'plugin',id:'a/b'}),/RESTORE_BACKUP_INVALID/);
  const stats=await backupStats(backupsDir);
  assert.equal(stats.count,list.length);
  assert.equal(stats.items.length,list.length);
  const after=(await stat(backupsDir)).mtimeMs;
  assert.equal(after,before,'只读核对不得修改备份目录 mtime');
});

/* --------------------------------------------------- P1-10 备份产品化（真实模块） */

async function backupDataDir(){
  const root=await tempDir();
  const data=join(root,'data');
  await mkdir(join(data,'config'),{recursive:true});
  await writeFile(join(data,'cmd_config.json'),'{"provider":[{"id":"plain-provider","type":"openai_chat_completion"},{"id":"<provider>/<model>","type":"openai_chat_completion"}]}','utf8');
  await writeFile(join(data,'config','abconf_test.json'),'{"test":true}','utf8');
  const db=new DatabaseSync(join(data,'data_v4.db'));
  db.exec("CREATE TABLE sample(v TEXT);INSERT INTO sample VALUES('ok')");
  db.close();
  return {root,data,dest:join(root,'backups')};
}

test('P1-10 备份产品化：listBackups/stats/prune 返回值与字节上限告警，onWarning 抛错不影响备份',async()=>{
  const {root,data,dest}=await backupDataDir();
  try{
    const warnings=[];
    await backupState(data,dest,{env:{MODEL_CONSOLE_BACKUP_MAX_MB:'0.001'},onWarning:(code,details)=>warnings.push({code,details})});
    assert.ok(warnings.some(warning=>warning.code===BACKUP_SIZE_LIMIT_EXCEEDED));
    assert.ok(warnings.every(warning=>typeof warning.details==='object'));
    const stats=await backupStats(dest);
    assert.equal(stats.count,1);
    assert.ok(stats.bytes>0);
    assert.equal(backupKeep({}),10);
    assert.equal(backupKeep({MODEL_CONSOLE_BACKUP_KEEP:'3'}),3);
    assert.equal(backupMaxBytes({}),2048*1024*1024);
    assert.equal(backupMaxBytes({MODEL_CONSOLE_BACKUP_MAX_MB:'2'}),2*1024*1024);
    for(const invalid of ['0','-1','abc','']){assert.equal(backupMaxBytes({MODEL_CONSOLE_BACKUP_MAX_MB:invalid}),2048*1024*1024);}
    for(let index=0;index<2;index++)await backupState(data,dest,{env:{MODEL_CONSOLE_BACKUP_KEEP:'10'}});
    const listed=await listBackups(dest);
    assert.equal(listed.length,3);
    assert.ok(listed.every(item=>UUID.test(item.id)&&Number.isInteger(item.files)&&item.files>0));
    const provider=await readBackupResource(dest,listed[0].id,{kind:'provider',id:'plain-provider'});
    assert.equal(provider.file,'cmd_config.json');
    assert.equal(provider.config.id,'plain-provider');
    const slashProvider=await readBackupResource(dest,listed[0].id,{kind:'provider',id:'<provider>/<model>'});
    assert.equal(slashProvider.config.id,'<provider>/<model>');
    await assert.rejects(()=>readBackupResource(dest,listed[0].id,{kind:'provider',id:'a/../../b'}),/RESTORE_BACKUP_INVALID/);
    await mkdir(join(dest,'notes'),{recursive:true});
    await writeFile(join(dest,'notes','keep.txt'),'keep','utf8');
    const pruned=await pruneBackups(dest,{keep:2});
    assert.equal(pruned.kept.length,2);
    assert.equal(pruned.removed.length,1);
    assert.ok(pruned.bytes>0);
    assert.ok(pruned.removed.every(path=>UUID.test(path.split(/[\\/]/).at(-1))));
    assert.equal((await stat(join(dest,'notes','keep.txt'))).isFile(),true);
    // onWarning 抛错时必须被吞掉：备份照常完成。
    await backupState(data,dest,{env:{MODEL_CONSOLE_BACKUP_MAX_MB:'0.001'},onWarning:()=>{throw Error('warning boom');}});
    assert.ok((await listBackups(dest)).length>=1);
  }finally{await rm(root,{recursive:true,force:true});}
});

/* --------------------------------------------------- Epic-1 /devices + /snapshot */

function fakeRemoteFactory(snapshotOverrides={}){
  const created=[];
  const factory=device=>{
    const engine={
      gateway:{health:async()=>({reachable:true,latencyMs:3})},
      snapshots:0,
      async snapshot(){
        engine.snapshots++;
        return {readAt:new Date().toISOString(),writeEnabled:false,models:[{id:`model-${device.id}`}],resources:[],routing:{total:0,platformLevel:0,granular:0},...snapshotOverrides};
      },
    };
    created.push({device,engine});
    return engine;
  };
  return {factory,created};
}
const codedError=(code,details)=>{const error=Error(code);error.code=code;if(details)error.details=details;return error;};

test('P1-04 恢复边界：embedding/rerank 差异在计划阶段即被索引迁移规则阻断',async()=>{
  const resource={kind:'plugin',id:'astrbot_plugin_livingmemory'};
  let current={provider_settings:{embedding_provider_id:'emb-a'}};
  const writes=[];
  const gateway={
    read:async r=>r.kind==='profile'
      ?{provider:[{id:'emb-a',type:'openai_embedding',enable:true},{id:'emb-b',type:'openai_embedding',enable:true}]}
      :structuredClone(current),
    resources:async()=>[],
    efforts:async()=>[],
    write:async(_r,next)=>{writes.push(structuredClone(next));current=structuredClone(next);},
  };
  const backups={list:async()=>[],read:async()=>({config:{provider_settings:{embedding_provider_id:'emb-b'}},file:'config/astrbot_plugin_livingmemory_config.json'})};
  const engine=new Engine({gateway,writeEnabled:true,backups,backup:async()=>`C:\\state\\backups\\${BACKUP_1}`,audit:async()=>{}});
  const diff=await engine.backupDiff(BACKUP_1,resource);
  assert.ok(diff.changes.some(change=>change.path==='provider_settings.embedding_provider_id'));
  await assert.rejects(()=>engine.planRestore(BACKUP_1,resource),/INDEX_MIGRATION_REQUIRES_SEPARATE_WORKFLOW/);
  assert.equal(engine.plans.size,0,'索引类恢复不得留下计划');
  assert.equal(writes.length,0,'索引类恢复必须在写入前被阻断');
});

test('Epic-1 /devices：CRUD、secret 分离、重复 409、DELETE true、health 精简',async()=>{
  const {factory}=fakeRemoteFactory();
  await apiFixture({engine:fakeEngine().engine,createRemoteEngine:factory,remoteSnapshotTtlMs:60000},async({base,stateDir})=>{
    assert.equal((await fetch(base+'/devices')).status,403);
    const responses=[];
    const create=async(name,url,key)=>{
      const response=await fetch(base+'/devices',{method:'POST',headers:JSON_HEADERS,body:JSON.stringify({name,baseUrl:url,apiKey:key})});
      responses.push(await response.text());
      assert.equal(response.status,200);
      return JSON.parse(responses.at(-1)).device;
    };
    const a=await create('书房主机','http://192.168.1.20:6185','abk_SECRET_A');
    const b=await create('卧室主机','http://192.168.1.21:6185','abk_SECRET_B');
    for(const device of [a,b]){
      assert.equal(device.kind,'http');
      assert.equal(device.readOnly,true);
      assert.equal(device.hasSecret,true);
      assert.equal('apiKey' in device,false);
    }
    const list=await (await fetch(base+'/devices',{headers:AUTH})).json();
    assert.equal(list.devices[0].id,'local');
    assert.deepEqual(list.devices.slice(1).map(device=>device.id),[a.id,b.id]);
    const listText=JSON.stringify(list);
    assert.doesNotMatch(listText,/abk_SECRET|apiKey/);
    const devicesFile=await readFile(join(stateDir,'devices.json'),'utf8');
    const secretsFile=await readFile(join(stateDir,'secrets.json'),'utf8');
    assert.doesNotMatch(devicesFile,/abk_SECRET/);
    // §9.3：DPAPI 可用时 secrets.json 是 dpapi:<base64>，不可用时降级明文；两种都不能出现在响应/日志。
    const storedSecrets=Object.values(JSON.parse(secretsFile).secrets??{});
    assert.ok(storedSecrets.length>=2);
    if(storedSecrets.some(value=>typeof value==='string'&&value.startsWith('dpapi:'))){
      assert.ok(storedSecrets.every(value=>typeof value==='string'&&value.startsWith('dpapi:')),'DPAPI 可用时必须全部加密');
      assert.doesNotMatch(secretsFile,/abk_SECRET_A|abk_SECRET_B/);
    }else{
      assert.match(secretsFile,/abk_SECRET_A/);
      assert.match(secretsFile,/abk_SECRET_B/);
    }
    // §9.2：http/ssh 设备 readOnly 强制 true，只有 agent 允许 readOnly:false。
    const writable=await (await fetch(base+'/devices',{method:'POST',headers:JSON_HEADERS,body:JSON.stringify({name:'可写设备',baseUrl:'http://192.168.1.22:6185',apiKey:'abk_SECRET_C',readOnly:false})})).json();
    assert.equal(writable.device.readOnly,true,'http 设备 readOnly:false 必须被强制为 true');
    const duplicate=await fetch(base+'/devices',{method:'POST',headers:JSON_HEADERS,body:JSON.stringify({name:'书房主机',baseUrl:'http://192.168.1.20:6185/',apiKey:'abk_SECRET_D'})});
    assert.equal(duplicate.status,409);
    assert.deepEqual(await duplicate.json(),{error:'DEVICE_EXISTS'});
    const afterDuplicate=await (await fetch(base+'/devices',{headers:AUTH})).json();
    assert.equal(afterDuplicate.devices.length,4,'重复设备不得改变注册表');
    // 健康检查只回 {reachable,latencyMs?,error?}（RISK-10），不再附带设备字段。
    const localHealth=await (await fetch(base+'/devices/local/health',{headers:AUTH})).json();
    assert.deepEqual(localHealth,{reachable:true});
    const remoteHealth=await (await fetch(`${base}/devices/${a.id}/health`,{headers:AUTH})).json();
    assert.deepEqual(remoteHealth,{reachable:true,latencyMs:3});
    assert.doesNotMatch(JSON.stringify(remoteHealth),/abk_SECRET|baseUrl|name/);
    // 删除：未知 404、本机 400、远程 200，响应 {removed:true}（RISK-02）。
    assert.equal((await fetch(base+'/devices/missing',{method:'DELETE',headers:AUTH})).status,404);
    assert.equal((await fetch(base+'/devices/local',{method:'DELETE',headers:AUTH})).status,400);
    const deleted=await (await fetch(`${base}/devices/${a.id}`,{method:'DELETE',headers:AUTH})).json();
    assert.deepEqual(deleted,{removed:true});
    assert.equal((await fetch(`${base}/snapshot?device=${encodeURIComponent(a.id)}`,{headers:AUTH})).status,404);
    assert.doesNotMatch(JSON.stringify(responses),/abk_SECRET/);
  });
});

test('Epic-1 /snapshot?device=：按设备隔离缓存、TTL 失效、错误映射 409 且不泄 apiKey/路径',async()=>{
  const {factory,created}=fakeRemoteFactory();
  await apiFixture({engine:fakeEngine().engine,createRemoteEngine:factory,remoteSnapshotTtlMs:25},async({base,stateDir,server})=>{
    const a=await addDevice(stateDir,{id:'remote-a',name:'A',baseUrl:'http://127.0.0.1:7'},'abk_KEY_A');
    const b=await addDevice(stateDir,{id:'remote-b',name:'B',baseUrl:'http://127.0.0.1:6'},'abk_KEY_B');
    // 先 B 后 A：证明缓存按 deviceId 隔离而不是按请求顺序复用。
    const first=await (await fetch(`${base}/snapshot?device=${encodeURIComponent(b.id)}`,{headers:AUTH})).json();
    assert.deepEqual(first.device,{id:'remote-b',name:'B',kind:'http'});
    assert.equal(first.models[0].id,'model-remote-b');
    assert.equal(created.length,1);
    const second=await (await fetch(`${base}/snapshot?device=${encodeURIComponent(a.id)}`,{headers:AUTH})).json();
    assert.deepEqual(second.device,{id:'remote-a',name:'A',kind:'http'});
    assert.equal(second.models[0].id,'model-remote-a');
    assert.equal(created.length,2);
    const cached=await (await fetch(`${base}/snapshot?device=${encodeURIComponent(a.id)}`,{headers:AUTH})).json();
    assert.deepEqual(cached,second);
    assert.equal(created.find(item=>item.device.id==='remote-a').engine.snapshots,1);
    await new Promise(resolve=>setTimeout(resolve,60));
    await fetch(`${base}/snapshot?device=${encodeURIComponent(a.id)}`,{headers:AUTH});
    assert.equal(created.find(item=>item.device.id==='remote-a').engine.snapshots,2);
    // 本地快照带 local device 标签；无 device 参数/device=local 等价。
    const local=await (await fetch(base+'/snapshot',{headers:AUTH})).json();
    assert.deepEqual(local.device,{id:'local',name:'本机',kind:'local'});
    const explicitLocal=await (await fetch(base+'/snapshot?device=local',{headers:AUTH})).json();
    assert.deepEqual(explicitLocal.device,{id:'local',name:'本机',kind:'local'});
    assert.deepEqual(explicitLocal.models,local.models);
    assert.doesNotMatch(JSON.stringify(first)+JSON.stringify(second),/abk_KEY|C:\\\\|alice/);
  });
});

test('Epic-1 远程错误映射：DEVICE_* → 409，details 白名单，响应与诊断均不含 apiKey/路径',async()=>{
  const createRemoteEngine=device=>{
    if(device.id==='bad-auth')throw codedError('DEVICE_AUTH_FAILED',{path:`C:\\Users\\alice\\${BACKUP_1}`,token:'abk_KEY_A',backupId:`C:\\x\\${BACKUP_1}`});
    if(device.id==='bad-forbidden')throw codedError('DEVICE_FORBIDDEN');
    return {gateway:{},snapshot:async()=>{throw codedError('DEVICE_UNREACHABLE',{token:'abk_KEY_B',path:'/secret'});}};
  };
  await apiFixture({engine:fakeEngine().engine,createRemoteEngine},async({base,stateDir,server})=>{
    for(const id of ['bad-auth','bad-forbidden','bad-unreachable'])await addDevice(stateDir,{id,name:id,baseUrl:`http://127.0.0.1:${id.length}`},'abk_KEY_A');
    for(const [id,code] of [['bad-auth','DEVICE_AUTH_FAILED'],['bad-forbidden','DEVICE_FORBIDDEN'],['bad-unreachable','DEVICE_UNREACHABLE']]){
      const response=await fetch(`${base}/snapshot?device=${id}`,{headers:AUTH});
      assert.equal(response.status,409,id);
      const text=JSON.stringify(await response.json());
      assert.equal(JSON.parse(text).error,code,id);
      assert.doesNotMatch(text,/C:\\\\|alice|abk_KEY|secret/i);
    }
    // 4xx 诊断只记 code/path/status，不含 apiKey、绝对路径。
    await server.flushDiagnostics();
    const journal=await readFile(join(stateDir,'diagnostics.jsonl'),'utf8');
    assert.match(journal,/DEVICE_AUTH_FAILED/);
    assert.doesNotMatch(journal,/abk_KEY|C:\\\\|alice|Bearer/i);
    const exported=await (await fetch(base+'/diagnostics/export',{headers:AUTH})).json();
    assert.ok(Array.isArray(exported.events));
    assert.doesNotMatch(JSON.stringify(exported),/abk_KEY|C:\\\\|alice/);
  });
});

/* -------------------------------------------------- 409 白名单 + 诊断脱敏（回归） */

test('409 白名单：engine 失败 details 含绝对路径/token 时响应与诊断均不外泄',async()=>{
  const failure=Error('WRITE_FAILED');
  failure.details={id:PLAN_ID,backupId:`C:\\Users\\alice\\AppData\\backups\\${BACKUP_1}`,outcome:'possibly-written',path:'C:\\Windows',token:TOKEN,authorization:`Bearer ${TOKEN}`};
  const {engine}=fakeEngine({apply:async()=>{throw failure;}});
  await apiFixture({engine},async({base,stateDir,server})=>{
    const response=await fetch(base+'/apply',{method:'POST',headers:JSON_HEADERS,body:JSON.stringify({id:PLAN_ID})});
    assert.equal(response.status,409);
    const text=await response.text();
    const body=JSON.parse(text);
    assert.deepEqual(body,{error:'WRITE_FAILED',id:PLAN_ID,outcome:'possibly-written'});
    assert.doesNotMatch(text,/C:\\\\|alice|Windows|Bearer|sprint-token/);
    await server.flushDiagnostics();
    const journal=await readFile(join(stateDir,'diagnostics.jsonl'),'utf8');
    assert.match(journal,/WRITE_FAILED/);
    assert.doesNotMatch(journal,/C:\\\\|alice|Bearer|sprint-token|Windows/);
  });
});
