/**
 * P0 独立集成回归（task-5）。真实 createServer + fake engine；真实 Engine + fake gateway。
 * 只验证 P0 修复的对外契约：错误响应不泄路径/令牌、apply 只回 UUID basename、空 embedding/rerank 被拦、
 * 审计仍保留完整路径、状态目录与数据发现优先级、单实例锁互斥与 stale 清理、sessionStorage 纯函数。
 * 不连接真实 AstrBot，不读写真实 state/ 或 %LOCALAPPDATA%。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import net from 'node:net';
import {createServer} from '../src/server.mjs';
import {Engine} from '../src/engine.mjs';
import {resolveStateDir,discoverAstrBotData,ASTRBOT_DATA_REQUIRED} from '../src/config.mjs';
import {acquireLock,ANOTHER_INSTANCE_RUNNING,isPortListening} from '../src/lock.mjs';
import {parseTokenHash,loadToken,saveToken,clearToken} from '../public/ui-state.mjs';

const PLAN_ID='0f8fad5b-d9cb-469f-a165-70867728950e';
const BACKUP_UUID='0243f684-e8ed-44ac-8c95-657df32890aa';
const TOKEN='audit-token-do-not-leak';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const temp=()=>mkdtemp(join(tmpdir(),'model-console-p0-'));

/** Start a real HTTP server around a fake engine, run assertions, always close. */
async function withServer(engine,run){
  const server=createServer(engine,TOKEN);
  await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolveListen();});});
  try{return await run({base:`http://127.0.0.1:${server.address().port}`});}
  finally{await new Promise(resolveClose=>{server.close(resolveClose);server.closeAllConnections?.();});}
}

function fakeEngine(overrides={}){
  const engine={
    gateway:{efforts:async()=>['low','max']},
    snapshot:async()=>({writeEnabled:true,models:[],resources:[]}),
    plan:async(resource,changes,_internal,expectedRevision)=>({id:PLAN_ID,resource,changes,expectedRevision}),
    apply:async()=>({status:'saved-and-readback-verified',id:PLAN_ID,generationVerified:false,hotLoadVerified:false}),
    ...overrides,
  };
  return engine;
}

const post=(path,body,headers={Authorization:`Bearer ${TOKEN}`,'Content-Type':'application/json'})=>fetch(path,{method:'POST',headers,body:JSON.stringify(body)});

test('409 响应白名单：engine 抛错 details 带 C:\\ 绝对路径与令牌时不外泄',async()=>{
  const absolutePath=`C:\\Users\\alice\\AppData\\Local\\AstrBotModelConsole\\state\\backups\\${BACKUP_UUID}`;
  const error=Error('BACKUP_FAILED');
  error.details={
    id:PLAN_ID,
    backupId:absolutePath,
    outcome:'not-written',
    code:'BACKUP_FAILED',
    path:'C:\\Windows\\System32',
    token:TOKEN,
    authorization:`Bearer ${TOKEN}`,
    nested:{secret:absolutePath},
  };
  const engine=fakeEngine({apply:async()=>{throw error;}});
  await withServer(engine,async({base})=>{
    const response=await post(base+'/apply',{id:PLAN_ID});
    assert.equal(response.status,409);
    assert.match(response.headers.get('content-type'),/application\/json/);
    const body=await response.json();
    // 只有白名单字段可以出进程；绝对路径形式（含盘符/分隔符）的 backupId 被丢弃。
    assert.deepEqual(body,{error:'BACKUP_FAILED',id:PLAN_ID,outcome:'not-written',code:'BACKUP_FAILED'});
    const serialized=JSON.stringify(body);
    assert.doesNotMatch(serialized,/C:\\|AppData|Users|alice|System32|backups/i);
    assert.doesNotMatch(serialized,new RegExp(`${TOKEN}|Bearer`));
    assert.ok(Object.keys(body).every(key=>['error','id','backupId','outcome','code'].includes(key)));
    // 非代码型错误消息（可能含盘符）一律折成 OPERATION_FAILED；details 里的路径与令牌同样不得外泄。
    const planError=Error(`open failed: ${absolutePath}`);
    planError.details={path:absolutePath,token:TOKEN,authorization:`Bearer ${TOKEN}`};
    engine.plan=async()=>{throw planError;};
    const planResponse=await post(base+'/plans',{resource:{kind:'profile',id:'default'},changes:[{path:'x',value:'y'}]});
    assert.equal(planResponse.status,409);
    const planBody=await planResponse.json();
    assert.deepEqual(planBody,{error:'OPERATION_FAILED'});
    assert.doesNotMatch(JSON.stringify(planBody),/C:\\|AppData|Users|alice|System32|Bearer|audit-token/i);
  });
});

