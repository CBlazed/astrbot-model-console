/** Explicit, reviewed binding semantics; unknown schema discoveries never become writable automatically. */
const entry=(path,capability='llm',inherit=null)=>({path,capability,inherit});
export const core=[entry('agent_runner.config.model.provider_id'),entry('agent_runner.config.compression.provider_id'),entry('provider_settings.default_image_caption_provider_id','vision'),entry('provider_stt_settings.provider_id','stt'),entry('provider_tts_settings.provider_id','tts'),entry('provider_ltm_settings.image_caption_provider_id','vision')];
/** AstrBot 内置网页搜索提供商（顺序/值与 AstrBot 4.29.3 配置项一致）。 */
export const webSearchProviders=[
 {value:'serpapi',label:'SerpApi'},
 {value:'deepseek',label:'DeepSeek Search API'},
 {value:'tavily',label:'Tavily'},
 {value:'baidu_ai_search',label:'Baidu AI Search'},
 {value:'bocha',label:'Bocha'},
 {value:'brave',label:'Brave'},
 {value:'firecrawl',label:'Firecrawl'},
 {value:'exa',label:'Exa'},
 {value:'anysearch',label:'AnySearch'},
];
/** 模型原生搜索（由本工作区的插件提供）的固定标识。 */
export const nativeSearchPlugin={id:'astrbot_plugin_model_websearch',value:'model_native',label:'跟随当前聊天模型（模型原生搜索）'};
/**
 * Provider options for the profile web-search settings.
 * The native option only appears after the plugin list was read and the plugin is installed;
 * it stays disabled until the plugin is activated.
 */
export function webSearchProviderOptions(features){
 const options=webSearchProviders.map(provider=>({...provider}));
 const native=features?.nativeWebSearch;
 if(native?.installed){
  options.push({
   value:nativeSearchPlugin.value,
   label:native.activated?nativeSearchPlugin.label:`${nativeSearchPlugin.label}（插件未启用）`,
   native:true,
   disabled:!native.activated,
  });
 }
 return options;
}
const setting=(path,type,extra={})=>({path,capability:'setting',group:'websearch',type,...extra});
/** Built-in search providers and the provider_settings field that stores their API key(s). */
export const webSearchKeyFields={
 tavily:{path:'provider_settings.websearch_tavily_key',type:'list'},
 bocha:{path:'provider_settings.websearch_bocha_key',type:'list'},
 brave:{path:'provider_settings.websearch_brave_key',type:'list'},
 firecrawl:{path:'provider_settings.websearch_firecrawl_key',type:'list'},
 exa:{path:'provider_settings.websearch_exa_key',type:'list'},
 anysearch:{path:'provider_settings.websearch_anysearch_key',type:'list'},
 deepseek:{path:'provider_settings.websearch_deepseek_key',type:'list'},
 serpapi:{path:'provider_settings.websearch_serpapi_key',type:'list'},
 baidu_ai_search:{path:'provider_settings.websearch_baidu_app_builder_key',type:'string'},
};
/** Secret key settings are reviewed fields whose values never enter a snapshot. */
export const secretSettings=Object.entries(webSearchKeyFields).map(([provider,definition])=>({
 ...setting(definition.path,definition.type==='list'?'secret-list':'secret-string',{provider,secret:true}),
}));
/** Reviewed non-model settings; boolean values are stored as real booleans by the engine. */
export const settings=[
 setting('provider_settings.web_search','bool'),
 setting('provider_settings.websearch_provider','enum'),
 setting('provider_settings.websearch_native_provider_id','model'),
 ...secretSettings,
];
/** Look up the key field definition for a built-in provider. */
export function webSearchKeyField(provider){return webSearchKeyFields[provider]??null;}
/** All provider_settings paths that carry API keys and must never be serialized into snapshots. */
export const secretPaths=new Set(secretSettings.map(field=>field.path));
export function isSecretPath(path){return secretPaths.has(path);}
export const plugins={
 astrbot_plugin_group_chat_plus:[entry('decision_ai_provider_id','llm','session'),entry('image_to_text_provider_id','vision'),entry('private_image_to_text_provider_id','vision')],
 astrbot_plugin_livingmemory:[entry('provider_settings.embedding_provider_id','embedding'),entry('provider_settings.llm_provider_id'),entry('recall_engine.rerank_provider_id','rerank')],
 astrbot_plugin_self_learning:[entry('Model_Configuration.filter_provider_id'),entry('Model_Configuration.refine_provider_id'),entry('Model_Configuration.reinforce_provider_id'),entry('V2_Architecture_Settings.embedding_provider_id','embedding'),entry('V2_Architecture_Settings.rerank_provider_id','rerank')],
 meme_manager:[entry('semantic.vision_provider_id','vision'),entry('semantic.embedding_provider_id','embedding'),entry('auto_collect.vision_provider_id','vision'),entry('generation.emotion.llm.provider_id')]
};
export const get=(object,path)=>path.split('.').reduce((v,k)=>v?.[k],object);
export function set(object,path,value){const parts=path.split('.');let v=object;for(const k of parts.slice(0,-1)){if(!v[k]||typeof v[k]!=='object')v[k]={};v=v[k];}v[parts.at(-1)]=value;}
export function fields(resource){return resource.kind==='profile'?[...core,...settings]:resource.kind==='plugin'?(plugins[resource.id]??[]):[];}
export function discover(config,prefix=''){return Object.entries(config??{}).flatMap(([k,v])=>{const path=prefix?`${prefix}.${k}`:k;return v&&typeof v==='object'&&!Array.isArray(v)?discover(v,path):typeof v==='string'&&/(provider_id|model_id)$/.test(k)?[{path,value:v,reviewRequired:true}]:[];});}
