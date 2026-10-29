import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,stat,utimes} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {backupState,backupKeep,DEFAULT_BACKUP_KEEP,backupMaxBytes,DEFAULT_BACKUP_MAX_MB,listBackups,readBackupResource,backupStats,pruneBackups} from '../src/backup.mjs';
import {Engine,revision} from '../src/engine.mjs';

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

async function createRichData(root){
  const data=join(root,'data');
  await mkdir(join(data,'config'),{recursive:true});
  await writeFile(join(data,'cmd_config.json'),JSON.stringify({dashboard:{},provider:[{id:'p1',model:'m1'},{id:'p2',model:'m2'}]}));
  await writeFile(join(data,'config','abconf_test.json'),JSON.stringify({agent_runner:{config:{model:{provider_id:'p1'}}}}));
  await writeFile(join(data,'config','plugin_config.json'),JSON.stringify({decision_ai_provider_id:'p1'}));
  const db=new DatabaseSync(join(data,'data_v4.db'));
  db.exec('CREATE TABLE sample(value TEXT)');
  db.close();
  return data;
}
const basename=path=>path.split(/[\\/]+/).filter(Boolean).at(-1)??'';
async function walkBytes(path){
  let total=0;
  for(const entry of await readdir(path,{withFileTypes:true})){
    const child=join(path,entry.name);
    if(entry.isDirectory())total+=await walkBytes(child);
    else if(entry.isFile())total+=(await stat(child)).size;
  }
  return total;
}

