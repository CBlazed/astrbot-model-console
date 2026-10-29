/**
 * SSH tunnel + remote dashboard-port discovery for ssh-kind devices (Epic-2).
 * Every ssh invocation is an argv array executed without a shell, so hosts, keys and remote paths can never be
 * re-interpreted as commands. Nothing here stores credentials: the key stays on disk and no config value is logged.
 */
import {execFile,spawn} from 'node:child_process';
import net from 'node:net';

const PORT_UNKNOWN='DEVICE_PORT_UNKNOWN';
const SSH_UNAVAILABLE='DEVICE_SSH_UNAVAILABLE';
const SSH_FAILED='DEVICE_SSH_FAILED';
/** "Starting WebUI at http://host:port", last match in the remote log wins. */
const START_PATTERN=/Starting WebUI at http:\/\/[^\s:]+:(\d+)/g;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const fail=code=>Error(code);
const knownCode=value=>typeof value==='string'&&/^DEVICE_[A-Z_]+$/.test(value);
/** Map a spawn failure to a contract error: a missing local ssh binary is distinguishable from a failed tunnel. */
const spawnFailure=error=>fail(error?.code==='ENOENT'?SSH_UNAVAILABLE:SSH_FAILED);
const normalizeFailure=error=>knownCode(error?.message)?error:fail(SSH_FAILED);
/** PowerShell single-quoted literal; embedded quotes are doubled, never escaped through a shell. */
const powerShellLiteral=value=>`'${String(value).replace(/'/g,"''")}'`;
const remoteLogPath=dataPath=>`${String(dataPath).replace(/[\\/]+$/,'')}\\logs\\astrbot.log`;

/** Common ssh connection flags. Throws DEVICE_SSH_FAILED when host/user are unusable. */
function connectionArgs(ssh){
  const {host,user}=ssh??{};
  if(typeof host!=='string'||!host||typeof user!=='string'||!user)throw fail(SSH_FAILED);
  const port=ssh.port===undefined?22:Number(ssh.port);
  if(!Number.isInteger(port)||port<1||port>65535)throw fail(SSH_FAILED);
  const args=['-p',String(port)];
  if(typeof ssh.keyPath==='string'&&ssh.keyPath!=='')args.push('-i',ssh.keyPath);
  return {args,destination:`${user}@${host}`};
}

/** Default port-discovery runner: ssh argv in, stdout out. */
function defaultRun(args){
  return new Promise((resolve,reject)=>{
    execFile('ssh',args,{windowsHide:true,timeout:20000,maxBuffer:1048576},(error,stdout)=>error?reject(error):resolve(stdout));
  });
}

/** Ask the OS for a currently free loopback port (listener is closed before returning). */
export function findFreePort(){
  return new Promise((resolve,reject)=>{
    const server=net.createServer();
    server.unref();
    server.once('error',error=>{try{server.close();}catch{}reject(error);});
    server.listen(0,'127.0.0.1',()=>{const {port}=server.address();server.close(()=>resolve(port));});
  });
}

/**
 * Read the remote dashboard port from the last `Starting WebUI at ...` line of `<dataPath>/logs/astrbot.log`.
 * `run(argv)` is injectable (default: ssh via execFile) and must resolve to stdout (string or `{stdout}`).
 * Any failure — unusable ssh config, ssh error, unreadable log, no matching line — becomes DEVICE_PORT_UNKNOWN.
 */
export async function discoverRemoteDashboardPort({ssh,dataPath,run=defaultRun}={}){
  try{
    if(typeof dataPath!=='string'||dataPath==='')throw fail(PORT_UNKNOWN);
    const {args,destination}=connectionArgs(ssh);
    const command=`powershell -NoProfile -NonInteractive -Command "Select-String -LiteralPath ${powerShellLiteral(remoteLogPath(dataPath))} -Pattern 'Starting WebUI at' -SimpleMatch | Select-Object -Last 1 | ForEach-Object { $_.Line }"`;
    const output=await run([...args,'-o','BatchMode=yes','-o','ConnectTimeout=10',destination,command]);
    const text=typeof output==='string'?output:String(output?.stdout??'');
    const found=[...text.matchAll(START_PATTERN)].at(-1)?.[1];
    if(!found)throw fail(PORT_UNKNOWN);
    const port=Number(found);
    if(!Number.isInteger(port)||port<1||port>65535)throw fail(PORT_UNKNOWN);
    return port;
  }catch(error){
    throw error?.message===PORT_UNKNOWN?error:fail(PORT_UNKNOWN);
  }
}

