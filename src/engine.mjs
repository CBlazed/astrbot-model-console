/** Plan/apply engine. One resource per plan; cross-resource atomicity is intentionally not promised. */
import {createHash,randomUUID} from 'node:crypto';
import {fields,get,set,discover,webSearchProviderOptions,isSecretPath} from './registry.mjs';
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const revision=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const backupShortId=value=>typeof value==='string'?value.split(/[\\/]+/).filter(Boolean).at(-1)??'':value;
/** AstrBot stores its schema/config version on the default profile; absent or non-scalar means unknown. */
const configVersionOf=config=>{const value=config?.config_version;return typeof value==='string'||typeof value==='number'?value:null;};
/** The config literal must contain every segment: absent path is reported as field-missing, not as empty. */
const hasPath=(object,path)=>{let current=object;for(const key of path.split('.')){if(current===null||typeof current!=='object'||!Object.hasOwn(current,key))return false;current=current[key];}return true;};
export function bindingRows(resource,config,models,sessionModel=null,features=null){
 return fields(resource).map(field=>{
  const present=hasPath(config,field.path);
  if(field.capability==='setting'){
   const raw=present?get(config,field.path):undefined;
   if(field.type==='bool'){
    const value=present?(raw===true?'true':raw===false?'false':String(raw)):'';
    return {...resource,...field,value,status:!present?'field-missing':value==='true'?'configured':'off'};
   }
   if(field.type==='secret-list'||field.type==='secret-string'){
    const count=Array.isArray(raw)?raw.filter(item=>typeof item==='string'&&item.trim()).length:(typeof raw==='string'&&raw.trim()?1:0);
    return {...resource,...field,configured:count>0,count,status:!present?'field-missing':count>0?'configured':'empty'};
   }
   if(field.type==='model'){
    const value=present?String(raw??''):'';
    const options=models.filter(model=>model.enabled&&model.capabilities.includes('llm')).map(model=>({value:model.id,label:model.id}));
    const selected=value?models.find(model=>model.id===value):null;
    let status=!value?'configured':selected?(!selected.enabled?'disabled':'configured'):'missing';
    return {...resource,...field,value,options,status};
   }
   const value=present?String(raw??''):'';
   const options=webSearchProviderOptions(features);
   const selected=value?options.find(option=>option.value===value):null;
   let status=!present?'field-missing':'configured';
   if(value==='model_native'&&(!selected||selected.disabled))status='plugin-unavailable';
   else if(value&&!selected)status='value-unrecognized';
   return {...resource,...field,value,options,status};
  }
  const value=present?get(config,field.path)??'':'';const resolved=value||(field.inherit==='session'?sessionModel:null);const model=models.find(x=>x.id===resolved);return {...resource,...field,value,effectiveModel:resolved,status:!present?'field-missing':resolved?(!model?'missing':!model.enabled?'disabled':'configured'):field.inherit==='session'?'per-session':'empty-semantics-unverified'};
 });
}
const MAX_SECRET_KEYS=20,MAX_SECRET_LENGTH=4096;
/** Parse a secret-list change (JSON string from the UI or an array from a backup restore). */
export function parseSecretList(value){
 let list=value;
 if(typeof value==='string'){
  const text=value.trim();
  if(!text)return [];
  try{list=JSON.parse(text);}catch{return null;}
 }
 if(!Array.isArray(list))return null;
 const keys=list.map(item=>typeof item==='string'?item.trim():'').filter(Boolean);
 if(keys.length>MAX_SECRET_KEYS||keys.some(key=>key.length===0||key.length>MAX_SECRET_LENGTH))return null;
 return keys;
}
/** Display copy of plan changes: secret values are replaced by a masked summary. */
function maskedSecretSummary(path,value){
 const field=fields({kind:'profile',id:'default'}).find(item=>item.path===path);
 if(field?.type==='secret-list'){
  const keys=parseSecretList(value);
  const count=Array.isArray(keys)?keys.length:0;
  return count>0?`设置 ${count} 个 Key（已隐藏）`:'清空 Key';
 }
 return typeof value==='string'&&value.trim()?'设置 Key（已隐藏）':'清空 Key';
}
export class Engine{
 constructor({gateway,backup,backups=null,audit=async()=>{},writeEnabled=false,ttl=2000}){Object.assign(this,{gateway,backup,backups,audit,writeEnabled,ttl});this.plans=new Map();this.busy=false;this.cached=null;this.pending=null;}
 async models(config){const global=config??await this.gateway.read({kind:'profile',id:'default'});return (global.provider??[]).map(p=>{const source=global.provider_sources?.find(s=>s.id===p.provider_source_id);const capabilities=inferCapability(source?.type??p.type);if(capabilities.includes('llm')&&p.modalities?.includes('image'))capabilities.push('vision');return {revision:revision(p),id:p.id,model:p.model,enabled:p.enable!==false,capabilities,capabilityEvidence:'configured provider type/modalities, not generation tested',effort:p.custom_extra_body?.reasoning_effort??null};});}
 async snapshot(){if(this.cached&&Date.now()-this.cached.at<this.ttl)return this.cached.value;if(this.pending)return this.pending;this.pending=this.loadSnapshot().then(value=>{this.cached={at:Date.now(),value};return value;}).finally(()=>{this.pending=null;});return this.pending;}
 async loadSnapshot(){
  const global=await this.gateway.read({kind:'profile',id:'default'});
  const models=await this.models(global);
  const resources=await this.gateway.resources();
  const routing=await this.routingSummary();
  let plugins=null;
  try{plugins=await this.gateway.plugins?.()??null;}catch{plugins=null;}
  const features=this.featuresFromPlugins(plugins);
  const results=[];
  for(const resource of resources){
   try{const config=await this.gateway.read(resource);results.push({resource,revision:revision(config),bindings:bindingRows(resource,config,models,null,features),unreviewed:discover(config).filter(x=>!fields(resource).some(f=>f.path===x.path)).map(x=>({path:x.path,reviewRequired:true}))});}
   catch{results.push({resource,status:'unavailable'});}
  }
  return {readAt:new Date().toISOString(),writeEnabled:this.writeEnabled,configVersion:configVersionOf(global),coverage:'reviewed bindings plus unreviewed field discovery; hidden schema/defaults not guaranteed',routing,plugins:Array.isArray(plugins)?plugins:null,features,models:models.map(m=>({...m,resource:{kind:'provider',id:m.id},writableFields:['custom_extra_body.reasoning_effort']})),resources:results};
 }
 /** Feature flags derived from the sanitized plugin inventory; null means "plugin list unreadable". */
 featuresFromPlugins(plugins){
  const list=Array.isArray(plugins)?plugins:null;
  const native=list?list.find(plugin=>plugin.name==='astrbot_plugin_model_websearch')??null:null;
  return {nativeWebSearch:{pluginId:'astrbot_plugin_model_websearch',listAvailable:Array.isArray(list),installed:Boolean(native),activated:Boolean(native?.activated),available:Boolean(native?.activated),version:native?.version??null}};
 }
 /** Fresh plugin detection used to re-validate native search at plan time. */
 async nativeSearchFeatures(){
  try{const plugins=await this.gateway.plugins?.();return this.featuresFromPlugins(plugins);}
  catch{return this.featuresFromPlugins(null);}
 }
 /** Optional gateway capability; any failure or absence falls back to an all-zero summary so snapshots never fail on it. */
 async routingSummary(){try{const summary=await this.gateway.routingSummary?.();if(!summary||typeof summary!=='object')return {total:0,platformLevel:0,granular:0};return {total:Number.isFinite(summary.total)?summary.total:0,platformLevel:Number.isFinite(summary.platformLevel)?summary.platformLevel:0,granular:Number.isFinite(summary.granular)?summary.granular:0};}catch{return {total:0,platformLevel:0,granular:0};}}
 async plan(resource,changes,internal=false,expectedRevision){
  if(!resource||!['plugin','profile','provider'].includes(resource.kind)||typeof resource.id!=='string'||!Array.isArray(changes)||!changes.length||changes.length>30)throw Error('INVALID_PLAN');
  for(const [key,plan]of this.plans)if(plan.expires<Date.now())this.plans.delete(key);
  if(!internal&&this.plans.size>=100)throw Error('PLAN_LIMIT');
  const before=await this.gateway.read(resource);
  if(expectedRevision!==undefined&&revision(before)!==expectedRevision)throw Error('CONCURRENT_CHANGE');
  const after=structuredClone(before),models=await this.models();
  const features=resource.kind==='profile'?await this.nativeSearchFeatures():null;
  const paths=new Set();
  for(const change of changes){
   if(!change||typeof change.path!=='string'||paths.has(change.path))throw Error('INVALID_CHANGE');
   paths.add(change.path);
   if(resource.kind==='provider'){
    if(change.path!=='custom_extra_body.reasoning_effort')throw Error('FIELD_NOT_WRITABLE');
    const capability=await this.gateway.efforts?.(resource.id);
    if(!capability?.includes(change.value))throw Error('EFFORT_UNVERIFIED_OR_UNSUPPORTED');
    set(after,change.path,change.value);
    continue;
   }
   const field=fields(resource).find(f=>f.path===change.path);
   if(!field||(typeof change.value!=='string'&&!(field.type==='secret-list'&&Array.isArray(change.value))))throw Error('FIELD_NOT_WRITABLE');
   if(field.capability==='setting'){
    if(field.type==='bool'){
     if(change.value!=='true'&&change.value!=='false')throw Error('VALUE_NOT_ALLOWED');
     set(after,change.path,change.value==='true');
     continue;
    }
    if(field.type==='secret-list'){
     const keys=parseSecretList(change.value);
     if(keys===null)throw Error('SECRET_VALUE_INVALID');
     set(after,change.path,keys);
     continue;
    }
    if(field.type==='secret-string'){
     const secret=String(change.value??'').trim();
     if(secret.length>MAX_SECRET_LENGTH)throw Error('SECRET_VALUE_INVALID');
     set(after,change.path,secret);
     continue;
    }
    if(field.type==='model'){
     if(change.value===''){set(after,change.path,'');continue;}
     const model=models.find(item=>item.id===change.value);
     if(!model?.enabled)throw Error('MODEL_MISSING_OR_DISABLED');
     if(!model.capabilities.includes('llm'))throw Error('CAPABILITY_UNVERIFIED_OR_MISMATCH');
     set(after,change.path,change.value);
     continue;
    }
    const options=webSearchProviderOptions(features);
    const option=options.find(item=>item.value===change.value);
    if(!option)throw Error('VALUE_NOT_ALLOWED');
    if(option.disabled)throw Error('NATIVE_SEARCH_PLUGIN_UNAVAILABLE');
    set(after,change.path,change.value);
    continue;
   }
   if(change.value){
    const model=models.find(x=>x.id===change.value);
    if(!model?.enabled)throw Error('MODEL_MISSING_OR_DISABLED');
    if(!model.capabilities.includes(field.capability))throw Error('CAPABILITY_UNVERIFIED_OR_MISMATCH');
    if(['embedding','rerank'].includes(field.capability))throw Error('INDEX_MIGRATION_REQUIRES_SEPARATE_WORKFLOW');
   }else if(['embedding','rerank'].includes(field.capability))throw Error('INDEX_MIGRATION_REQUIRES_SEPARATE_WORKFLOW');
   set(after,change.path,change.value);
  }
  const rawChanges=structuredClone(changes);
  const id=randomUUID(),plan={id,resource,before,after,revision:revision(before),changes:rawChanges,expires:Date.now()+600000};
  if(!internal)this.plans.set(id,plan);
  return {id,resource,revision:plan.revision,changes:this.displayChanges(rawChanges),expiresAt:new Date(plan.expires).toISOString(),impact:resource.kind==='provider'?'all references to this shared model':resource.kind==='plugin'?'all bots using this plugin':'this profile',warning:'No cross-resource atomicity; API readback is not a model generation test'};
 }
 /** Mask secret values before a plan/diff leaves the engine. */
 displayChanges(changes){
  return (Array.isArray(changes)?changes:[]).map(change=>{
   if(!change||!isSecretPath(change.path))return change;
   return {...change,value:'（已隐藏）',secret:true,summary:maskedSecretSummary(change.path,change.value)};
  });
 }
 async apply(id){if(!this.writeEnabled)throw Error('READ_ONLY');if(this.busy)throw Error('WRITE_IN_PROGRESS');const plan=this.plans.get(id);if(!plan||plan.expires<Date.now())throw Error('PLAN_EXPIRED');this.busy=true;let backupId;let writeAttempted=false;try{if(revision(await this.gateway.read(plan.resource))!==plan.revision)throw Error('CONCURRENT_CHANGE');const revalidated=plan.changes.length?await this.plan(plan.resource,plan.changes,true):null;if(revalidated)this.plans.delete(revalidated.id);backupId=await this.backup();if(revision(await this.gateway.read(plan.resource))!==plan.revision)throw Error('CONCURRENT_CHANGE');await this.audit({event:'apply-start',id,resource:plan.resource,backupId});writeAttempted=true;await this.gateway.write(plan.resource,plan.after);const actual=await this.gateway.read(plan.resource);if(revision(actual)!==revision(plan.after))throw Error('VERIFY_FAILED');await this.audit({event:'applied',id,resource:plan.resource,backupId});this.plans.delete(id);this.cached=null;return {status:'saved-and-readback-verified',id,backupId:backupShortId(backupId),generationVerified:false,hotLoadVerified:false};}catch(error){if(writeAttempted)this.cached=null;try{await this.audit({event:'apply-failed',id,resource:plan.resource,backupId,code:knownError(error)});}catch{}this.plans.delete(id);const failure=Error(knownError(error));failure.details={id,backupId:backupShortId(backupId),outcome:writeAttempted?'possibly-written':'not-written'};throw failure;}finally{this.busy=false;}}
 backupsStore(){if(!this.backups||typeof this.backups.list!=='function'||typeof this.backups.read!=='function')throw Error('BACKUPS_UNAVAILABLE');return this.backups;}
 async listBackups(){return this.backupsStore().list();}
 async backupStats(){const store=this.backupsStore();if(typeof store.stats==='function')return store.stats();const items=await store.list();return {count:items.length,bytes:items.reduce((total,item)=>total+(Number(item.bytes)||0),0),items:items.map(item=>({id:item.id,bytes:item.bytes,createdAt:item.createdAt}))};}
 /** Only reviewed bindings are diffed; restoring still writes the complete backup object (see warning). */
 restoreChanges(resource,before,after){
   if(resource.kind==='provider'){const path='custom_extra_body.reasoning_effort',beforeValue=get(before,path)??'',value=get(after,path)??'';return beforeValue===value?[]:[{path,before:beforeValue,value,capability:'llm'}];}
   const asText=value=>value===true?'true':value===false?'false':value===undefined||value===null?'':String(value);
   return fields(resource).flatMap(field=>{const beforeRaw=get(before,field.path),afterRaw=get(after,field.path);const beforeValue=field.capability==='setting'?asText(beforeRaw):beforeRaw??'';const value=field.capability==='setting'?asText(afterRaw):afterRaw??'';return beforeValue===value?[]:[{path:field.path,before:beforeValue,value,capability:field.capability}];});
  }
 async backupDiff(backupId,resource){const store=this.backupsStore();if(!resource||!['plugin','profile','provider'].includes(resource.kind)||typeof resource.id!=='string')throw Error('INVALID_RESOURCE');const current=await this.gateway.read(resource);const {config}=await store.read(backupId,resource);return {backupId,resource,changes:this.displayChanges(this.restoreChanges(resource,current,config)),currentRevision:revision(current)};}
 async planRestore(backupId,resource,expectedRevision){const store=this.backupsStore();if(!resource||!['plugin','profile','provider'].includes(resource.kind)||typeof resource.id!=='string')throw Error('INVALID_PLAN');for(const [key,plan]of this.plans)if(plan.expires<Date.now())this.plans.delete(key);if(this.plans.size>=100)throw Error('PLAN_LIMIT');const before=await this.gateway.read(resource);if(expectedRevision!==undefined&&revision(before)!==expectedRevision)throw Error('CONCURRENT_CHANGE');const {config}=await store.read(backupId,resource);const after=structuredClone(config),changes=this.restoreChanges(resource,before,after),id=randomUUID();if(changes.some(change=>['embedding','rerank'].includes(change.capability)))throw Error('INDEX_MIGRATION_REQUIRES_SEPARATE_WORKFLOW');const plan={id,resource:structuredClone(resource),before,after,revision:revision(before),changes,expires:Date.now()+600000,mode:'restore',backupId};this.plans.set(id,plan);return {id,resource:plan.resource,revision:plan.revision,changes:this.displayChanges(changes),expiresAt:new Date(plan.expires).toISOString(),impact:resource.kind==='provider'?'all references to this shared model':resource.kind==='plugin'?'all bots using this plugin':'this profile',warning:'恢复会覆盖该资源完整对象：备份中的配置将整体写回，只有列出的已审查字段差异经过校验。应用后可读回验证，但这不是模型生成测试。',mode:'restore',backupId};}
 async rollbackPlan(id){const plan=this.plans.get(id);if(!plan)throw Error('PLAN_EXPIRED');throw Error('ROLLBACK_USES_BACKUP_AND_NEW_REVIEWED_PLAN');}
}
export function inferCapability(type=''){if(/embedding/.test(type))return ['embedding'];if(/rerank/.test(type))return ['rerank'];if(/stt/.test(type))return ['stt'];if(/tts/.test(type))return ['tts'];if(/chat_completion|responses/.test(type))return ['llm'];return [];}
export const knownError=error=>/^[A-Z][A-Z0-9_]+$/.test(error?.message??'')?error.message:'OPERATION_FAILED';

