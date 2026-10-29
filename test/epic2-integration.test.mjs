/**
 * Epic-2 / Epic-3 独立集成审计（task-21）。
 *
 * 独立于 worker 自测：真实 createServer + 真实 startAgent（配对 → 快照 → 删除）、注入式 SSH 隧道、
 * RISK 04/05/07/08/09/10 回归、Epic-3 打包静态 + 临时产物检查。
 * 不连真实 ssh/远端/AstrBot，不读写真实 state/；所有临时目录用 mkdtemp。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createServer,DIAGNOSTICS_RATE_LIMIT,resetDiagnosticsRateLimit} from '../src/server.mjs';
import {Engine} from '../src/engine.mjs';
import {addDevice} from '../src/devices.mjs';
import {logDiagnostic} from '../src/diagnostics.mjs';
import {startAgent} from '../src/agent.mjs';
import {configVersionText} from '../public/ui-state.mjs';

const REPO=fileURLToPath(new URL('..',import.meta.url));
const TOKEN='epic2-hub-token-do-not-leak';
const AUTH={Authorization:`Bearer ${TOKEN}`};
const JSON_HEADERS={...AUTH,'Content-Type':'application/json'};
const BACKUP_1='bc1257f4-c25a-48a5-b74c-8e5246c0664a';
const PLAN_ID='0f8fad5b-d9cb-469f-a165-70867728950e';
const sha256=value=>createHash('sha256').update(value,'utf8').digest('hex');
const codeError=(code,details)=>{const error=Error(code);error.code=code;if(details)error.details=details;return error;};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

let seq=0;
const tempDir=async prefix=>mkdtemp(join(tmpdir(),`model-console-${prefix}-${++seq}-`));

function hostEngine(overrides={}){
  return {
    writeEnabled:false,
    gateway:{efforts:async()=>['low']},
    snapshot:async()=>({readAt:new Date().toISOString(),writeEnabled:false,configVersion:'4.29.3',models:[],resources:[],routing:{total:0,platformLevel:0,granular:0}}),
    listBackups:async()=>[],
    backupStats:async()=>({count:0,bytes:0}),
    planRestore:async()=>({id:PLAN_ID,resource:{kind:'profile',id:'default'},revision:'r1',changes:[],warning:'恢复会覆盖完整对象'}),
    ...overrides,
  };
}

/** Real createServer with a temp state dir; all Epic-2 seams are injectable options. */
async function hubFixture({engine=hostEngine(),stateDir,deviceStateDir,options={}},run){
  const root=await tempDir('hub');
  const hubState=stateDir??join(root,'state');
  const server=createServer(engine,TOKEN,{
    staticRoot:root,
    health:{stateDir:hubState,dataPath:join(root,'data'),readOnly:true},
    deviceStateDir:deviceStateDir??hubState,
    ...options,
  });
  await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolveListen();});});
  try{
    return await run({base:`http://127.0.0.1:${server.address().port}`,server,stateDir:hubState,root});
  }finally{
    await new Promise(resolveClose=>{server.close(resolveClose);server.closeAllConnections?.();});
    await server.flushDiagnostics();
    resetDiagnosticsRateLimit();
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
}

/** Gateway stub good enough for the real Engine used by the ssh branch. */
function fakeUpstreamGateway({configVersion=7,health={reachable:true,latencyMs:5}}={}){
  return {
    read:async resource=>resource.kind==='profile'?{provider:[],config_version:configVersion}:{},
    resources:async()=>[],
    efforts:async()=>[],
    routingSummary:async()=>({total:0,platformLevel:0,granular:0}),
    health:async()=>health,
  };
}

/* --------------------------------------------------------------- Epic-2: SSH */

