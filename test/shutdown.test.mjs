import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';

const serverUrl=new URL('../src/server.mjs',import.meta.url).href;
const DLL_INIT_FAILURES=new Set([3221225794,-1073741502,'3221225794','-1073741502']);

test('SIGINT handler releases the instance lock and exits 0', async (t) => {
  const root=await mkdtemp(join(tmpdir(),'model-console-shutdown-'));
  const data=join(root,'data'),state=join(root,'state');
  await mkdir(join(data,'logs'),{recursive:true});
  await writeFile(join(data,'cmd_config.json'),JSON.stringify({dashboard:{username:'astrbot',jwt_secret:'shutdown-test-secret'}}));
  await writeFile(join(data,'logs','astrbot.log'),'');
  const childFile=join(root,'child.mjs');
  await writeFile(childFile,`import {start} from ${JSON.stringify(serverUrl)};
await start({env:{...process.env,ASTRBOT_DATA:${JSON.stringify(data)},MODEL_CONSOLE_STATE:${JSON.stringify(state)},MODEL_CONSOLE_PORT:'0'}});
setTimeout(()=>process.emit('SIGINT'),300);
`);
  const outFile=join(root,'child.out'),errFile=join(root,'child.err');
  const outFd=openSync(outFile,'w'),errFd=openSync(errFile,'w');
  try{
    const child=spawn(process.execPath,[childFile],{stdio:['ignore',outFd,errFd],windowsHide:true,env:{...process.env}});
    const code=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{child.kill();reject(Error('child did not exit after SIGINT'));},10000);
      child.on('exit',value=>{clearTimeout(timer);resolve(value);});
      child.on('error',reject);
    });
    closeSync(outFd);closeSync(errFd);
    if(DLL_INIT_FAILURES.has(code)){
      t.skip(`沙箱子进程 DLL init failure (${code})，SIGINT 用例在普通 Windows 运行`);
      return;
    }
    assert.equal(code,0,'SIGINT shutdown should exit 0');
    const lockExists=await stat(join(state,'instance.lock')).then(()=>true).catch(()=>false);
    assert.equal(lockExists,false,'instance.lock must be released on SIGINT');
    const diag=await readFile(join(state,'diagnostics.jsonl'),'utf8').catch(()=> '');
    assert.ok(!diag.includes('shutdown-test-secret'),'diagnostics must not contain the jwt secret');
  }finally{
    try{closeSync(outFd);}catch{}
    try{closeSync(errFd);}catch{}
    await rm(root,{recursive:true,force:true});
  }
});
