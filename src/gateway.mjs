/** Local AstrBot API adapter. No credentials or upstream error bodies leave this module. */
import {readFile,open,stat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {profileIdentity} from './identity.mjs';
export const readJSON=async path=>JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
export class Gateway{
 constructor(data,fetcher=fetch){this.data=data;this.fetcher=fetcher;this.logCache=null;}
 async call(method,path,body){
  if(!path.startsWith('/api/v1/'))throw Error('INVALID_API_PATH');
  const log=join(this.data,'logs','astrbot.log'),info=await stat(log),size=info.size;
  let port=this.logCache?.port;
  if(!this.logCache||this.logCache.size!==size||this.logCache.mtime!==info.mtimeMs){const f=await open(log,'r');try{let end=size,carry='';const incremental=this.logCache&&size>=this.logCache.size;const minimum=incremental?Math.max(0,this.logCache.size-256):0;while(end>minimum){const start=Math.max(minimum,end-65536),buffer=Buffer.alloc(end-start);await f.read(buffer,0,buffer.length,start);const text=buffer.toString('utf8')+carry;const found=[...text.matchAll(/Starting WebUI at http:\/\/[^\s:]+:(\d+)/g)].at(-1)?.[1];if(found){port=found;break;}carry=text.slice(0,256);end=start;}}finally{await f.close();}this.logCache={size,mtime:info.mtimeMs,port};}if(!port)throw Error('DASHBOARD_NOT_FOUND');
  const conf=await readJSON(join(this.data,'cmd_config.json'));
  const enc=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
  const token=enc({alg:'HS256',typ:'JWT'})+'.'+enc({username:conf.dashboard.username??'astrbot',exp:Math.floor(Date.now()/1000)+60});
  const signature=createHmac('sha256',conf.dashboard.jwt_secret).update(token).digest('base64url');
  let response;try{response=await this.fetcher(`http://127.0.0.1:${port}${path}`,{method,redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:`Bearer ${token}.${signature}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});}catch{throw Error('ASTRBOT_UNREACHABLE');}
  if(!response.ok)throw Error(`ASTRBOT_HTTP_${response.status}`);
  let json;try{json=await response.json();}catch{throw Error('ASTRBOT_INVALID_RESPONSE');}if(json.status!=='ok')throw Error('ASTRBOT_API_REJECTED');return json.data;
 }
 async read(resource){const id=encodeURIComponent(resource.id);if(resource.kind==='provider')return (await this.call('GET',`/api/v1/providers/by-id?provider_id=${id}`)).provider;if(resource.kind==='profile')return (await this.call('GET',`/api/v1/config-profiles/${id}`)).config;if(resource.kind==='plugin')return (await this.call('GET',`/api/v1/plugins/config?plugin_id=${id}`)).config;throw Error('INVALID_RESOURCE');}
 async write(resource,config){const id=encodeURIComponent(resource.id);if(resource.kind==='provider')return this.call('PUT','/api/v1/providers/by-id',{provider_id:resource.id,config});if(resource.kind==='profile')return this.call('PUT',`/api/v1/config-profiles/${id}`,config);if(resource.kind==='plugin')return this.call('PUT','/api/v1/plugins/config',{plugin_id:resource.id,config});throw Error('INVALID_RESOURCE');}
 async efforts(id){const {provider}=await this.call('GET',`/api/v1/providers/by-id?provider_id=${encodeURIComponent(id)}&merged=true`);const base=new URL(provider.api_base);if(!['127.0.0.1','localhost'].includes(base.hostname)||base.protocol!=='http:')return null;try{const response=await this.fetcher(base.href.replace(/\/$/,'')+'/models?client_version=0.161.0',{redirect:'error',signal:AbortSignal.timeout(5000),headers:{Authorization:`Bearer ${provider.key?.[0]??''}`}});if(!response.ok)return null;const body=await response.json();const rows=body.data??body.models??[];const model=rows.find(x=>(x.id??x.slug)===provider.model);return model?.supported_reasoning_levels?.map(x=>typeof x==='string'?x:x.effort)??null;}catch{return null;}}
 async resources(){const [list,files,global]=await Promise.all([this.call('GET','/api/v1/config-profiles'),readdir(join(this.data,'config')),this.read({kind:'profile',id:'default'})]);let routing={},platforms=global.platform??[];try{routing=(await this.call('GET','/api/v1/config-routes')).routing??{};}catch{}try{platforms=(await this.call('GET','/api/v1/bots')).bots??platforms;}catch{}let stats=[];try{stats=(await this.call('GET','/api/v1/bots/stats')).platforms??[];}catch{}const publicPlatforms=platforms.map(p=>({id:p.id,type:p.type,status:stats.find(s=>s.id===p.id)?.status??'unknown'}));return [{kind:'profile',id:'default',identity:profileIdentity({id:'default'},publicPlatforms,routing)},...(list.info_list??[]).filter(x=>x.id!=='default').map(x=>({kind:'profile',id:x.id??x.uuid,identity:profileIdentity(x,publicPlatforms,routing)})),...files.filter(x=>x.endsWith('_config.json')).map(x=>({kind:'plugin',id:x.slice(0,-12)}))];}
}
