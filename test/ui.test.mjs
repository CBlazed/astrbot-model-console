import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stage,groups,currentRevision,candidates,indexCapability,counts,parseTokenHash,loadToken,saveToken,clearToken} from '../public/ui-state.mjs';
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
