import {adminFetch as fetch} from './auth-client.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {pipeline} from 'node:stream/promises';
import yauzl from 'yauzl';
import yazl from 'yazl';
import {createApp} from '../server/index.js';
import {createStore} from '../server/store.js';
import {createTransferManager} from '../server/transfer.js';
import {LIMITS,validateManifest} from '../server/transfer-schema.js';
import {PNG} from './fixtures.js';

export const CAMERA={id:'custom-camera',category:'camera',name:'肩後仰角',prompt:'camera',tags:['自訂'],angle:{horizontalAngle:133,verticalAngle:-90,zoom:10},mappingVersion:2,mappingSource:'manual',mappingNote:'保留加強參數'};
export const PRESETS=[CAMERA,{id:'custom-pose',category:'pose',name:'站姿',prompt:'Standing naturally.',tags:['測試']},{id:'custom-light',category:'lighting',name:'窗光',prompt:'Soft window light.',tags:[]},{id:'custom-color',category:'color',name:'自然',prompt:'Natural colors.',tags:[]},{id:'custom-quality',category:'quality',name:'高清',prompt:'Sharp photographic detail.',tags:[]}];
export const SHOOTING={cameraMode:'multiangle',cameraEnabled:true,mode:'random',randomCount:30,randomPoolMode:'selected',randomOptional:{expression:false,clothing_state:false,interaction:false},characterId:'person',garmentIds:['dress'],poseIds:['custom-pose'],cameraIds:['custom-camera'],lightingIds:['custom-light'],colorIds:['custom-color'],qualityIds:['custom-quality'],steps:47,angleSteps:22,refineDenoise:0.25,aspectRatio:'16:9',resolution:2048,seed:-1,copies:1,extra:'保留衣服細節。',negative:'blurry'};
export function seedLibrary(store,dir) {
  const asset=(id,name)=>({id,name,description:`${name}的提詞`,tags:['中文標籤'],fileName:`${id}.png`,image:`/uploads/${id}.png`,mime:'image/png',createdAt:'2026-10-09T00:00:00.000Z'});
  store.mutate(state=>{state.characters=[asset('person','測試角色')];state.garments=[asset('dress','測試服裝')];state.scenes=[asset('old-scene','舊場景')];state.presets=structuredClone(PRESETS);state.draft=structuredClone(SHOOTING);state.settings={comfyUrl:'http://private-comfy:8188',comfyDirectory:'Z:/old/machine',environmentDraft:{comfyDirectory:'private'}};state.jobs=[{id:'existing-job',name:'不可匯入任務',status:'completed',createdAt:'2026-10-09',images:[]}];});
  for(const row of ['person','dress','old-scene']) fs.writeFileSync(path.join(dir,'uploads',`${row}.png`),PNG);
}
function fixture(t,{source=false,...options}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'photocreate-transfer-test-')),store=createStore(dir);
  if(source) seedLibrary(store,dir);
  const transfer=createTransferManager({dataDir:dir,store,...options});
  t.after(()=>{transfer.close();store.close();assert.equal(path.dirname(fs.realpathSync(dir)),fs.realpathSync(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,store,transfer};
}
async function exportTo(source,target) {
  const exported=await source.transfer.exportZip(),archive=source.transfer.download(exported.token),file=path.join(target.transfer.uploadDir,`${randomUUID()}.zip`);
  fs.copyFileSync(archive.path,file);archive.cleanup();return file;
}
export async function zipEntries(file) {
  const zip=await yauzl.openPromise(file,{lazyEntries:true});const result=new Map();
  try {for await(const entry of zip.eachEntry()) {const stream=await zip.openReadStreamPromise(entry),chunks=[];for await(const chunk of stream) chunks.push(chunk);result.set(entry.fileName,Buffer.concat(chunks));}} finally {zip.close();}
  return result;
}
export async function writeZip(file,entries,{symlink}={}) {
  const zip=new yazl.ZipFile(),writing=pipeline(zip.outputStream,fs.createWriteStream(file));
  for(const [name,buffer] of entries) zip.addBuffer(buffer,name,{compress:true,...(name===symlink ? {mode:0o120777} : {})});
  zip.end();await writing;return file;
}

test('資料搬移不匯出訪客角色，也不將私人角色合併成公用預設',async t=> {
  const source=fixture(t,{source:true}),target=fixture(t);
  const person=source.store.read().characters[0];
  source.store.mutate(state=>state.characters.push({...person,id:'source-visitor',name:'私人角色',visitorId:'a'.repeat(64)}));
  target.store.mutate(state=>state.characters.push({...person,id:'target-visitor',visitorId:'b'.repeat(64)}));
  fs.writeFileSync(path.join(target.dir,'uploads',person.fileName),PNG);
  const archive=await exportTo(source,target),entries=await zipEntries(archive),manifest=JSON.parse(entries.get('photocreate.json'));
  assert.equal(manifest.assets.characters.length,1);assert.equal(manifest.assets.characters[0].id,person.id);
  const preview=await target.transfer.prepare(archive);assert.equal(preview.added.characters,1);
  await target.transfer.commit(preview.token);
  const characters=target.store.read().characters;assert.equal(characters.length,2);
  assert.equal(characters.find(row=>row.id==='target-visitor').visitorId,'b'.repeat(64));
  assert.equal(characters.find(row=>row.id===person.id).visitorId,undefined);
});

test('portable ZIP round trip preserves originals, prompts, enhanced angles and draft, excluding environment/tasks',async t=> {
  const source=fixture(t,{source:true}),target=fixture(t),before=target.store.read();
  const archive=await exportTo(source,target),entries=await zipEntries(archive);
  assert.equal(entries.size,2,'Identical image files are stored once');
  const manifest=JSON.parse(entries.get('photocreate.json'));
  assert.deepEqual(Object.keys(manifest).sort(),['assets','createdAt','draft','format','presets','version']);
  assert.equal(JSON.stringify(manifest).includes('private-comfy'),false);
  const preview=await target.transfer.prepare(archive);
  assert.deepEqual(preview.added,{garments:1,characters:1,scenes:1,presets:5});
  assert.equal(target.store.read().characters.length,0,'Preview must not modify the library');
  const imported=await target.transfer.commit(preview.token,{applyDraft:true});assert.equal(imported.draftApplied,true);
  const state=target.store.read();
  assert.deepEqual(state.settings,before.settings);assert.deepEqual(state.jobs,before.jobs);
  assert.deepEqual(state.presets.find(row=>row.id===CAMERA.id),CAMERA);
  for(const kind of ['characters','garments','scenes']) {
    const row=state[kind][0];assert.equal(row.description,source.store.read()[kind][0].description);assert.deepEqual(row.tags,['中文標籤']);assert.deepEqual(fs.readFileSync(path.join(target.dir,'uploads',row.fileName)),PNG);
  }
  assert.equal(state.draft.cameraEnabled,true);assert.equal(state.draft.characterId,'person');assert.deepEqual(state.draft.cameraIds,[CAMERA.id]);assert.equal(state.draft.steps,47);assert.equal(state.draft.angleSteps,22);assert.equal(state.draft.refineDenoise,0.25);assert.equal(state.draft.aspectRatio,'16:9');
  assert.equal(target.store.searchPresets({q:'Standing'}).rows[0].id,'custom-pose');
  assert.equal(fs.readdirSync(path.join(target.dir,'uploads')).length,1,'Shared image data must not multiply disk usage');
  assert.deepEqual(fs.readdirSync(target.transfer.uploadDir),[]);
});

test('content duplicates are skipped and ID conflicts get fresh IDs with draft remapping',async t=> {
  const source=fixture(t,{source:true}),target=fixture(t,{source:true});
  target.store.mutate(state=>{state.characters[0].description='本機修改';state.presets.find(row=>row.id===CAMERA.id).angle={horizontalAngle:180,verticalAngle:31,zoom:9};state.draft.steps=35;});
  const before=target.store.read(),preview=await target.transfer.prepare(await exportTo(source,target));
  assert.deepEqual(preview.added,{characters:1,garments:0,scenes:0,presets:1});
  await target.transfer.commit(preview.token,{applyDraft:true});
  const after=target.store.read();assert.deepEqual(after.characters[0],before.characters[0]);assert.deepEqual(after.presets.find(row=>row.id===CAMERA.id),before.presets.find(row=>row.id===CAMERA.id));
  assert.notEqual(after.draft.characterId,'person');assert.notEqual(after.draft.cameraIds[0],CAMERA.id);
  assert.deepEqual(after.characters.find(row=>row.id===after.draft.characterId).tags,['中文標籤']);assert.deepEqual(after.presets.find(row=>row.id===after.draft.cameraIds[0]).angle,CAMERA.angle);
  const repeated=await target.transfer.prepare(await exportTo(source,target));assert.deepEqual(repeated.added,{characters:0,garments:0,scenes:0,presets:0});
  target.store.mutate(state=>{state.draft.steps=26;});await target.transfer.commit(repeated.token,{applyDraft:false});assert.equal(target.store.read().draft.steps,26);
});

test('ZIP 搬移保留三類複選，ID 衝突時重映射每一項候選',async t=> {
  const source=fixture(t,{source:true}),target=fixture(t);
  const pools={expression:'expressionIds',clothing_state:'clothingStateIds',interaction:'interactionIds'};
  const rows=Object.keys(pools).flatMap(category=>[1,2].map(index=>({id:`optional-${category}-${index}`,category,name:`${category} choice ${index}`,prompt:`Neutral ${category} option ${index}.`,tags:[]})));
  source.store.mutate(state=>{
    state.presets.push(...rows);
    for(const [category,field] of Object.entries(pools)) state.draft[field]=rows.filter(row=>row.category===category).map(row=>row.id);
  });
  target.store.mutate(state=>state.presets.push({...rows[0],prompt:'A local edit to retain.'}));
  const preview=await target.transfer.prepare(await exportTo(source,target));
  await target.transfer.commit(preview.token,{applyDraft:true});
  const state=target.store.read();
  assert.equal(state.presets.find(row=>row.id===rows[0].id).prompt,'A local edit to retain.');
  assert.notEqual(state.draft.expressionIds[0],rows[0].id);
  for(const [category,field] of Object.entries(pools)) {
    assert.equal(state.draft[field].length,2);
    assert.deepEqual(state.draft[field].map(id=>state.presets.find(row=>row.id===id).prompt),rows.filter(row=>row.category===category).map(row=>row.prompt));
  }
});

test('commit recomputes a preview after intervening library edits without overwriting them',async t=> {
  const source=fixture(t,{source:true}),target=fixture(t);
  const preview=await target.transfer.prepare(await exportTo(source,target));
  target.store.mutate(state=>state.presets.push({...CAMERA,angle:{horizontalAngle:180,verticalAngle:0,zoom:1}}));
  const before=target.store.read().presets.find(row=>row.id===CAMERA.id);
  await target.transfer.commit(preview.token,{applyDraft:true});
  assert.deepEqual(target.store.read().presets.find(row=>row.id===CAMERA.id),before);
  assert.notEqual(target.store.read().draft.cameraIds[0],CAMERA.id);
});

test('corrupt, missing, extra, unsupported and symlink ZIP entries leave the database and uploads unchanged',async t=> {
  const source=fixture(t,{source:true}),target=fixture(t),original=await exportTo(source,target),entries=await zipEntries(original),before=target.store.read();
  fs.rmSync(original);
  const imageName=[...entries.keys()].find(name=>name.startsWith('images/'));
  for(const variant of ['corrupt','missing','extra','version','symlink','duplicate']) {
    const changed=new Map(entries);const file=path.join(target.transfer.uploadDir,`${randomUUID()}.zip`);
    if(variant==='corrupt') {const b=Buffer.from(changed.get(imageName));b[b.length-1]^=1;changed.set(imageName,b);}
    if(variant==='missing') changed.delete(imageName);
    if(variant==='extra') changed.set('unrelated.txt',Buffer.from('no'));
    if(variant==='version') {const data=JSON.parse(changed.get('photocreate.json'));data.version=99;changed.set('photocreate.json',Buffer.from(JSON.stringify(data)));}
    await writeZip(file,variant==='duplicate' ? [...changed,...changed] : changed,{symlink:variant==='symlink' ? imageName : undefined});
    await assert.rejects(target.transfer.prepare(file),undefined,variant);
    assert.deepEqual(target.store.read(),before,variant);assert.deepEqual(fs.readdirSync(path.join(target.dir,'uploads')),[],variant);assert.deepEqual(fs.readdirSync(target.transfer.uploadDir),[],variant);
  }
});

test('traversal paths and bad CRC are rejected before any data is applied',async t=> {
  const source=fixture(t,{source:true}),target=fixture(t),original=await exportTo(source,target),bytes=fs.readFileSync(original);fs.rmSync(original);
  const file=path.join(target.transfer.uploadDir,`${randomUUID()}.zip`);
  // Change both local and central filenames, preserving their lengths, to ../ escape.
  const entries=await zipEntries(await exportTo(source,target)),name=[...entries.keys()].find(value=>value.startsWith('images/'));
  const escaped=Buffer.from(bytes),replacement=`../out/${'x'.repeat(name.length-7)}`;
  for(let offset=escaped.indexOf(name);offset!==-1;offset=escaped.indexOf(name,offset+name.length)) escaped.write(replacement,offset);
  fs.writeFileSync(file,escaped);await assert.rejects(target.transfer.prepare(file));
  const corruptCrc=Buffer.from(bytes),central=corruptCrc.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));corruptCrc[central+16]^=1;
  fs.writeFileSync(file,corruptCrc);await assert.rejects(target.transfer.prepare(file),/ZIP 校驗失敗/);
  assert.equal(target.store.read().characters.length,0);
});

