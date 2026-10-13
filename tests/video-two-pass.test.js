import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {createEnvironmentManager} from '../server/environment.js';
import {videoTemplate,videoUiTemplate,convertVideoWorkflow,videoWorkflowParameters,videoSize} from '../server/video-workflow.js';
import {DEFAULT_TWO_PASS_UNET,DEFAULT_LATENT_UPSCALER,TWO_PASS_WORKFLOW_PATH} from '../shared/photo-video.js';
import {videoFixture,videoObjectInfo} from './photo-video-fixture.js';

test('editable two-pass workflow retains the upstream latent upscale topology, denoised first output and exact refinement sigmas',()=>{
  const reference=JSON.parse(fs.readFileSync(new URL('./fasth3-upscale-reference.json',import.meta.url)));
  const node=id=>reference.nodes.find(n=>n.id===id),input=(id,name)=>{const idLink=node(id).inputs.find(i=>i.name===name).link,l=reference.links.find(l=>l[0]===idLink);return {type:node(l[1]).type,slot:l[2]};};
  assert.deepEqual(input(38,'av_latent'),{type:'SamplerCustomAdvanced',slot:1});
  assert.deepEqual(input(26,'sigmas'),{type:'SplitSigmas',slot:0});
  assert.deepEqual(input(54,'latent'),{type:'LTXVSeparateAVLatent',slot:0});
  assert.deepEqual(input(18,'audio_latent'),{type:'LTXVSeparateAVLatent',slot:1});
  assert.deepEqual(input(25,'latent_image'),{type:'LTXVConcatAVLatent',slot:0});
  const api=convertVideoWorkflow(videoUiTemplate('two-pass'),videoObjectInfo()),canonical=videoTemplate('two-pass');
  for(const [id,n] of Object.entries(canonical)) assert.deepEqual(api[id].inputs,n.inputs,id);
  assert.deepEqual(api.separate.inputs.av_latent,['sample',1]);assert.deepEqual(api.sample.inputs.sigmas,['sigmas_first',0]);
  assert.deepEqual(api.upscale.inputs.latent,['separate',0]);assert.deepEqual(api.concat.inputs.audio_latent,['separate',1]);
  assert.deepEqual(api.sample_refine.inputs.latent_image,['concat',0]);assert.deepEqual(api.decode.inputs.samples,['sample_refine',0]);
  assert.equal(api.sigmas_first.inputs.step,node(3).widgets_values[0]);assert.equal(api.sigmas_refine.inputs.sigmas,node(30).widgets_values[0]);
  assert.deepEqual(videoWorkflowParameters(api),{sampler:'euler',scheduler:'simple',steps:8,megapixels:0.4,multiple:32,generationVersion:'two-pass',refineMegapixels:1,refineMultiple:32,firstPassSteps:4,refineSteps:3});
});

test('two-pass customer jobs freeze both resolutions and selected models, inherit the photo ratio and record final output dimensions',async t=>{
  const f=await videoFixture();t.after(()=>f.close());
  f.control.sourcePng=await sharp({create:{width:900,height:1600,channels:3,background:'white'}}).png().toBuffer();
  const before=f.photoVideos.settings().models;
  const parameters=(await f.request('/photo-videos/parameters?generationVersion=two-pass')).data;
  const values={sampler:parameters.sampler,scheduler:parameters.scheduler,steps:parameters.steps,megapixels:parameters.megapixels,refineMegapixels:parameters.refineMegapixels};
  assert.equal((await f.request('/photo-videos/settings',{generationVersion:'two-pass',workflowParameters:values,workflowRevision:parameters.revision},'PUT')).status,200);
  assert.equal(f.photoVideos.settings().effectiveModels.unet,DEFAULT_TWO_PASS_UNET);assert.deepEqual(f.photoVideos.settings().models,before);
  assert.ok(f.control.workflows.has('workflows/'+TWO_PASS_WORKFLOW_PATH));
  const customer=await f.customer('two-pass');f.store.mutate(s=>s.jobs[0].visitorId=customer.ownerId);
  assert.equal((await customer.request('/jobs/original/video',{requestId:'two-pass-frozen-01',mode:'custom',prompt:'Gentle motion.',duration:7,aspectRatio:'1:1'})).status,202);
  await f.request('/photo-videos/settings',{generationVersion:'single'},'PUT');await f.restart();await f.photoVideos.tick();
  const row=f.store.read().photoVideos[0],api=f.submitted[0].prompt,low=videoSize(900,1600,'reference',{megapixels:0.4}),high=videoSize(900,1600);
  assert.deepEqual([api.encode.inputs.width,api.encode.inputs.height],[low.width,low.height]);
  assert.deepEqual([api.encode_high.inputs.width,api.encode_high.inputs.height],[high.width,high.height]);
  assert.deepEqual([api.upscale.inputs['mode.width'],api.upscale.inputs['mode.height']],[high.width,high.height]);
  assert.equal(api.upscale.inputs.model_name,DEFAULT_LATENT_UPSCALER);assert.equal(api.model.inputs.unet_name,DEFAULT_TWO_PASS_UNET);
  assert.equal(api.encode.inputs.prompt,api.encode_high.inputs.prompt);assert.equal(api.encode.inputs.length,api.encode_high.inputs.length);
  assert.equal(api.trim_frames.inputs.length,168);assert.equal(api.trim_audio.inputs.duration,7);assert.equal(api.sampler.inputs.sampler_name,'euler');assert.equal(api.schedule.inputs.scheduler,'simple');
  assert.deepEqual([row.width,row.height],[high.width,high.height]);assert.equal(row.aspectRatio,'reference');
  await f.finish();assert.equal(f.photoVideos.list(customer.ownerId)[0].generationVersion,'two-pass');
});

