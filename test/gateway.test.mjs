/**
 * Gateway cache + routingSummary regression tests (P1-01 / P1-07).
 * Everything is local: temp AstrBot data directory + injected fetcher. No real AstrBot, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,appendFile,utimes,rm} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Gateway} from '../src/gateway.mjs';

const START_LINE='[2026-10-29 21:00:00] INFO: Starting WebUI at http://127.0.0.1:6185\n';
const ZEROS={total:0,platformLevel:0,granular:0};

async function dataDir({log=START_LINE,secret='secret-one',config}={}){
  const root=await mkdtemp(join(tmpdir(),'model-console-gateway-'));
  await mkdir(join(root,'logs'),{recursive:true});
  await mkdir(join(root,'config'),{recursive:true});
  if(log!==null)await writeFile(join(root,'logs','astrbot.log'),log);
  await writeFile(join(root,'cmd_config.json'),config??JSON.stringify({dashboard:{username:'astrbot',jwt_secret:secret}}));
  return root;
}

/** Fake fetcher: records every invocation and answers with a Response-like object. */
function responder(handler){
  const calls=[];
  const fetcher=async(url,options)=>{calls.push({url,options});const out=handler?.(url,options,calls);if(out instanceof Error)throw out;return out??ok({});};
  return {calls,fetcher};
}
const ok=data=>({ok:true,status:200,json:async()=>({status:'ok',data})});
const bearer=options=>String(options.headers.Authorization);
const tokenOf=options=>bearer(options).replace(/^Bearer /,'');
const payloadOf=options=>JSON.parse(Buffer.from(tokenOf(options).split('.')[1],'base64url').toString('utf8'));
function signedWith(options,secret){const [header,body,signature]=tokenOf(options).split('.');return createHmac('sha256',secret).update(`${header}.${body}`).digest('base64url')===signature;}

