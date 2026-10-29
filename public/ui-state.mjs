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
export const isIssue=b=>['missing','disabled'].includes(b.status);
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

/** Instance cards use their effective profile resource; unassigned archives never substitute for bots. */
export function profileViews(resources){
 const profiles=resources.filter(r=>r.resource.kind==='profile'),bots=[],configs=[],unassigned=[];
 for(const item of profiles){const identity=item.resource.identity;for(const instance of identity?.instances??[]){bots.push({...item,viewGroup:'bot',viewKey:'bot:'+instance.instanceId,viewName:instance.instanceId,viewSubtitle:instance.category+' · 类型：'+instance.type+' · '+(item.resource.id==='default'?'使用全局默认配置（default）':'使用专用配置（'+item.resource.id.slice(0,8)+'）')+' · 名称来源：AstrBot实例标识'});}
 if(item.resource.id==='default')configs.push({...item,viewGroup:'shared',viewKey:'shared:default',viewName:'全局默认配置（共享）',viewSubtitle:'修改将影响所有使用 default 的机器人与会话'});
 else if(!identity?.instances?.length)unassigned.push({...item,viewGroup:'unassigned',viewKey:'archive:'+item.resource.id,viewName:'未使用的配置档案 · '+item.resource.id.slice(0,8),viewSubtitle:'未关联机器人实例；独立保留，不代表任何已接入bot'});
 }
 return [...bots,...configs,...unassigned];
}
