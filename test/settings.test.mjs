import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine,bindingRows,revision} from '../src/engine.mjs';
import {nativeSearchPlugin,webSearchProviderOptions} from '../src/registry.mjs';
import {Gateway} from '../src/gateway.mjs';
import {HttpGatewayAdapter} from '../src/http-adapter.mjs';
import {counts,isIssue,webSearchStatus,webSearchValueText,bindingStatus,isSecretPath,secretDraftText} from '../public/ui-state.mjs';

const profile={kind:'profile',id:'default'};
const nativeValue=nativeSearchPlugin.value;

function baseConfig(){
 return {
  provider:[
   {id:'a',type:'openai_chat_completion',enable:true},
   {id:'b',type:'openai_chat_completion',enable:true},
   {id:'disabled',type:'openai_chat_completion',enable:false},
   {id:'embed',type:'openai_embedding',enable:true},
  ],
  provider_sources:[{id:'src',type:'openai_chat_completion'}],
  agent_runner:{config:{model:{provider_id:'a'},compression:{provider_id:'a'}}},
  provider_settings:{web_search:false,websearch_provider:'deepseek',websearch_deepseek_key:['sk-secret-1'],websearch_baidu_app_builder_key:'baidu-secret',unrelated:{secret:'KEEP'}},
 };
}
function features(state='missing'){
 if(state==='missing')return {nativeWebSearch:{pluginId:'astrbot_plugin_model_websearch',listAvailable:true,installed:false,activated:false,available:false}};
 if(state==='disabled')return {nativeWebSearch:{pluginId:'astrbot_plugin_model_websearch',listAvailable:true,installed:true,activated:false,available:false,version:'v0.1.0'}};
 if(state==='unreadable')return {nativeWebSearch:{pluginId:'astrbot_plugin_model_websearch',listAvailable:false,installed:false,activated:false,available:false}};
 return {nativeWebSearch:{pluginId:'astrbot_plugin_model_websearch',listAvailable:true,installed:true,activated:true,available:true,version:'v0.1.0'}};
}
function fixture(pluginState='missing',options={}){
 let config=baseConfig(),writes=0,backups=0;
 const gateway={
  read:async resource=>resource.kind==='profile'?structuredClone(config):structuredClone(config),
  resources:async()=>[profile],
  write:async(resource,value)=>{writes++;config=structuredClone(value);},
  efforts:async()=>null,
  plugins:async()=>pluginState==='unreadable'?null:pluginState==='missing'?[]:[{name:'astrbot_plugin_model_websearch',activated:pluginState==='active',version:'v0.1.0'}],
  routingSummary:async()=>({total:0,platformLevel:0,granular:0}),
 };
 const engine=new Engine({gateway,writeEnabled:true,backup:async()=>{backups++;return 'backup';},audit:async()=>{},...options});
 return {engine,gateway,get config(){return config;},set config(value){config=value;},get writes(){return writes;},get backups(){return backups;}};
}
const rowOf=(rows,path)=>rows.find(row=>row.path===path);

test('web-search settings are reviewed profile fields, bindings stay model-only',()=>{
 const rows=bindingRows(profile,baseConfig(),[{id:'a',enabled:true,capabilities:['llm']}],null,features('active'));
 assert.equal(rowOf(rows,'provider_settings.web_search').value,'false');
 assert.equal(rowOf(rows,'provider_settings.websearch_provider').value,'deepseek');
 assert.equal(rowOf(rows,'provider_settings.websearch_provider').options.length,10);
 assert.equal(rowOf(rows,'provider_settings.websearch_native_provider_id').options.map(option=>option.value).join(','),'a');
 assert.equal(rows.filter(row=>row.capability!=='setting').length,6);
});

test('native option follows plugin state',()=>{
 const missing=rowOf(bindingRows(profile,baseConfig(),[],null,features('missing')),'provider_settings.websearch_provider');
 assert.equal(missing.options.some(option=>option.value===nativeValue),false);
 const disabled=rowOf(bindingRows(profile,baseConfig(),[],null,features('disabled')),'provider_settings.websearch_provider');
 assert.equal(disabled.options.find(option=>option.value===nativeValue).disabled,true);
 const stored={...baseConfig(),provider_settings:{...baseConfig().provider_settings,web_search:true,websearch_provider:nativeValue}};
 assert.equal(rowOf(bindingRows(profile,stored,[],null,features('disabled')),'provider_settings.websearch_provider').status,'plugin-unavailable');
 assert.equal(rowOf(bindingRows(profile,stored,[],null,features('active')),'provider_settings.websearch_provider').status,'configured');
});

test('snapshot exposes plugin features without secrets and with 12 setting rows',async()=>{
 const f=fixture('active');
 const snapshot=await f.engine.snapshot();
 assert.equal(snapshot.features.nativeWebSearch.available,true);
 assert.equal(snapshot.resources[0].bindings.filter(row=>row.capability==='setting').length,12);
 const raw=JSON.stringify(snapshot);
 assert.ok(!raw.includes('sk-secret-1'));
 assert.ok(!raw.includes('baidu-secret'));
 const key=rowOf(snapshot.resources[0].bindings,'provider_settings.websearch_deepseek_key');
 assert.equal(key.configured,true);
 assert.equal(key.count,1);
 assert.equal(Object.hasOwn(key,'value'),false);
});