test('Epic-2 SSH：注入隧道完成创建/健康/快照/删除关闭，公开视图不泄露 keyPath/dataPath/apiKey',async()=>{
  const opened=[],closed=[],gateways=[];
  const options={
    createSshTunnel:async device=>{opened.push(device);return {baseUrl:'http://127.0.0.1:4599',close:async()=>{closed.push(device.id);}};},
    createHttpGateway:(device,{baseUrl,apiKey})=>{gateways.push({device,baseUrl,apiKey});return fakeUpstreamGateway({configVersion:7});},
  };
  await hubFixture({options},async({base,stateDir})=>{
    const created=await (await fetch(base+'/devices',{method:'POST',headers:JSON_HEADERS,body:JSON.stringify({
      name:'云主机',kind:'ssh',baseUrl:'http://127.0.0.1:6185',apiKey:'abk_SSH_SECRET',
      ssh:{host:'10.0.0.9',user:'root',port:2222,keyPath:'C:\\keys\\id_ed25519',dataPath:'C:\\AstrBot\\data'},
    })})).json();
    const device=created.device;
    assert.equal(device.kind,'ssh');
    assert.equal(device.hasSecret,true);
    assert.deepEqual(device.ssh,{host:'10.0.0.9',user:'root',port:2222});
    const serialized=JSON.stringify(device);
    assert.doesNotMatch(serialized,/id_ed25519|AstrBot\\\\data|abk_SSH_SECRET|keyPath|dataPath/);
    const registry=await readFile(join(stateDir,'devices.json'),'utf8');
    assert.match(registry,/id_ed25519/,'内部 ssh 配置仍需落库供连接使用');
    assert.doesNotMatch(registry,/abk_SSH_SECRET/);
    // §9.3：DPAPI 可用时落 dpapi:<base64>；不可用时降级明文（都不得出现在响应/日志）。
    const sshSecrets=await readFile(join(stateDir,'secrets.json'),'utf8');
    const sshStored=Object.values(JSON.parse(sshSecrets).secrets??{});
    assert.ok(sshStored.length>=1);
    if(sshStored.every(value=>typeof value==='string'&&value.startsWith('dpapi:')))assert.doesNotMatch(sshSecrets,/abk_SSH_SECRET/);
    else assert.match(sshSecrets,/abk_SSH_SECRET/);
    // 健康检查走同一隧道；只回 reachable/latencyMs/error。
    const health=await (await fetch(`${base}/devices/${device.id}/health`,{headers:AUTH})).json();
    assert.deepEqual(health,{reachable:true,latencyMs:5});
    assert.equal(opened.length,1);
    assert.equal(opened[0].ssh.dataPath,'C:\\AstrBot\\data');
    assert.equal(gateways[0].baseUrl,'http://127.0.0.1:4599');
    assert.equal(gateways[0].apiKey,'abk_SSH_SECRET');
    // 快照：真实 Engine + fake upstream gateway，configVersion 来自远端配置；强制只读、带 device 标签。
    const snapshot=await (await fetch(`${base}/snapshot?device=${encodeURIComponent(device.id)}`,{headers:AUTH})).json();
    assert.equal(snapshot.writeEnabled,false);
    assert.equal(snapshot.configVersion,7);
    assert.deepEqual(snapshot.device,{id:device.id,name:'云主机',kind:'ssh'});
    await fetch(`${base}/snapshot?device=${encodeURIComponent(device.id)}`,{headers:AUTH});
    assert.equal(opened.length,1,'5 秒缓存内不得重复建隧道');
    const removed=await fetch(`${base}/devices/${encodeURIComponent(device.id)}`,{method:'DELETE',headers:AUTH});
    assert.deepEqual(await removed.json(),{removed:true});
    assert.deepEqual(closed,[device.id]);
    assert.equal((await fetch(`${base}/snapshot?device=${encodeURIComponent(device.id)}`,{headers:AUTH})).status,404);
    assert.equal((await fetch(`${base}/devices/${encodeURIComponent(device.id)}/health`,{headers:AUTH})).status,404);
  });
});

