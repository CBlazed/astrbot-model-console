import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stage,groups,currentRevision,candidates,indexCapability,counts,parseTokenHash,loadToken,saveToken,clearToken,buildConflictRows,bindingStatus,routingNoticeText,isIssue,loadDevice,saveDevice,snapshotPath,isRemoteSnapshot,deviceOptions,healthBadge,deviceErrorText} from '../public/ui-state.mjs';
test('UI drafts preserve original values and remove changes reverted to original',()=>{const resource={kind:'plugin',id:'one'};let drafts=stage(new Map(),resource,'model','luna','flash','r1');assert.equal([...drafts.values()][0].baseValue,'flash');drafts=stage(drafts,resource,'model','flash','flash','r1');assert.equal(drafts.size,0);});
test('UI groups writes by resource while preserving unrelated resources',()=>{let drafts=new Map();drafts=stage(drafts,{kind:'plugin',id:'a'},'first','luna','','r');drafts=stage(drafts,{kind:'plugin',id:'a'},'second','luna','','r');drafts=stage(drafts,{kind:'profile',id:'b'},'main','flash','','s');assert.equal(groups(drafts).length,2);assert.equal(groups(drafts)[0].changes.length,2);});
test('UI model candidates only include enabled models with declared capability',()=>{assert.deepEqual(candidates([{id:'a',enabled:true,capabilities:['llm']},{id:'b',enabled:false,capabilities:['vision']},{id:'c',enabled:true,capabilities:['vision']}],'vision').map(x=>x.id),['c']);assert.equal(indexCapability('embedding'),true);assert.equal(indexCapability('vision'),false);});
test('UI detects resource and shared model revisions without guessing',()=>{const snapshot={models:[{id:'luna',revision:'m'}],resources:[{resource:{kind:'plugin',id:'p'},revision:'r'}]};assert.equal(currentRevision(snapshot,{kind:'provider',id:'luna'}),'m');assert.equal(currentRevision(snapshot,{kind:'plugin',id:'p'}),'r');assert.equal(currentRevision(snapshot,{kind:'plugin',id:'missing'}),undefined);});
test('UI summary distinguishes disabled/missing refs and unreadable resources',()=>{assert.deepEqual(counts({models:[{enabled:true},{enabled:false}],resources:[{bindings:[{status:'missing'},{status:'configured'}]},{status:'unavailable'}]}),{models:1,resources:2,bindings:2,issues:2});});