test('snapshot degrades to official-only when the plugin list is unreadable',async()=>{
 const snapshot=await fixture('unreadable').engine.snapshot();
 assert.equal(snapshot.features.nativeWebSearch.listAvailable,false);
 const row=rowOf(snapshot.resources[0].bindings,'provider_settings.websearch_provider');
 assert.equal(row.options.some(option=>option.value===nativeValue),false);
});

test('plan writes real booleans and keeps unrelated keys',async()=>{
 const f=fixture('active');
 const plan=await f.engine.plan(profile,[{path:'provider_settings.web_search',value:'true'},{path:'provider_settings.websearch_provider',value:nativeValue}]);
 assert.equal(f.writes,0);
 await f.engine.apply(plan.id);
 assert.equal(f.config.provider_settings.web_search,true);
 assert.equal(f.config.provider_settings.websearch_provider,nativeValue);
 assert.equal(f.config.provider_settings.unrelated.secret,'KEEP');
 assert.equal(f.backups,1);
});

test('invalid booleans, provider values and native option without active plugin are rejected',async()=>{
 await assert.rejects(()=>fixture('active').engine.plan(profile,[{path:'provider_settings.web_search',value:'yes'}]),/VALUE_NOT_ALLOWED/);
 await assert.rejects(()=>fixture('active').engine.plan(profile,[{path:'provider_settings.websearch_provider',value:'future_provider'}]),/VALUE_NOT_ALLOWED/);
 await assert.rejects(()=>fixture('disabled').engine.plan(profile,[{path:'provider_settings.websearch_provider',value:nativeValue}]),/NATIVE_SEARCH_PLUGIN_UNAVAILABLE/);
 await assert.rejects(()=>fixture('missing').engine.plan(profile,[{path:'provider_settings.websearch_provider',value:nativeValue}]),/VALUE_NOT_ALLOWED/);
});

test('plan re-reads plugin state instead of trusting a stale snapshot',async()=>{
 const f=fixture('active');
 await f.engine.snapshot();
 f.gateway.plugins=async()=>[{name:'astrbot_plugin_model_websearch',activated:false}];
 await assert.rejects(()=>f.engine.plan(profile,[{path:'provider_settings.websearch_provider',value:nativeValue}]),/NATIVE_SEARCH_PLUGIN_UNAVAILABLE/);
});

test('search-model setting accepts enabled llm models and empty means follow chat',async()=>{
 const f=fixture('active');
 const set=await f.engine.plan(profile,[{path:'provider_settings.websearch_native_provider_id',value:'b'}]);
 await f.engine.apply(set.id);
 assert.equal(f.config.provider_settings.websearch_native_provider_id,'b');
 const clear=await f.engine.plan(profile,[{path:'provider_settings.websearch_native_provider_id',value:''}]);
 await f.engine.apply(clear.id);
 assert.equal(f.config.provider_settings.websearch_native_provider_id,'');
 await assert.rejects(()=>f.engine.plan(profile,[{path:'provider_settings.websearch_native_provider_id',value:'disabled'}]),/MODEL_MISSING_OR_DISABLED/);
 await assert.rejects(()=>f.engine.plan(profile,[{path:'provider_settings.websearch_native_provider_id',value:'embed'}]),/CAPABILITY_UNVERIFIED_OR_MISMATCH/);
});

test('secret keys are parsed, masked and written without leaking',async()=>{
 const f=fixture('active');
 const plan=await f.engine.plan(profile,[{path:'provider_settings.websearch_deepseek_key',value:JSON.stringify(['new-1','new-2'])}]);
 assert.equal(plan.changes[0].secret,true);
 assert.equal(plan.changes[0].value,'（已隐藏）');
 assert.ok(!JSON.stringify(plan).includes('new-1'));
 await f.engine.apply(plan.id);
 assert.deepEqual(f.config.provider_settings.websearch_deepseek_key,['new-1','new-2']);
 await assert.rejects(()=>f.engine.plan(profile,[{path:'provider_settings.websearch_deepseek_key',value:'not-json'}]),/SECRET_VALUE_INVALID/);
 await assert.rejects(()=>f.engine.plan(profile,[{path:'provider_settings.websearch_deepseek_key',value:JSON.stringify(Array.from({length:21},(_,i)=>'k'+i))}]),/SECRET_VALUE_INVALID/);
 const clear=await f.engine.plan(profile,[{path:'provider_settings.websearch_deepseek_key',value:'[]'}]);
 assert.match(clear.changes[0].summary,/清空 Key/);
 await f.engine.apply(clear.id);
 assert.deepEqual(f.config.provider_settings.websearch_deepseek_key,[]);
});

