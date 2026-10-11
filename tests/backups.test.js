import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {pipeline} from 'node:stream/promises';
import yauzl from 'yauzl';
import yazl from 'yazl';
import {restoreBackup} from '../server/backups.js';
import {createApp} from '../server/index.js';
import {previewFixture} from './preset-preview-fixture.js';
import {buildShotPlans} from '../shared/domain.js';
import {DRAFT,PNG,fixtureState} from './fixtures.js';
import {adminFetch,login} from './auth-client.js';
import {testWav} from './gallery-music-fixture.js';

async function fixture(t) {
  const f=await previewFixture();t.after(f.close);
  const account=await f.authentication.createCustomer({username:'backup-alice',password:'backup-password'});
  const db=new DatabaseSync(path.join(f.dataDir,'accounts.sqlite'),{readOnly:true});const owner=db.prepare('SELECT owner_id FROM accounts WHERE id=?').get(account.id).owner_id;db.close();
  const shot={...buildShotPlans(fixtureState(),DRAFT)[0],createdAt:'2026-10-11T03:00:00Z',status:'completed',comfyUrl:'http://127.0.0.1:8188'};
  fs.mkdirSync(path.join(f.outputDir,'PhotoCreate','backup'),{recursive:true});fs.writeFileSync(path.join(f.outputDir,'PhotoCreate','backup','original.png'),PNG);
  f.store.mutate(state=>{
    state.jobs=[{...shot,id:'customer-photo',batchId:'customer-batch',visitorId:owner,images:[{filename:'original.png',subfolder:'PhotoCreate/backup',type:'output'}],folderId:'private-folder'},
      {...shot,id:'other-photo',batchId:'other-batch',visitorId:'different-owner',images:[{filename:'original.png',subfolder:'PhotoCreate/backup',type:'output'}]}];
    state.batches=[{id:'customer-batch',name:'森林拍攝',visitorId:owner,createdAt:shot.createdAt},{id:'other-batch',name:'其他拍攝',visitorId:'different-owner',createdAt:shot.createdAt}];
    state.photoFolders=[{id:'private-folder',ownerId:owner,name:'森林寫真',createdAt:shot.createdAt}];
    state.galleryEntries=[{id:'featured-photo',jobId:'customer-photo',imageIndex:0,ownerId:owner,addedAt:shot.createdAt}];
    state.settings.characterPrompts.heightPrompts.below140='My saved height prompt';
  });
  f.galleryMusic.upload({buffer:testWav()},{name:'備份鋼琴',kind:'piano'});
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-backup-test-'));
  t.after(()=>{assert.equal(path.dirname(fs.realpathSync(root)),fs.realpathSync(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});
  return {...f,root,owner};
}
async function entries(file) {
  const zip=await yauzl.openPromise(file,{lazyEntries:true}),files=new Map();
  try {for await(const entry of zip.eachEntry()) {const chunks=[];for await(const chunk of await zip.openReadStreamPromise(entry)) chunks.push(chunk);files.set(entry.fileName,Buffer.concat(chunks));}}
  finally {zip.close();}return files;
}

test('complete backup and offline restore preserve original photos, owners, folders, prompts and playable music',async t=>{
  const f=await fixture(t),jobs=f.store.read().jobs;
  const result=await f.request('/backups/export',{});assert.equal(result.status,200);assert.equal(result.data.photos,1);assert.equal(result.data.unavailableOriginals,0);
  const response=await adminFetch(f.base+'/api/backups/'+result.data.token);assert.equal(response.status,200);
  const archive=path.join(f.root,'complete.zip');fs.writeFileSync(archive,Buffer.from(await response.arrayBuffer()));
  const files=await entries(archive);assert.ok(files.has('studio.sqlite'));assert.ok(files.has('photos.sqlite'));assert.ok([...files.keys()].some(name=>name.startsWith('photos/')));assert.ok([...files.keys()].some(name=>name.startsWith('gallery-music/')));
  const destination=path.join(f.root,'restored');fs.mkdirSync(destination);fs.writeFileSync(path.join(destination,'keep.txt'),'original data');
  let offlineChecks=0;const restored=await restoreBackup({archive,dataDir:destination,assertOffline:async()=>{offlineChecks++;}});
  assert.equal(offlineChecks,2);assert.equal(fs.readFileSync(path.join(restored.previousDataDir,'keep.txt'),'utf8'),'original data');
  const accounts=new DatabaseSync(path.join(destination,'accounts.sqlite'),{readOnly:true});
  assert.equal(accounts.prepare('SELECT COUNT(*) n FROM sessions').get().n,0);assert.equal(accounts.prepare('SELECT owner_id FROM accounts WHERE username=?').get('backup-alice').owner_id,f.owner);accounts.close();
  const app=createApp({dataDir:destination,fetchImpl:async()=>{throw new Error('ComfyUI is offline');}}),server=app.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  try {
    const base=`http://127.0.0.1:${server.address().port}`,session=await login(base,'backup-alice','backup-password'),headers={Cookie:session.cookie};
    const state=await (await fetch(base+'/api/studio/state',{headers})).json();assert.equal(state.jobs.length,1);assert.equal(state.jobs[0].id,'customer-photo');assert.equal(state.folders[0].name,'森林寫真');assert.equal(state.gallery.length,1);assert.equal(state.music[0].name,'備份鋼琴');
    assert.deepEqual(Buffer.from(await (await fetch(base+'/api/studio/jobs/customer-photo/image/0',{headers})).arrayBuffer()),PNG);
    assert.equal((await fetch(base+'/api/studio/jobs/other-photo/image/0',{headers})).status,404);
    assert.deepEqual(app.store.read().jobs,jobs);assert.equal(app.store.read().settings.characterPrompts.heightPrompts.below140,'My saved height prompt');
  } finally {await new Promise(resolve=>server.close(resolve));app.store.close();}
});

test('backup download is administrator-only and active shoots prevent creating an inconsistent snapshot',async t=>{
  const f=await fixture(t),result=await f.backups.exportZip(),customer=await login(f.base,'backup-alice','backup-password');
  assert.equal((await fetch(f.base+'/api/backups/'+result.token)).status,401);
  assert.equal((await fetch(f.base+'/api/backups/'+result.token,{headers:{Cookie:customer.cookie}})).status,403);
  f.store.mutate(state=>{state.jobs[0].status='running';});
  assert.equal((await f.request('/backups/export',{})).status,409);
});

test('restore rejects corrupt image bytes and an online service before replacing any existing data',async t=>{
  const f=await fixture(t),result=await f.backups.exportZip(),source=f.backups.download(result.token),files=await entries(source.path),archive=path.join(f.root,'corrupt.zip');
  const zip=new yazl.ZipFile(),writing=pipeline(zip.outputStream,fs.createWriteStream(archive));
  for(const [name,buffer] of files) zip.addBuffer(name.startsWith('photos/') ? Buffer.from('corrupt image') : buffer,name);zip.end();await writing;
  const destination=path.join(f.root,'existing');fs.mkdirSync(destination);fs.writeFileSync(path.join(destination,'keep.txt'),'keep');
  await assert.rejects(restoreBackup({archive,dataDir:destination}),/校驗失敗/);
  assert.equal(fs.readFileSync(path.join(destination,'keep.txt'),'utf8'),'keep');
  await assert.rejects(restoreBackup({archive:source.path,dataDir:destination,assertOffline:async()=>{throw new Error('service is online');}}),/online/);
  assert.equal(fs.readFileSync(path.join(destination,'keep.txt'),'utf8'),'keep');
});

test('an in-flight write must finish before a complete backup can freeze the data',async t=>{
  let entered,release;const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const f=await previewFixture({directoryPicker:async()=>{entered();await gate;return null;}});t.after(f.close);
  const choosing=f.request('/environment/directory/pick',{});
  try {
    await started;const busy=await f.request('/backups/export',{});assert.equal(busy.status,409);assert.match(busy.data.error,/資料保存/);
  } finally {release();}
  assert.equal((await choosing).status,200);
  const backup=await f.request('/backups/export',{});assert.equal(backup.status,200);
});
