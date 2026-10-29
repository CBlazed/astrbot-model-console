/** Pure draft helpers; snapshots never replace unsaved edits. */
export const resourceKey = r => `${r.kind}:${r.id}`;
export const draftKey = (r,path) => `${resourceKey(r)}:${path}`;
export function stage(drafts,resource,path,value,baseValue,revision){
 const next=new Map(drafts),key=draftKey(resource,path);
 if(value===baseValue)next.delete(key);
 else next.set(key,{resource,path,value,baseValue,revision});
 return next;
}
export function groups(drafts){const result=new Map();for(const d of drafts.values()){const key=resourceKey(d.resource);if(!result.has(key))result.set(key,{resource:d.resource,revision:d.revision,changes:[]});result.get(key).changes.push({path:d.path,value:d.value});}return [...result.values()];}
export function currentRevision(snapshot,resource){return resource.kind==='provider'?snapshot.models.find(m=>m.id===resource.id)?.revision:snapshot.resources.find(r=>resourceKey(r.resource)===resourceKey(resource))?.revision;}
export const candidates=(models,capability)=>models.filter(m=>m.enabled&&m.capabilities.includes(capability));
export const indexCapability=c=>['embedding','rerank'].includes(c);
export const isIssue=b=>['missing','disabled','field-missing'].includes(b.status);
export function counts(snapshot){return {models:snapshot.models.filter(m=>m.enabled).length,resources:snapshot.resources.length,bindings:snapshot.resources.reduce((n,r)=>n+(r.bindings?.length??0),0),issues:snapshot.resources.reduce((n,r)=>n+(r.status==='unavailable'?1:(r.bindings??[]).filter(isIssue).length),0)};}

