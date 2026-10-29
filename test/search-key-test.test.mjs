import test from 'node:test';
import assert from 'node:assert/strict';
import {testSearchKey,supportedProviders} from '../src/search-key-test.mjs';

const KEY='sk-test-SECRET-123456';
const jsonResponse=(status,body)=>({status,text:async()=>JSON.stringify(body??{})});
const fetcherFor=(status,body,spy)=>(url,options)=>{spy.push({url,options});return Promise.resolve(jsonResponse(status,body));};

test('all nine built-in providers are supported',()=>{
 assert.deepEqual(supportedProviders.sort(),['anysearch','baidu_ai_search','bocha','brave','deepseek','exa','firecrawl','serpapi','tavily']);
});

test('tests every provider against its fixed host and never returns the key',async()=>{
 for(const provider of supportedProviders){
  const spy=[];
  const result=await testSearchKey({provider,key:KEY,fetcher:fetcherFor(200,{results:[]},spy)});
  assert.equal(result.ok,true,`${provider} should pass`);
  assert.equal(spy.length,1);
  const {url,options}=spy[0];
  assert.ok(url.startsWith('https://'),`${provider} must use a fixed https host`);
  assert.ok(!JSON.stringify(result).includes(KEY),`${provider} leaked the key`);
  assert.ok(!JSON.stringify(result).includes('SECRET'),`${provider} leaked a key fragment`);
  assert.ok(options.method==='GET'||options.method==='POST');
  assert.ok(options.signal,'request must be abortable');
 }
});

test('auth, quota and server failures are mapped without response bodies',async()=>{
 for(const [status,pattern] of [[401,/鉴权失败/],[403,/鉴权失败/],[429,/频率/],[500,/暂时不可用/],[404,/请求被拒绝/]]){
  const result=await testSearchKey({provider:'deepseek',key:KEY,fetcher:fetcherFor(status,{error:'API key '+KEY},[])});
  assert.equal(result.ok,false);
  assert.equal(result.status,status);
  assert.match(result.message,pattern);
  assert.ok(!JSON.stringify(result).includes(KEY));
 }
});

test('provider business errors are surfaced as failures',async()=>{
 const any=await testSearchKey({provider:'anysearch',key:KEY,fetcher:fetcherFor(200,{code:7,message:'bad'},[])});
 assert.equal(any.ok,false);
 assert.match(any.message,/业务错误/);
 const serp=await testSearchKey({provider:'serpapi',key:KEY,fetcher:fetcherFor(200,{search_metadata:{status:'Error'},error:'invalid key'},[])});
 assert.equal(serp.ok,false);
 assert.match(serp.message,/SerpApi/);
});

test('deepseek success reports result count and docs-specific auth/balance hints',async()=>{
 const ok=await testSearchKey({provider:'deepseek',key:KEY,fetcher:fetcherFor(200,{results:[{title:'a'},{title:'b'}]},[])});
 assert.equal(ok.ok,true);
 assert.match(ok.message,/返回 2 条结果/);
 const auth=await testSearchKey({provider:'deepseek',key:KEY,fetcher:fetcherFor(401,{},[])});
 assert.match(auth.message,/platform\.deepseek\.com/);
 const balance=await testSearchKey({provider:'deepseek',key:KEY,fetcher:fetcherFor(402,{},[])});
 assert.match(balance.message,/余额不足/);
});

test('missing or unsupported provider/key is rejected before any request',async()=>{
 let called=0;
 const fetcher=()=>{called++;return Promise.resolve(jsonResponse(200,{}));};
 assert.equal((await testSearchKey({provider:'nope',key:KEY,fetcher})).ok,false);
 assert.equal((await testSearchKey({provider:'deepseek',key:'',fetcher})).ok,false);
 assert.equal(called,0);
});

test('timeouts are reported as timeout failures',async()=>{
 const fetcher=(url,options)=>new Promise((resolve,reject)=>{
  options.signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})));
 });
 const result=await testSearchKey({provider:'tavily',key:KEY,fetcher,timeoutMs:100});
 assert.equal(result.ok,false);
 assert.match(result.message,/超时/);
});
