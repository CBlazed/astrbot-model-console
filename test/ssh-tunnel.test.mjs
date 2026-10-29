/**
 * ssh-tunnel regression tests (Epic-2 task-16).
 * No real ssh and no real network: spawn, port probes and the discovery runner are all injected.
 * The only real OS call is findFreePort(), which binds loopback and closes immediately.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {findFreePort,discoverRemoteDashboardPort,createSshTunnel,openSshTunnel} from '../src/ssh-tunnel.mjs';

const SSH={host:'1.2.3.4',port:2222,user:'Administrator',keyPath:'C:\\keys\\id_ed25519'};

function fakeChild(){
  const child=new EventEmitter();
  child.kills=[];
  child.pid=4242;
  child.kill=signal=>{child.kills.push(signal);if(signal==='SIGTERM')queueMicrotask(()=>child.emit('exit',0,null));return true;};
  return child;
}
const noProbe=async()=>false;
const alwaysReady=async()=>true;

test('findFreePort returns a usable loopback port',async()=>{
  const port=await findFreePort();
  assert.equal(Number.isInteger(port),true);
  assert.ok(port>0&&port<65536);
});

test('tunnel spawns ssh with an argv array, forwarding flags and keyPath, never a shell',async()=>{
  const child=fakeChild();
  const spawned=[];
  const spawnImpl=(command,args,options)=>{spawned.push({command,args,options});return child;};
  const tunnel=await createSshTunnel({ssh:SSH,remotePort:6185,localPort:40001,spawnImpl,probeConnect:alwaysReady});
  assert.equal(spawned.length,1);
  const [{command,args,options}]=spawned;
  assert.equal(command,'ssh');
  assert.equal(Array.isArray(args),true);
  assert.ok(args.every(value=>typeof value==='string'));
  assert.deepEqual(args,[
    '-N',
    '-L','127.0.0.1:40001:127.0.0.1:6185',
    '-p','2222',
    '-i','C:\\keys\\id_ed25519',
    '-o','BatchMode=yes',
    '-o','ExitOnForwardFailure=yes',
    '-o','ServerAliveInterval=15',
    'Administrator@1.2.3.4',
  ]);
  assert.equal(options.shell,undefined,'ssh must never run through a shell');
  assert.equal(options.stdio,'ignore');
  assert.equal(tunnel.localPort,40001);
  tunnel.close();
});

test('tunnel defaults to ssh port 22 and honors a custom remoteHost',async()=>{
  const child=fakeChild();
  const spawned=[];
  const spawnImpl=(command,args,options)=>{spawned.push({command,args,options});return child;};
  const tunnel=await createSshTunnel({ssh:{host:'cloud.example',user:'ops'},remoteHost:'10.0.0.5',remotePort:7001,localPort:41000,spawnImpl,probeConnect:alwaysReady});
  const args=spawned[0].args;
  assert.deepEqual(args.slice(0,5),['-N','-L','127.0.0.1:41000:10.0.0.5:7001','-p','22']);
  assert.equal(args.includes('-i'),false);
  assert.equal(args.at(-1),'ops@cloud.example');
  tunnel.close();
});

test('tunnel allocates a free local port when none is given',async()=>{
  const child=fakeChild();
  const spawned=[];
  const spawnImpl=(command,args,options)=>{spawned.push({command,args,options});return child;};
  const tunnel=await createSshTunnel({ssh:SSH,remotePort:6185,spawnImpl,probeConnect:alwaysReady});
  const forward=spawned[0].args[2];
  assert.equal(forward,`127.0.0.1:${tunnel.localPort}:127.0.0.1:6185`);
  assert.ok(tunnel.localPort>0);
  tunnel.close();
});

test('tunnel waits through failed connection probes until the port is reachable',async()=>{
  const child=fakeChild();
  let probes=0;
  const probeConnect=async()=>{probes++;return probes>=3;};
  const tunnel=await createSshTunnel({ssh:SSH,remotePort:6185,localPort:42000,spawnImpl:()=>child,probeConnect,retryDelayMs:2});
  assert.equal(probes,3);
  assert.equal(tunnel.localPort,42000);
  tunnel.close();
});

test('tunnel times out with DEVICE_SSH_FAILED and kills ssh',async()=>{
  const child=fakeChild();
  const started=Date.now();
  await assert.rejects(()=>createSshTunnel({ssh:SSH,remotePort:6185,localPort:42001,spawnImpl:()=>child,probeConnect:noProbe,readyTimeoutMs:40,retryDelayMs:5}),/DEVICE_SSH_FAILED/);
  assert.ok(Date.now()-started<2000,'timeout must not wait the default 10s');
  assert.deepEqual(child.kills,['SIGTERM']);
});

test('a missing ssh binary on spawn maps to DEVICE_SSH_UNAVAILABLE',async()=>{
  const spawnImpl=()=>{throw Object.assign(Error('spawn ssh ENOENT'),{code:'ENOENT'});};
  await assert.rejects(()=>createSshTunnel({ssh:SSH,remotePort:6185,localPort:42002,spawnImpl,probeConnect:alwaysReady}),/DEVICE_SSH_UNAVAILABLE/);
});

test('an asynchronous ENOENT child error maps to DEVICE_SSH_UNAVAILABLE',async()=>{
  const child=fakeChild();
  const promise=createSshTunnel({ssh:SSH,remotePort:6185,localPort:42003,spawnImpl:()=>child,probeConnect:noProbe,readyTimeoutMs:500,retryDelayMs:5});
  setImmediate(()=>child.emit('error',Object.assign(Error('spawn ssh ENOENT'),{code:'ENOENT'})));
  await assert.rejects(promise,/DEVICE_SSH_UNAVAILABLE/);
  assert.deepEqual(child.kills,['SIGTERM']);
});

test('other spawn failures and early ssh exits map to DEVICE_SSH_FAILED',async()=>{
  const failingSpawn=()=>{throw Object.assign(Error('EACCES'),{code:'EACCES'});};
  await assert.rejects(()=>createSshTunnel({ssh:SSH,remotePort:6185,localPort:42004,spawnImpl:failingSpawn,probeConnect:alwaysReady}),/DEVICE_SSH_FAILED/);
  const child=fakeChild();
  const promise=createSshTunnel({ssh:SSH,remotePort:6185,localPort:42005,spawnImpl:()=>child,probeConnect:noProbe,readyTimeoutMs:500,retryDelayMs:5});
  setImmediate(()=>child.emit('exit',255,null));
  await assert.rejects(promise,/DEVICE_SSH_FAILED/);
});

test('invalid tunnel input fails before spawning ssh',async()=>{
  let spawned=0;
  const spawnImpl=()=>{spawned++;return fakeChild();};
  await assert.rejects(()=>createSshTunnel({ssh:{host:'h'},remotePort:6185,localPort:42006,spawnImpl,probeConnect:alwaysReady}),/DEVICE_SSH_FAILED/);
  await assert.rejects(()=>createSshTunnel({ssh:SSH,remotePort:0,localPort:42007,spawnImpl,probeConnect:alwaysReady}),/DEVICE_SSH_FAILED/);
  await assert.rejects(()=>createSshTunnel({ssh:SSH,remotePort:70000,localPort:42008,spawnImpl,probeConnect:alwaysReady}),/DEVICE_SSH_FAILED/);
  assert.equal(spawned,0);
});

test('close() is idempotent and only sends SIGTERM once',async()=>{
  const child=fakeChild();
  const tunnel=await createSshTunnel({ssh:SSH,remotePort:6185,localPort:42009,spawnImpl:()=>child,probeConnect:alwaysReady});
  tunnel.close();
  tunnel.close();
  tunnel.close();
  assert.deepEqual(child.kills,['SIGTERM']);
  await new Promise(resolve=>setImmediate(resolve));
});

test('discovery runs ssh with argv and reads the last Starting WebUI line',async()=>{
  const calls=[];
  const run=async argv=>{calls.push(argv);return [
    '[2026-10-29 09:00:00] INFO: Starting WebUI at http://127.0.0.1:6100',
    '[2026-10-29 12:00:00] INFO: Starting WebUI at http://localhost:7001',
  ].join('\r\n');};
  const port=await discoverRemoteDashboardPort({ssh:SSH,dataPath:'C:\\AstrBot\\data',run});
  assert.equal(port,7001,'last matching line wins');
  assert.equal(calls.length,1);
  const argv=calls[0];
  assert.equal(Array.isArray(argv),true);
  assert.ok(argv.every(value=>typeof value==='string'));
  assert.deepEqual(argv.slice(0,7),['-p','2222','-i','C:\\keys\\id_ed25519','-o','BatchMode=yes','-o']);
  assert.equal(argv[7],'ConnectTimeout=10');
  assert.equal(argv[8],'Administrator@1.2.3.4');
  const command=argv.at(-1);
  assert.match(command,/^powershell -NoProfile -NonInteractive -Command "/);
  assert.ok(command.includes("-LiteralPath 'C:\\AstrBot\\data\\logs\\astrbot.log'"),'remote log path must be single-quoted');
  assert.ok(command.includes("'Starting WebUI at'"));
  assert.ok(command.includes('Select-Object -Last 1'));
});

test('discovery quotes paths with spaces and apostrophes as PowerShell literals',async()=>{
  let argv;
  const run=async value=>{argv=value;return 'Starting WebUI at http://127.0.0.1:6185\n';};
  await discoverRemoteDashboardPort({ssh:{host:'1.2.3.4',user:'Administrator'},dataPath:"C:\\Astr Bot\\It's data",run});
  const command=argv.at(-1);
  assert.ok(command.includes("'C:\\Astr Bot\\It''s data\\logs\\astrbot.log'"),'single quotes must be doubled, not shell-escaped');
  assert.equal(argv[0],'-p');
  assert.equal(argv[1],'22');
  assert.equal(argv.includes('-i'),false);
  assert.equal(argv.at(-2),'Administrator@1.2.3.4');
});

test('discovery accepts a {stdout} runner result',async()=>{
  const port=await discoverRemoteDashboardPort({ssh:{host:'h',user:'u'},dataPath:'C:\\data',run:async()=>({stdout:'INFO: Starting WebUI at http://127.0.0.1:6185\n'})});
  assert.equal(port,6185);
});

test('discovery failures always report DEVICE_PORT_UNKNOWN without leaking details',async()=>{
  const sshErrors=[
    ['ssh exec rejects',{ssh:SSH,dataPath:'C:\\data',run:async()=>{const error=Error('ssh: connect to host 1.2.3.4 port 2222: Connection refused SECRET');error.code='ENOENT';throw error;}}],
    ['no matching line',{ssh:SSH,dataPath:'C:\\data',run:async()=>'INFO: nothing about a dashboard here\n'}],
    ['empty output',{ssh:SSH,dataPath:'C:\\data',run:async()=>''}],
    ['missing dataPath',{ssh:SSH,run:async()=>'Starting WebUI at http://127.0.0.1:6185\n'}],
    ['unusable ssh host',{ssh:{user:'u'},dataPath:'C:\\data',run:async()=>'Starting WebUI at http://127.0.0.1:6185\n'}],
    ['port out of range',{ssh:SSH,dataPath:'C:\\data',run:async()=>'Starting WebUI at http://127.0.0.1:99999\n'}],
  ];
  for(const [label,options] of sshErrors){
    await assert.rejects(()=>discoverRemoteDashboardPort(options),/DEVICE_PORT_UNKNOWN/,label);
  }
});

test('openSshTunnel uses the baseUrl port when no dataPath is given',async()=>{
  const child=fakeChild();
  const spawned=[];
  const spawnImpl=(command,args,options)=>{spawned.push({command,args,options});return child;};
  const opened=await openSshTunnel({ssh:SSH,baseUrl:'http://127.0.0.1:6185',spawnImpl,probeConnect:alwaysReady});
  const localPort=Number(new URL(opened.baseUrl).port);
  assert.equal(opened.baseUrl,`http://127.0.0.1:${localPort}`);
  assert.equal(spawned.length,1);
  const args=spawned[0].args;
  assert.equal(args[2],`127.0.0.1:${localPort}:127.0.0.1:6185`);
  assert.equal(args.at(-1),'Administrator@1.2.3.4');
  opened.close();
  opened.close();
  assert.deepEqual(child.kills,['SIGTERM']);
});

test('openSshTunnel rediscovers the remote port from dataPath and overrides baseUrl',async()=>{
  const child=fakeChild();
  const spawned=[];
  const runCalls=[];
  const spawnImpl=(command,args,options)=>{spawned.push({command,args,options});return child;};
  const run=async argv=>{runCalls.push(argv);return 'INFO: Starting WebUI at http://127.0.0.1:7001\n';};
  const opened=await openSshTunnel({ssh:SSH,baseUrl:'http://127.0.0.1:6185',dataPath:'C:\\AstrBot\\data',run,spawnImpl,probeConnect:alwaysReady});
  const localPort=Number(new URL(opened.baseUrl).port);
  assert.equal(runCalls.length,1);
  assert.equal(spawned[0].args[2],`127.0.0.1:${localPort}:127.0.0.1:7001`,'discovered port must override the placeholder');
  opened.close();
  assert.deepEqual(child.kills,['SIGTERM']);
});

test('openSshTunnel surfaces DEVICE_PORT_UNKNOWN from discovery and never spawns ssh',async()=>{
  let spawned=0;
  const spawnImpl=()=>{spawned++;return fakeChild();};
  await assert.rejects(()=>openSshTunnel({ssh:SSH,baseUrl:'http://127.0.0.1:6185',dataPath:'C:\\data',run:async()=>'no dashboard here\n',spawnImpl,probeConnect:alwaysReady}),/DEVICE_PORT_UNKNOWN/);
  assert.equal(spawned,0);
});

test('openSshTunnel rejects an unusable baseUrl before doing any work',async()=>{
  let spawned=0;
  const spawnImpl=()=>{spawned++;return fakeChild();};
  await assert.rejects(()=>openSshTunnel({ssh:SSH,baseUrl:'http://127.0.0.1',spawnImpl,probeConnect:alwaysReady}),/DEVICE_SSH_FAILED/);
  await assert.rejects(()=>openSshTunnel({ssh:SSH,baseUrl:'not a url',spawnImpl,probeConnect:alwaysReady}),/DEVICE_SSH_FAILED/);
  assert.equal(spawned,0);
});