test('unchanged data files are scanned and parsed once across many API calls',async()=>{
  const root=await dataDir();
  try{
    const {calls,fetcher}=responder();
    const gateway=new Gateway(root,fetcher);
    for(let i=0;i<6;i++)await gateway.call('GET','/api/v1/config-profiles');
    assert.equal(calls.length,6);
    assert.equal(gateway.reads.log,1,'log must be scanned once');
    assert.equal(gateway.reads.config,1,'cmd_config.json must be parsed once');
    for(const {url} of calls)assert.match(url,/^http:\/\/127\.0\.0\.1:6185\/api\/v1\/config-profiles$/);
    const first=calls[0].options;
    assert.equal(payloadOf(first).username,'astrbot');
    assert.equal(signedWith(first,'secret-one'),true);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('concurrent calls belonging to one snapshot share a single log scan and config parse',async()=>{
  const root=await dataDir();
  try{
    const {calls,fetcher}=responder();
    const gateway=new Gateway(root,fetcher);
    await Promise.all([
      gateway.call('GET','/api/v1/config-profiles'),
      gateway.call('GET','/api/v1/config-routes'),
      gateway.read({kind:'profile',id:'default'}),
      gateway.read({kind:'plugin',id:'astrbot_plugin_x'}),
      gateway.call('GET','/api/v1/bots'),
    ]);
    assert.equal(calls.length,5);
    assert.equal(gateway.reads.log,1);
    assert.equal(gateway.reads.config,1);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('log growth reselects the dashboard port without re-reading cmd_config.json',async()=>{
  const root=await dataDir();
  try{
    const {calls,fetcher}=responder();
    const gateway=new Gateway(root,fetcher);
    await gateway.call('GET','/api/v1/config-profiles');
    assert.match(calls[0].url,/^http:\/\/127\.0\.0\.1:6185\//);
    await gateway.call('GET','/api/v1/config-profiles');
    assert.equal(gateway.reads.log,1,'unchanged log must not be rescanned');
    await appendFile(join(root,'logs','astrbot.log'),'[2026-10-29 21:05:00] INFO: Starting WebUI at http://127.0.0.1:7001\n');
    await gateway.call('GET','/api/v1/config-profiles');
    assert.match(calls[2].url,/^http:\/\/127\.0\.0\.1:7001\//);
    assert.equal(gateway.reads.log,2);
    assert.equal(gateway.reads.config,1,'port change must not invalidate the config cache');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('rotated jwt_secret invalidates the cached config and signs the next request with it',async()=>{
  const root=await dataDir({secret:'secret-one'});
  const configPath=join(root,'cmd_config.json');
  try{
    const {calls,fetcher}=responder();
    const gateway=new Gateway(root,fetcher);
    await gateway.call('GET','/api/v1/config-profiles');
    assert.equal(signedWith(calls[0].options,'secret-one'),true);
    await writeFile(configPath,JSON.stringify({dashboard:{username:'astrbot',jwt_secret:'secret-two-rotated'}}));
    await gateway.call('GET','/api/v1/config-profiles');
    assert.equal(gateway.reads.config,2);
    assert.equal(signedWith(calls[1].options,'secret-one'),false);
    assert.equal(signedWith(calls[1].options,'secret-two-rotated'),true);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('mtime-only config change invalidates the cache even when the size is unchanged',async()=>{
  const root=await dataDir();
  const configPath=join(root,'cmd_config.json');
  try{
    const {fetcher}=responder();
    const gateway=new Gateway(root,fetcher);
    await gateway.call('GET','/api/v1/config-profiles');
    assert.equal(gateway.reads.config,1);
    const future=new Date(Date.now()+5000);
    await utimes(configPath,future,future);
    await gateway.call('GET','/api/v1/config-profiles');
    assert.equal(gateway.reads.config,2);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('invalidate() forces the next call to re-read log and config',async()=>{
  const root=await dataDir();
  try{
    const {fetcher}=responder();
    const gateway=new Gateway(root,fetcher);
    await gateway.call('GET','/api/v1/config-profiles');
    await gateway.call('GET','/api/v1/config-profiles');
    assert.deepEqual({...gateway.reads},{log:1,config:1});
    gateway.invalidate();
    await gateway.call('GET','/api/v1/config-profiles');
    assert.deepEqual({...gateway.reads},{log:2,config:2});
  }finally{await rm(root,{recursive:true,force:true});}
});

test('unparseable cmd_config.json is not cached as a value',async()=>{
  const root=await dataDir({config:'{not json'});
  const configPath=join(root,'cmd_config.json');
  try{
    const {fetcher}=responder();
    const gateway=new Gateway(root,fetcher);
    await assert.rejects(()=>gateway.call('GET','/api/v1/config-profiles'));
    assert.equal(gateway.reads.config,0,'a failed parse must not count as a cached read');
    await writeFile(configPath,JSON.stringify({dashboard:{username:'astrbot',jwt_secret:'secret-one'}}));
    await gateway.call('GET','/api/v1/config-profiles');
    assert.equal(gateway.reads.config,1);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('routingSummary classifies platform-level and granular route patterns',async()=>{
  const root=await dataDir();
  try{
    const routing={'onebot::':'profile-a','official::':'profile-b','qq:group:12345':'profile-a','*':'default'};
    const {calls,fetcher}=responder(url=>url.includes('/api/v1/config-routes')?ok({routing}):ok({}));
    const gateway=new Gateway(root,fetcher);
    assert.deepEqual(await gateway.routingSummary(),{total:4,platformLevel:2,granular:2});
    assert.equal(calls.length,1);
    assert.match(calls[0].url,/\/api\/v1\/config-routes$/);
    assert.equal(gateway.reads.config,1);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('routingSummary reports the all-platform-level case and an empty routing map',async()=>{
  const root=await dataDir();
  try{
    const platformOnly=responder(url=>url.includes('/api/v1/config-routes')?ok({routing:{'onebot::':'p','qq_official::':'q'}}):ok({}));
    assert.deepEqual(await new Gateway(root,platformOnly.fetcher).routingSummary(),{total:2,platformLevel:2,granular:0});
    const empty=responder(url=>url.includes('/api/v1/config-routes')?ok({}):ok({}));
    assert.deepEqual(await new Gateway(root,empty.fetcher).routingSummary(),ZEROS);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('routingSummary degrades to zeros without throwing on API failures',async()=>{
  const root=await dataDir();
  try{
    const cases=[
      ['unreachable',async()=>{throw Error('ECONNREFUSED');}],
      ['http error',async()=>({ok:false,status:500,json:async()=>({})})],
      ['invalid json',async()=>({ok:true,status:200,json:async()=>{throw Error('bad json');}})],
      ['api rejected',async()=>({ok:true,status:200,json:async()=>({status:'error',message:'SECRET_UPSTREAM_BODY'})})],
    ];
    for(const [label,fetcher] of cases){
      const gateway=new Gateway(root,fetcher);
      const summary=await gateway.routingSummary();
      assert.deepEqual(summary,ZEROS,`${label} must degrade to zeros`);
      assert.equal(JSON.stringify(summary).includes('SECRET'),false);
    }
  }finally{await rm(root,{recursive:true,force:true});}
});

test('existing error codes are preserved',async()=>{
  const root=await dataDir();
  const noLine=await dataDir({log:'nothing about a dashboard here\n'});
  const noLog=await dataDir({log:null});
  try{
    await assert.rejects(()=>new Gateway(root,async()=>ok({})).call('GET','/v1/not-api'),/INVALID_API_PATH/);
    await assert.rejects(()=>new Gateway(root,async()=>{throw Error('refused');}).call('GET','/api/v1/config-profiles'),/ASTRBOT_UNREACHABLE/);
    await assert.rejects(()=>new Gateway(root,async()=>({ok:false,status:503,json:async()=>({})})).call('GET','/api/v1/config-profiles'),/ASTRBOT_HTTP_503/);
    await assert.rejects(()=>new Gateway(root,async()=>({ok:true,status:200,json:async()=>{throw Error('bad');}})).call('GET','/api/v1/config-profiles'),/ASTRBOT_INVALID_RESPONSE/);
    await assert.rejects(()=>new Gateway(root,async()=>({ok:true,status:200,json:async()=>({status:'error'})})).call('GET','/api/v1/config-profiles'),/ASTRBOT_API_REJECTED/);
    await assert.rejects(()=>new Gateway(noLine,async()=>ok({})).call('GET','/api/v1/config-profiles'),/DASHBOARD_NOT_FOUND/);
    await assert.rejects(()=>new Gateway(noLog,async()=>ok({})).call('GET','/api/v1/config-profiles'),error=>error.code==='ENOENT');
  }finally{
    await rm(root,{recursive:true,force:true});
    await rm(noLine,{recursive:true,force:true});
    await rm(noLog,{recursive:true,force:true});
  }
});
