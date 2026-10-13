import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import sharp from 'sharp';
import path from 'node:path';
import {defaultVideoSettings,DEFAULT_VIDEO_PROMPT,VIDEO_DURATIONS} from '../shared/photo-video.js';
import {buildVideoPrompt,videoAvailability,videoSize} from '../server/video-workflow.js';
import {videoFixture,videoObjectInfo,MP4} from './photo-video-fixture.js';
import {adminFetch} from './auth-client.js';
import {restoreBackup} from '../server/backups.js';
import {createApp} from '../server/index.js';

const request=(id='video-request-001',extra={})=>({requestId:id,imageIndex:1,duration:5,mode:'official',presetId:'natural',...extra});
async function fixture(t) {const f=await videoFixture();t.after(()=>f.close());return f;}

test('H3 keeps the reference ratio and rounds model frames up while trimming video and audio to 5/7/10 seconds',()=>{
  for(const duration of VIDEO_DURATIONS) {
    const graph=buildVideoPrompt({id:'video-duration-test',prompt:DEFAULT_VIDEO_PROMPT,duration,image:'selected-version.png',width:640,height:1152,seed:123});
    assert.equal(graph.encode.inputs.width,640);assert.equal(graph.encode.inputs.height,1152);assert.equal(graph.source.inputs.image,'selected-version.png');
    assert.equal(graph.encode.inputs.length%17,5);assert.ok(graph.encode.inputs.length>=duration*24);
    assert.equal(graph.trim_frames.inputs.length,duration*24);assert.equal(graph.trim_audio.inputs.duration,duration);assert.equal(graph.combine.inputs.fps,24);
    assert.equal(graph.save.inputs.format,'mp4');assert.equal(graph.save.inputs['format.codec'],'h264');assert.equal(graph.schedule.inputs.steps,8);
    assert.equal(graph.encode.inputs.last_frame,undefined);assert.equal(graph.sparse.inputs.selection,'vsa');
  }
  const info=videoObjectInfo();delete info.MiniMaxH3ImageToVideo;info.UNETLoader.input.required.unet_name=[['qwen-image.safetensors']];
  const result=videoAvailability(info);assert.equal(result.ready,false);assert.ok(result.missingNodes.includes('MiniMaxH3ImageToVideo'));assert.equal(result.choices.unet.length,0);
});

test('admin video settings persist, publish official prompts/default duration and reject invalid settings',async t=>{
  const f=await fixture(t);assert.deepEqual((await f.request('/photo-videos/settings')).data,{...defaultVideoSettings(),effectiveModels:defaultVideoSettings().models});
  const config={...defaultVideoSettings(),defaultDuration:7,prompts:[{id:'natural',name:'自然動作',prompt:'沿用人物外貌，自然轉頭。'},{id:'breeze',name:'微風',prompt:'衣角隨微風擺動。'}]};
  assert.equal((await f.request('/photo-videos/settings',config,'PUT')).status,200);
  await f.request('/photo-videos/selection',{selectedPromptIds:config.prompts.map(row=>row.id)},'PATCH');await f.request('/photo-videos/publish',{});config.selectedPromptIds=config.prompts.map(row=>row.id);
  for(const changed of [{...config,defaultDuration:6},{...config,prompts:[]},{...config,prompts:[config.prompts[0],config.prompts[0]]}]) assert.equal((await f.request('/photo-videos/settings',changed,'PUT')).status,400);
  await f.restart();assert.deepEqual((await f.request('/photo-videos/settings')).data,{...config,effectiveModels:config.models});
  const alice=await f.customer('settings'),state=(await alice.request('/state')).data;
  assert.equal(state.photoVideo,1);assert.equal(state.videoSettings.defaultDuration,7);assert.deepEqual(state.videoSettings.prompts,config.prompts);assert.equal(state.videoSettings.models,undefined);
  const response=await fetch(f.base+'/api/photo-videos/settings',{method:'PUT',headers:{Cookie:alice.cookie,'content-type':'application/json'},body:JSON.stringify(config)});assert.equal(response.status,403);
});

