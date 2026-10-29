import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,stat} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {backupState,backupKeep,DEFAULT_BACKUP_KEEP} from '../src/backup.mjs';

const UUID_DIRECTORY=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function temp(){return mkdtemp(join(tmpdir(),'model-console-test-'));}
async function createData(root){
  const data=join(root,'data');
  await mkdir(join(data,'config'),{recursive:true});
  await writeFile(join(data,'cmd_config.json'),'{}');
  await writeFile(join(data,'config','abconf_test.json'),'{"test":true}');
  await writeFile(join(data,'config','plugin_config.json'),'{}');
  const db=new DatabaseSync(join(data,'data_v4.db'));
  db.exec("CREATE TABLE sample(value TEXT);INSERT INTO sample VALUES ('present')");
  db.close();
  return data;
}
async function uuidDirectories(dest){
  const entries=await readdir(dest,{withFileTypes:true});
  return entries.filter(entry=>entry.isDirectory()&&UUID_DIRECTORY.test(entry.name)).map(entry=>join(dest,entry.name)).sort();
}
async function exists(path){try{await stat(path);return true;}catch{return false;}}
async function uuidBackups(dest){
  const directories=await uuidDirectories(dest);
  const withManifest=[];
  for(const directory of directories)if(await exists(join(directory,'manifest.json')))withManifest.push(directory);
  return withManifest;
}

test('real node SQLite backup preserves committed data, profiles and plugin files',async()=>{const temp=await mkdtemp(join(tmpdir(),'model-console-test-'));try{const data=join(temp,'data');await mkdir(join(data,'config'),{recursive:true});await writeFile(join(data,'cmd_config.json'),'{}');await writeFile(join(data,'config','abconf_test.json'),'{"test":true}');await writeFile(join(data,'config','plugin_config.json'),'{}');const db=new DatabaseSync(join(data,'data_v4.db'));db.exec('CREATE TABLE sample(value TEXT);INSERT INTO sample VALUES (\'present\')');const dir=await backupState(data,join(temp,'backups'));const result=new DatabaseSync(join(dir,'data_v4.db'),{readOnly:true});assert.equal(result.prepare('SELECT value FROM sample').get().value,'present');result.close();db.close();assert.equal(JSON.parse(await readFile(join(dir,'manifest.json'),'utf8')).files.length,3);}finally{await rm(temp,{recursive:true,force:true});}});

test('MODEL_CONSOLE_BACKUP_KEEP overrides the default and invalid values fall back to 10',()=>{
  assert.equal(backupKeep({}),DEFAULT_BACKUP_KEEP);
  assert.equal(DEFAULT_BACKUP_KEEP,10);
  assert.equal(backupKeep({MODEL_CONSOLE_BACKUP_KEEP:'3'}),3);
  for(const value of ['0','-1','abc','1.5',''])assert.equal(backupKeep({MODEL_CONSOLE_BACKUP_KEEP:value}),DEFAULT_BACKUP_KEEP);
});

test('retention keeps the newest N UUID backups, never the protected one, and spares non-backup dirs',async()=>{
  const root=await temp();
  try{
    const data=await createData(root);
    const backups=join(root,'backups');
    await mkdir(join(backups,'notes'),{recursive:true});
    await writeFile(join(backups,'notes','readme.txt'),'keep me','utf8');
    const incomplete=join(backups,'11111111-2222-3333-4444-555555555555');
    await mkdir(incomplete,{recursive:true});
    const env={MODEL_CONSOLE_BACKUP_KEEP:'3'};
    const created=[];
    for(let index=0;index<5;index++)created.push(await backupState(data,backups,{env}));
    const remaining=await uuidBackups(backups);
    assert.equal(remaining.length,3);
    assert.ok(remaining.includes(created[4]));
    assert.equal(await exists(created[0]),false);
    assert.equal(await exists(created[1]),false);
    assert.equal(await exists(created[4]),true);
    assert.ok(isAbsolute(created[4]));
    assert.equal(await exists(join(backups,'notes','readme.txt')),true);
    assert.equal(await exists(incomplete),true);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('default retention keeps 10 backups and always keeps the newest one',async()=>{
  const root=await temp();
  try{
    const data=await createData(root);
    const backups=join(root,'backups');
    const created=[];
    for(let index=0;index<12;index++)created.push(await backupState(data,backups));
    const remaining=await uuidBackups(backups);
    assert.equal(remaining.length,10);
    assert.ok(remaining.includes(created[11]));
    assert.equal(await exists(created[0]),false);
    assert.equal(await exists(created[1]),false);
    assert.equal(await exists(created[11]),true);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('retention never deletes the just-created backup even when keep is 1',async()=>{
  const root=await temp();
  try{
    const data=await createData(root);
    const backups=join(root,'backups');
    const first=await backupState(data,backups,{env:{MODEL_CONSOLE_BACKUP_KEEP:'1'}});
    const second=await backupState(data,backups,{env:{MODEL_CONSOLE_BACKUP_KEEP:'1'}});
    assert.deepEqual(await uuidBackups(backups),[second]);
    assert.equal(await exists(first),false);
  }finally{await rm(root,{recursive:true,force:true});}
});