test('listBackups reports only UUID backups newest first with size and sqlite status',async()=>{
  const root=await temp();
  try{
    const data=await createRichData(root);
    const dest=join(root,'backups');
    await mkdir(join(dest,'notes'),{recursive:true});
    await writeFile(join(dest,'notes','readme.txt'),'keep me');
    await mkdir(join(dest,'11111111-2222-3333-4444-555555555555'),{recursive:true});
    const corrupt=join(dest,'22222222-3333-4444-5555-666666666666');
    await mkdir(corrupt,{recursive:true});
    await writeFile(join(corrupt,'manifest.json'),'not json');
    const first=await backupState(data,dest),second=await backupState(data,dest);
    const stamp=async(dir,createdAt)=>{const path=join(dir,'manifest.json');const manifest=JSON.parse(await readFile(path,'utf8'));await writeFile(path,JSON.stringify({...manifest,createdAt}));};
    await stamp(first,'2026-01-01T00:00:00.000Z');
    await stamp(second,'2026-01-02T00:00:00.000Z');
    const listed=await listBackups(dest);
    const ids=listed.map(item=>item.id);
    assert.ok(ids.indexOf(basename(second))<ids.indexOf(basename(first)));
    for(const item of listed.filter(entry=>[basename(first),basename(second)].includes(entry.id))){
      assert.ok(item.bytes>0);
      assert.equal(item.bytes,await walkBytes(join(dest,item.id)));
      assert.equal(item.files,3);
      assert.equal(item.sqlite,'ok');
      assert.ok(!Number.isNaN(Date.parse(item.createdAt)));
    }
    const corruptEntry=listed.find(item=>item.id===basename(corrupt));
    assert.equal(corruptEntry.files,null);
    assert.equal(corruptEntry.sqlite,'invalid');
    assert.ok(corruptEntry.bytes>0);
    assert.ok(!ids.includes('notes'));
    const stats=await backupStats(dest);
    assert.equal(stats.count,3);
    assert.deepEqual(stats.items.map(item=>item.id).sort(),ids.slice().sort());
    assert.equal(stats.bytes,stats.items.reduce((total,item)=>total+item.bytes,0));
    assert.deepEqual(Object.keys(stats.items[0]).sort(),['bytes','createdAt','id']);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('readBackupResource maps every reviewed resource to its documented backup file',async()=>{
  const root=await temp();
  try{
    const data=await createRichData(root);
    const dest=join(root,'backups');
    const backupId=basename(await backupState(data,dest));
    const profileDefault=await readBackupResource(dest,backupId,{kind:'profile',id:'default'});
    assert.equal(profileDefault.file,'cmd_config.json');
    assert.deepEqual(profileDefault.config.provider.map(provider=>provider.id),['p1','p2']);
    const profile=await readBackupResource(dest,backupId,{kind:'profile',id:'test'});
    assert.equal(profile.file,'config/abconf_test.json');
    assert.equal(profile.config.agent_runner.config.model.provider_id,'p1');
    const plugin=await readBackupResource(dest,backupId,{kind:'plugin',id:'plugin'});
    assert.equal(plugin.file,'config/plugin_config.json');
    assert.equal(plugin.config.decision_ai_provider_id,'p1');
    const provider=await readBackupResource(dest,backupId,{kind:'provider',id:'p2'});
    assert.equal(provider.file,'cmd_config.json');
    assert.equal(provider.config.model,'m2');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('readBackupResource fails closed with documented restore error codes',async()=>{
  const root=await temp();
  try{
    const data=await createRichData(root);
    const dest=join(root,'backups');
    const dir=await backupState(data,dest),backupId=basename(dir);
    const notFound=async run=>assert.rejects(run,error=>error.code==='RESTORE_BACKUP_NOT_FOUND');
    const invalid=async run=>assert.rejects(run,error=>error.code==='RESTORE_BACKUP_INVALID');
    await notFound(()=>readBackupResource(dest,'not-a-uuid',{kind:'profile',id:'default'}));
    await notFound(()=>readBackupResource(dest,'33333333-3333-3333-3333-333333333333',{kind:'profile',id:'default'}));
    await notFound(()=>readBackupResource(dest,backupId,{kind:'profile',id:'missing'}));
    await notFound(()=>readBackupResource(dest,backupId,{kind:'provider',id:'absent'}));
    for(const resource of [{kind:'plugin',id:'../evil'},{kind:'unknown',id:'x'},{kind:'plugin',id:''},null])await invalid(()=>readBackupResource(dest,backupId,resource));
    await writeFile(join(dir,'config','plugin_config.json'),'{invalid');
    await invalid(()=>readBackupResource(dest,backupId,{kind:'plugin',id:'plugin'}));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('pruneBackups returns kept, removed and the remaining byte total',async()=>{
  const root=await temp();
  try{
    const data=await createRichData(root);
    const dest=join(root,'backups');
    const created=[];
    for(let index=0;index<3;index++)created.push(await backupState(data,dest));
    const base=Date.now()-10000;
    for(const [index,dir] of created.entries())await utimes(dir,new Date(base+index*1000),new Date(base+index*1000));
    const result=await pruneBackups(dest,{keep:1});
    assert.deepEqual(result.kept,[created[2]]);
    assert.deepEqual(result.removed,[created[1],created[0]]);
    assert.equal(result.bytes,await walkBytes(created[2]));
    const stats=await backupStats(dest);
    assert.equal(stats.count,1);
    assert.equal(stats.bytes,result.bytes);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('total size cap removes the oldest backups and reports warnings without throwing',async()=>{
  const root=await temp();
  try{
    const data=await createRichData(root);
    const dest=join(root,'backups');
    const first=await backupState(data,dest);
    const warnings=[];
    const second=await backupState(data,dest,{env:{MODEL_CONSOLE_BACKUP_KEEP:'10',MODEL_CONSOLE_BACKUP_MAX_MB:'0.001'},onWarning:(code,details)=>warnings.push({code,details})});
    assert.equal(await exists(first),false);
    assert.equal(await exists(second),true);
    const over=warnings.find(warning=>warning.code==='BACKUP_SIZE_LIMIT_EXCEEDED');
    assert.ok(over);
    assert.equal(typeof over.details.bytes,'number');
    assert.equal(over.details.maxBytes,Math.floor(0.001*1024*1024));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a throwing onWarning cannot fail backup creation',async()=>{
  const root=await temp();
  try{
    const data=await createRichData(root);
    const dest=join(root,'backups');
    await backupState(data,dest);
    const dir=await backupState(data,dest,{env:{MODEL_CONSOLE_BACKUP_KEEP:'10',MODEL_CONSOLE_BACKUP_MAX_MB:'0.001'},onWarning:()=>{throw Error('hook boom');}});
    assert.equal(await exists(dir),true);
    assert.deepEqual(await uuidBackups(dest),[dir]);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('MODEL_CONSOLE_BACKUP_MAX_MB defaults to 2048 MiB and ignores invalid values',()=>{
  assert.equal(DEFAULT_BACKUP_MAX_MB,2048);
  assert.equal(backupMaxBytes({}),2048*1024*1024);
  assert.equal(backupMaxBytes({MODEL_CONSOLE_BACKUP_MAX_MB:'1'}),1024*1024);
  for(const value of ['0','-1','abc',''])assert.equal(backupMaxBytes({MODEL_CONSOLE_BACKUP_MAX_MB:value}),2048*1024*1024);
});

async function createSlashProviderData(root){
  const data=join(root,'data');
  await mkdir(join(data,'config'),{recursive:true});
  await writeFile(join(data,'cmd_config.json'),JSON.stringify({dashboard:{},provider:[{id:'example-provider/model-a',model:'m1'},{id:'deepseek/model-a',model:'m2'}]}));
  await writeFile(join(data,'config','plugin_config.json'),JSON.stringify({decision_ai_provider_id:'example-provider/model-a'}));
  const db=new DatabaseSync(join(data,'data_v4.db'));
  db.exec('CREATE TABLE sample(value TEXT)');
  db.close();
  return data;
}

test('provider ids may contain slashes but traversal-shaped ids are rejected',async()=>{
  const root=await temp();
  try{
    const data=await createSlashProviderData(root);
    const dest=join(root,'backups');
    const backupId=basename(await backupState(data,dest));
    const slashProvider=await readBackupResource(dest,backupId,{kind:'provider',id:'example-provider/model-a'});
    assert.equal(slashProvider.file,'cmd_config.json');
    assert.equal(slashProvider.config.model,'m1');
    assert.equal((await readBackupResource(dest,backupId,{kind:'provider',id:'deepseek/model-a'})).config.model,'m2');
    const invalid=async run=>assert.rejects(run,error=>error.code==='RESTORE_BACKUP_INVALID');
    for(const id of ['../x','a/../../b','a\\b','C:/x','/x','x/','a//b','x'.repeat(201)])await invalid(()=>readBackupResource(dest,backupId,{kind:'provider',id}));
    for(const resource of [{kind:'profile',id:'../x'},{kind:'profile',id:'bad/id'},{kind:'plugin',id:'../evil'},{kind:'plugin',id:'a\\b'}])await invalid(()=>readBackupResource(dest,backupId,resource));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('slash provider ids flow through engine backupDiff, planRestore and apply',async()=>{
  const root=await temp();
  try{
    const data=await createSlashProviderData(root);
    const dest=join(root,'backups');
    const dir=await backupState(data,dest),backupId=basename(dir);
    const backedPath=join(dir,'cmd_config.json');
    const backed=JSON.parse(await readFile(backedPath,'utf8'));
    backed.provider[0].custom_extra_body={reasoning_effort:'max'};
    await writeFile(backedPath,JSON.stringify(backed));
    let provider={id:'example-provider/model-a',model:'m1',custom_extra_body:{reasoning_effort:'low'}};
    const writes=[];
    const gateway={read:async()=>structuredClone(provider),write:async(resource,value)=>{writes.push({resource,value});provider=structuredClone(value);},efforts:async()=>['low','max']};
    const engine=new Engine({gateway,writeEnabled:true,backup:async()=>'backup',backups:{list:()=>listBackups(dest),read:(id,res)=>readBackupResource(dest,id,res)}});
    const resource={kind:'provider',id:'example-provider/model-a'};
    assert.equal((await engine.listBackups()).length,1);
    const diff=await engine.backupDiff(backupId,resource);
    assert.deepEqual(diff.changes,[{path:'custom_extra_body.reasoning_effort',before:'low',value:'max',capability:'llm'}]);
    const plan=await engine.planRestore(backupId,resource,revision(provider));
    assert.equal(plan.mode,'restore');
    assert.equal(plan.backupId,backupId);
    assert.deepEqual(plan.changes,diff.changes);
    const applied=await engine.apply(plan.id);
    assert.equal(applied.status,'saved-and-readback-verified');
    assert.equal(writes.length,1);
    assert.equal(provider.custom_extra_body.reasoning_effort,'max');
  }finally{await rm(root,{recursive:true,force:true});}
});