test('二採 install plan includes verified NVFP4, latent weights and node files while a one-pass plan stays independent',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-upscale-plan-'));fs.writeFileSync(path.join(directory,'main.py'),'');fs.mkdirSync(path.join(directory,'comfy'));
  t.after(()=>{const resolved=path.resolve(directory);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.match(path.basename(resolved),/^PhotoCreate-upscale-plan-/);fs.rmSync(resolved,{recursive:true,force:true});});
  const manager=createEnvironmentManager({dataDir:directory});t.after(()=>manager.close());
  const single=manager.plan(directory,{purpose:'video'});assert.equal(single.resources.length,5);
  const models={...single.resources.filter(r=>r.kind==='model').reduce((m,r)=>({...m,[r.role]:r.fileName}),{}),unet:DEFAULT_TWO_PASS_UNET,latentUpscaler:DEFAULT_LATENT_UPSCALER};
  const plan=manager.plan(directory,{purpose:'video',videoModels:models});assert.equal(plan.resources.filter(r=>r.kind==='model').length,5);assert.equal(plan.resources.filter(r=>r.kind==='node').length,6);
  assert.match(plan.resources.find(r=>r.kind==='workflow').source,/02 FastH3/);
  const unet=plan.resources.find(r=>r.role==='unet'),upscale=plan.resources.find(r=>r.role==='latentUpscaler');
  assert.equal(unet.size,11894623166);assert.equal(upscale.size,690592672);assert.match(upscale.target,/models\/latent_upscale_models\//);assert.equal(plan.manualModels.length,0);
});

test('invalid refinement parameters or stale revision cannot switch the active customer workflow',async t=>{
  const f=await videoFixture();t.after(()=>f.close());const p=(await f.request('/photo-videos/parameters?generationVersion=two-pass')).data;
  const body={generationVersion:'two-pass',workflowParameters:{sampler:p.sampler,scheduler:p.scheduler,steps:p.steps,megapixels:p.megapixels,refineMegapixels:0.01},workflowRevision:p.revision};
  assert.equal((await f.request('/photo-videos/settings',body,'PUT')).status,400);assert.equal(f.photoVideos.settings().generationVersion,'single');
  body.workflowParameters.refineMegapixels=1;body.workflowRevision='0'.repeat(64);
  assert.equal((await f.request('/photo-videos/settings',body,'PUT')).status,409);assert.equal(f.photoVideos.settings().generationVersion,'single');assert.equal(f.control.workflows.size,0);
});

test('a new machine can select and install two-pass before its custom node is loaded, without claiming readiness',async t=>{
  const f=await videoFixture();t.after(()=>f.close());delete f.info.MinimaxH3LatentUpscaler3D;
  const result=await f.request('/photo-videos/parameters?generationVersion=two-pass');assert.equal(result.status,200);const p=result.data;
  assert.equal((await f.request('/photo-videos/settings',{generationVersion:'two-pass',workflowParameters:{sampler:p.sampler,scheduler:p.scheduler,steps:p.steps,megapixels:p.megapixels,refineMegapixels:p.refineMegapixels},workflowRevision:p.revision},'PUT')).status,200);
  const availability=(await f.request('/photo-videos/availability')).data;assert.equal(availability.ready,false);assert.ok(availability.missingNodes.includes('MinimaxH3LatentUpscaler3D'));
  assert.equal((await f.request('/jobs/original/video',{requestId:'two-pass-missing-node',mode:'custom',prompt:'Gentle motion.'})).status,503);
});
