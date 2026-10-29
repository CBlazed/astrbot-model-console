/** DPAPI-backed secret protection for the local console.
 *  Windows uses PowerShell `ProtectedData` (CurrentUser); the plaintext and ciphertext only travel through
 *  stdin/stdout as base64, so no secret can appear in a command line or process list. Non-Windows platforms
 *  and any runner failure surface as SECURE_STORE_UNAVAILABLE and callers decide how to degrade. */
import {spawn} from 'node:child_process';

export const SECURE_STORE_UNAVAILABLE='SECURE_STORE_UNAVAILABLE';
export const PROTECTED_PREFIX='dpapi:';
const RUNNER_TIMEOUT_MS=20000;
const BASE64=/^[A-Za-z0-9+/]+={0,2}$/;

const unavailable=()=>{const error=Error(SECURE_STORE_UNAVAILABLE);error.code=SECURE_STORE_UNAVAILABLE;return error;};

const POWERSHELL_SCRIPTS=Object.freeze({
  protect:[
    'Add-Type -AssemblyName System.Security',
    '$raw=[Console]::In.ReadToEnd().Trim()',
    '$bytes=[Convert]::FromBase64String($raw)',
    '$out=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Console]::Out.Write([Convert]::ToBase64String($out))',
  ].join('\n'),
  unprotect:[
    'Add-Type -AssemblyName System.Security',
    '$raw=[Console]::In.ReadToEnd().Trim()',
    '$bytes=[Convert]::FromBase64String($raw)',
    '$out=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[Console]::Out.Write([Convert]::ToBase64String($out))',
  ].join('\n'),
});

/** Run one static PowerShell script; only base64 goes in, only base64 comes out. */
function runPowerShell(script,inputBase64){
  return new Promise((resolve,reject)=>{
    let settled=false,timer;
    const finish=(error,value)=>{
      if(settled)return;
      settled=true;
      clearTimeout(timer);
      if(error)reject(unavailable());
      else resolve(value);
    };
    let child;
    try{
      child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    }catch{return finish(unavailable());}
    timer=setTimeout(()=>{try{child.kill();}catch{}finish(unavailable());},RUNNER_TIMEOUT_MS);
    timer.unref?.();
    const stdout=[];
    child.on('error',()=>finish(unavailable()));
    child.stdout.on('data',chunk=>stdout.push(chunk));
    child.stderr.on('data',()=>{});
    child.stdin.on('error',()=>finish(unavailable()));
    child.on('close',code=>{
      const output=Buffer.concat(stdout).toString('utf8').replace(/\s+/g,'');
      if(code!==0||!output||!BASE64.test(output))return finish(unavailable());
      finish(null,output);
    });
    child.stdin.end(inputBase64);
  });
}

/**
 * Default runner: PowerShell DPAPI for the current user.
 * `platform` is only overridden by tests to exercise the non-Windows branch deterministically.
 */
export function defaultRunner({platform=process.platform}={}){
  if(platform!=='win32')return async()=>{throw unavailable();};
  return async(operation,inputBase64)=>{
    if(!Object.hasOwn(POWERSHELL_SCRIPTS,operation))throw unavailable();
    if(typeof inputBase64!=='string'||!BASE64.test(inputBase64))throw unavailable();
    return runPowerShell(POWERSHELL_SCRIPTS[operation],inputBase64);
  };
}

const resolveRunner=(options={})=>typeof options.runner==='function'?options.runner:defaultRunner(options);

/** Encrypt one UTF-8 string into `dpapi:<base64>`. Throws SECURE_STORE_UNAVAILABLE. */
export async function protect(value,options={}){
  if(typeof value!=='string')throw unavailable();
  let runner;
  try{runner=resolveRunner(options);}catch{throw unavailable();}
  let output;
  try{output=await runner('protect',Buffer.from(value,'utf8').toString('base64'));}
  catch{throw unavailable();}
  if(typeof output!=='string'||!output||!BASE64.test(output))throw unavailable();
  return PROTECTED_PREFIX+output;
}

/** Decrypt a `dpapi:<base64>` blob back to its UTF-8 string. Throws SECURE_STORE_UNAVAILABLE. */
export async function unprotect(blob,options={}){
  if(typeof blob!=='string'||!blob.startsWith(PROTECTED_PREFIX))throw unavailable();
  const payload=blob.slice(PROTECTED_PREFIX.length);
  if(!payload||!BASE64.test(payload))throw unavailable();
  let runner;
  try{runner=resolveRunner(options);}catch{throw unavailable();}
  let output;
  try{output=await runner('unprotect',payload);}
  catch{throw unavailable();}
  if(typeof output!=='string'||!output||!BASE64.test(output))throw unavailable();
  return Buffer.from(output,'base64').toString('utf8');
}

/** True when a stored value is a DPAPI blob rather than a legacy plaintext secret. */
export const isProtected=value=>typeof value==='string'&&value.startsWith(PROTECTED_PREFIX);
