/** Local AstrBot API adapter. No credentials or upstream error bodies leave this module. */
import {readFile,open,stat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {profileIdentity} from './identity.mjs';
export const readJSON=async path=>JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
/** A routing pattern that only pins a platform instance, not a session. */
const PLATFORM_LEVEL_ROUTE=/^[^:]+::$/;
export class Gateway{
 /**
  * Process-local caches keep a single snapshot from re-reading the dashboard port and the signing secret
  * on every API call. `reads` counts actual file work (log scans / config parses) for diagnostics and stays
  * monotonic; `invalidate()` only drops the caches. Log/port cache is keyed by size+mtimeMs, config cache by
  * size+mtimeMs as well, so a rotated secret or restarted dashboard is picked up on the next call.
  */
 constructor(data,fetcher=fetch){this.data=data;this.fetcher=fetcher;this.logCache=null;this.configCache=null;this.logPending=null;this.configPending=null;this.reads={log:0,config:0};}
 /** Drop every process-local file cache so the next call() re-reads the log tail and cmd_config.json. */
 invalidate(){this.logCache=null;this.configCache=null;this.logPending=null;this.configPending=null;}
 /** Concurrent call()s in one snapshot share one in-flight stat/scan (no cache stampede on a fresh cache). */
 async #port(){if(this.logPending)return this.logPending;this.logPending=this.#loadPort().finally(()=>{this.logPending=null;});return this.logPending;}
 /**
  * Cached dashboard port. Unchanged size+mtimeMs reuses the cached port without touching log contents;
  * a changed file re-runs the reverse 64 KiB scan (incremental when the log only grew).
  */
 async #loadPort(){
  const log=join(this.data,'logs','astrbot.log'),info=await stat(log),size=info.size,cached=this.logCache;
  if(cached&&cached.size===size&&cached.mtime===info.mtimeMs)return cached.port;
  let port=cached?.port;
  const f=await open(log,'r');
  try{let end=size,carry='';const incremental=cached&&size>=cached.size;const minimum=incremental?Math.max(0,cached.size-256):0;while(end>minimum){const start=Math.max(minimum,end-65536),buffer=Buffer.alloc(end-start);await f.read(buffer,0,buffer.length,start);const text=buffer.toString('utf8')+carry;const found=[...text.matchAll(/Starting WebUI at http:\/\/[^\s:]+:(\d+)/g)].at(-1)?.[1];if(found){port=found;break;}carry=text.slice(0,256);end=start;}}finally{await f.close();}
  this.reads.log++;this.logCache={size,mtime:info.mtimeMs,port};
  return port;
 }
 /** Cached cmd_config.json parse. Only re-read after the file's size or mtime changed. */
 async #config(){if(this.configPending)return this.configPending;this.configPending=this.#loadConfig().finally(()=>{this.configPending=null;});return this.configPending;}
 async #loadConfig(){
  const path=join(this.data,'cmd_config.json'),info=await stat(path),cached=this.configCache;
  if(cached&&cached.size===info.size&&cached.mtime===info.mtimeMs)return cached.config;
  const config=await readJSON(path);
  this.reads.config++;this.configCache={size:info.size,mtime:info.mtimeMs,config};
  return config;
 }
 async call(method,path,body){
  if(!path.startsWith('/api/v1/'))throw Error('INVALID_API_PATH');
  const port=await this.#port();if(!port)throw Error('DASHBOARD_NOT_FOUND');
  const conf=await this.#config();
  const enc=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
  const token=enc({alg:'HS256',typ:'JWT'})+'.'+enc({username:conf.dashboard.username??'astrbot',exp:Math.floor(Date.now()/1000)+60});
  const signature=createHmac('sha256',conf.dashboard.jwt_secret).update(token).digest('base64url');
  let response;try{response=await this.fetcher(`http://127.0.0.1:${port}${path}`,{method,redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:`Bearer ${token}.${signature}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});}catch{throw Error('ASTRBOT_UNREACHABLE');}
  if(!response.ok)throw Error(`ASTRBOT_HTTP_${response.status}`);
  let json;try{json=await response.json();}catch{throw Error('ASTRBOT_INVALID_RESPONSE');}if(json.status!=='ok')throw Error('ASTRBOT_API_REJECTED');return json.data;
 }
 /**
  * Route-shape summary for the "cards only show the platform-level view" hint.
  * platformLevel counts `platform_id::` exact routes; granular is everything else (session/wildcard routes).
  * Never throws and never leaks upstream errors: any failure reports zeros.
  */
 async routingSummary(){
  try{
   const data=await this.call('GET','/api/v1/config-routes');
   const routing=data?.routing;
   const patterns=Array.isArray(routing)?routing.filter(pattern=>typeof pattern==='string'):routing&&typeof routing==='object'?Object.keys(routing):[];
   const platformLevel=patterns.filter(pattern=>PLATFORM_LEVEL_ROUTE.test(pattern)).length;
   return {total:patterns.length,platformLevel,granular:patterns.length-platformLevel};
  }catch{return {total:0,platformLevel:0,granular:0};}
 }
 async read(resource){const id=encodeURIComponent(resource.id);if(resource.kind==='provider')return (await this.call('GET',`/api/v1/providers/by-id?provider_id=${id}`)).provider;if(resource.kind==='profile')return (await this.call('GET',`/api/v1/config-profiles/${id}`)).config;if(resource.kind==='plugin')return (await this.call('GET',`/api/v1/plugins/config?plugin_id=${id}`)).config;throw Error('INVALID_RESOURCE');}
 async write(resource,config){const id=encodeURIComponent(resource.id);if(resource.kind==='provider')return this.call('PUT','/api/v1/providers/by-id',{provider_id:resource.id,config});if(resource.kind==='profile')return this.call('PUT',`/api/v1/config-profiles/${id}`,config);if(resource.kind==='plugin')return this.call('PUT','/api/v1/plugins/config',{plugin_id:resource.id,config});throw Error('INVALID_RESOURCE');}
 async efforts(id){const {provider}=await this.call('GET',`/api/v1/providers/by-id?provider_id=${encodeURIComponent(id)}&merged=true`);const base=new URL(provider.api_base);if(!['127.0.0.1','localhost'].includes(base.hostname)||base.protocol!=='http:')return null;try{const response=await this.fetcher(base.href.replace(/\/$/,'')+'/models?client_version=0.161.0',{redirect:'error',signal:AbortSignal.timeout(5000),headers:{Authorization:`Bearer ${provider.key?.[0]??''}`}});if(!response.ok)return null;const body=await response.json();const rows=body.data??body.models??[];const model=rows.find(x=>(x.id??x.slug)===provider.model);return model?.supported_reasoning_levels?.map(x=>typeof x==='string'?x:x.effort)??null;}catch{return null;}}
 async resources(){const [list,files,global]=await Promise.all([this.call('GET','/api/v1/config-profiles'),readdir(join(this.data,'config')),this.read({kind:'profile',id:'default'})]);let routing={},platforms=global.platform??[];try{routing=(await this.call('GET','/api/v1/config-routes')).routing??{};}catch{}try{platforms=(await this.call('GET','/api/v1/bots')).bots??platforms;}catch{}let stats=[];try{stats=(await this.call('GET','/api/v1/bots/stats')).platforms??[];}catch{}const publicPlatforms=platforms.map(p=>({id:p.id,type:p.type,status:stats.find(s=>s.id===p.id)?.status??'unknown'}));return [{kind:'profile',id:'default',identity:profileIdentity({id:'default'},publicPlatforms,routing)},...(list.info_list??[]).filter(x=>x.id!=='default').map(x=>({kind:'profile',id:x.id??x.uuid,identity:profileIdentity(x,publicPlatforms,routing)})),...files.filter(x=>x.endsWith('_config.json')).map(x=>({kind:'plugin',id:x.slice(0,-12)}))];}

  /**
   * Sanitized plugin inventory used only for feature detection (never for credentials).
   * Returns null when the dashboard does not expose the plugin list; callers must then
   * behave as if the optional plugin is absent instead of guessing.
   */
  async plugins(){
    try{
      const data=await this.call('GET','/api/v1/plugins');
      const list=Array.isArray(data)?data:(data?.plugins??data?.list??[]);
      return (Array.isArray(list)?list:[]).map(plugin=>{
        const name=plugin?.name??plugin?.id??plugin?.plugin_id;
        return typeof name==='string'&&name?{
          name,
          displayName:plugin?.display_name??plugin?.displayName??null,
          version:typeof plugin?.version==='string'?plugin.version:null,
          activated:plugin?.activated===true,
        }:null;
      }).filter(Boolean);
    }catch{return null;}
  }
}