test('Epic-2 SSH 错误映射：DEVICE_PORT_UNKNOWN / DEVICE_SSH_UNAVAILABLE / DEVICE_SSH_FAILED → 409 且不泄露细节',async()=>{
  const options={
    createSshTunnel:async device=>{
      if(device.ssh.host==='no-port')throw codeError('DEVICE_PORT_UNKNOWN',{path:'C:\\Users\\alice\\secret'});
      if(device.ssh.host==='no-ssh')throw codeError('DEVICE_SSH_UNAVAILABLE',{token:'secret-token'});
      throw codeError('DEVICE_SSH_FAILED',{backupId:`C:\\x\\${BACKUP_1}`});
    },
  };
  await hubFixture({options},async({base,stateDir,server})=>{
    for(const [index,[id,host,code]] of [['ssh-port','no-port','DEVICE_PORT_UNKNOWN'],['ssh-bin','no-ssh','DEVICE_SSH_UNAVAILABLE'],['ssh-fail','broken','DEVICE_SSH_FAILED']].entries()){
      await addDevice(stateDir,{id,name:id,kind:'ssh',baseUrl:`http://127.0.0.1:${7000+index}`,ssh:{host,user:'root'}},`abk_${id}`);
      const snapshot=await fetch(`${base}/snapshot?device=${id}`,{headers:AUTH});
      assert.equal(snapshot.status,409,id);
      const body=await snapshot.json();
      assert.deepEqual(body,{error:code},id);
      assert.doesNotMatch(JSON.stringify(body),/C:\\\\|alice|token|backup/i);
      // 隧道建立失败在 health 路由同样以 409 稳定码返回（不是 200 reachable:false）。
      const health=await fetch(`${base}/devices/${id}/health`,{headers:AUTH});
      assert.equal(health.status,409,id);
      assert.deepEqual(await health.json(),{error:code},id);
    }
    await server.flushDiagnostics();
    const journal=await readFile(join(stateDir,'diagnostics.jsonl'),'utf8');
    assert.doesNotMatch(journal,/C:\\\\|alice|secret-token|abk_/i);
  });
});

/* ------------------------------------------------- Epic-2: Agent 真实链路 */

