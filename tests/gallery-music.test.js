import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createGalleryMusic} from '../server/gallery-music.js';
import {DEFAULT_PIANO_CAPTION} from '../shared/gallery-music.js';
import {previewFixture} from './preset-preview-fixture.js';
import {adminFetch,login} from './auth-client.js';
import {testWav} from './gallery-music-fixture.js';

function fixture(t) {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-music-')),pending=new Set(),history=new Map(),prompts=[];
  const control={busy:false,lost:false,nodes:true,foreign:false,historyGate:null};
  const comfyJson=async(route,options={})=>{
    if(route==='/object_info') return control.nodes ? {MiniMaxMusic3Generate:{},SaveAudioMP3:{}} : {};
    if(route==='/queue') return {queue_running:[],queue_pending:[...pending,...(control.foreign ? ['foreign'] : [])].map(id=>[0,id])};
    if(route==='/prompt') {const receipt=JSON.parse(options.body);prompts.push(receipt);pending.add(receipt.prompt_id);if(control.lost) throw new Error('lost receipt');return {prompt_id:receipt.prompt_id};}
    if(route.startsWith('/api/jobs/') && route.endsWith('/cancel')) return {cancelled:pending.delete(route.split('/')[3])};
    if(route.startsWith('/history/')) {if(control.historyGate) await control.historyGate;const id=route.split('/').at(-1);return history.has(id) ? {[id]:history.get(id)} : {};}
    throw new Error('Unexpected call: '+route);
  };
  const options={dataDir,comfyUrl:()=> 'http://127.0.0.1:8188',comfyJson,comfyAt:async()=>new Response(testWav()),isBusy:()=>control.busy,pollMs:100000};
  let music=createGalleryMusic(options);
  t.after(()=>{music.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  const complete=(id,folder=`PhotoCreate/_gallery_music/${id}`)=>{pending.delete(id);history.set(id,{status:{completed:true,status_str:'success'},outputs:{'2':{audio:[{filename:'music_00001_.wav',subfolder:folder,type:'output'}]}}});};
  return {music,control,complete,dataDir,prompts,reopen:()=>{music.close();music=createGalleryMusic(options);return music;}};
}
test('音樂產生保留同一請求，遺失回應後同步完成而不重送，檔案與公開選單重啟後保留',async t=>{
  const f=fixture(t),id=randomUUID(),input={name:'柔和鋼琴',kind:'piano',caption:DEFAULT_PIANO_CAPTION,durationCap:90};
  f.control.lost=true;
  assert.equal((await f.music.generate(id,input)).status,'uncertain');
  assert.equal((await f.music.generate(id,input)).id,id);assert.equal(f.prompts.length,1);
  assert.equal(f.prompts[0].prompt['1'].inputs.lyrics,'[Intro]\n[Instrumental]\n[Solo]\n[Instrumental]\n[Outro]');assert.equal(f.prompts[0].prompt['1'].inputs.release_gpu_after_generate,true);
  assert.equal(f.prompts[0].prompt['2'].inputs.filename_prefix,`PhotoCreate/_gallery_music/${id}/music`);
  assert.deepEqual(f.music.list(true),[]);
  f.complete(id,`PhotoCreate\\_gallery_music\\${id}`);await f.music.sync();assert.equal(f.music.list()[0].status,'completed');
  assert.deepEqual(fs.readFileSync(f.music.audio(id)),testWav());
  assert.deepEqual(f.music.list(true),[],'Generated music is private until reviewed and enabled');f.music.update(id,{enabled:true});
  const publicTrack=f.music.list(true)[0];assert.deepEqual(Object.keys(publicTrack).sort(),['audio','id','kind','name']);
  const reopened=f.reopen();assert.deepEqual(reopened.list(true),[publicTrack]);
  reopened.update(id,{enabled:false});assert.deepEqual(reopened.list(true),[]);assert.throws(()=>reopened.audio(id,true),/找不到/);
  reopened.update(id,{enabled:true});const file=reopened.audio(id);reopened.remove(id);assert.equal(fs.existsSync(file),false);assert.deepEqual(reopened.list(true),[]);
});
test('音樂生成檢查共用製作工作、節點、上游排程及輸出路徑；不打斷其他任務',async t=>{
  const f=fixture(t),input={name:'piano',kind:'piano'};
  for(const key of ['busy','foreign']) {f.control[key]=true;await assert.rejects(f.music.generate(randomUUID(),input),{status:409});f.control[key]=false;}
  f.control.nodes=false;await assert.rejects(f.music.generate(randomUUID(),input),{status:503});f.control.nodes=true;
  for(const extra of [{durationCap:0},{durationCap:361},{caption:''},{kind:'rain'}]) await assert.rejects(f.music.generate(randomUUID(),{...input,...extra}),{status:400});
  assert.equal(f.prompts.length,0);
  const id=randomUUID();await f.music.generate(id,input);assert.throws(()=>f.music.remove(id),{status:409});
  f.complete(id,'PhotoCreate/another-owner');await f.music.sync();assert.equal(f.music.list()[0].status,'queued');assert.match(f.music.list()[0].error,/位置無效/);assert.deepEqual(f.music.list(true),[]);
  assert.equal((await f.music.cancel(id)).status,'stopped');assert.equal(f.music.hasWork(),false);f.music.remove(id);assert.deepEqual(f.music.list(),[]);
});
test('音樂匯入與播放需登入；顧客只見開放曲目，支援範圍播放且不能修改資料库',async t=>{
  const f=await previewFixture();t.after(f.close);
  const row=f.galleryMusic.upload({buffer:testWav()},{name:'雨聲',kind:'rain'});
  const hidden=f.galleryMusic.upload({buffer:testWav()},{name:'hidden',kind:'violin'});f.galleryMusic.update(hidden.id,{enabled:false});
  await f.authentication.createCustomer({username:'music-customer',password:'test-password'});
  const session=await login(f.base,'music-customer','test-password'),headers={Cookie:session.cookie};
  assert.equal((await fetch(f.base+'/api/studio/music')).status,401);
  assert.equal((await fetch(f.base+row.audio)).status,401);
  const result=await fetch(f.base+'/api/studio/music',{headers});assert.equal(result.status,200);assert.equal((await result.json()).length,1);
  const state=await fetch(f.base+'/api/studio/state',{headers});assert.equal((await state.json()).music[0].name,'雨聲');
  const media=await fetch(`${f.base}/api/studio/music/${row.id}/audio`,{headers:{...headers,Range:'bytes=0-43'}});assert.equal(media.status,206);assert.deepEqual(Buffer.from(await media.arrayBuffer()),testWav().subarray(0,44));
  assert.equal((await fetch(`${f.base}/api/studio/music/${hidden.id}/audio`,{headers})).status,404);
  assert.equal((await fetch(`${f.base}/api/music/${row.id}`,{method:'DELETE',headers})).status,403);
  const form=new FormData();form.append('audio',new Blob([testWav()],{type:'audio/wav'}),'piano.wav');form.append('name','鋼琴');form.append('kind','piano');
  assert.equal((await adminFetch(f.base+'/api/music/upload',{method:'POST',body:form})).status,201);
  assert.equal((await adminFetch(`${f.base}/api/music/${row.id}`,{method:'DELETE'})).status,200);
  assert.equal((await fetch(`${f.base}/api/studio/music/${row.id}/audio`,{headers})).status,404);
});

test('取消音樂時已在查詢的遲到成果不會重新發布或阻擋後續拍攝',async t=>{
  const f=fixture(t),id=randomUUID();await f.music.generate(id,{name:'取消中的音樂',kind:'piano'});
  let release;f.control.historyGate=new Promise(resolve=>{release=resolve;});const syncing=f.music.sync();
  assert.equal((await f.music.cancel(id)).status,'stopped');f.complete(id);release();await syncing;
  assert.equal(f.music.list()[0].status,'stopped');assert.equal(f.music.hasWork(),false);assert.deepEqual(f.music.list(true),[]);assert.equal(fs.readdirSync(path.join(f.dataDir,'gallery-music')).length,0);
});
