import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {previewFixture} from './preset-preview-fixture.js';
import {PNG,DRAFT,fixtureState} from './fixtures.js';
import {buildShotPlans} from '../shared/domain.js';
import {adminFetch} from './auth-client.js';

function seed(f,{owner='',corrupt=false,shared=false}={}) {
  const shot=buildShotPlans(fixtureState(),DRAFT)[0],folder=path.join(f.outputDir,'PhotoCreate','archive');
  fs.mkdirSync(folder,{recursive:true});
  const jobs=Array.from({length:shared ? 2 : 1},(_,index)=>({...shot,id:`archived-${index}`,visitorId:owner || undefined,status:'completed',createdAt:'2026-10-11T03:00:00Z',comfyUrl:'http://127.0.0.1:8188',images:[{filename:`original-${index}.png`,subfolder:'PhotoCreate/archive',type:'output'}]}));
  for(const job of jobs) fs.writeFileSync(path.join(folder,job.images[0].filename),corrupt ? PNG.subarray(0,24) : PNG);
  f.store.mutate(state=>{state.jobs=jobs;});
  return {jobs,files:jobs.map(row=>path.join(folder,row.images[0].filename))};
}

test('generated originals are saved, bound to owners and verified before their ComfyUI files are removed',async t=>{
  const f=await previewFixture();t.after(f.close);const {jobs,files}=seed(f,{owner:'customer-owner'}),before=f.store.read();
  fs.writeFileSync(path.join(f.outputDir,'unrelated.png'),PNG);
  await f.photoStorage.archive();
  const saved=f.photoStorage.find(jobs[0].comfyUrl,jobs[0].images[0]);
  assert.ok(saved?.file.startsWith(path.join(f.dataDir,'photos')+path.sep));
  assert.deepEqual(fs.readFileSync(saved.file),PNG);assert.equal(fs.existsSync(files[0]),false);
  assert.equal(fs.existsSync(path.join(f.outputDir,'unrelated.png')),true,'Other engine outputs are untouched');
  const db=new DatabaseSync(path.join(f.dataDir,'photos.sqlite'),{readOnly:true});
  const binding=db.prepare('SELECT job_id,owner_id FROM photo_links').get();db.close();
  assert.deepEqual({...binding},{job_id:jobs[0].id,owner_id:'customer-owner'});
  assert.deepEqual(f.store.read(),before,'Original prompts, job snapshots and account ownership remain intact');
});

test('archived viewing and angle sources work without ComfyUI and deduplicated files disappear after their last photo is deleted',async t=>{
  const f=await previewFixture();t.after(f.close);const {jobs}=seed(f,{shared:true});
  await f.photoStorage.archive();
  const first=f.photoStorage.find(jobs[0].comfyUrl,jobs[0].images[0]),second=f.photoStorage.find(jobs[1].comfyUrl,jobs[1].images[0]);
  assert.equal(first.file,second.file,'Identical originals are stored only once');
  const start=f.calls.length;
  for(const route of ['/api/jobs/archived-0/image/0','/api/jobs/archived-0/image/0?download=1','/api/jobs/archived-0/angle-source?index=0','/api/jobs/archived-0/image/0?thumbnail=1']) {
    const response=await adminFetch(f.base+route);assert.equal(response.status,200);await response.arrayBuffer();
  }
  assert.equal(f.calls.slice(start).filter(row=>row==='/view').length,0,'Viewing and generation source reads use PhotoCreate storage');
  assert.equal((await f.request('/jobs/outputs/delete',{ids:['archived-0']})).status,200);assert.ok(fs.existsSync(first.file));
  assert.equal((await f.request('/jobs/outputs/delete',{ids:['archived-1']})).status,200);assert.equal(fs.existsSync(first.file),false);
});

test('invalid images remain in ComfyUI and cannot be marked as safely archived',async t=>{
  const f=await previewFixture();t.after(f.close);const {jobs,files}=seed(f,{corrupt:true});
  await f.photoStorage.archive();
  assert.equal(f.photoStorage.find(jobs[0].comfyUrl,jobs[0].images[0]),null);
  assert.ok(fs.existsSync(files[0]),'Failed validation never deletes the only original');
  assert.equal(f.photoStorage.status().failed,1);
  assert.deepEqual(fs.readdirSync(path.join(f.dataDir,'photos')),[]);
});

