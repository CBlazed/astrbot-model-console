import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stage,groups,currentRevision,candidates,indexCapability,counts,parseTokenHash,loadToken,saveToken,clearToken,buildConflictRows,bindingStatus,routingNoticeText,isIssue,loadDevice,saveDevice,snapshotPath,isRemoteSnapshot,deviceOptions,healthBadge,deviceErrorText,deviceKind,deviceKindLabel,validateDeviceInput,backupWarnings,configVersionText,deviceApiPath,snapshotWritable,snapshotMode,hotLoadMessage,planWarning} from '../public/ui-state.mjs';
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
 assert.equal(isRemoteSnapshot({device:{id:'d',name:'host',kind:'ssh'}}),true);
 assert.equal(isRemoteSnapshot({device:{id:'d',name:'host',kind:'agent'}}),true);
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

test('UI device kind normalizes legacy records and labels every kind',()=>{
 assert.equal(deviceKind({id:'local',kind:'local'}),'local');
 assert.equal(deviceKind({id:'x',kind:'http'}),'http');
 assert.equal(deviceKind({id:'x',kind:'ssh'}),'ssh');
 assert.equal(deviceKind({id:'x',kind:'agent'}),'agent');
 assert.equal(deviceKind({id:'legacy'}),'http');
 assert.equal(deviceKind({id:'legacy',name:'旧设备'}),'http');
 assert.equal(deviceKind(undefined),'http');
 assert.equal(deviceKind({id:'local'}),'local');
 assert.equal(deviceKindLabel('local'),'本机');
 assert.equal(deviceKindLabel('http'),'HTTP');
 assert.equal(deviceKindLabel('ssh'),'SSH');
 assert.equal(deviceKindLabel('agent'),'Agent');
 assert.equal(deviceKindLabel(undefined),'HTTP');
});
test('UI device form validates http/ssh/agent payloads and never echoes secrets',()=>{
 const http=validateDeviceInput({kind:'http',name:' 书房主机 ',baseUrl:'http://192.168.1.20:6185',apiKey:' abk_key '});
 assert.equal(http.ok,true);
 assert.deepEqual(http.payload,{name:'书房主机',kind:'http',baseUrl:'http://192.168.1.20:6185',apiKey:'abk_key',readOnly:true});
 assert.deepEqual(validateDeviceInput({kind:'http',name:'',baseUrl:''}).errors,['DEVICE_NAME_REQUIRED','DEVICE_BASEURL_REQUIRED','DEVICE_SECRET_REQUIRED']);
 assert.deepEqual(validateDeviceInput({name:'旧表单',baseUrl:'http://a',apiKey:'abk'}).payload.kind,'http');
 const ssh=validateDeviceInput({kind:'ssh',name:'云主机',baseUrl:'http://127.0.0.1:6185',apiKey:'abk_1',host:'1.2.3.4',port:'2222',user:'Administrator',keyPath:' C:\\keys\\id ',dataPath:'C:\\AstrBot\\data'});
 assert.equal(ssh.ok,true);
 assert.deepEqual(ssh.payload.ssh,{host:'1.2.3.4',user:'Administrator',port:2222,keyPath:'C:\\keys\\id',dataPath:'C:\\AstrBot\\data'});
 assert.equal(ssh.payload.apiKey,'abk_1');
 assert.equal(validateDeviceInput({kind:'ssh',name:'x',baseUrl:'http://a',apiKey:'abk',port:'abc',keyPath:'',dataPath:''}).payload.ssh.port,undefined);
 assert.equal(validateDeviceInput({kind:'ssh',name:'x',baseUrl:'http://a',apiKey:'abk',port:'70000'}).payload.ssh.port,undefined);
 assert.deepEqual(validateDeviceInput({kind:'ssh',name:'x',baseUrl:'http://a',apiKey:''}).errors,['DEVICE_SECRET_REQUIRED','DEVICE_SSH_HOST_REQUIRED','DEVICE_SSH_USER_REQUIRED']);
 const agent=validateDeviceInput({kind:'agent',name:'Agent 主机',baseUrl:'http://127.0.0.1:7100',pairingCode:' 12345678 '});
 assert.equal(agent.ok,true);
 assert.deepEqual(agent.payload,{name:'Agent 主机',kind:'agent',baseUrl:'http://127.0.0.1:7100',pairingCode:'12345678',readOnly:true});
 assert.equal(agent.payload.apiKey,undefined);
 assert.deepEqual(validateDeviceInput({kind:'agent',name:'x',baseUrl:'http://a'}).errors,['DEVICE_PAIRING_REQUIRED']);
 // 允许远程写入：仅 agent 生效，http/ssh 恒只读。
 assert.equal(validateDeviceInput({kind:'agent',name:'x',baseUrl:'http://a',pairingCode:'1',allowWrite:true}).payload.readOnly,false);
 assert.equal(validateDeviceInput({kind:'agent',name:'x',baseUrl:'http://a',pairingCode:'1',allowWrite:false}).payload.readOnly,true);
 assert.equal(validateDeviceInput({kind:'http',name:'x',baseUrl:'http://a',apiKey:'k',allowWrite:true}).payload.readOnly,true);
 assert.equal(validateDeviceInput({kind:'ssh',name:'x',baseUrl:'http://a',apiKey:'k',host:'h',user:'u',allowWrite:true}).payload.readOnly,true);
});
test('UI SSH/Agent/backup and version RISK texts are readable and bounded',()=>{
 assert.match(deviceErrorText('DEVICE_SSH_UNAVAILABLE'),/ssh/i);
 assert.match(deviceErrorText('DEVICE_SSH_FAILED'),/SSH|隧道/);
 assert.match(deviceErrorText('DEVICE_PORT_UNKNOWN'),/端口/);
 assert.match(deviceErrorText('AGENT_UNREACHABLE'),/Agent/);
 assert.match(deviceErrorText('AGENT_PAIR_FAILED'),/配对码/);
 assert.match(deviceErrorText('AGENT_AUTH_FAILED'),/令牌/);
 assert.equal(deviceErrorText('DEVICE_UNKNOWN_X'),'');
 const warnings=backupWarnings([{code:'BACKUP_PRUNE_FAILED',time:'2026-10-29T00:00:00Z',message:'清理失败'},{code:'BACKUP_OVERSIZE'},{},null,...Array.from({length:5},(_,i)=>({code:`BACKUP_${i}`,message:`m${i}`}))]);
 assert.equal(warnings.length,5);
 assert.deepEqual(warnings[0],{code:'BACKUP_PRUNE_FAILED',time:'2026-10-29T00:00:00Z',message:'清理失败'});
 assert.deepEqual(warnings[1],{code:'BACKUP_OVERSIZE',time:'',message:''});
 assert.deepEqual(backupWarnings(undefined),[]);
 assert.deepEqual(backupWarnings([{code:'A',message:'x'}],2).length,1);
 assert.equal(configVersionText({configVersion:'v4.29.3'}),'配置版本 v4.29.3');
 assert.equal(configVersionText({}),'配置版本 未知');
 assert.equal(configVersionText({configVersion:0}),'配置版本 0');
});
test('UI 页面覆盖 Epic-2 设备表单与 RISK 契约',()=>{
 const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
 const app=readFileSync(new URL('../public/app.mjs',import.meta.url),'utf8');
 for(const id of ['device-kind','device-key-field','device-ssh-fields','device-ssh-host','device-ssh-port','device-ssh-user','device-ssh-key','device-ssh-data','device-pairing-field','device-pairing','diagnostics-export','backup-warnings','config-version']){
  assert.ok(new RegExp(`id="${id}"`).test(html),`index.html 缺少 #${id}`);
 }
 for(const fragment of ["api('/diagnostics/export')",'validateDeviceInput','backupWarnings','deviceKind(','配置版本','控制台版本','device-ssh-host','device-ssh-user','device-pairing']){
  assert.ok(app.includes(fragment),`app.mjs 缺少 ${fragment}`);
 }
 assert.ok(!app.includes('AstrBot 版本'),'版本标签只能是“控制台版本”');
 assert.match(app,/\$\('device-pairing'\)\.value=''/,'配对码输入在提交后必须被清空');
 assert.match(app,/\$\('device-key'\)\.value=''/,'apiKey 输入在提交后必须被清空');
 assert.ok(!/localStorage/.test(app));
 assert.ok(!/\bconsole\.(log|info|debug|warn|error)\s*\(/.test(app));
 assert.ok(!/<script\b(?![^>]*\bsrc\s*=)/i.test(html),'不得内联脚本');
 assert.ok(!/\bon[a-z]+\s*=\s*"/i.test(html),'不得内联事件处理器');
});

test('UI remote writability comes from snapshot.writeEnabled, never from kind alone',()=>{
 const local={device:{kind:'local'},writeEnabled:true};
 const localReadOnly={device:{id:'local',kind:'local'},writeEnabled:false};
 const agentReadOnly={device:{id:'a',kind:'agent'},writeEnabled:false};
 const http={device:{id:'h',kind:'http'},writeEnabled:false};
 const ssh={device:{id:'s',kind:'ssh'},writeEnabled:false};
 const agentWritable={device:{id:'a',kind:'agent'},writeEnabled:true};
 assert.deepEqual(snapshotMode(undefined),{text:'未连接',kind:''});
 assert.deepEqual(snapshotMode(local),{text:'允许保存',kind:'good'});
 assert.deepEqual(snapshotMode(localReadOnly),{text:'只读模式',kind:'purple'});
 assert.deepEqual(snapshotMode(agentReadOnly),{text:'远程 · 只读',kind:'purple'});
 assert.deepEqual(snapshotMode(http),{text:'远程 · 只读',kind:'purple'});
 assert.deepEqual(snapshotMode(ssh),{text:'远程 · 只读',kind:'purple'});
 assert.deepEqual(snapshotMode(agentWritable),{text:'远程 · 可写',kind:'good'});
 assert.equal(snapshotWritable(agentWritable),true);
 assert.equal(snapshotWritable(agentReadOnly),false);
 assert.equal(snapshotWritable(undefined),false);
 // 远程可写时 prepare/apply/backups 必须带 ?device=；本机不带。
 assert.equal(deviceApiPath('/plans',''),'/plans');
 assert.equal(deviceApiPath('/plans','local'),'/plans');
 assert.equal(deviceApiPath('/plans','agent-1'),'/plans?device=agent-1');
 assert.equal(deviceApiPath('/apply','agent-1'),'/apply?device=agent-1');
 assert.equal(deviceApiPath('/backups','agent-1'),'/backups?device=agent-1');
 assert.equal(deviceApiPath('/backups','local'),'/backups');
 assert.equal(deviceApiPath('/backups','dev 1'),'/backups?device=dev%201');
});
test('UI hotLoad evidence wording never overstates a hot reload',()=>{
 assert.equal(hotLoadMessage(undefined),'');
 assert.equal(hotLoadMessage(null),'');
 assert.match(hotLoadMessage({verified:true,checked:true}),/热加载已核实/);
 assert.match(hotLoadMessage({verified:false,checked:true}),/热加载未核实/);
 assert.match(hotLoadMessage({verified:false,checked:true}),/已检查日志/);
 assert.match(hotLoadMessage({verified:false,checked:false}),/未检查日志/);
 assert.doesNotMatch(hotLoadMessage({verified:false,checked:true,note:'末尾未见 reload'}),/热加载已核实|已热加载/);
 assert.match(hotLoadMessage({verified:false,checked:true,note:'末尾未见 reload'}),/末尾未见 reload/);
 assert.match(hotLoadMessage({verified:true}),/已核实/);
});
test('UI 远程可写错误码有可读文案',()=>{
 assert.match(deviceErrorText('DEVICE_READ_ONLY'),/只读/);
 assert.match(deviceErrorText('AGENT_READ_ONLY'),/Agent/);
 assert.match(deviceErrorText('AGENT_READ_ONLY'),/enable-writes|写入/);
});
test('UI 页面覆盖 Epic-3 远程可写契约',()=>{
 const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
 const app=readFileSync(new URL('../public/app.mjs',import.meta.url),'utf8');
 for(const id of ['device-allow-write-field','device-allow-write','backup-actions']){
  assert.ok(new RegExp(`id="${id}"`).test(html),`index.html 缺少 #${id}`);
 }
 assert.match(html,/id="device-allow-write"[^>]*type="checkbox"/,'允许远程写入必须是 checkbox');
 assert.ok(app.includes('deviceApiPath'),'远程写请求必须带 device 参数');
 assert.ok(app.includes("deviceApiPath('/plans',selectedDevice)"),'prepare 必须使用 /plans?device=');
 assert.ok(app.includes("deviceApiPath('/apply',selectedDevice)"),'apply 必须使用 /apply?device=');
 assert.ok(app.includes("deviceApiPath('/backups',selectedDevice)"),'远程备份必须使用 /backups?device=');
 assert.ok(app.includes('hotLoadMessage'),'apply 必须展示 hotLoad 证据');
 assert.ok(app.includes('snapshotMode'),'模式必须来自 snapshot.writeEnabled');
 assert.ok(app.includes('snapshotWritable'),'可写判断必须来自 snapshot.writeEnabled');
 assert.match(app,/\$\('device-allow-write'\)\.checked=false/,'提交后必须重置允许写入勾选');
 assert.ok(!/localStorage/.test(app));
 assert.ok(!/\bconsole\.(log|info|debug|warn|error)\s*\(/.test(app));
 assert.ok(!/<script\b(?![^>]*\bsrc\s*=)/i.test(html));
 assert.ok(!/\bon[a-z]+\s*=\s*"/i.test(html));
});

test('UI plan warning: engine boilerplate becomes neutral Chinese info, restore stays a destructive warning',()=>{
  const boilerplate=planWarning('No cross-resource atomicity; API readback is not a model generation test');
  assert.deepEqual(boilerplate,{text:'多资源按顺序保存，不是原子操作；保存并回读成功不代表模型已能生成。',kind:'info'});
  const restore=planWarning('恢复会覆盖该资源的完整对象',{restore:true});
  assert.equal(restore.kind,'danger');
  assert.match(restore.text,/恢复会覆盖/);
  const restoreFallback=planWarning(undefined,{restore:true});
  assert.equal(restoreFallback.kind,'danger');
  assert.match(restoreFallback.text,/完整对象/);
  assert.equal(planWarning(undefined),null);
  assert.deepEqual(planWarning('自定义警告'),{text:'自定义警告',kind:'info'});
});