test('secret-string keys can be replaced and cleared',async()=>{
 const f=fixture('active');
 const set=await f.engine.plan(profile,[{path:'provider_settings.websearch_baidu_app_builder_key',value:'new-baidu'}]);
 await f.engine.apply(set.id);
 assert.equal(f.config.provider_settings.websearch_baidu_app_builder_key,'new-baidu');
 const clear=await f.engine.plan(profile,[{path:'provider_settings.websearch_baidu_app_builder_key',value:''}]);
 await f.engine.apply(clear.id);
 assert.equal(f.config.provider_settings.websearch_baidu_app_builder_key,'');
});

test('restore diff compares booleans as text and masks secrets',()=>{
 const f=fixture('active');
 const before={...baseConfig(),provider_settings:{...baseConfig().provider_settings,web_search:false,websearch_provider:'deepseek',websearch_deepseek_key:['old-secret']}};
 const after={...before,provider_settings:{...before.provider_settings,web_search:true,websearch_provider:nativeValue,websearch_deepseek_key:['new-secret']}};
 const raw=f.engine.restoreChanges(profile,before,after);
 assert.equal(raw.find(change=>change.path==='provider_settings.web_search').value,'true');
 const masked=f.engine.displayChanges(raw);
 assert.equal(masked.find(change=>change.path==='provider_settings.websearch_deepseek_key').value,'（已隐藏）');
 assert.ok(!JSON.stringify(masked).includes('new-secret'));
});

test('gateway and HTTP adapter sanitize the plugin inventory',async()=>{
 const gateway=new Gateway('E:/tmp/not-read');
 gateway.call=async()=>[{name:'astrbot_plugin_model_websearch',activated:true,version:'v0.1.0',display_name:'模型原生网页搜索',key:['SECRET']},{id:'other'}];
 assert.deepEqual(await gateway.plugins(),[
  {name:'astrbot_plugin_model_websearch',displayName:'模型原生网页搜索',version:'v0.1.0',activated:true},
  {name:'other',displayName:null,version:null,activated:false},
 ]);
 gateway.call=async()=>{throw Error('ASTRBOT_HTTP_403');};
 assert.equal(await gateway.plugins(),null);
 const adapter=new HttpGatewayAdapter({baseUrl:'http://127.0.0.1:1',apiKey:'k'});
 adapter.call=async()=>[{name:'astrbot_plugin_model_websearch',activated:false,version:'v0.1.0'}];
 assert.deepEqual(await adapter.plugins(),[{name:'astrbot_plugin_model_websearch',displayName:null,version:'v0.1.0',activated:false}]);
 adapter.call=async()=>{throw Error('DEVICE_FORBIDDEN');};
 assert.equal(await adapter.plugins(),null);
});

test('UI helpers: counts exclude settings, secret values are masked',()=>{
 const snapshot={models:[],resources:[{bindings:[
  {path:'agent_runner.config.model.provider_id',capability:'llm',status:'configured'},
  {path:'provider_settings.web_search',capability:'setting',status:'off'},
  {path:'provider_settings.websearch_native_provider_id',capability:'setting',status:'configured'},
 ]}]};
 assert.equal(counts(snapshot).bindings,1);
 assert.equal(isIssue({status:'off'}),false);
 assert.equal(isIssue({status:'plugin-unavailable'}),true);
 assert.equal(bindingStatus('empty').label,'未配置');
 assert.equal(webSearchValueText('provider_settings.web_search','true'),'已启用');
 assert.equal(webSearchValueText('provider_settings.websearch_provider','tavily'),'Tavily');
 assert.equal(isSecretPath('provider_settings.websearch_deepseek_key'),true);
 assert.equal(secretDraftText('provider_settings.websearch_deepseek_key','["a","b"]'),'设置 2 个 Key（已隐藏）');
 assert.equal(webSearchProviderOptions(features('active')).find(option=>option.value===nativeValue).disabled,false);
});

test('UI web-search status covers closed/native/builtin/unavailable',()=>{
 const rows=(enabled,value,featureSet)=>({enabled:{path:'provider_settings.web_search',value:enabled?'true':'false'},provider:{path:'provider_settings.websearch_provider',value,options:webSearchProviderOptions(featureSet)}});
 const active=features('active'),missing=features('missing'),disabled=features('disabled');
 assert.equal(webSearchStatus([rows(false,'deepseek',missing).enabled,rows(false,'deepseek',missing).provider],missing).label,'网页搜索 · 已关闭');
 assert.equal(webSearchStatus([rows(true,nativeValue,active).enabled,rows(true,nativeValue,active).provider],active).label,'模型原生 · 已就绪');
 assert.equal(webSearchStatus([rows(true,nativeValue,disabled).enabled,rows(true,nativeValue,disabled).provider],disabled).kind,'bad');
 assert.equal(webSearchStatus([rows(true,'tavily',missing).enabled,rows(true,'tavily',missing).provider],missing).label,'内置 · Tavily');
});