test('Epic-2 Agent：真实 startAgent + 真实 createServer 配对→快照→删除，状态只存哈希且远程只读',async()=>{
  const agentRoot=await tempDir('agent');
  const agentState=join(agentRoot,'state');
  const agentEngine={
    snapshots:0,
    async snapshot(){agentEngine.snapshots++;return {readAt:new Date().toISOString(),writeEnabled:true,configVersion:5,models:[{id:'agent-model'}],resources:[],routing:{total:0,platformLevel:0,granular:0}};},
  };
  let agent;
  try{
    agent=await startAgent({stateDir:agentState,engine:agentEngine});
    const before=JSON.parse(await readFile(join(agentState,'agent.json'),'utf8'));
    assert.equal(before.tokenHash,null);
    assert.equal(before.pairing.hash,sha256(agent.pairingCode));
    const beforeText=await readFile(join(agentState,'agent.json'),'utf8');
    assert.doesNotMatch(beforeText,new RegExp(agent.pairingCode));

    await hubFixture({options:{remoteSnapshotTtlMs:60000}},async({base,stateDir})=>{
      // 缺 pairingCode → 400；错误 pairingCode 经真实 AgentAdapter 映射为 AGENT_UNAUTHORIZED → 409。
      let response=await fetch(base+'/devices',{method:'POST',headers:JSON_HEADERS,body:JSON.stringify({name:'Agent',kind:'agent',baseUrl:agent.url})});
      assert.equal(response.status,400);
      assert.deepEqual(await response.json(),{error:'DEVICE_SECRET_REQUIRED'});
      const wrong=String((Number(agent.pairingCode)+1)%100000000).padStart(8,'0');
      response=await fetch(base+'/devices',{method:'POST',headers:JSON_HEADERS,body:JSON.stringify({name:'Agent',kind:'agent',baseUrl:agent.url,pairingCode:wrong})});
      assert.equal(response.status,409);
      assert.deepEqual(await response.json(),{error:'AGENT_UNAUTHORIZED'});

      // 正确配对：真实 HTTP 到 agent，token 只进 secrets.json。
      response=await fetch(base+'/devices',{method:'POST',headers:JSON_HEADERS,body:JSON.stringify({name:'Agent',kind:'agent',baseUrl:agent.url,pairingCode:agent.pairingCode})});
      assert.equal(response.status,200);
      const {device}=await response.json();
      assert.equal(device.kind,'agent');
      assert.equal(device.hasSecret,true);
      assert.equal('pairingCode' in device,false);
      assert.doesNotMatch(JSON.stringify(device),/token|pairingCode/i);
      const secretsText=await readFile(join(stateDir,'secrets.json'),'utf8');
      const storedSecret=JSON.parse(secretsText).secrets[device.id];
      const registryText=await readFile(join(stateDir,'devices.json'),'utf8');
      const after=JSON.parse(await readFile(join(agentState,'agent.json'),'utf8'));
      if(storedSecret.startsWith('dpapi:')){
        // DPAPI 可用：hub 侧只有密文，无法在此解出 token 与 agent 哈希比对；只断言两侧都是合法形态。
        assert.match(storedSecret,/^dpapi:[A-Za-z0-9+/]+={0,2}$/);
        assert.match(after.tokenHash,/^[a-f0-9]{64}$/);
        assert.doesNotMatch(secretsText,new RegExp(after.tokenHash));
      }else{
        const token=storedSecret;
        assert.match(token,/^[a-f0-9]{64}$/);
        assert.equal(after.tokenHash,sha256(token),'hub 保存的 token 必须与 agent 侧哈希一致');
        assert.doesNotMatch(await readFile(join(agentState,'agent.json'),'utf8'),new RegExp(token));
      }
      assert.doesNotMatch(registryText,new RegExp(agent.pairingCode));
      assert.doesNotMatch(registryText,new RegExp(storedSecret));
      assert.equal(after.pairing,null,'配对码一次使用后失效');

      // 重复设备在配对前被拒：不得再次消耗 agent 配对状态。
      response=await fetch(base+'/devices',{method:'POST',headers:JSON_HEADERS,body:JSON.stringify({name:'Agent 2',kind:'agent',baseUrl:agent.url,pairingCode:agent.pairingCode})});
      assert.equal(response.status,409);
      assert.deepEqual(await response.json(),{error:'DEVICE_EXISTS'});

      // 快照：真实 AgentAdapter → agent /snapshot；hub 强制 writeEnabled=false（RISK-09）。
      const snapshot=await (await fetch(`${base}/snapshot?device=${encodeURIComponent(device.id)}`,{headers:AUTH})).json();
      assert.equal(snapshot.writeEnabled,false);
      assert.equal(snapshot.configVersion,5);
      assert.equal(snapshot.models[0].id,'agent-model');
      assert.deepEqual(snapshot.device,{id:device.id,name:'Agent',kind:'agent'});
      assert.equal(agentEngine.snapshots,1);
      await fetch(`${base}/snapshot?device=${encodeURIComponent(device.id)}`,{headers:AUTH});
      assert.equal(agentEngine.snapshots,1,'5 秒缓存内只读一次');
      // health 只回白名单字段（RISK-10）。
      const health=await (await fetch(`${base}/devices/${encodeURIComponent(device.id)}/health`,{headers:AUTH})).json();
      assert.deepEqual(Object.keys(health).sort(),['latencyMs','reachable']);
      assert.equal(health.reachable,true);
      // 删除 → {removed:true}，之后 404；agent 本体仍健康。
      const removed=await fetch(`${base}/devices/${encodeURIComponent(device.id)}`,{method:'DELETE',headers:AUTH});
      assert.deepEqual(await removed.json(),{removed:true});
      assert.equal((await fetch(`${base}/snapshot?device=${encodeURIComponent(device.id)}`,{headers:AUTH})).status,404);
      assert.equal((await fetch(`${agent.url}/agent/v1/health`)).status,200);
    });
  }finally{
    if(agent)await agent.close();
    await rm(agentRoot,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
});

/* ------------------------------------------------------- RISK 04/05/07/08/10 */

test('RISK-04 诊断限频：注入小阈值后超出部分静默丢弃，默认上限为 120/min',async()=>{
  assert.equal(DIAGNOSTICS_RATE_LIMIT,120);
  await hubFixture({options:{diagnosticsLimitPerMinute:3}},async({base,stateDir,server})=>{
    for(let index=0;index<8;index++)assert.equal((await fetch(base+'/health')).status,403);
    await server.flushDiagnostics();
    const lines=(await readFile(join(stateDir,'diagnostics.jsonl'),'utf8')).trim().split('\n').filter(Boolean);
    assert.equal(lines.length,3,'超过 3 events/min 的 403 不得写入诊断');
    for(const line of lines){
      const event=JSON.parse(line);
      assert.equal(event.code,'ACCESS_DENIED');
      assert.equal(event.path,'/health');
      assert.equal(event.status,403);
    }
  });
});

test('RISK-05 配置版本：Engine 快照读取 config_version，缺失/非标量不猜测，UI 文本可读',async()=>{
  const gateway={read:async resource=>resource.kind==='profile'?{provider:[],config_version:'4.29.3'}:{},resources:async()=>[],efforts:async()=>[]};
  const engine=new Engine({gateway});
  assert.equal((await engine.snapshot()).configVersion,'4.29.3');
  const numeric=new Engine({gateway:{...gateway,read:async resource=>resource.kind==='profile'?{provider:[],config_version:7}:{}}});
  assert.equal((await numeric.snapshot()).configVersion,7);
  const missing=new Engine({gateway:{...gateway,read:async resource=>resource.kind==='profile'?{provider:[]}:{}}});
  assert.equal((await missing.snapshot()).configVersion,null);
  const objectVersion=new Engine({gateway:{...gateway,read:async resource=>resource.kind==='profile'?{provider:[],config_version:{major:4}}:{}}});
  assert.equal((await objectVersion.snapshot()).configVersion,null);
  assert.equal(configVersionText({configVersion:'4.29.3'}),'配置版本 4.29.3');
  assert.equal(configVersionText({}),'配置版本 未知');
  assert.equal(configVersionText({configVersion:0}),'配置版本 0');
  // RISK-06：向导文案把 /health.version 标为“控制台版本”，不再冒充 AstrBot 版本。
  const app=await readFile(join(REPO,'public','app.mjs'),'utf8');
  assert.match(app,/控制台版本/);
  assert.doesNotMatch(app,/AstrBot 版本/);
});

test('RISK-07 备份警告：/backups 返回最近 5 条 BACKUP_* 诊断，字段白名单且无路径/密钥',async()=>{
  await hubFixture({engine:hostEngine()},async({base,stateDir})=>{
    for(let index=0;index<7;index++){
      await logDiagnostic(stateDir,{level:'warn',event:'backup-warning',code:index===6?'BACKUP_PRUNE_FAILED':'BACKUP_SIZE_LIMIT_EXCEEDED',detail:`C:\\Users\\alice\\backups 第 ${index} 条`,time:`2026-10-29T0${index}:00:00.000Z`});
    }
    const body=await (await fetch(base+'/backups',{headers:AUTH})).json();
    assert.ok(Array.isArray(body.warnings));
    assert.equal(body.warnings.length,5,'最多返回 5 条');
    assert.equal(body.warnings[0].code,'BACKUP_PRUNE_FAILED','最新一条排最前');
    for(const warning of body.warnings){
      assert.deepEqual(Object.keys(warning).sort(),['code','message','time']);
      assert.match(warning.code,/^BACKUP_[A-Z0-9_]+$/);
      assert.equal(Number.isNaN(Date.parse(warning.time)),false);
      assert.doesNotMatch(warning.message,/C:\\\\|alice/);
    }
    // UI 有展示位置与渲染函数（静态断言）。
    const [html,app,uiState]=await Promise.all([
      readFile(join(REPO,'public','index.html'),'utf8'),
      readFile(join(REPO,'public','app.mjs'),'utf8'),
      readFile(join(REPO,'public','ui-state.mjs'),'utf8'),
    ]);
    assert.match(html,/id="backup-warnings"/);
    assert.match(app,/backup-warnings/);
    assert.match(uiState,/export function backupWarnings/);
  });
});

test('RISK-08 restore 计划顶层白名单：engine 内部字段与路径不得进入响应',async()=>{
  const engine=hostEngine({
    planRestore:async()=>({
      id:PLAN_ID,
      resource:{kind:'profile',id:'default'},
      revision:'rev-1',
      changes:[{path:'agent_runner.config.model.provider_id',before:'a',value:'b',capability:'llm',secret:'drop'}],
      expiresAt:'2026-10-29T12:00:00.000Z',
      warning:'恢复会覆盖该资源完整对象',
      internal:'drop-me',
      enginePath:'C:\\Users\\alice\\secret',
      backupId:`C:\\Users\\alice\\backups\\${BACKUP_1}`,
    }),
  });
  await hubFixture({engine},async({base})=>{
    const response=await fetch(base+'/restore-plans',{method:'POST',headers:JSON_HEADERS,body:JSON.stringify({backupId:BACKUP_1,resource:{kind:'profile',id:'default'},expectedRevision:'rev-1'})});
    assert.equal(response.status,200);
    const body=await response.json();
    assert.ok(Object.keys(body).every(key=>['mode','id','resource','revision','expiresAt','impact','warning','backupId','changes'].includes(key)),JSON.stringify(Object.keys(body)));
    assert.equal(body.mode,'restore');
    assert.equal(body.backupId,BACKUP_1);
    assert.deepEqual(body.changes,[{path:'agent_runner.config.model.provider_id',before:'a',value:'b',capability:'llm'}]);
    assert.doesNotMatch(JSON.stringify(body),/internal|enginePath|C:\\\\|alice|secret/);
  });
});

test('RISK-09/10 远程快照强制只读、health 字段白名单（含错误码收敛）',async()=>{
  const created=[];
  const createRemoteEngine=device=>{
    const remote={
      gateway:{health:async()=>({reachable:false,error:'device_unreachable_lowercase',extra:'drop'})},
      snapshots:0,
      async snapshot(){remote.snapshots++;return {readAt:new Date().toISOString(),writeEnabled:true,models:[{id:`model-${device.id}`}],resources:[],configVersion:null};},
    };
    created.push(remote);
    return remote;
  };
  await hubFixture({options:{createRemoteEngine}},async({base,stateDir})=>{
    const device=await addDevice(stateDir,{id:'remote-risks',name:'远端',baseUrl:'http://127.0.0.1:9'},'abk_remote');
    const snapshot=await (await fetch(`${base}/snapshot?device=${encodeURIComponent(device.id)}`,{headers:AUTH})).json();
    assert.equal(snapshot.writeEnabled,false,'远程返回 writeEnabled=true 也必须被强制为 false');
    assert.equal(snapshot.models[0].id,'model-remote-risks');
    const health=await (await fetch(`${base}/devices/${encodeURIComponent(device.id)}/health`,{headers:AUTH})).json();
    // 非大写错误码被丢弃；不可达且无合法 error → 收敛为 DEVICE_UNREACHABLE。
    assert.deepEqual(health,{reachable:false,error:'DEVICE_UNREACHABLE'});
    assert.deepEqual(Object.keys(health).sort(),['error','reachable']);
  });
});

/* --------------------------------------------------- Epic-3 静态 + 临时产物 */

function walkFiles(dir,out=[]){
  const run=async()=>{
    for(const entry of await readdir(dir,{withFileTypes:true})){
      const path=join(dir,entry.name);
      if(entry.isDirectory())await walkFiles(path,out);
      else out.push(path);
    }
    return out;
  };
  return run();
}

test('Epic-3 静态：打包脚本便携-only（无 installer/Inno/自动更新），installer 目录已删除，文档口径一致',async()=>{
  const script=await readFile(join(REPO,'scripts','build-package.mjs'),'utf8');
  assert.doesNotMatch(script,/model-console\.iss|Inno\s*Setup|ISCC\.exe|\[Setup\]/i);
  // 仅允许注释里出现 “no auto-update”；不得有更新 URL/清单等自动更新实现。
  assert.equal((script.match(/auto[-_ ]?update/gi)??[]).length,1);
  assert.doesNotMatch(script,/updateUrl|latest\.yml|app-update\.yml/i);
  assert.match(script,/no installer, no auto-update/);
  assert.match(script,/SKIP_NAMES=new Set\(\['\.git','node_modules','state','dist','test','scripts'\]\)/);
  await assert.rejects(()=>stat(join(REPO,'installer')),error=>error.code==='ENOENT','installer/ 应已删除');
  const buildDoc=await readFile(join(REPO,'docs','BUILD.zh-CN.md'),'utf8');
  assert.match(buildDoc,/安装器/);
  assert.match(buildDoc,/自动更新/);
  assert.match(buildDoc,/不需要安装器|不生成安装器|没有自动更新/);
});

test('Epic-3 产物：临时 --out 构建成功，白名单产物不含 state/test/密钥/日志且 SHA256 全部匹配',{timeout:180000},async()=>{
  if(process.platform!=='win32')return;
  const root=await tempDir('build');
  const out=join(root,'out');
  try{
    const result=spawnSync(process.execPath,[join(REPO,'scripts','build-package.mjs'),'--out',out],{cwd:REPO,stdio:'ignore',timeout:150000});
    assert.equal(result.status,0,`build-package.mjs 退出码 ${result.status} ${result.error?.message??''}`);
    const product=join(out,'AstrBotModelConsole');
    const files=await walkFiles(product);
    const rels=files.map(file=>relative(product,file).split('\\').join('/'));
    assert.ok(files.length>=20,'产物文件数异常：'+files.length);
    const forbidden=rels.filter(rel=>/(^|\/)(state|test|scripts|node_modules|\.git)(\/|$)/.test(rel)||/\.log$/i.test(rel)||/(^|\/)(secrets\.json|devices\.json|agent\.json|audit\.jsonl|diagnostics\.jsonl|instance\.lock)$/.test(rel));
    assert.deepEqual(forbidden,[],'产物不得包含 state/test/日志/密钥文件');
    assert.equal(rels.includes('node.exe'),true);
    assert.equal(rels.includes('start.cmd'),true);
    assert.equal(rels.includes('SHA256SUMS.txt'),true);
    // SHA256SUMS 完整性。
    const sums=(await readFile(join(product,'SHA256SUMS.txt'),'utf8')).trim().split('\n').map(line=>{const parts=line.split(/\s+/);return {hash:parts[0],rel:parts[1]};});
    assert.equal(sums.length,files.length-1);
    for(const entry of sums){
      const actual=createHash('sha256').update(await readFile(join(product,entry.rel))).digest('hex');
      assert.equal(actual,entry.hash,`${entry.rel} 哈希不匹配`);
    }
    // 真实密钥值不得进入产物。
    const cmd=JSON.parse((await readFile('C:\\Users\\<你>\\.astrbot_launcher\\instances\\<实例ID>\\core\\data\\cmd_config.json','utf8')).replace(/^\uFEFF/,''));
    const secrets=[cmd.dashboard?.jwt_secret,...(cmd.provider??[]).flatMap(p=>p.key??[]),...(cmd.provider_sources??[]).flatMap(s=>s.key??[])].filter(value=>typeof value==='string'&&value.length>=8);
    for(const file of files){
      if(!/\.(txt|md|mjs|js|css|html|json|cmd)$/i.test(file))continue;
      if((await stat(file)).size>5*1024*1024)continue;
      const text=await readFile(file,'utf8');
      for(const secret of secrets)assert.ok(!text.includes(secret),`产物 ${relative(product,file)} 泄露真实密钥`);
    }
  }finally{
    await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});
  }
});
