import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {addDevice,getSecret,listDevices,loadRegistry,removeDevice,updateDevice,validateDevice,deviceError} from '../src/devices.mjs';

const temp=()=>mkdtemp(join(tmpdir(),'model-console-devices-'));

test('validateDevice rejects bad names, URLs, protocols and duplicate ids',()=>{
  assert.throws(()=>validateDevice({name:'',baseUrl:'http://h:1'}),/设备名称/);
  assert.throws(()=>validateDevice({name:'x',baseUrl:'not-a-url'}),/合法 URL/);
  assert.throws(()=>validateDevice({name:'x',baseUrl:'ftp://h:1'}),/http/);
  assert.throws(()=>validateDevice({name:'x',baseUrl:'http://user:pass@h:1'}),/账号密码/);
  assert.throws(()=>validateDevice({name:'x',baseUrl:'http://h:1',kind:'ssh'}),/设备类型/);
  assert.throws(()=>validateDevice({name:'x',baseUrl:'http://h:1',id:'a'},{existingIds:['a']}),/已存在/);
  const device=validateDevice({name:'  书房  ',baseUrl:'http://192.168.1.20:6185/',readOnly:true});
  assert.equal(device.name,'书房');
  assert.equal(device.baseUrl,'http://192.168.1.20:6185');
  assert.equal(device.readOnly,true);
});

test('addDevice stores the API key outside devices.json and list never returns it',async()=>{
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