/** One TCP probe of the local forwarding port. Resolves true when something accepts the connection. */
function probePort(port){
  return new Promise(resolve=>{
    const socket=net.connect({host:'127.0.0.1',port});
    let settled=false;
    const finish=ok=>{if(settled)return;settled=true;socket.destroy();resolve(ok);};
    socket.setTimeout(500,()=>finish(false));
    socket.once('connect',()=>finish(true));
    socket.once('error',()=>finish(false));
  });
}

/**
 * Start `ssh -N -L 127.0.0.1:<local>:<remoteHost>:<remotePort> ...`, wait until the local port accepts
 * connections, then resolve `{localPort, close}`. close() is idempotent and kills the ssh process.
 * spawn ENOENT → DEVICE_SSH_UNAVAILABLE; timeout, early exit or handshake/forward failure → DEVICE_SSH_FAILED.
 * `spawnImpl`, `probeConnect`, `readyTimeoutMs` and `retryDelayMs` are injectable for tests.
 */
export async function createSshTunnel({ssh,remoteHost='127.0.0.1',remotePort,localPort,spawnImpl=spawn,probeConnect=probePort,readyTimeoutMs=10000,retryDelayMs=100}={}){
  const remote=Number(remotePort);
  if(!Number.isInteger(remote)||remote<1||remote>65535)throw fail(SSH_FAILED);
  const {args:connection,destination}=connectionArgs(ssh);
  const port=Number.isInteger(localPort)&&localPort>0&&localPort<=65535?localPort:await findFreePort();
  const args=['-N','-L',`127.0.0.1:${port}:${remoteHost}:${remote}`,...connection,'-o','BatchMode=yes','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=15',destination];
  let child;
  try{child=spawnImpl('ssh',args,{stdio:'ignore',windowsHide:true});}catch(error){throw spawnFailure(error);}
  let closed=false,stopped=false,abortError=null,rejectAbort=()=>{};
  const aborted=new Promise((_,reject)=>{rejectAbort=reject;});
  aborted.catch(()=>{});
  const abort=error=>{if(!abortError){abortError=error;rejectAbort(error);}};
  child.once?.('error',error=>abort(spawnFailure(error)));
  child.once?.('exit',()=>abort(fail(SSH_FAILED)));
  /** Idempotent teardown: SIGTERM first, SIGKILL as a fallback if the process is still alive. */
  const close=()=>{
    if(closed)return;closed=true;
    let fallback;
    child.once?.('exit',()=>clearTimeout(fallback));
    fallback=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}},1000);
    fallback.unref?.();
    try{child.kill('SIGTERM');}catch{}
  };
  let timer;
  try{
    const ready=(async()=>{while(!stopped){if(await probeConnect(port))return;await pause(retryDelayMs);}throw fail(SSH_FAILED);})();
    ready.catch(()=>{});
    const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail(SSH_FAILED)),readyTimeoutMs);});
    await Promise.race([ready,aborted,timeout]);
    if(abortError)throw abortError;
  }catch(error){
    stopped=true;clearTimeout(timer);close();throw abortError??normalizeFailure(error);
  }
  clearTimeout(timer);
  return {localPort:port,close};
}

/**
 * Composite helper for an ssh device: use the port from `baseUrl` (a loopback placeholder) as the remote
 * dashboard port, or rediscover the real port from `dataPath` when it is configured (discovery failure keeps
 * DEVICE_PORT_UNKNOWN), then open a loopback tunnel and report the address the API adapter should call.
 * Returns `{baseUrl:'http://127.0.0.1:<localPort>', close}`; close() is the tunnel's idempotent teardown.
 * `run`, `spawnImpl` and `probeConnect` are injectable test seams.
 */
export async function openSshTunnel({ssh,baseUrl,dataPath,run,spawnImpl,probeConnect,readyTimeoutMs=10000,retryDelayMs=100}={}){
  let placeholder;
  try{placeholder=Number(new URL(baseUrl).port);}catch{throw fail(SSH_FAILED);}
  if(!Number.isInteger(placeholder)||placeholder<1||placeholder>65535)throw fail(SSH_FAILED);
  const remotePort=dataPath?await discoverRemoteDashboardPort({ssh,dataPath,run}):placeholder;
  const localPort=await findFreePort();
  const tunnel=await createSshTunnel({ssh,remotePort,localPort,spawnImpl,probeConnect,readyTimeoutMs,retryDelayMs});
  return {baseUrl:`http://127.0.0.1:${tunnel.localPort}`,close:tunnel.close};
}
