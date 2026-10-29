/** Path resolution for state and AstrBot data. Pure discovery: no network, no secrets, no migration. */
import {homedir,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {readdir,stat} from 'node:fs/promises';

export const ASTRBOT_DATA_REQUIRED='ASTRBOT_DATA_REQUIRED';

const isDirectory=async path=>{try{return (await stat(path)).isDirectory();}catch{return false;}};

/**
 * Resolve the writable state directory.
 * Priority: MODEL_CONSOLE_STATE > %LOCALAPPDATA%\AstrBotModelConsole\state > <tmp>/AstrBotModelConsole/state.
 * Never touches the filesystem; callers create the directory.
 */
export function resolveStateDir(env=process.env){
  if(env.MODEL_CONSOLE_STATE)return resolve(env.MODEL_CONSOLE_STATE);
  const base=env.LOCALAPPDATA?join(env.LOCALAPPDATA,'AstrBotModelConsole'):join(tmpdir(),'AstrBotModelConsole');
  return join(base,'state');
}

/**
 * Discover the AstrBot data directory. ASTRBOT_DATA wins; otherwise scan the launcher instance
 * directories and the classic ~/.astrbot/data. Exactly one hit is required.
 * Throws an Error with code ASTRBOT_DATA_REQUIRED (readable message, candidate count, no secrets).
 */
export async function discoverAstrBotData(env=process.env){
  if(env.ASTRBOT_DATA)return resolve(env.ASTRBOT_DATA);
  const home=env.USERPROFILE||homedir();
  const candidates=[];
  const instancesRoot=join(home,'.astrbot_launcher','instances');
  let instances=[];
  try{instances=await readdir(instancesRoot,{withFileTypes:true});}catch{}
  for(const entry of instances){
    if(!entry.isDirectory())continue;
    const candidate=join(instancesRoot,entry.name,'core','data');
    if(await isDirectory(candidate))candidates.push(candidate);
  }
  const classic=join(home,'.astrbot','data');
  if(await isDirectory(classic))candidates.push(classic);
  if(candidates.length===1)return candidates[0];
  const error=Error(candidates.length===0
    ?'ASTRBOT_DATA_REQUIRED: 未找到 AstrBot 数据目录。已检查 %USERPROFILE%\\.astrbot_launcher\\instances\\*\\core\\data 与 %USERPROFILE%\\.astrbot\\data。请先启动一次 AstrBot，或设置 ASTRBOT_DATA 指向其 data 目录。'
    :`ASTRBOT_DATA_REQUIRED: 发现 ${candidates.length} 个 AstrBot 数据目录，无法自动选择。请用环境变量 ASTRBOT_DATA 指定其中一个。`);
  error.code=ASTRBOT_DATA_REQUIRED;
  error.candidates=candidates.length;
  throw error;
}

/**
 * Report an old project-local ./state directory so the user can opt into it with MODEL_CONSOLE_STATE.
 * Returns a readable hint string, or null when there is nothing legacy to report.
 * Never migrates, modifies or deletes the old directory.
 */
export async function findLegacyState(cwd=process.cwd()){
  const legacy=join(cwd,'state');
  if(!(await isDirectory(legacy)))return null;
  return `提示：检测到旧状态目录 ${legacy}。本工具不会自动迁移或删除它；如需沿用旧备份与审计，请设置 MODEL_CONSOLE_STATE 指向该目录。`;
}