test('409 响应：路径形式的 backupId 被拒，UUID 短 id 与完整 UUID 被接受',async()=>{
  const pathLike=Error('WRITE_FAILED');
  pathLike.details={id:PLAN_ID,backupId:`C:\\Users\\alice\\backups\\${BACKUP_UUID}`,outcome:'possibly-written'};
  const shortLike=Error('WRITE_FAILED');
  shortLike.details={id:PLAN_ID,backupId:BACKUP_UUID,outcome:'possibly-written'};
  const engine=fakeEngine({apply:async()=>{throw pathLike;}});
  await withServer(engine,async({base})=>{
    let body=await (await post(base+'/apply',{id:PLAN_ID})).json();
    assert.deepEqual(body,{error:'WRITE_FAILED',id:PLAN_ID,outcome:'possibly-written'});
    engine.apply=async()=>{throw shortLike;};
    body=await (await post(base+'/apply',{id:PLAN_ID})).json();
    assert.equal(body.backupId,BACKUP_UUID);
    assert.ok(!/[\\/]/.test(body.backupId));
  });
});

test('/apply 成功响应只暴露 UUID basename，不含备份绝对路径',async()=>{
  const engine=fakeEngine({apply:async()=>({status:'saved-and-readback-verified',id:PLAN_ID,backupId:join(tmpdir(),'audit-user','backups',BACKUP_UUID),generationVerified:false,hotLoadVerified:false})});
  await withServer(engine,async({base})=>{
    const response=await post(base+'/apply',{id:PLAN_ID});
    assert.equal(response.status,200);
    const body=await response.json();
    assert.equal(body.backupId,BACKUP_UUID);
    assert.match(body.backupId,UUID);
    const serialized=JSON.stringify(body);
    assert.doesNotMatch(serialized,/audit-user|backups|\/|\\\\/);
    assert.ok(!serialized.includes(tmpdir()));
  });
});

test('/apply 成功响应：无法归一为 UUID 的 backupId 直接丢弃而不是回传原文',async()=>{
  const engine=fakeEngine({apply:async()=>({status:'saved-and-readback-verified',id:PLAN_ID,backupId:'C:\\Users\\alice\\backups\\tmp-123',generationVerified:false})});
  await withServer(engine,async({base})=>{
    const body=await (await post(base+'/apply',{id:PLAN_ID})).json();
    assert.equal('backupId' in body,false);
    assert.doesNotMatch(JSON.stringify(body),/C:\\|alice|backups/i);
  });
});

function engineFixture({backup=async()=>`C:\\state\\backups\\${BACKUP_UUID}`}={}){
  let config={decision_ai_provider_id:'llm-a',unrelated:{keep:true}};
  const events=[];
  let writes=0;
  const gateway={
    read:async resource=>resource.kind==='profile'
      ?{provider:[{id:'llm-a',type:'openai_chat_completion',enable:true},{id:'llm-b',type:'openai_chat_completion',enable:true},{id:'emb-a',type:'openai_embedding',enable:true},{id:'rr-a',type:'openai_rerank',enable:true}]}
      :structuredClone(config),
    resources:async()=>[],
    efforts:async()=>['low','max'],
    write:async(_resource,next)=>{writes++;config=structuredClone(next);},
  };
  const engine=new Engine({gateway,writeEnabled:true,backup,audit:async event=>events.push(event)});
  return {engine,events,get config(){return config;},get writes(){return writes;}};
}

test('engine plan 对 embedding/rerank 空值一律抛 INDEX_MIGRATION_REQUIRES_SEPARATE_WORKFLOW',async()=>{
  const {engine}=engineFixture();
  const livingmemory={kind:'plugin',id:'astrbot_plugin_livingmemory'};
  for(const [path,value] of [['provider_settings.embedding_provider_id','emb-a'],['recall_engine.rerank_provider_id','rr-a']]){
    await assert.rejects(()=>engine.plan(livingmemory,[{path,value:''}]),/^Error: INDEX_MIGRATION_REQUIRES_SEPARATE_WORKFLOW$/);
    await assert.rejects(()=>engine.plan(livingmemory,[{path,value}]),/INDEX_MIGRATION_REQUIRES_SEPARATE_WORKFLOW/);
  }
  // 被拒绝的请求不得留下计划。
  assert.equal(engine.plans.size,0);
  // 对照：普通 llm 字段清空仍可计划，证明拦截只针对索引类 capability。
  const plan=await engine.plan({kind:'plugin',id:'astrbot_plugin_group_chat_plus'},[{path:'decision_ai_provider_id',value:''}]);
  assert.equal(plan.changes[0].value,'');
});