test('video generation uses exactly the selected photo output, snapshots official text and serves a saved MP4 with byte ranges',async t=>{
  const f=await fixture(t),source=structuredClone(f.store.read().jobs[0]),created=await f.request('/jobs/original/video',request());assert.equal(created.status,202);
  const id=created.data.video.id;
  assert.equal((await f.request('/jobs/original/video',request())).data.video.id,id);
  assert.equal((await f.request('/jobs/original/video',request('video-request-001',{imageIndex:0}))).status,409);
  assert.equal((await f.request('/jobs/original/video',request('video-request-002'))).status,409);
  f.store.mutate(state=>{state.presets.find(row=>row.category==='video').prompt='新的官方提詞';});
  await f.photoVideos.tick();assert.equal(f.submitted.length,1);
  assert.equal(f.submitted[0].prompt.encode.inputs.prompt,DEFAULT_VIDEO_PROMPT);
  assert.ok(f.calls.some(call=>new URL(call.url).searchParams.get('filename')==='second.png'));
  assert.equal(f.submitted[0].prompt.encode.inputs.width,f.submitted[0].prompt.encode.inputs.height);
  const raw=await f.finish(),row=f.photoVideos.list('admin')[0];assert.equal(row.status,'completed');assert.deepEqual(f.store.read().jobs[0],source);
  const response=await adminFetch(f.base+row.video,{headers:{Range:'bytes=0-11'}});assert.equal(response.status,206);assert.match(response.headers.get('content-type'),/video\/mp4/);assert.deepEqual(Buffer.from(await response.arrayBuffer()),MP4.subarray(0,12));
  const uploaded=path.join(f.dataDir,'input','PhotoCreate','_videos',id,'source.png');assert.equal(fs.existsSync(uploaded),false);
  assert.equal(fs.existsSync(raw),true);assert.equal(fs.existsSync(path.join(f.dataDir,'photo-videos',id+'.mp4')),true);
});

test('customers only generate/read/cancel/delete their own clips and explicitly select their video for favorites',async t=>{
  const f=await fixture(t),alice=await f.customer('alice'),bob=await f.customer('bob');f.store.mutate(state=>{state.jobs[0].visitorId=alice.ownerId;state.workflow=null;state.customerRecipe=null;});
  assert.equal((await bob.request('/jobs/original/video',request())).status,404);assert.equal((await f.request('/jobs/original/video',request())).status,404);
  assert.equal((await alice.request('/gallery',{jobId:'original',imageIndex:1})).status,201);
  const created=await alice.request('/jobs/original/video',request());assert.equal(created.status,202);const id=created.data.video.id;
  assert.equal((await bob.request(`/photo-videos/${id}/stop`,{})).status,404);assert.equal((await bob.request(`/photo-videos/${id}`,undefined,'DELETE')).status,404);
  await f.photoVideos.tick();await f.finish();
  await alice.request('/gallery',{jobId:'original',imageIndex:1,mediaType:'video',videoId:id});
  const state=(await alice.request('/state')).data,entry=state.gallery.find(row=>row.videoId===id);assert.match(entry.video,new RegExp(id));assert.equal(entry.videoDuration,5);assert.equal(state.jobs[0].videos[0].id,id);
  assert.equal((await bob.request('/state')).data.videos.length,0);assert.equal((await f.request('/state')).data.videos.length,0);assert.equal((await f.request('/state')).data.photoVideos,undefined);
  const foreign=await fetch(f.base+entry.video,{headers:{Cookie:bob.cookie}});assert.equal(foreign.status,404);
  assert.equal((await alice.request('/gallery/remove',{ids:[entry.id]})).status,200);assert.equal(fs.existsSync(path.join(f.dataDir,'photo-videos',id+'.mp4')),true);
  assert.equal((await alice.request(`/photo-videos/${id}`,undefined,'DELETE')).status,200);assert.equal(fs.existsSync(path.join(f.dataDir,'photo-videos',id+'.mp4')),false);assert.equal(f.store.read().jobs[0].images.length,2);
});