test('expanded byte caps and expired previews are enforced',async t=> {
  const source=fixture(t,{source:true}),small=fixture(t,{limits:{...LIMITS,manifest:30}});
  await assert.rejects(small.transfer.prepare(await exportTo(source,small)),/大小|範圍/);
  let clock=Date.now();const expired=fixture(t,{now:()=>clock}),preview=await expired.transfer.prepare(await exportTo(source,expired));
  clock+=31*60000;await assert.rejects(expired.transfer.commit(preview.token),error=>error.status===410);
  assert.deepEqual(fs.readdirSync(expired.transfer.uploadDir),[]);
});

test('failed SQLite transaction rolls back every imported record and copied image',async t=> {
  const source=fixture(t,{source:true}),target=fixture(t),preview=await target.transfer.prepare(await exportTo(source,target)),before=target.store.read();
  const db=new DatabaseSync(path.join(target.dir,'studio.sqlite'));
  db.exec("CREATE TRIGGER reject_import BEFORE INSERT ON presets WHEN new.id='custom-light' BEGIN SELECT RAISE(ABORT,'test import failure'); END");
  await assert.rejects(target.transfer.commit(preview.token,{applyDraft:true}),/test import failure/);
  assert.deepEqual(target.store.read(),before);assert.deepEqual(fs.readdirSync(path.join(target.dir,'uploads')),[]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM assets').get().n,0);
  db.exec('DROP TRIGGER reject_import');db.close();
  await target.transfer.commit(preview.token,{applyDraft:true});assert.equal(target.store.read().characters.length,1);
});

test('manifest whitelists metadata and validates enhanced camera and shooting parameters',async t=> {
  const source=fixture(t,{source:true}),target=fixture(t),file=await exportTo(source,target),entries=await zipEntries(file),manifest=JSON.parse(entries.get('photocreate.json'));
  const cleaned=validateManifest({...manifest,settings:{comfyUrl:'private'},jobs:['ignored'],draft:{...manifest.draft,comfyUrl:'private',workflowPath:'private'}});
  assert.equal(cleaned.settings,undefined);assert.equal(cleaned.draft.comfyUrl,undefined);
  for(const angle of [{horizontalAngle:361,verticalAngle:0,zoom:1},{horizontalAngle:133,verticalAngle:-91,zoom:10},{horizontalAngle:133,verticalAngle:-90,zoom:11}]) assert.throws(()=>validateManifest({...manifest,presets:[{...CAMERA,angle}]}));
  assert.throws(()=>validateManifest({...manifest,draft:{...manifest.draft,steps:101}}));
});

test('HTTP export/upload/preview/import works without contacting ComfyUI, preserves active connection and existing tasks',async t=> {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'photocreate-transfer-api-'));let upstream=0;
  const instance=createApp({dataDir:dir,fetchImpl:async()=>{upstream++;throw new Error('must not contact ComfyUI');}}),{app,store}=instance;
  seedLibrary(store,dir);const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();assert.equal(path.dirname(fs.realpathSync(dir)),fs.realpathSync(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${server.address().port}/api`,request=(endpoint,body)=>fetch(url+endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body ?? {})});
  const exported=await (await request('/transfer/export')).json(),download=await fetch(`${url}/transfer/export/${exported.token}`);
  assert.equal(download.headers.get('content-type'),'application/zip');const bytes=await download.arrayBuffer();
  const form=new FormData();form.append('archive',new Blob([bytes]),'資料.zip');const response=await fetch(url+'/transfer/preview',{method:'POST',body:form});assert.equal(response.status,200);const preview=await response.json();
  assert.deepEqual(preview.added,{garments:0,characters:0,scenes:0,presets:0});
  store.mutate(state=>{state.jobs[0].status='queued';});const blocked=await request('/transfer/import',{token:preview.token,applyDraft:true});assert.equal(blocked.status,409);
  const before=store.read();const imported=await request('/transfer/import',{token:preview.token,applyDraft:false});assert.equal(imported.status,200);assert.deepEqual(store.read(),before);assert.equal(upstream,0);
  const replay=await request('/transfer/import',{token:preview.token});assert.equal(replay.status,410);
  const invalidForm=new FormData();invalidForm.append('archive',new Blob(['not zip']),'test.zip');assert.equal((await fetch(url+'/transfer/preview',{method:'POST',body:invalidForm})).status,400);
});
