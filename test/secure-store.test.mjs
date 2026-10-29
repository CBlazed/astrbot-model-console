import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {protect,unprotect,isProtected,defaultRunner,SECURE_STORE_UNAVAILABLE,PROTECTED_PREFIX} from '../src/secure-store.mjs';

/** This sandbox blocks piped child stdio (EPERM), so the real DPAPI path is skipped where it cannot run. */
const pipesBlocked=()=>{
  if(process.platform!=='win32')return false;
  try{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command','[Console]::Out.Write(1)'],{stdio:['pipe','pipe','ignore'],windowsHide:true});
    child.on('error',()=>{});
    child.stdin?.end();
    child.unref?.();
    return false;
  }catch(error){return error?.code==='EPERM';}
};
const realDpapiSkip=process.platform!=='win32'?'Windows only':pipesBlocked()?'sandbox blocks Node→PowerShell piped stdio':false;

const unavailableCode=error=>error?.code===SECURE_STORE_UNAVAILABLE;
const b64=value=>Buffer.from(value,'utf8').toString('base64');
const fakeRunner=async(operation,payload)=>{
  const bytes=Buffer.from(payload,'base64');
  if(operation==='protect')return Buffer.from(Buffer.concat([Buffer.from('FAKE:','utf8'),bytes])).toString('base64');
  if(operation==='unprotect'){
    const text=Buffer.from(payload,'base64').toString('utf8');
    if(!text.startsWith('FAKE:'))throw Error('FAKE_BAD_BLOB');
    return b64(text.slice('FAKE:'.length));
  }
  throw Error('FAKE_UNKNOWN_OPERATION');
};
const failingRunner=async()=>{throw Error('runner exploded');};

test('fake runner round-trips a value and keeps plaintext out of the blob',async()=>{
  const value='abk_secret_value_中文_$';
  const calls=[];
  const runner=async(operation,payload)=>{calls.push([operation,payload]);return fakeRunner(operation,payload);};
  const blob=await protect(value,{runner});
  assert.ok(blob.startsWith(PROTECTED_PREFIX));
  assert.equal(isProtected(blob),true);
  assert.ok(!blob.includes(value));
  assert.deepEqual(calls[0],['protect',b64(value)]);
  assert.equal(await unprotect(blob,{runner}),value);
  assert.deepEqual(calls[1],['unprotect',blob.slice(PROTECTED_PREFIX.length)]);
});

test('explicit fake runner works even when the platform is not Windows',async()=>{
  const blob=await protect('ssh key',{runner:fakeRunner,platform:'linux'});
  assert.equal(await unprotect(blob,{runner:fakeRunner,platform:'linux'}),'ssh key');
});

test('default DPAPI path refuses non-Windows platforms with SECURE_STORE_UNAVAILABLE',async()=>{
  await assert.rejects(()=>protect('x',{platform:'linux'}),unavailableCode);
  await assert.rejects(()=>unprotect('dpapi:AAAA',{platform:'linux'}),unavailableCode);
});

test('malformed values and blobs fail closed',async()=>{
  for(const bad of [undefined,null,123,{},[]])await assert.rejects(()=>protect(bad,{runner:fakeRunner}),unavailableCode);
  for(const bad of [undefined,null,'','plain','dpapi:','dpapi:%%%','DPAPI:AAAA','dpapi:AAAA\n'])await assert.rejects(()=>unprotect(bad,{runner:fakeRunner}),unavailableCode);
  assert.equal(isProtected('dpapi:AAAA'),true);
  assert.equal(isProtected('plaintext'),false);
});

test('runner failures and malformed runner output never leak through',async()=>{
  await assert.rejects(()=>protect('x',{runner:failingRunner}),unavailableCode);
  await assert.rejects(()=>unprotect('dpapi:AAAA',{runner:failingRunner}),unavailableCode);
  await assert.rejects(()=>protect('x',{runner:async()=>''}),unavailableCode);
  await assert.rejects(()=>protect('x',{runner:async()=>'not base64!'}),unavailableCode);
  await assert.rejects(()=>unprotect('dpapi:AAAA',{runner:async()=>'%%%'}),unavailableCode);
  await assert.rejects(()=>protect('x',{runner:async()=>{throw Error('boom');}}),unavailableCode);
});

test('defaultRunner is a function and resolves lazily',()=>{
  assert.equal(typeof defaultRunner(),'function');
});

test('real DPAPI CurrentUser round-trips shell-sensitive text and rejects tampering',{skip:realDpapiSkip},async()=>{
  const value='abk_$env:PATH; "quote" \'single\' `backtick`\n中文密钥';
  const blob=await protect(value);
  assert.ok(blob.startsWith(PROTECTED_PREFIX));
  assert.ok(!blob.includes(value));
  assert.ok(!blob.includes(b64(value)));
  assert.equal(await unprotect(blob),value);
  const payload=Buffer.from(blob.slice(PROTECTED_PREFIX.length),'base64');
  payload[payload.length-1]^=0xff;
  await assert.rejects(()=>unprotect(PROTECTED_PREFIX+payload.toString('base64')),unavailableCode);
});
