import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {addDevice,getSecret,listDevices,loadRegistry,removeDevice,updateDevice,validateDevice,deviceError} from '../src/devices.mjs';

const temp=()=>mkdtemp(join(tmpdir(),'model-console-devices-'));

test('validateDevice rejects bad names, URLs, protocols, kinds and credentials',()=>{
  assert.throws(()=>validateDevice({name:'',baseUrl:'http://h:1'}),/设备名称/);
  assert.throws(()=>validateDevice({name:'x',baseUrl:'not-a-url'}),/合法 URL/);
  assert.throws(()=>validateDevice({name:'x',baseUrl:'ftp://h:1'}),/http/);
  assert.throws(()=>validateDevice({name:'x',baseUrl:'http://user:pass@h:1'}),/账号密码/);
  assert.throws(()=>validateDevice({name:'x',baseUrl:'http://h:1',kind:'ftp'}),/设备类型/);
  assert.throws(()=>validateDevice({name:'x',baseUrl:'http://h:1',id:'a'},{existingIds:['a']}),/已存在/);
  const device=validateDevice({name:'  书房  ',baseUrl:'http://192.168.1.20:6185/',readOnly:true});
  assert.equal(device.name,'书房');
  assert.equal(device.kind,'http');
  assert.equal(device.baseUrl,'http://192.168.1.20:6185');
  assert.equal(device.readOnly,true);
  assert.deepEqual(device.auth,{type:'api-key'});
});

test('ssh devices require host/user and keep optional port/keyPath/dataPath',()=>{
  assert.throws(()=>validateDevice({name:'x',kind:'ssh',baseUrl:'http://127.0.0.1:1'}),/ssh 配置/);
  assert.throws(()=>validateDevice({name:'x',kind:'ssh',baseUrl:'http://127.0.0.1:1',ssh:{host:'',user:'u'}}),/ssh\.host/);
  assert.throws(()=>validateDevice({name:'x',kind:'ssh',baseUrl:'http://127.0.0.1:1',ssh:{host:'h'}}),/ssh\.user/);
  assert.throws(()=>validateDevice({name:'x',kind:'ssh',baseUrl:'http://127.0.0.1:1',ssh:{host:'h',user:'u',port:0}}),/ssh\.port/);
  assert.throws(()=>validateDevice({name:'x',kind:'ssh',baseUrl:'http://127.0.0.1:1',ssh:{host:'h',user:'u',port:'22'}}),/ssh\.port/);
  const device=validateDevice({name:'云主机',kind:'ssh',baseUrl:'http://127.0.0.1:6185',ssh:{host:'1.2.3.4',port:2222,user:'Administrator',keyPath:'C:\\keys\\id_ed25519',dataPath:'C:\\AstrBot\\data'}});
  assert.deepEqual(device.ssh,{host:'1.2.3.4',user:'Administrator',port:2222,keyPath:'C:\\keys\\id_ed25519',dataPath:'C:\\AstrBot\\data'});
  assert.deepEqual(device.auth,{type:'api-key'});
});

test('agent devices are structurally valid without persisting the pairing code',()=>{
  const device=validateDevice({name:'Agent',kind:'agent',baseUrl:'http://127.0.0.1:9000',pairingCode:'12345678'});
  assert.equal(device.kind,'agent');
  assert.deepEqual(device.auth,{type:'agent-token'});
  assert.equal('pairingCode' in device,false);
  assert.equal(JSON.stringify(device).includes('12345678'),false);
});

test('duplicate devices are detected by kind + normalized baseUrl, never across kinds',()=>{
  const existing=[{kind:'http',baseUrl:'http://h:1/'}];
  assert.throws(()=>validateDevice({name:'dup',baseUrl:'http://h:1'},{existingDevices:existing}),error=>error.code==='DEVICE_EXISTS');
  assert.throws(()=>validateDevice({name:'dup',baseUrl:'HTTP://H:1'},{existingDevices:existing}),error=>error.code==='DEVICE_EXISTS');
  assert.doesNotThrow(()=>validateDevice({name:'other-kind',kind:'agent',baseUrl:'http://h:1'},{existingDevices:existing}));
  assert.doesNotThrow(()=>validateDevice({name:'other-url',baseUrl:'http://h:2'},{existingDevices:existing}));
});

test('addDevice stores the credential outside devices.json and list never returns it',async()=>{
  const dir=await temp();
  try{
    const device=await addDevice(dir,{name:'书房主机',baseUrl:'http://192.168.1.20:6185'},'abk_secret_value');
    assert.equal(device.hasSecret,true);
    const raw=await readFile(join(dir,'devices.json'),'utf8');
    assert.ok(!raw.includes('abk_secret_value'),'devices.json 不得包含密钥');
    const secrets=JSON.parse(await readFile(join(dir,'secrets.json'),'utf8'));
    assert.equal(secrets.secrets[device.id],'abk_secret_value');
    assert.equal(await getSecret(dir,device.id),'abk_secret_value');
    const listed=await listDevices(dir);
    assert.equal(listed.length,1);
    assert.equal(listed[0].hasSecret,true);
    assert.ok(!JSON.stringify(listed).includes('abk_secret_value'));
    await assert.rejects(()=>addDevice(dir,{name:'second',baseUrl:'http://h:2'},''),/OpenAPI Key/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('ssh and agent devices persist sanitized records; tokens/pairing codes stay out of devices.json',async()=>{
  const dir=await temp();
  try{
    const ssh=await addDevice(dir,{name:'云主机',kind:'ssh',baseUrl:'http://127.0.0.1:1',ssh:{host:'10.0.0.2',user:'root',port:22}},'abk_ssh_key');
    assert.equal(ssh.kind,'ssh');
    assert.deepEqual(ssh.ssh,{host:'10.0.0.2',user:'root',port:22});
    const token='a'.repeat(64);
    const agent=await addDevice(dir,{name:'Agent',kind:'agent',baseUrl:'http://127.0.0.1:9000',pairingCode:'87654321'},token);
    assert.equal(agent.kind,'agent');
    assert.equal(await getSecret(dir,agent.id),token);
    const raw=await readFile(join(dir,'devices.json'),'utf8');
    assert.ok(!raw.includes('87654321'),'配对码不得落库');
    assert.ok(!raw.includes(token),'设备 token 不得落库');
    assert.ok(!raw.includes('abk_ssh_key'));
    const listed=await listDevices(dir);
    assert.ok(!JSON.stringify(listed).includes(token));
    assert.ok(!JSON.stringify(listed).includes('87654321'));
    await assert.rejects(()=>addDevice(dir,{name:'Agent2',kind:'agent',baseUrl:'http://127.0.0.1:9001'},''),/token/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('updateDevice keeps the old secret unless a new key is provided; removeDevice clears both',async()=>{
  const dir=await temp();
  try{
    const device=await addDevice(dir,{name:'a',baseUrl:'http://h:1'},'abk_one');
    await updateDevice(dir,device.id,{name:'b'});
    assert.equal(await getSecret(dir,device.id),'abk_one');
    await updateDevice(dir,device.id,{apiKey:'abk_two'});
    assert.equal(await getSecret(dir,device.id),'abk_two');
    await removeDevice(dir,device.id);
    assert.equal((await loadRegistry(dir)).devices.length,0);
    assert.equal(await getSecret(dir,device.id),null);
    await assert.rejects(()=>removeDevice(dir,device.id),/设备不存在/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('deviceError carries a stable code',()=>{
  const error=deviceError('DEVICE_INVALID','x');
  assert.equal(error.code,'DEVICE_INVALID');
  assert.equal(error.message,'x');
});