test('permanent photo deletion cleans managed videos, raw ComfyUI files, all video rows and featured entries',async t=>{
  const f=await fixture(t),alice=await f.customer('purge');f.store.mutate(state=>{state.jobs[0].visitorId=alice.ownerId;});
  await alice.request('/gallery',{jobId:'original',imageIndex:1});
  const created=await alice.request('/jobs/original/video',request());await f.photoVideos.tick();const raw=await f.finish(),id=created.data.video.id;
  const response=await alice.request('/jobs/original',{permanent:true},'DELETE');assert.equal(response.status,200);assert.ok(response.data.deletedFiles>=4);
  assert.equal(fs.existsSync(raw),false);assert.equal(fs.existsSync(path.join(f.dataDir,'photo-videos',id+'.mp4')),false);assert.equal(fs.existsSync(path.join(f.outputDir,'PhotoCreate','first.png')),false);
  assert.equal(f.store.read().photoVideos.length,0);assert.equal(f.store.read().galleryEntries.length,0);assert.equal(f.store.read().jobs.length,0);
});

test('active videos block source deletion; stopping cancels only the owned prompt and then permits cleanup',async t=>{
  const f=await fixture(t),created=await f.request('/jobs/original/video',request());await f.photoVideos.tick();const own=f.submitted[0].prompt_id;
  f.pending.add('foreign-running-job');assert.equal((await f.request('/jobs/outputs/delete',{ids:['original']})).status,409);assert.equal(fs.existsSync(path.join(f.outputDir,'PhotoCreate','first.png')),true);
  const stopped=await f.request(`/photo-videos/${created.data.video.id}/stop`,{});assert.equal(stopped.data.status,'stopped');assert.deepEqual(f.cancelled,[own]);assert.equal(f.pending.has('foreign-running-job'),true);
  assert.equal((await f.request('/jobs/outputs/delete',{ids:['original']})).status,200);assert.equal(f.store.read().photoVideos.length,0);
});

test('lost prompt replies survive a server restart and reconcile without submitting duplicate video jobs',async t=>{
  const f=await fixture(t),created=await f.request('/jobs/original/video',request());f.control.loseReply=true;await f.photoVideos.tick();assert.equal(f.photoVideos.list('admin')[0].status,'uncertain');
  await f.restart();await f.photoVideos.tick();assert.equal(f.submitted.length,1);
  assert.equal((await f.request('/jobs/original/video',request())).data.video.id,created.data.video.id);await f.finish();assert.equal(f.photoVideos.list('admin')[0].status,'completed');
});

test('shared queues and image jobs delay videos; custom text and valid durations are checked on the server',async t=>{
  const f=await fixture(t);
  for(const body of [request('bad-video-001',{duration:6}),request('bad-video-002',{imageIndex:2}),request('bad-video-003',{mode:'custom',prompt:' '}),request('bad-video-004',{mode:'official',presetId:'missing'}),request('bad-video-005',{imageIndex:'1'})]) assert.ok((await f.request('/jobs/original/video',body)).status>=400);
  assert.equal(f.store.read().photoVideos.length,0);
  const created=await f.request('/jobs/original/video',request('custom-video-001',{mode:'custom',prompt:'慢慢抬頭，鏡頭向前推進。',duration:10}));assert.equal(created.status,202);
  f.pending.add('foreign-prompt');await f.photoVideos.tick();assert.equal(f.submitted.length,0);f.pending.delete('foreign-prompt');
  f.store.mutate(state=>{state.jobs.push({...state.jobs[0],id:'working-photo',status:'running'});});await f.photoVideos.tick();assert.equal(f.submitted.length,0);
  f.store.mutate(state=>{state.jobs.find(row=>row.id==='working-photo').status='stopped';});await f.photoVideos.tick();assert.equal(f.submitted.length,1);assert.equal(f.submitted[0].prompt.encode.inputs.prompt,'慢慢抬頭，鏡頭向前推進。');assert.equal(f.submitted[0].prompt.trim_frames.inputs.length,240);
});