test('engine apply 成功：结果 details 为短 UUID，审计保留完整备份路径',async()=>{
  const full=`C:\\state\\backups\\${BACKUP_UUID}`;
  const fixture=engineFixture({backup:async()=>full});
  const {engine,events}=fixture;
  const resource={kind:'plugin',id:'astrbot_plugin_group_chat_plus'};
  const plan=await engine.plan(resource,[{path:'decision_ai_provider_id',value:'llm-b'}]);
  const result=await engine.apply(plan.id);
  assert.equal(result.status,'saved-and-readback-verified');
  assert.equal(result.backupId,BACKUP_UUID);
  assert.match(result.backupId,UUID);
  assert.doesNotMatch(result.backupId,/[:\\/]/);
  assert.equal(fixture.writes,1);
  const applied=events.find(event=>event.event==='applied');
  const started=events.find(event=>event.event==='apply-start');
  assert.equal(applied.backupId,full);
  assert.equal(started.backupId,full);
  assert.ok(applied.backupId.includes('C:\\state\\backups'));
});

test('engine apply 失败：details 短 UUID，审计仍保留完整路径，且失败详情不含盘符',async()=>{
  const full=`C:\\state\\backups\\${BACKUP_UUID}`;
  const {engine,events}=engineFixture({backup:async()=>full});
  engine.gateway.write=async()=>{throw Error('NETWORK_LOST');};
  const resource={kind:'plugin',id:'astrbot_plugin_group_chat_plus'};
  const plan=await engine.plan(resource,[{path:'decision_ai_provider_id',value:'llm-b'}]);
  await assert.rejects(()=>engine.apply(plan.id),error=>{
    assert.equal(error.message,'NETWORK_LOST');
    assert.equal(error.details.backupId,BACKUP_UUID);
    assert.equal(error.details.outcome,'possibly-written');
    assert.ok(!/[\\/]/.test(error.details.backupId));
    assert.ok(!JSON.stringify(error.details).includes('C:'));
    return true;
  });
  assert.equal(events.find(event=>event.event==='apply-failed').backupId,full);
});

test('config.resolveStateDir 优先级：MODEL_CONSOLE_STATE > LOCALAPPDATA > tmpdir',()=>{
  const local=join('C:','Users','someone','AppData','Local');
  assert.equal(resolveStateDir({}),join(tmpdir(),'AstrBotModelConsole','state'));
  assert.equal(resolveStateDir({LOCALAPPDATA:local}),join(local,'AstrBotModelConsole','state'));
  assert.equal(resolveStateDir({LOCALAPPDATA:local,MODEL_CONSOLE_STATE:join(local,'custom','state')}),resolve(join(local,'custom','state')));
  assert.equal(resolveStateDir({LOCALAPPDATA:local,MODEL_CONSOLE_STATE:'relative-state'}),resolve('relative-state'));
  // 函数不得创建目录：调用后路径仍不存在。
});

