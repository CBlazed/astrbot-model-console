import test from 'node:test';
import assert from 'node:assert/strict';
import {HttpGatewayAdapter} from '../src/http-adapter.mjs';

function ok(data){return {status:200,ok:true,json:async()=>({status:'ok',data})};}
function bad(status,body={}){return {status,ok:false,json:async()=>body};}

function fakeFetch(routes){
  const calls=[];
  const fetcher=async (url,options={})=>{
    calls.push({url,options});
    const path=new URL(url).pathname+new URL(url).search;
    for(const [matcher,handler] of routes){
      if(matcher.test(path))return handler(path,options);
    }
    return bad(404);
  };
  return {fetcher,calls};
}

test('read maps provider/profile/plugin endpoints and always sends the API key',async()=>{
  const {fetcher,calls}=fakeFetch([
    [/^\/api\/v1\/providers\/by-id\?provider_id=a$/,()=>ok({provider:{id:'a',model:'m'}})],
    [/^\/api\/v1\/config-profiles\/default$/,()=>ok({config:{agent_runner:{}}})],
    [/^\/api\/v1\/plugins\/config\?plugin_id=p$/,()=>ok({config:{x:1}})],
  ]);
  const adapter=new HttpGatewayAdapter({baseUrl:'http://192.168.1.20:6185/',apiKey:'abk_test',fetcher});
  assert.equal((await adapter.read({kind:'provider',id:'a'})).model,'m');
  assert.deepEqual(await adapter.read({kind:'profile',id:'default'}),{agent_runner:{}});
  assert.deepEqual(await adapter.read({kind:'plugin',id:'p'}),{x:1});
  for(const call of calls){
    assert.equal(call.options.headers.Authorization,'Bearer abk_test');
    assert.ok(!call.url.includes('abk_test'),'key 不得出现在 URL');
  }
});

test('write sends the expected request bodies',async()=>{
  const {fetcher,calls}=fakeFetch([
    [/^\/api\/v1\/providers\/by-id$/,()=>ok({})],
    [/^\/api\/v1\/config-profiles\/default$/,()=>ok({})],
    [/^\/api\/v1\/plugins\/config$/,()=>ok({})],
  ]);
  const adapter=new HttpGatewayAdapter({baseUrl:'http://h:1',apiKey:'k',fetcher});
  await adapter.write({kind:'provider',id:'a'},{id:'a',model:'m'});
  await adapter.write({kind:'profile',id:'default'},{agent_runner:{}});
  await adapter.write({kind:'plugin',id:'p'},{x:1});
  assert.deepEqual(JSON.parse(calls[0].options.body),{provider_id:'a',config:{id:'a',model:'m'}});
  assert.deepEqual(JSON.parse(calls[1].options.body),{agent_runner:{}});
  assert.equal(JSON.parse(calls[1].options.body).config,undefined);
  assert.deepEqual(JSON.parse(calls[2].options.body),{plugin_id:'p',config:{x:1}});
});

test('HTTP failures map to stable device error codes',async()=>{
  const cases=[
    [bad(401),'DEVICE_AUTH_FAILED'],
    [bad(403),'DEVICE_FORBIDDEN'],
    [bad(500),'DEVICE_HTTP_500'],
    [{status:200,ok:true,json:async()=>{throw Error('bad json');}},'DEVICE_INVALID_RESPONSE'],
    [{status:200,ok:true,json:async()=>({status:'error'})},'DEVICE_API_REJECTED'],
  ];
  for(const [response,code] of cases){
    const adapter=new HttpGatewayAdapter({baseUrl:'http://h:1',apiKey:'k',fetcher:async()=>response});
    await assert.rejects(()=>adapter.read({kind:'profile',id:'default'}),error=>error.code===code);
  }
  const unreachable=new HttpGatewayAdapter({baseUrl:'http://h:1',apiKey:'k',fetcher:async()=>{throw Error('ECONNREFUSED');}});
  await assert.rejects(()=>unreachable.read({kind:'profile',id:'default'}),error=>error.code==='DEVICE_UNREACHABLE');
});

test('resources renders default first, remote profiles and tolerated plugin list',async()=>{
  const {fetcher}=fakeFetch([
    [/^\/api\/v1\/config-profiles$/,()=>ok({info_list:[{id:'default',name:'Default'},{id:'p1',name:'远程档案'}]})],
    [/^\/api\/v1\/plugins$/,()=>ok({plugins:[{name:'astrbot_plugin_a'},{id:'b'}]})],
    [/^\/api\/v1\/config-routes$/,()=>ok({routing:{'snow::':'p1','qq::':'p2','a::b':'p3'}})],
  ]);
  const adapter=new HttpGatewayAdapter({baseUrl:'http://h:1',apiKey:'k',fetcher});
  const resources=await adapter.resources();
  const ids=resources.map(resource=>`${resource.kind}:${resource.id}`);
  assert.deepEqual(ids,['profile:default','profile:p1','plugin:astrbot_plugin_a','plugin:b']);
  assert.match(resources[0].identity.name,/远程/);
  assert.equal(resources[0].identity.association,'remote-default');
  const plugins=await adapter.routingSummary();
  assert.deepEqual(plugins,{total:3,platformLevel:2,granular:1});
  assert.equal((await adapter.resources())[1].identity.routingStatus.includes('会话级'),true);
});

test('routingSummary degrades to zeros and health reports unreachable on errors',async()=>{
  const adapter=new HttpGatewayAdapter({baseUrl:'http://h:1',apiKey:'k',fetcher:async()=>bad(401)});
  assert.deepEqual(await adapter.routingSummary(),{total:0,platformLevel:0,granular:0});
  const health=await adapter.health();
  assert.equal(health.reachable,false);
  assert.equal(health.error,'DEVICE_AUTH_FAILED');
});
