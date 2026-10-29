/** Explicit, reviewed binding semantics; unknown schema discoveries never become writable automatically. */
const entry=(path,capability='llm',inherit=null)=>({path,capability,inherit});
export const core=[entry('agent_runner.config.model.provider_id'),entry('agent_runner.config.compression.provider_id'),entry('provider_settings.default_image_caption_provider_id','vision'),entry('provider_stt_settings.provider_id','stt'),entry('provider_tts_settings.provider_id','tts'),entry('provider_ltm_settings.image_caption_provider_id','vision')];
export const plugins={
 astrbot_plugin_group_chat_plus:[entry('decision_ai_provider_id','llm','session'),entry('image_to_text_provider_id','vision'),entry('private_image_to_text_provider_id','vision')],
 astrbot_plugin_livingmemory:[entry('provider_settings.embedding_provider_id','embedding'),entry('provider_settings.llm_provider_id'),entry('recall_engine.rerank_provider_id','rerank')],
 astrbot_plugin_self_learning:[entry('Model_Configuration.filter_provider_id'),entry('Model_Configuration.refine_provider_id'),entry('Model_Configuration.reinforce_provider_id'),entry('V2_Architecture_Settings.embedding_provider_id','embedding'),entry('V2_Architecture_Settings.rerank_provider_id','rerank')],
 meme_manager:[entry('semantic.vision_provider_id','vision'),entry('semantic.embedding_provider_id','embedding'),entry('auto_collect.vision_provider_id','vision'),entry('generation.emotion.llm.provider_id')]
};
export const get=(object,path)=>path.split('.').reduce((v,k)=>v?.[k],object);
export function set(object,path,value){const parts=path.split('.');let v=object;for(const k of parts.slice(0,-1)){if(!v[k]||typeof v[k]!=='object')v[k]={};v=v[k];}v[parts.at(-1)]=value;}
export function fields(resource){return resource.kind==='profile'?core:resource.kind==='plugin'?(plugins[resource.id]??[]):[];}
export function discover(config,prefix=''){return Object.entries(config??{}).flatMap(([k,v])=>{const path=prefix?`${prefix}.${k}`:k;return v&&typeof v==='object'&&!Array.isArray(v)?discover(v,path):typeof v==='string'&&/(provider_id|model_id)$/.test(k)?[{path,value:v,reviewRequired:true}]:[];});}
