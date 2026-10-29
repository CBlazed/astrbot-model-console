#!/usr/bin/env node
/**
 * Portable package builder for AstrBot Model Console. Zero third-party dependencies.
 *
 * Usage: node scripts/build-package.mjs [--zip] [--out <dir>] [--help]
 *
 * Copies a strict whitelist (src/, public/, package.json, start-console*.cmd, README, necessary
 * docs) into <out>/AstrBotModelConsole, bundles node.exe + the Node license, writes start.cmd /
 * start-edit.cmd and SHA256SUMS.txt, regenerates installer/model-console.iss, and optionally
 * builds the portable zip with PowerShell Compress-Archive (visible window, never hidden).
 *
 * Never copy state/, .git/, .tmp*, *.log or tests: user data and secrets stay out of the package.
 */
import {createHash} from 'node:crypto';
import {createReadStream,existsSync} from 'node:fs';
import {copyFile,mkdir,readdir,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const PRODUCT='AstrBotModelConsole';
const APP_ID='{{6D3C8B4E-2F5A-4E7B-9C1D-8A7E6F5D4C3B}';
const SCRIPT_DIR=dirname(fileURLToPath(import.meta.url));
const REPO_ROOT=resolve(SCRIPT_DIR,'..');
const REQUIRED_DIRS=['src','public'];
const REQUIRED_FILES=['package.json','README.md','start-console.cmd','start-console-edit.cmd'];
const REQUIRED_DOCS=['docs/HANDOVER.zh-CN.md'];
const OPTIONAL_DOCS=['docs/BUILD.zh-CN.md','docs/DESIGN-multi-device-2026-10-29.zh-CN.md'];
const SKIP_NAMES=new Set(['.git','node_modules','state','dist','test','installer','scripts']);

const isFile=async path=>{try{return (await stat(path)).isFile();}catch{return false;}};
const isDirectory=async path=>{try{return (await stat(path)).isDirectory();}catch{return false;}};

function skipEntry(name){
  return SKIP_NAMES.has(name)||name.startsWith('.')||/\.log$/i.test(name)||/\.tmp$/i.test(name);
}

async function copyTree(source,dest){
  const copied=[];
  for(const entry of await readdir(source,{withFileTypes:true})){
    if(skipEntry(entry.name))continue;
    const from=join(source,entry.name),to=join(dest,entry.name);
    if(entry.isDirectory()){await mkdir(to,{recursive:true});copied.push(...await copyTree(from,to));}
    else if(entry.isFile()){await mkdir(dirname(to),{recursive:true});await copyFile(from,to);copied.push(to);}
  }
  return copied;
}

async function listFiles(root){
  const found=[];
  async function walk(directory){
    for(const entry of await readdir(directory,{withFileTypes:true})){
      const full=join(directory,entry.name);
      if(entry.isDirectory())await walk(full);
      else if(entry.isFile())found.push(full);
    }
  }
  await walk(root);
  return found;
}

function sha256File(path){
  return new Promise((resolveHash,reject)=>{
    const hash=createHash('sha256');
    const stream=createReadStream(path);
    stream.on('error',reject);
    stream.on('data',chunk=>hash.update(chunk));
    stream.on('end',()=>resolveHash(hash.digest('hex')));
  });
}

async function writeIfChanged(path,content){
  try{if(await readFile(path,'utf8')===content)return false;}catch{}
  await writeFile(path,content,'utf8');
  return true;
}

function launcher(extraArgs,description){
  const command=['"%~dp0node.exe"','"%~dp0src\\server.mjs"',...extraArgs].join(' ');
  return [
    '@echo off',
    'setlocal',
    'cd /d "%~dp0"',
    'if not exist "%~dp0node.exe" (',
    '  echo [ERROR] node.exe is missing next to start.cmd. Extract the complete package again.',
    '  pause',
    '  exit /b 1',
    ')',
    `echo ${description}`,
    command,
    'if errorlevel 1 pause',
    '',
  ].join('\r\n');
}

function parseArgs(argv){
  const options={zip:false,out:join(REPO_ROOT,'dist'),help:false};
  for(let index=0;index<argv.length;index++){
    const arg=argv[index];
    if(arg==='--zip')options.zip=true;
    else if(arg==='--help'||arg==='-h')options.help=true;
    else if(arg==='--out'){
      const value=argv[++index];
      if(!value)throw Error('--out 需要一个目录参数。');
      options.out=resolve(value);
    }else if(arg.startsWith('--out='))options.out=resolve(arg.slice('--out='.length));
    else throw Error(`未知参数：${arg}（支持 --zip、--out <dir>、--help）`);
  }
  return options;
}

function printHelp(){
  console.log([
    'AstrBot Model Console 便携打包脚本（零依赖）',
    '',
    '用法：node scripts/build-package.mjs [选项]',
    '',
    '选项：',
    '  --zip          构建后用 PowerShell Compress-Archive 生成便携 zip',
    '  --out <dir>    输出根目录，默认 <repo>/dist',
    '  --help, -h     显示本帮助',
    '',
    '产物：<out>/AstrBotModelConsole/（含 node.exe、src/、public/、start.cmd、SHA256SUMS.txt）',
    '      <out>/AstrBotModelConsole-<version>-win-<arch>.zip（仅 --zip）',
    '      <repo>/installer/model-console.iss（自动重新生成）',
    '',
    '不会打包：state/、.git/、.tmp*、*.log、test/、任何密钥或用户数据。',
  ].join('\n'));
}

function guardTarget(target,out){
  if(resolve(out)===target||basename(target)!==PRODUCT)throw Error(`拒绝清理异常输出目录：${target}`);
  for(const sensitive of ['src','public','docs','test','scripts','installer'])if(target===resolve(REPO_ROOT,sensitive))throw Error(`拒绝清理源码目录：${target}`);
  if(target===REPO_ROOT)throw Error('拒绝清理仓库根目录。');
}

function resolvePowershell(){
  const systemRoot=process.env.SystemRoot??'C:\\Windows';
  const absolute=join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  return existsSync(absolute)?absolute:'powershell.exe';
}

/** PowerShell single-quoted literal: internal single quotes are doubled; spaces stay inside the quotes. */
function psLiteral(value){
  return `'${String(value).replaceAll("'","''")}'`;
}

function installerSourceDir(out){
  const target=join(out,PRODUCT);
  const relativePath=relative(join(REPO_ROOT,'installer'),target);
  return isAbsolute(relativePath)?target:relativePath;
}

function installerScript({version,out,nodeVersion}){
  const sourceDir=installerSourceDir(out);
  return `\uFEFF; AstrBot Model Console - Inno Setup 脚本（per-user 安装，免管理员）
; 本文件由 scripts/build-package.mjs 自动生成；要改安装器请改脚本里的模板，不要直接改本文件。
; 生成安装器前先构建便携包：node scripts/build-package.mjs
; 编译（需安装 Inno Setup 6）：ISCC.exe installer\\model-console.iss
; 产物：installer\\Output\\AstrBotModelConsole-${version}-win-${process.arch}-setup.exe

#define AppName "AstrBot Model Console"
#define AppVersion "${version}"
#define NodeVersion "${nodeVersion}"
#define SourceDir "${sourceDir}"

[Setup]
AppId=${APP_ID}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=AstrBot Model Console
DefaultDirName={localappdata}\\AstrBotModelConsole\\app
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=Output
OutputBaseFilename=AstrBotModelConsole-{#AppVersion}-win-${process.arch}-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
UninstallDisplayIcon={app}\\node.exe
CloseApplications=no

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加任务："; Flags: unchecked

[Files]
; 只安装便携包内容；state\\ 用户数据不在安装范围内。
Source: "{#SourceDir}\\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\\{#AppName}"; Filename: "{app}\\start.cmd"; WorkingDir: "{app}"
Name: "{group}\\{cm:UninstallProgram,{#AppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\\{#AppName}"; Filename: "{app}\\start.cmd"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\\start.cmd"; Description: "启动 {#AppName}"; Flags: nowait postinstall skipifsilent

; 卸载只删除安装目录 {app}（%LOCALAPPDATA%\\AstrBotModelConsole\\app）与快捷方式。
; 用户数据目录 %LOCALAPPDATA%\\AstrBotModelConsole\\state（备份、审计、锁）由程序自行管理，
; 这里刻意不写 [UninstallDelete]，卸载后保留 state。
`;
}

async function main(){
  const options=parseArgs(process.argv.slice(2));
  if(options.help){printHelp();return;}
  if(process.platform!=='win32')throw Error('打包脚本仅支持 Windows：需要复制 node.exe 并生成 start.cmd。');
  const packageJson=JSON.parse(await readFile(join(REPO_ROOT,'package.json'),'utf8'));
  if(!packageJson.version)throw Error('package.json 缺少 version 字段。');
  const version=packageJson.version;
  const target=join(options.out,PRODUCT);
  guardTarget(target,options.out);
  if(resolve(options.out)===target)throw Error('--out 不能指向包目录本身。');
  await rm(target,{recursive:true,force:true});
  await mkdir(target,{recursive:true});

  for(const name of REQUIRED_DIRS){
    const source=join(REPO_ROOT,name);
    if(!(await isDirectory(source)))throw Error(`缺少必需目录：${name}/`);
    await mkdir(join(target,name),{recursive:true});
    await copyTree(source,join(target,name));
  }
  for(const name of REQUIRED_FILES){
    const source=join(REPO_ROOT,name);
    if(!(await isFile(source)))throw Error(`缺少必需文件：${name}`);
    await copyFile(source,join(target,name));
  }
  await mkdir(join(target,'docs'),{recursive:true});
  for(const doc of REQUIRED_DOCS){
    const source=join(REPO_ROOT,doc);
    if(!(await isFile(source)))throw Error(`缺少必需文档：${doc}`);
    await copyFile(source,join(target,doc));
  }
  for(const doc of OPTIONAL_DOCS){
    const source=join(REPO_ROOT,doc);
    if(await isFile(source))await copyFile(source,join(target,doc));
    else console.warn(`跳过可选文档（不存在）：${doc}`);
  }

  if(basename(process.execPath).toLowerCase()!=='node.exe')throw Error(`当前进程不是 Windows node.exe：${process.execPath}`);
  await copyFile(process.execPath,join(target,'node.exe'));
  let nodeLicense=null;
  try{
    const nodeDirectory=dirname(process.execPath);
    nodeLicense=(await readdir(nodeDirectory)).find(name=>/^licen[cs]e(\.md|\.txt)?$/i.test(name))??null;
    if(nodeLicense)await copyFile(join(nodeDirectory,nodeLicense),join(target,'LICENSE.node.txt'));
  }catch{}
  if(!nodeLicense)console.warn('警告：未找到 Node 的 LICENSE 文件，分发前请自行确认许可证合规。');

  await writeFile(join(target,'start.cmd'),launcher(['--open'],'AstrBot Model Console (read-only). Close this window to stop it.'),'utf8');
  await writeFile(join(target,'start-edit.cmd'),launcher(['--enable-writes','--open'],'AstrBot Model Console (editing). Changes still require preview and Apply in the browser.'),'utf8');

  await mkdir(join(REPO_ROOT,'installer'),{recursive:true});
  const installerPath=join(REPO_ROOT,'installer','model-console.iss');
  const installerChanged=await writeIfChanged(installerPath,installerScript({version,out:options.out,nodeVersion:process.version}));

  const files=(await listFiles(target)).filter(file=>basename(file)!=='SHA256SUMS.txt').sort();
  const lines=[];let totalBytes=0;
  for(const file of files){
    lines.push(`${await sha256File(file)}  ${relative(target,file).split(sep).join('/')}`);
    totalBytes+=(await stat(file)).size;
  }
  await writeFile(join(target,'SHA256SUMS.txt'),lines.join('\n')+'\n','utf8');

  console.log('AstrBot Model Console 便携包构建完成');
  console.log(`  版本：${version}（Node ${process.version} ${process.arch}，随包 node.exe）`);
  console.log(`  输出：${target}`);
  console.log(`  文件：${files.length} 个，合计 ${(totalBytes/1048576).toFixed(1)} MB`);
  console.log(`  校验：${join(target,'SHA256SUMS.txt')}（${lines.length} 行）`);
  console.log(`  启动：${join(target,'start.cmd')}（双击；只读模式）`);
  console.log(`  安装器脚本：${installerPath}${installerChanged?'':'（未变化）'}`);

  if(options.zip){
    const zipPath=join(options.out,`${PRODUCT}-${version}-win-${process.arch}.zip`);
    await rm(zipPath,{force:true});
    console.log(`[zip] 调用 PowerShell Compress-Archive（可见窗口）：${zipPath}`);
    // -Command 之后的多个参数会被 PowerShell 重新拼接并丢失空格引用，这里必须传一整条命令字符串。
    const command=`Compress-Archive -LiteralPath ${psLiteral(target)} -DestinationPath ${psLiteral(zipPath)} -Force`;
    const result=spawnSync(resolvePowershell(),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',command],{stdio:'inherit',windowsHide:false});
    if(result.error)throw result.error;
    if(result.status!==0)throw Error(`Compress-Archive 失败（退出码 ${result.status}）。`);
    const zipSize=(await stat(zipPath)).size;
    console.log(`[zip] 完成：${zipPath}（${(zipSize/1048576).toFixed(1)} MB）`);
    console.log(`[zip] sha256：${await sha256File(zipPath)}`);
  }
}

main().catch(error=>{console.error(`\n打包失败：${error?.message??error}`);process.exitCode=1;});
