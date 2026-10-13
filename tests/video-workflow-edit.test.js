import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {BUNDLE_DIR} from '../server/environment.js';
import {videoFixture} from './photo-video-fixture.js';
import {videoUiTemplate,convertVideoWorkflow,videoWorkflowParameters} from '../server/video-workflow.js';
import {videoObjectInfo} from './photo-video-fixture.js';
import {DEFAULT_VIDEO_WORKFLOW_PATH,DEFAULT_VIDEO_PROMPT,LEGACY_VIDEO_PROMPT} from '../shared/photo-video.js';

test('installed H3 workflow can open in ComfyUI and exposes sampler, scheduler and Megapixels',()=> {
  const manifest=JSON.parse(fs.readFileSync(path.join(BUNDLE_DIR,'video-manifest.json'),'utf8'));
  const resource=manifest.resources.find(row=>row.kind==='workflow'),ui=JSON.parse(fs.readFileSync(path.join(BUNDLE_DIR,resource.source),'utf8'));
  assert.ok(Array.isArray(ui.nodes),'H3 installation must provide the editable ComfyUI nodes/links format');
  assert.ok(ui.nodes.some(row=>row.type==='KSamplerSelect'));
  assert.ok(ui.nodes.some(row=>row.type==='BasicScheduler'));
  assert.ok(ui.nodes.some(row=>row.type==='ResolutionSelector'));
});

test('customers save, reopen and privately manage their own video prompts',async t=> {
  const f=await videoFixture();t.after(()=>f.close());const alice=await f.customer('saved-video'),bob=await f.customer('saved-video-other');
  const body={field:'video',name:'My gentle motion',prompt:'The subject gently sways. The camera slowly frames the upper body.'};
  const created=await alice.request('/prompts',body);assert.equal(created.status,201);assert.equal(created.data.field,'video');
  assert.equal((await alice.request('/prompts')).data.find(row=>row.id===created.data.id).prompt,body.prompt);
  assert.equal((await bob.request('/prompts')).data.length,0);
  assert.equal((await bob.request('/prompts/'+created.data.id,{...body,name:'Not mine'},'PATCH')).status,404);
  await f.restart();assert.equal((await alice.request('/prompts')).data.find(row=>row.id===created.data.id).prompt,body.prompt);
  assert.equal((await alice.request('/prompts',{...body,prompt:'A'.repeat(2200)})).status,201);
  assert.equal((await alice.request('/prompts',{...body,prompt:'A'.repeat(16001)})).status,400);
  assert.equal((await bob.request('/prompts/'+created.data.id,undefined,'DELETE')).status,404);
  assert.equal((await alice.request('/prompts/'+created.data.id,undefined,'DELETE')).status,200);
});

const edit=(ui,role,values)=>{const node=ui.nodes.find(row=>row.properties?.photocreate_role===role);node.widgets_values=values;};
test('real ComfyUI widget layout converts linked width/height without shifting subsequent sampler inputs',()=> {
  const ui=videoUiTemplate();edit(ui,'sampler',['euler']);edit(ui,'schedule',['simple',12,0.9]);edit(ui,'resolution',['16:9 (Widescreen)',1.2,32]);
  const graph=convertVideoWorkflow(ui,videoObjectInfo());
  assert.deepEqual(videoWorkflowParameters(graph),{sampler:'euler',scheduler:'simple',steps:12,megapixels:1.2,multiple:32,generationVersion:'single'});
  assert.deepEqual(graph.encode.inputs.width,['resolution',0]);assert.deepEqual(graph.encode.inputs.height,['resolution',1]);
  assert.equal(graph.encode.inputs.length,124);assert.equal(graph.sparse.inputs['selection.keep_percent'],10);
});