const TOKEN='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const inactiveStorage=()=>({getItem(){throw Error('Storage disabled');},setItem(){throw Error('Storage disabled');},removeItem(){throw Error('Storage disabled');}});
const memoryStorage=()=>{const data=new Map();return {data,getItem:key=>data.has(key)?data.get(key):null,setItem:(key,value)=>void data.set(key,String(value)),removeItem:key=>void data.delete(key)};};
test('UI reads the session token from a URL hash and ignores hashes without one',()=>{
 assert.equal(parseTokenHash('#token='+TOKEN),TOKEN);
 assert.equal(parseTokenHash('?token='+TOKEN),TOKEN);
 assert.equal(parseTokenHash('#foo=1&token='+TOKEN),TOKEN);
 assert.equal(parseTokenHash('#overview'),'');
 assert.equal(parseTokenHash('#token='),'');
 assert.equal(parseTokenHash('#token=%20%20'),'');
 assert.equal(parseTokenHash(''),'');
 assert.equal(parseTokenHash(undefined),'');
 assert.equal(parseTokenHash('#tokens='+TOKEN),'');
});
test('UI restores a stored token and tolerates missing or broken storage',()=>{
 assert.equal(loadToken(memoryStorage()),'');
 assert.equal(loadToken(undefined),'');
 assert.equal(loadToken(null),'');
 assert.equal(loadToken({}),'');
 assert.equal(loadToken(inactiveStorage()),'');
 assert.equal(saveToken(memoryStorage(),TOKEN),true);
 const storage=memoryStorage();
 assert.equal(saveToken(storage,TOKEN),true);
 assert.equal(loadToken(storage),TOKEN);
});
test('UI refuses to persist blank or malformed tokens',()=>{
 for(const bad of ['','   ',null,undefined,42,{token:TOKEN},'short','has space in token','a'.repeat(600)]){
  const storage=memoryStorage();
  assert.equal(saveToken(storage,bad),false,`unexpected write for ${String(bad).slice(0,20)}`);
  assert.equal(storage.data.size,0);
 }
 const storage=memoryStorage();
 assert.equal(saveToken(storage,TOKEN),true);
 assert.equal(storage.data.size,1);
});
test('UI clears the session token without throwing',()=>{
 const storage=memoryStorage();
 saveToken(storage,TOKEN);
 assert.equal(clearToken(storage),true);
 assert.equal(loadToken(storage),'');
 assert.equal(storage.data.size,0);
 assert.equal(clearToken(undefined),false);
 assert.equal(clearToken({}),false);
 assert.equal(clearToken(inactiveStorage()),false);
});
test('UI token helpers never throw when storage access fails',()=>{
 const storage=inactiveStorage();
 assert.equal(loadToken(storage),'');
 assert.doesNotThrow(()=>loadToken(storage));
 assert.equal(saveToken(storage,TOKEN),false);
 assert.doesNotThrow(()=>saveToken(storage,TOKEN));
 assert.equal(clearToken(storage),false);
 assert.doesNotThrow(()=>clearToken(storage));
});
test('UI app keeps tokens in sessionStorage only and out of logs',()=>{
 const source=readFileSync(new URL('../public/app.mjs',import.meta.url),'utf8');
 assert.ok(!/localStorage/.test(source),'app must not touch persistent storage');
 assert.match(source,/sessionStorage/);
 for(const name of ['parseTokenHash','loadToken','saveToken','clearToken'])assert.ok(source.includes(name),`missing ${name}`);
 assert.ok(!/\bconsole\.(log|info|debug|warn|error)\s*\(/.test(source),'token must not be logged');
 assert.match(source,/parseTokenHash\(location\.hash\)/,'URL token must win over stored token');
 assert.match(source,/saveToken\(tokenStorage,token\)/,'successful connect must persist the token');
 assert.match(source,/clearToken\(tokenStorage\)/,'ACCESS_DENIED must clear the token');
});

test('UI conflict diff aligns local drafts with the latest server values',()=>{
 const rows=buildConflictRows(
  [{path:'agent_runner.config.model.provider_id',value:'luna'},{path:'custom_extra_body.reasoning_effort',value:'high'}],
  [{path:'agent_runner.config.model.provider_id',value:'flash'}],
  {'custom_extra_body.reasoning_effort':'推理强度'}
 );
 assert.equal(rows.length,2);
 assert.deepEqual(rows[0],{path:'agent_runner.config.model.provider_id',label:'agent_runner.config.model.provider_id',mine:'luna',server:'flash',changed:true});
 assert.equal(rows[1].label,'推理强度');
 assert.equal(rows[1].mine,'high');
 assert.equal(rows[1].server,'字段不存在');
 assert.equal(rows[1].changed,true);
 assert.equal(buildConflictRows([{path:'p',value:'v'}],{p:'v'})[0].changed,false);
 assert.equal(buildConflictRows([{path:'p',value:'v'}],{p:'v'})[0].server,'v');
 assert.equal(buildConflictRows([{path:'p',value:''}],{p:''})[0].mine,'空值 / 跟随默认');
 assert.deepEqual(buildConflictRows([],[]),[]);
 assert.deepEqual(buildConflictRows(undefined,undefined),[]);
 assert.deepEqual(buildConflictRows([null],[]),[]);
});
test('UI field-missing is rendered as 字段不存在 with bad style, never as 待核实',()=>{
 assert.deepEqual(bindingStatus('field-missing'),{label:'字段不存在',kind:'bad'});
 assert.deepEqual(bindingStatus('empty-semantics-unverified'),{label:'待核实',kind:'warn'});
 assert.deepEqual(bindingStatus('configured'),{label:'已配置',kind:'good'});
 assert.deepEqual(bindingStatus('missing'),{label:'引用缺失',kind:'bad'});
 assert.deepEqual(bindingStatus('unexpected-status'),{label:'unexpected-status',kind:'warn'});
 assert.equal(isIssue({status:'field-missing'}),true);
 assert.equal(isIssue({status:'empty-semantics-unverified'}),false);
});
test('UI routing notice only appears when granular routes exist',()=>{
 assert.equal(routingNoticeText({total:2,platformLevel:2,granular:0}),'');
 assert.equal(routingNoticeText({}),'');
 assert.equal(routingNoticeText(undefined),'');
 const text=routingNoticeText({total:5,platformLevel:3,granular:2});
 assert.match(text,/会话级\/通配符路由/);
 assert.match(text,/共 5 条路由/);
 assert.match(text,/细分路由 2 条/);
 assert.match(text,/平台级视图/);
});
test('UI 页面覆盖冲突/向导/备份恢复契约',()=>{
 const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
 const app=readFileSync(new URL('../public/app.mjs',import.meta.url),'utf8');
 for(const id of ['wizard','wizard-step-1','wizard-step-2','wizard-step-3','wizard-skip','wizard-next','wizard-prev','wizard-done','wizard-connection','wizard-writes','routing-notice','conflict','conflict-body','conflict-summary','conflict-rebase','conflict-dismiss','backups','backup-summary','backup-keep','backup-prune','backup-note','backup-body','restore-panel','restore-kind','restore-resource','restore-diff','restore-plan','restore-diff-view','review-warning']){
  assert.ok(new RegExp(`id="${id}"`).test(html),`index.html 缺少 #${id}`);
 }
 for(const route of ['/health','/backups','/backups/prune','/restore-plans','/diff?kind='])assert.ok(app.includes(route),`app.mjs 缺少 ${route}`);
 assert.ok(app.includes("model-console.wizard-done"),'向导完成标记必须使用 sessionStorage 键');
 assert.ok(app.includes('sessionStorage'));
 assert.ok(!/localStorage/.test(app),'token 与向导标记都不得写入持久存储');
 assert.ok(!/\bconsole\.(log|info|debug|warn|error)\s*\(/.test(app),'不得打印配置或令牌');
 assert.ok(!/<script\b(?![^>]*\bsrc\s*=)/i.test(html),'不得内联脚本');
 assert.ok(!/\bon[a-z]+\s*=\s*"/i.test(html),'不得内联事件处理器');
});

test('UI device selection stores only an id and local never sends a query',()=>{
 const storage=memoryStorage();
 assert.equal(loadDevice(storage),'');
 assert.equal(saveDevice(storage,'http:dev-1'),true);
 assert.equal(loadDevice(storage),'http:dev-1');
 assert.equal(saveDevice(storage,''),false);
 assert.equal(loadDevice(storage),'http:dev-1');
 assert.equal(saveDevice(storage,'local'),true);
 assert.equal(loadDevice(storage),'');
 assert.equal(loadDevice(inactiveStorage()),'');
 assert.equal(saveDevice(inactiveStorage(),'http:dev-1'),false);
 assert.equal(saveDevice(undefined,'http:dev-1'),false);
 assert.equal(snapshotPath(''),'/snapshot');
 assert.equal(snapshotPath('local'),'/snapshot');
 assert.equal(snapshotPath(undefined),'/snapshot');
 assert.equal(snapshotPath('dev 1'),'/snapshot?device=dev%201');
 assert.match(snapshotPath('http:192.168.1.20:6185'),/^\/snapshot\?device=http%3A192/);
});
test('UI remote snapshot is read-only while missing device means legacy local',()=>{
 assert.equal(isRemoteSnapshot({device:{id:'d',name:'host',kind:'http'}}),true);
 assert.equal(isRemoteSnapshot({device:{id:'local',kind:'local'}}),false);
 assert.equal(isRemoteSnapshot({}),false);
 assert.equal(isRemoteSnapshot(null),false);
 assert.equal(isRemoteSnapshot(undefined),false);
});
test('UI device options list local first and keep remote labels',()=>{
 const options=deviceOptions([{id:'local',name:'本机',kind:'local',readOnly:false},{id:'http:a',name:'书房主机',kind:'http',baseUrl:'http://a',readOnly:true,hasSecret:true}]);
 assert.deepEqual(options[0],{value:'local',label:'本机 · 可写',kind:'local',readOnly:false});
 assert.equal(options[1].value,'http:a');
 assert.equal(options[1].label,'书房主机');
 assert.equal(options[1].readOnly,true);
 assert.deepEqual(deviceOptions([{id:'local',kind:'local',readOnly:true}])[0],{value:'local',label:'本机 · 只读',kind:'local',readOnly:true});
 assert.deepEqual(deviceOptions(null).map(option=>option.value),['local']);
 assert.deepEqual(deviceOptions([]).map(option=>option.value),['local']);
 const withoutLocal=deviceOptions([{id:'http:a',kind:'http',name:'A',readOnly:true}]);
 assert.deepEqual(withoutLocal.map(option=>option.value),['local','http:a']);
});
test('UI health badges and device errors are user readable',()=>{
 assert.deepEqual(healthBadge({reachable:true,latencyMs:12}),{text:'可达 · 12ms',kind:'good'});
 assert.deepEqual(healthBadge({reachable:true}),{text:'可达',kind:'good'});
 assert.deepEqual(healthBadge({reachable:false,error:'DEVICE_UNREACHABLE'}),{text:'DEVICE_UNREACHABLE',kind:'bad'});
 assert.deepEqual(healthBadge(undefined),{text:'未检测',kind:'warn'});
 assert.match(deviceErrorText('DEVICE_AUTH_FAILED'),/凭据/);
 assert.match(deviceErrorText('DEVICE_FORBIDDEN'),/权限|scope/);
 assert.match(deviceErrorText('DEVICE_UNREACHABLE'),/不可达/);
 assert.equal(deviceErrorText('ACCESS_DENIED'),'');
 assert.equal(deviceErrorText(undefined),'');
});
test('UI 页面覆盖设备选择器与远程设备管理契约',()=>{
 const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
 const app=readFileSync(new URL('../public/app.mjs',import.meta.url),'utf8');
 const ui=readFileSync(new URL('../public/ui-state.mjs',import.meta.url),'utf8');
 for(const id of ['device-select','remote-notice','changes-panel','devices-section','devices-refresh','device-body','device-form','device-name','device-url','device-key','device-note']){
  assert.ok(new RegExp(`id="${id}"`).test(html),`index.html 缺少 #${id}`);
 }
 for(const fragment of ["api('/devices')",'/devices/','/health','snapshotPath(selectedDevice)',"'DELETE'",'isRemoteSnapshot(snapshot)','loadDevice(tokenStorage)','saveDevice(tokenStorage']){
  assert.ok(app.includes(fragment),`app.mjs 缺少 ${fragment}`);
 }
 assert.match(app,/\$\('device-key'\)\.value=''/,'apiKey 输入在提交后必须被清空');
 assert.match(app,/async function api\(path,body,method\)/,'api 必须接受显式 HTTP method');
 assert.match(app,/method:method\?\?\(body===undefined\?'GET':'POST'\)/,'默认 GET/POST 逻辑必须保留');
 assert.ok(app.includes("undefined,'DELETE'"),'删除设备必须发送真正的 DELETE 请求');
 assert.ok(ui.includes("deviceStorageKey='model-console.device'"),'设备选择必须存 sessionStorage 键 model-console.device');
 assert.ok(ui.includes('DEVICE_AUTH_FAILED')&&ui.includes('DEVICE_FORBIDDEN')&&ui.includes('DEVICE_UNREACHABLE'),'设备错误码需有可读文案');
 assert.ok(!/localStorage/.test(app));
 assert.ok(!/\bconsole\.(log|info|debug|warn|error)\s*\(/.test(app),'不得打印设备凭据');
});
