import test from 'node:test';
import assert from 'node:assert/strict';
import {testNativeSearch} from '../src/native-search-test.mjs';

const config={
 provider:[{id:'example-provider/model-a',provider_source_id:'example-provider',model:'model-a'}],
 provider_sources:[{id:'example-provider',type:'openai_chat_completion',api_base:'http://127.0.0.1:8080/v1',key:['secret-key']}],
};
const json=(status,body)=>({status,json:async()=>body});

test('native search is detected from web_search_call/citations',async()=>{
 let request=null;
 const result=await testNativeSearch({
  config,
  providerId:'example-provider/model-a',
  fetcher:async(url,options)=>{request={url,options};return json(200,{output:[{type:'web_search_call',action:{queries:['q']}},{type:'message',content:[{type:'output_text',text:'answer',annotations:[{type:'url_citation',url:'https://e/1'}]}]}]});},
 });
 assert.equal(result.ok,true);
 assert.equal(result.searchCalls,1);
 assert.equal(result.citations,1);
 assert.ok(request.url.endsWith('/v1/responses'));
 const body=JSON.parse(request.options.body);
 assert.deepEqual(body.tools,[{type:'web_search'}]);
 assert.ok(!JSON.stringify(result).includes('secret-key'));
});

test('models without an actual web_search call are reported as unsupported',async()=>{
 const result=await testNativeSearch({
  config,
  providerId:'example-provider/model-a',
  fetcher:async()=>json(200,{output:[{type:'message',content:[{type:'output_text',text:'cannot browse',annotations:[]}]}]}),
 });
 assert.equal(result.ok,false);
 assert.match(result.message,/没有实际执行 web_search/);
});

test('HTTP failures are mapped without upstream body or key',async()=>{
 const result=await testNativeSearch({
  config,
  providerId:'example-provider/model-a',
  fetcher:async()=>json(401,{error:'bad key secret-key'}),
 });
 assert.equal(result.ok,false);
 assert.match(result.message,/鉴权失败/);
 assert.ok(!JSON.stringify(result).includes('secret-key'));
});

test('unknown provider and missing config fail before any request',async()=>{
 let called=0;
 const fetcher=async()=>{called++;return json(200,{});};
 assert.equal((await testNativeSearch({config,providerId:'nope',fetcher})).ok,false);
 const broken={provider:[{id:'x',provider_source_id:'missing',model:'m'}],provider_sources:[]};
 assert.equal((await testNativeSearch({config:broken,providerId:'x',fetcher})).ok,false);
 assert.equal(called,0);
});

test('timeouts are reported as timeout failures',async()=>{
 const result=await testNativeSearch({
  config,
  providerId:'example-provider/model-a',
  timeoutMs:5000,
  fetcher:(url,options)=>new Promise((resolve,reject)=>{
   options.signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})));
  }),
 });
 assert.equal(result.ok,false);
 assert.match(result.message,/超时/);
});