test('archive retries do not regenerate; cancelling a failed download allows cleanup, and foreign output paths are rejected',async t=>{
  const f=await fixture(t),created=await f.request('/jobs/original/video',request());await f.photoVideos.tick();f.control.archiveFails=true;const raw=await f.finish();assert.equal(f.photoVideos.list('admin')[0].status,'archiving');
  await f.photoVideos.tick();assert.equal(f.submitted.length,1);assert.equal((await f.request(`/photo-videos/${created.data.video.id}/stop`,{})).data.status,'stopped');
  assert.equal((await f.request(`/photo-videos/${created.data.video.id}`,undefined,'DELETE')).status,200);assert.equal(fs.existsSync(raw),false);f.control.archiveFails=false;
  const next=await f.request('/jobs/original/video',request('unsafe-video-002'));await f.photoVideos.tick();const promptId=f.submitted.at(-1).prompt_id;f.pending.delete(promptId);
  f.history.set(promptId,{status:{status_str:'success',completed:true},outputs:{save:{images:[{filename:'foreign.mp4',subfolder:'PhotoCreate/other-user',type:'output'}]}}});await f.photoVideos.tick();
  assert.equal(f.photoVideos.list('admin').find(row=>row.id===next.data.video.id).status,'failed');assert.equal(f.store.read().photoVideos.find(row=>row.id===next.data.video.id).output,undefined);
});

test('complete backup and offline restore keep video files, settings and photo associations playable',async t=>{
  const f=await fixture(t),created=await f.request('/jobs/original/video',request());await f.photoVideos.tick();await f.finish();
  const config={...f.photoVideos.settings(),defaultDuration:10};await f.request('/photo-videos/settings',config,'PUT');
  const exported=await f.request('/backups/export',{});assert.equal(exported.status,200);
  const response=await adminFetch(f.base+`/api/backups/${exported.data.token}`);assert.equal(response.status,200);
  const archive=path.join(f.dataDir,'video-backup.zip');fs.writeFileSync(archive,Buffer.from(await response.arrayBuffer()));
  const destination=path.join(f.dataDir,'restored-studio');await restoreBackup({archive,dataDir:destination});
  const restored=createApp({dataDir:destination,fetchImpl:async()=>{throw new Error('Restored playback must not require ComfyUI');},comfyOutputDir:f.outputDir,photoVideoOptions:{intervalMs:0}});
  try {
    const row=restored.photoVideos.list('admin')[0];assert.equal(row.id,created.data.video.id);assert.equal(row.jobId,'original');assert.equal(restored.photoVideos.settings().defaultDuration,10);
    const file=restored.photoVideos.file('admin',row.id);assert.equal(file,path.join(destination,'photo-videos',row.id+'.mp4'));assert.deepEqual(fs.readFileSync(file),MP4);
  } finally {restored.store.close();}
});

test('all new videos preserve source photo ratio even when an older client sends square, horizontal or vertical choices',async t=>{
  const f=await fixture(t);f.control.sourcePng=await sharp({create:{width:900,height:1600,channels:3,background:'#8899aa'}}).png().toBuffer();
  const expected=videoSize(900,1600,'reference');
  for(const aspectRatio of ['1:1','16:9','9:16']) {
    const created=await f.request('/jobs/original/video',request('video-ratio-'+aspectRatio.replace(':','-'),{aspectRatio}));assert.equal(created.status,202);assert.equal(created.data.video.aspectRatio,'reference');await f.photoVideos.tick();
    const graph=f.submitted.at(-1).prompt;assert.equal(graph.encode.inputs.width,expected.width);assert.equal(graph.encode.inputs.height,expected.height);assert.equal(f.store.read().photoVideos[0].width,expected.width);assert.equal(f.store.read().photoVideos[0].height,expected.height);await f.finish();
  }
  assert.equal((await f.request('/jobs/original/video',request('bad-ratio-request',{aspectRatio:'4:3'}))).status,400);
  const config={...f.photoVideos.settings(),defaultAspectRatio:'9:16'};assert.equal((await f.request('/photo-videos/settings',config,'PUT')).data.defaultAspectRatio,'reference');
  await f.restart();assert.equal(f.photoVideos.settings().defaultAspectRatio,'reference');
});