/** Session token: survives reload via sessionStorage, dies with the tab. Never persistent storage, never logged. */
const tokenKey='model-console.token';
const tokenPattern=/^[A-Za-z0-9._~+/=-]{8,512}$/;
const canRead=storage=>Boolean(storage)&&typeof storage.getItem==='function';
const canWrite=storage=>Boolean(storage)&&typeof storage.setItem==='function';
/** Read a token from a URL hash such as '#token=...'; anything else yields ''. Never throws. */
export function parseTokenHash(hash){
 if(typeof hash!=='string')return '';
 const raw=hash.trim().replace(/^[#?]/,'');
 if(!raw)return '';
 let value;
 try{value=new URLSearchParams(raw).get('token');}catch{return '';}
 if(typeof value!=='string')return '';
 return value.trim();
}
/** Restore a stored token; missing storage, invalid content and storage exceptions all yield ''. */
export function loadToken(storage){
 if(!canRead(storage))return '';
 let value;
 try{value=storage.getItem(tokenKey);}catch{return '';}
 return typeof value==='string'&&tokenPattern.test(value)?value:'';
}
/** Persist a validated token; returns false for blank/invalid tokens, disabled storage and storage exceptions. */
export function saveToken(storage,token){
 if(typeof token!=='string')return false;
 const value=token.trim();
 if(!tokenPattern.test(value))return false;
 if(!canWrite(storage))return false;
 try{storage.setItem(tokenKey,value);return true;}catch{return false;}
}
/** Drop the stored token; silent when storage is unavailable or throws. */
export function clearToken(storage){
 if(!Boolean(storage)||typeof storage.removeItem!=='function')return false;
 try{storage.removeItem(tokenKey);return true;}catch{return false;}
}

/** Selected device (Epic-1): only an id is stored, never any credential. 'local' is represented as ''. */
export const deviceStorageKey='model-console.device';
export function loadDevice(storage){
 try{const value=storage?.getItem?.(deviceStorageKey);return typeof value==='string'&&value&&value!=='local'?value:'';}catch{return '';}
}
export function saveDevice(storage,id){
 if(!storage||typeof storage.setItem!=='function'||typeof id!=='string'||!id)return false;
 try{storage.setItem(deviceStorageKey,id);return true;}catch{return false;}
}
/** Snapshot URL: local (or no selection) never sends a device parameter. */
export function snapshotPath(deviceId){return deviceId&&deviceId!=='local'?`/snapshot?device=${encodeURIComponent(deviceId)}`:'/snapshot';}
/** A remote snapshot is read-only; a snapshot without a device field is the legacy local view. */
export function isRemoteSnapshot(snapshot){return snapshot?.device?.kind==='http';}
/** Device selector options: local first, then remote devices; falls back to local-only before /devices is available. */
export function deviceOptions(devices){
 const list=Array.isArray(devices)?devices.filter(device=>device&&typeof device.id==='string'&&device.id):[];
 const local=list.find(device=>device.kind==='local'||device.id==='local');
 const options=[{value:'local',label:`本机${local?(local.readOnly?' · 只读':' · 可写'):''}`,kind:'local',readOnly:Boolean(local?.readOnly)}];
 for(const device of list){if(local&&device.id===local.id)continue;if(device.id==='local')continue;options.push({value:device.id,label:device.name??device.id,kind:device.kind??'http',readOnly:device.readOnly!==false});}
 return options;
}
/** Readable device health badge for the settings table. */
export function healthBadge(health){
 if(!health||typeof health!=='object')return {text:'未检测',kind:'warn'};
 if(health.reachable===true)return {text:Number.isFinite(health.latencyMs)?`可达 · ${health.latencyMs}ms`:'可达',kind:'good'};
 return {text:typeof health.error==='string'&&health.error?health.error:'不可达',kind:'bad'};
}
/** Readable device errors; empty string means the code is not device-related. */
export const deviceErrors={DEVICE_AUTH_FAILED:'远程设备凭据无效或已被撤销，请在设备设置中更新 OpenAPI Key。',DEVICE_FORBIDDEN:'远程设备缺少所需权限（scope），请检查 OpenAPI Key 的授权范围。',DEVICE_UNREACHABLE:'远程设备不可达，请确认目标机 AstrBot 正在运行且地址可访问。',DEVICE_NOT_FOUND:'设备不存在，可能已被删除。',DEVICE_INVALID:'设备信息不合法，请检查名称与地址。',DEVICE_SECRET_REQUIRED:'添加 HTTP 设备需要 OpenAPI Key。',DEVICE_EXISTS:'设备已存在，请换一个名称或地址。',DEVICE_INVALID_RESPONSE:'远程设备返回了无法解析的响应。',DEVICE_API_REJECTED:'远程 AstrBot 拒绝了该请求。'};
export function deviceErrorText(code){return typeof code==='string'?deviceErrors[code]??'':'';}

/** Binding status pills. field-missing means the path is absent from config, not an unverified empty value. */
export const bindingStatuses={configured:{label:'已配置',kind:'good'},missing:{label:'引用缺失',kind:'bad'},disabled:{label:'模型禁用',kind:'bad'},'field-missing':{label:'字段不存在',kind:'bad'},'per-session':{label:'跟随会话',kind:'warn'},'empty-semantics-unverified':{label:'待核实',kind:'warn'}};
export function bindingStatus(status){const known=bindingStatuses[status];return known?{...known}:{label:String(status??'未知'),kind:'warn'};}

/** A session/wildcard route exists, so cards only describe the platform-level view. */
export function routingNoticeText(routing){
 const granular=Number(routing?.granular??0);
 if(!(granular>0))return '';
 const total=Number.isFinite(Number(routing?.total))?Number(routing.total):granular;
 return `本设备存在会话级/通配符路由（共 ${total} 条路由，其中细分路由 ${granular} 条），卡片仅代表平台级视图。`;
}

const displayValue=value=>value===undefined||value===null||value===''?'空值 / 跟随默认':String(value);
/** Conflict diff: align local drafts with the latest server values. Missing server paths mean the field does not exist. */
export function buildConflictRows(pending,current,labels={}){
 const server=new Map();
 if(Array.isArray(current)){for(const item of current)if(item&&typeof item.path==='string')server.set(item.path,item.value);}
 else if(current&&typeof current==='object'){for(const [path,value] of Object.entries(current))server.set(path,value);}
 const rows=[];
 for(const change of Array.isArray(pending)?pending:[]){
  if(!change||typeof change.path!=='string')continue;
  const mine=displayValue(change.value);
  const serverValue=server.has(change.path)?displayValue(server.get(change.path)):'字段不存在';
  rows.push({path:change.path,label:labels[change.path]??change.path,mine,server:serverValue,changed:mine!==serverValue});
 }
 return rows;
}

/** Instance cards use their effective profile resource; unassigned archives never substitute for bots. */
export function profileViews(resources){
 const profiles=resources.filter(r=>r.resource.kind==='profile'),bots=[],configs=[],unassigned=[];
 for(const item of profiles){const identity=item.resource.identity;for(const instance of identity?.instances??[]){bots.push({...item,viewGroup:'bot',viewKey:'bot:'+instance.instanceId,viewName:instance.instanceId,viewSubtitle:instance.category+' · 类型：'+instance.type+' · '+(item.resource.id==='default'?'使用全局默认配置（default）':'使用专用配置（'+item.resource.id.slice(0,8)+'）')+' · 名称来源：AstrBot实例标识'});}
 if(item.resource.id==='default')configs.push({...item,viewGroup:'shared',viewKey:'shared:default',viewName:'全局默认配置（共享）',viewSubtitle:'修改将影响所有使用 default 的机器人与会话'});
 else if(!identity?.instances?.length)unassigned.push({...item,viewGroup:'unassigned',viewKey:'archive:'+item.resource.id,viewName:'未使用的配置档案 · '+item.resource.id.slice(0,8),viewSubtitle:'未关联机器人实例；独立保留，不代表任何已接入bot'});
 }
 return [...bots,...configs,...unassigned];
}