test('angle and refine stages upload saved originals after ComfyUI output cleanup',async t=>{
  const f=await previewFixture();t.after(f.close);
  f.store.mutate(state=>{state.settings.releaseGpuMemory=false;});
  const created=await f.request('/jobs',{...DRAFT,garmentIds:['garment-a'],poseIds:['pose-standing'],copies:1,cameraEnabled:true,cameraMode:'multiangle'});
  assert.equal(created.status,201);const job=created.data[0];
  assert.equal((await f.request('/jobs/submit',{ids:[job.id]})).status,200);
  assert.equal(f.submitted.length,1);
  for(const stage of ['base','angle']) {
    f.complete(f.submitted.at(-1).id);f.pending.add('foreign-job');await f.stageRunner.tick();
    const saved=f.store.read(state=>state.jobs.find(row=>row.id===job.id)).stageResults[stage];
    assert.ok(saved.completed);const image=saved.images[0],raw=path.join(f.outputDir,image.subfolder,image.filename);
    await f.photoStorage.archive();assert.equal(fs.existsSync(raw),false);assert.ok(f.photoStorage.find(saved.comfyUrl,image));
    const reads=f.calls.filter(row=>row==='/view').length,uploads=f.calls.filter(row=>row==='/upload/image').length;
    f.pending.delete('foreign-job');await f.stageRunner.tick();
    assert.equal(f.calls.filter(row=>row==='/upload/image').length,uploads+1,'The next stage receives a new ComfyUI input from the managed original');
    assert.equal(f.calls.filter(row=>row==='/view').length,reads,'Removed engine outputs are never requested');
    const images=Object.values(f.submitted.at(-1).prompt).filter(node=>node.class_type==='LoadImage').map(node=>node.inputs.image);
    assert.ok(images.some(name=>name.includes(`stage-${stage==='base' ? 'angle' : 'refine'}-${job.id}`)));
    assert.ok(images.every(name=>!name.includes('[output]')));
  }
  f.complete(f.submitted.at(-1).id);await f.stageRunner.tick();assert.equal(f.store.read(state=>state.jobs.find(row=>row.id===job.id).status),'completed');
  await f.photoStorage.archive();assert.ok(f.photoStorage.find(job.comfyUrl || 'http://127.0.0.1:8188',f.store.read(state=>state.jobs.find(row=>row.id===job.id).images[0])));
  assert.ok(!f.calls.some(row=>['/free','/interrupt'].includes(row)),'Storage does not interrupt or unload the shared engine');
});

test('a corrupt managed copy never causes the remaining valid ComfyUI original to be deleted',async t=>{
  const f=await previewFixture();t.after(f.close);const {jobs,files}=seed(f);
  await f.photoStorage.archive();const saved=f.photoStorage.find(jobs[0].comfyUrl,jobs[0].images[0]);
  fs.writeFileSync(files[0],PNG);fs.writeFileSync(saved.file,PNG.subarray(0,24));
  await f.photoStorage.archive();assert.deepEqual(fs.readFileSync(files[0]),PNG);assert.equal(f.photoStorage.status().failed,1);
});

test('legacy camera input copies are backed up and reused without reading the engine source',async t=>{
  const f=await previewFixture();t.after(f.close);const {jobs}=seed(f),image={filename:'legacy-source.png',subfolder:'PhotoCreate',type:'input'};
  f.store.mutate(state=>{
    Object.assign(state.jobs[0],{jobKind:'angle-edit',cameraEnabled:true,cameraMode:'multiangle',angleSteps:25,refineSteps:20,refineDenoise:0.15,sourceInput:'PhotoCreate/legacy-source.png',sourceInputComfyUrl:jobs[0].comfyUrl,
      camera:{id:'legacy-camera',name:'正面',angle:{horizontalAngle:0,verticalAngle:0,zoom:5}},
      cameraSource:{image,comfyUrl:jobs[0].comfyUrl,jobId:'removed-legacy-source',stage:'source',seed:state.jobs[0].seed}});
    state.settings.releaseGpuMemory=false;
  });
  await f.photoStorage.archive();assert.deepEqual(fs.readFileSync(f.photoStorage.find(jobs[0].comfyUrl,image).file),PNG);
  const result=await f.request('/jobs/remake',{ids:[jobs[0].id],requestId:'saved-camera-input'});assert.equal(result.status,201);
  const before=f.calls.filter(row=>row==='/view').length;
  const submitted=await f.request('/jobs/submit',{ids:[result.data.jobs[0].id]});assert.equal(submitted.status,200);
  assert.equal(submitted.data.results[0].ok,true,JSON.stringify(submitted.data.results));
  assert.equal(f.calls.filter(row=>row==='/view').length,before);
  assert.ok(f.submitted.length>0);assert.ok(Object.values(f.submitted[0].prompt).some(node=>node.class_type==='LoadImage' && node.inputs.image.includes('angle-source-')));
});