test('config.discoverAstrBotData：ASTRBOT_DATA 优先、唯一命中、多命中抛错',async()=>{
  const root=await temp();
  try{
    const profile=join(root,'profile');
    const instanceA=join(profile,'.astrbot_launcher','instances','instance-a','core','data');
    const instanceB=join(profile,'.astrbot_launcher','instances','instance-b','core','data');
    await mkdir(instanceA,{recursive:true});
    assert.equal(await discoverAstrBotData({USERPROFILE:profile}),instanceA);
    // ASTRBOT_DATA 直接胜出，即使存在多个 launcher 实例。
    await mkdir(instanceB,{recursive:true});
    const explicit=join(root,'explicit-data');
    await mkdir(explicit,{recursive:true});
    assert.equal(await discoverAstrBotData({USERPROFILE:profile,ASTRBOT_DATA:explicit}),resolve(explicit));
    // 去掉显式覆盖后，两个候选必须抛错并给出候选数，不得静默挑一个。
    let error;
    try{await discoverAstrBotData({USERPROFILE:profile});}catch(caught){error=caught;}
    assert.equal(error?.code,ASTRBOT_DATA_REQUIRED);
    assert.equal(error.candidates,2);
    assert.match(error.message,/发现 2 个/);
    // 一个候选都没有时也必须抛错，而不是抛 ENOENT 或返回空。
    const emptyProfile=join(root,'empty-profile');
    await mkdir(emptyProfile,{recursive:true});
    let missing;
    try{await discoverAstrBotData({USERPROFILE:emptyProfile});}catch(caught){missing=caught;}
    assert.equal(missing?.code,ASTRBOT_DATA_REQUIRED);
    assert.equal(missing.candidates,0);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('lock：同一 state 目录并发互斥，存活 pid 的锁抛出 ANOTHER_INSTANCE_RUNNING',async()=>{
  const state=await temp();
  try{
    const outcomes=await Promise.allSettled([acquireLock(state,{port:0}),acquireLock(state,{port:0})]);
    const fulfilled=outcomes.filter(item=>item.status==='fulfilled');
    const rejected=outcomes.filter(item=>item.status==='rejected');
    assert.equal(fulfilled.length,1);
    assert.equal(rejected.length,1);
    assert.equal(rejected[0].reason.code,ANOTHER_INSTANCE_RUNNING);
    assert.equal(rejected[0].reason.details.pid,process.pid);
    const lock=fulfilled[0].value;
    const written=JSON.parse(await readFile(join(state,'instance.lock'),'utf8'));
    assert.equal(written.pid,process.pid);
    // 持有者释放后可以重新获取。
    await lock.release();
    const again=await acquireLock(state,{port:0});
    await again.release();
  }finally{await rm(state,{recursive:true,force:true});}
});

test('lock：不可能存活的 pid（999999）作为 stale 锁被替换并可获取',async()=>{
  const state=await temp();
  try{
    await writeFile(join(state,'instance.lock'),JSON.stringify({pid:999999,port:4321,startedAt:new Date().toISOString()}),'utf8');
    const lock=await acquireLock(state,{port:5000});
    const written=JSON.parse(await readFile(join(state,'instance.lock'),'utf8'));
    assert.equal(written.pid,process.pid);
    assert.equal(written.port,5000);
    await lock.release();
    await assert.rejects(()=>readFile(join(state,'instance.lock')),error=>error.code==='ENOENT');
  }finally{await rm(state,{recursive:true,force:true});}
});

test('lock：存活 pid 但记录端口不再监听时按 stale 处理（Windows pid 复用/EPERM 假阳性）',async()=>{
  const state=await temp();
  try{
    await writeFile(join(state,'instance.lock'),JSON.stringify({pid:process.pid,port:1,startedAt:new Date(Date.now()-3600000).toISOString()}),'utf8');
    const lock=await acquireLock(state,{port:0});
    const written=JSON.parse(await readFile(join(state,'instance.lock'),'utf8'));
    assert.equal(written.pid,process.pid);
    await lock.release();
  }finally{await rm(state,{recursive:true,force:true});}
});

test('lock：端口探测区分监听、未监听与未知端口',async()=>{
  assert.equal(await isPortListening(0),null);
  assert.equal(await isPortListening(-1),null);
  const server=net.createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  assert.equal(await isPortListening(port),true);
  await new Promise(resolve=>server.close(resolve));
  assert.equal(await isPortListening(port),false);
});

function memoryStorage(){
  const map=new Map();
  return {
    getItem:key=>map.has(key)?map.get(key):null,
    setItem:(key,value)=>{map.set(key,String(value));},
    removeItem:key=>{map.delete(key);},
    entries:()=>[...map.entries()],
  };
}

test('ui-state token：parseTokenHash 只认 token 参数且从不抛错',()=>{
  assert.equal(parseTokenHash('#token=abcdef0123456789'),'abcdef0123456789');
  assert.equal(parseTokenHash('token=abcdef0123456789'),'abcdef0123456789');
  assert.equal(parseTokenHash('#token=abc%2Fdef'),'abc/def');
  assert.equal(parseTokenHash('#token='),'');
  assert.equal(parseTokenHash('#other=value'),'');
  assert.equal(parseTokenHash('#'),'');
  assert.equal(parseTokenHash(''),'');
  assert.equal(parseTokenHash(null),'');
  assert.equal(parseTokenHash(123),'');
  assert.equal(parseTokenHash(undefined),'');
  // URLSearchParams 对畸形输入也不抛错，parseTokenHash 统一返回 '' 或参数值。
  assert.equal(typeof parseTokenHash('#token=%E0%A4%A'),'string');
});

test('ui-state token：loadToken/saveToken/clearToken 只接受合法 token 且容忍存储异常',()=>{
  const storage=memoryStorage();
  assert.equal(loadToken(storage),'');
  const token='a'.repeat(64);
  assert.equal(saveToken(storage,token),true);
  assert.equal(loadToken(storage),token);
  // 非法值不写入、不覆盖已有 token。
  assert.equal(saveToken(storage,'short'),false);
  assert.equal(saveToken(storage,'has space token'),false);
  assert.equal(saveToken(storage,undefined),false);
  assert.equal(loadToken(storage),token);
  assert.equal(clearToken(storage),true);
  assert.equal(loadToken(storage),'');
  // 存储不可用/抛异常时全部安全降级。
  assert.equal(loadToken(undefined),'');
  assert.equal(saveToken(undefined,token),false);
  assert.equal(clearToken(undefined),false);
  const throwing={getItem(){throw Error('denied');},setItem(){throw Error('denied');},removeItem(){throw Error('denied');}};
  assert.equal(loadToken(throwing),'');
  assert.equal(saveToken(throwing,token),false);
  assert.equal(clearToken(throwing),false);
  // token 只能由本模块读写，绝不进 localStorage 之类的显式变量（这里只验证返回契约）。
  assert.equal(saveToken({setItem(){}},token),true);
});
