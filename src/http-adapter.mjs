/** Remote AstrBot adapter over the official OpenAPI v1 surface with a scoped API key.
 *  Implements the same gateway-shaped interface Engine expects: read/write/resources/efforts. */

const PLATFORM_ROUTE=/^[^:]+::$/;

export class HttpGatewayAdapter{
  /**
   * @param {{baseUrl:string,apiKey:string,fetcher?:typeof fetch,timeoutMs?:number}} options
   */
  constructor({baseUrl,apiKey,fetcher=fetch,timeoutMs=10000}){
    if(typeof baseUrl!=='string'||!baseUrl)throw adapterError('DEVICE_INVALID','缺少 baseUrl');
    if(typeof apiKey!=='string'||!apiKey)throw adapterError('DEVICE_SECRET_REQUIRED','缺少 OpenAPI Key');
    this.baseUrl=baseUrl.replace(/\/$/,'');
    this.apiKey=apiKey;
    this.fetcher=fetcher;
    this.timeoutMs=timeoutMs;
  }

  async call(method,path,body){
    if(typeof path!=='string'||!path.startsWith('/api/v1/'))throw adapterError('DEVICE_INVALID','只允许 /api/v1/ 路径');
    let response;
    try{
      response=await this.fetcher(`${this.baseUrl}${path}`,{
        method,
        redirect:'error',
        signal:AbortSignal.timeout(this.timeoutMs),
        headers:{Authorization:`Bearer ${this.apiKey}`,'Content-Type':'application/json'},
        body:body===undefined?undefined:JSON.stringify(body),
      });
    }catch{throw adapterError('DEVICE_UNREACHABLE','远程 AstrBot 不可达');}
    if(response.status===401)throw adapterError('DEVICE_AUTH_FAILED','远程设备凭据无效或已被撤销');
    if(response.status===403)throw adapterError('DEVICE_FORBIDDEN','远程设备缺少所需 scope');
    if(!response.ok)throw adapterError(`DEVICE_HTTP_${response.status}`,`远程 AstrBot 返回 HTTP ${response.status}`);
    let json;
    try{json=await response.json();}catch{throw adapterError('DEVICE_INVALID_RESPONSE','远程响应不是合法 JSON');}
    if(json?.status!=='ok')throw adapterError('DEVICE_API_REJECTED','远程 AstrBot 拒绝了请求');
    return json.data;
  }

  async read(resource){
    const id=encodeURIComponent(resource.id);
    if(resource.kind==='provider')return (await this.call('GET',`/api/v1/providers/by-id?provider_id=${id}`)).provider;
    if(resource.kind==='profile')return (await this.call('GET',`/api/v1/config-profiles/${id}`)).config;
    if(resource.kind==='plugin')return (await this.call('GET',`/api/v1/plugins/config?plugin_id=${id}`)).config;
    throw adapterError('DEVICE_INVALID','未知资源类型');
  }

  async write(resource,config){
    const id=encodeURIComponent(resource.id);
    if(resource.kind==='provider')return this.call('PUT','/api/v1/providers/by-id',{provider_id:resource.id,config});
    if(resource.kind==='profile')return this.call('PUT',`/api/v1/config-profiles/${id}`,config);
    if(resource.kind==='plugin')return this.call('PUT','/api/v1/plugins/config',{plugin_id:resource.id,config});
    throw adapterError('DEVICE_INVALID','未知资源类型');
  }

  /** Remote reasoning-level probing is not part of the scoped OpenAPI surface yet. */
  async efforts(){return null;}

  async routingSummary(){
    try{
      const data=await this.call('GET','/api/v1/config-routes');
      const routing=data?.routing&&typeof data.routing==='object'?data.routing:{};
      const patterns=Object.keys(routing);
      const platformLevel=patterns.filter(pattern=>PLATFORM_ROUTE.test(pattern)).length;
      return {total:patterns.length,platformLevel,granular:patterns.length-platformLevel};
    }catch{return {total:0,platformLevel:0,granular:0};}
  }

  async resources(){
    const routingData=await this.routingSummary();
    let profileList=[];
    try{profileList=(await this.call('GET','/api/v1/config-profiles')).info_list??[];}catch(error){throw error;}
    const profiles=profileList.filter(item=>item&&item.id!=='default').map(item=>({
      kind:'profile',
      id:item.id??item.uuid,
      identity:remoteIdentity(item.id??item.uuid,item.name??null,routingData),
    }));
    const plugins=[];
    try{
      const data=await this.call('GET','/api/v1/plugins');
      const list=Array.isArray(data)?data:(data?.plugins??data?.list??[]);
      for(const plugin of list){
        const id=plugin?.name??plugin?.id??plugin?.plugin_id;
        if(typeof id==='string'&&id)plugins.push({kind:'plugin',id});
      }
    }catch{/* plugins scope optional: keep profiles only */}
    return [{kind:'profile',id:'default',identity:remoteIdentity('default','全局默认配置',routingData)},...profiles,...plugins];
  }

  async health(){
    const started=Date.now();
    try{
      await this.call('GET','/api/v1/config-profiles');
      return {reachable:true,latencyMs:Date.now()-started};
    }catch(error){
      return {reachable:false,latencyMs:Date.now()-started,error:error?.code??'DEVICE_UNREACHABLE'};
    }
  }
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

function remoteIdentity(id,name,routing){
  return {
    name:id==='default'?`${name||'全局默认配置'}（远程）`:(name||`远程配置 · ${String(id).slice(0,8)}`),
    transport:'远程设备',
    association:id==='default'?'remote-default':'remote-profile',
    instances:[],
    account:null,
    nickname:null,
    routingStatus:routing?.granular>0?'远程视图：存在会话级/通配符路由，仅平台级展示':'远程只读视图',
  };
}

export function adapterError(code,message){
  const error=Error(message);error.code=code;return error;
}