test('saved ComfyUI sampler/scheduler/Megapixels changes apply to new videos and freeze queued videos across restart',async t=> {
  const f=await videoFixture();t.after(()=>f.close());const ui=videoUiTemplate(),key='workflows/'+DEFAULT_VIDEO_WORKFLOW_PATH;
  edit(ui,'sampler',['euler']);edit(ui,'schedule',['simple',8,1]);edit(ui,'resolution',['16:9 (Widescreen)',1,32]);f.control.workflows.set(key,ui);
  const first=await f.request('/jobs/original/video',{requestId:'workflow-first-0001',mode:'custom',prompt:'Slow camera movement.',aspectRatio:'16:9',duration:5});assert.equal(first.status,202);
  edit(ui,'sampler',['res_multistep']);edit(ui,'schedule',['normal',10,1]);edit(ui,'resolution',['16:9 (Widescreen)',1.2,32]);
  await f.restart();await f.photoVideos.tick();let graph=f.submitted.at(-1).prompt;
  assert.equal(graph.sampler.inputs.sampler_name,'euler');assert.equal(graph.schedule.inputs.scheduler,'simple');assert.equal(graph.resolution.inputs.megapixels,1);
  assert.deepEqual([f.store.read().photoVideos[0].width,f.store.read().photoVideos[0].height],[1024,1024]);await f.finish();
  assert.equal((await f.request('/jobs/original/video',{requestId:'workflow-second-0002',mode:'custom',prompt:'Slow camera movement.',aspectRatio:'16:9',duration:5})).status,202);
  await f.photoVideos.tick();graph=f.submitted.at(-1).prompt;assert.equal(graph.sampler.inputs.sampler_name,'res_multistep');assert.equal(graph.schedule.inputs.scheduler,'normal');assert.equal(graph.schedule.inputs.steps,10);assert.equal(graph.resolution.inputs.megapixels,1.2);
  assert.deepEqual([f.store.read().photoVideos[0].width,f.store.read().photoVideos[0].height],[1120,1120]);
});

test('admin chooses another editable workflow and receives its real parameters without overwriting prompts or models',async t=> {
  const f=await videoFixture();t.after(()=>f.close());const ui=videoUiTemplate(),file='PhotoCreate/custom-H3.json';
  edit(ui,'resolution',['1:1 (Square)',1.5,32]);f.control.workflows.set('workflows/'+file,ui);
  const list=await f.request('/photo-videos/workflows');assert.ok(list.data.includes(file));
  const previous=f.photoVideos.settings();assert.equal((await f.request('/photo-videos/workflow',{workflowPath:file},'PATCH')).status,200);
  const result=await f.request('/photo-videos/workflow');assert.equal(result.data.megapixels,1.5);assert.equal(result.data.resolvedPath,file);
  const {models,workflowPath,...preferences}=previous;preferences.defaultDuration=7;await f.request('/photo-videos/settings',preferences,'PUT');
  assert.equal(f.photoVideos.settings().workflowPath,file);assert.deepEqual(f.photoVideos.settings().models,models);
  assert.equal((await f.request('/photo-videos/workflow',{workflowPath:'../outside.json'},'PATCH')).status,400);
  assert.equal((await f.request('/photo-videos/workflow',{workflowPath:'other.api.json'},'PATCH')).status,400);
  edit(ui,'resolution',['1:1 (Square)',0,32]);assert.equal((await f.request('/photo-videos/workflow')).status,400);
  const downloadable=await f.request('/photo-videos/workflow/file');assert.ok(Array.isArray(downloadable.data.nodes));
});

test('legacy official text migrates to English without touching custom text, models or completed video snapshots',async t=> {
  const f=await videoFixture();t.after(()=>f.close());
  f.store.mutate(state=>{state.videoPromptLibraryVersion=0;state.presets=state.presets.filter(row=>row.category!=='video');state.settings.photoVideo.prompts=[{id:'natural',name:'自然演繹',prompt:LEGACY_VIDEO_PROMPT},{id:'mine',name:'My custom text',prompt:'Keep my own instruction.'}];});
  await f.restart();assert.equal(f.photoVideos.settings().prompts[0].prompt,DEFAULT_VIDEO_PROMPT);assert.equal(f.photoVideos.settings().prompts[1].prompt,'Keep my own instruction.');
});
