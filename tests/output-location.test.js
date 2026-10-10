import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server/index.js';
import {purgeJobOutputs} from '../server/outputs.js';
import {adminFetch} from './auth-client.js';
import {PNG} from './fixtures.js';

async function fixture(t) {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-test-output-location-'));
  const comfyOutputDir=path.join(temporary,'current-output');
  const image={filename:'result.png',subfolder:'PhotoCreate\\2026-10-10',type:'output'};
  const picture=path.join(comfyOutputDir,'PhotoCreate','2026-10-10',image.filename);
  fs.mkdirSync(path.dirname(picture),{recursive:true});fs.writeFileSync(picture,PNG);
  const {app,store}=createApp({dataDir:path.join(temporary,'data'),comfyOutputDir});
  const job={id:'old-photo',status:'completed',createdAt:new Date().toISOString(),comfyUrl:store.read().settings.comfyUrl,comfyOutputDir:path.join(temporary,'missing-old-output'),images:[image]};
  store.mutate(state=>state.jobs.push(job));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();fs.rmSync(temporary,{recursive:true,force:true});});
  const remove=async()=>{
    const response=await adminFetch(`http://127.0.0.1:${server.address().port}/api/jobs/outputs/delete`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ids:[job.id]})});
    return {status:response.status,data:await response.json()};
  };
  return {temporary,comfyOutputDir,image,picture,job,store,remove};
}

test('更正本機輸出目錄後，舊成果可刪除實際圖片而不再使用不存在的舊路徑',async t=>{
  const f=await fixture(t),result=await f.remove();
  assert.equal(result.status,200,result.data.error);
  assert.equal(result.data.deletedFiles,1);
  assert.equal(fs.existsSync(f.picture),false);
  assert.deepEqual(f.store.read().jobs.find(job=>job.id===f.job.id).images,[]);
});

test('舊輸出目錄仍存在時，保留目前環境的同名成果',async t=>{
  const f=await fixture(t),oldPicture=path.join(f.job.comfyOutputDir,'PhotoCreate','2026-10-10',f.image.filename);
  fs.mkdirSync(path.dirname(oldPicture),{recursive:true});fs.writeFileSync(oldPicture,PNG);
  const result=await f.remove();assert.equal(result.status,200,result.data.error);
  assert.equal(result.data.deletedFiles,1);assert.equal(fs.existsSync(oldPicture),false);
  assert.deepEqual(fs.readFileSync(f.picture),PNG);
});

test('不同 ComfyUI 連線的失效路徑不能改用目前環境刪除同名成果',async t=>{
  const f=await fixture(t);
  f.store.mutate(state=>state.jobs.find(job=>job.id===f.job.id).comfyUrl='http://127.0.0.1:8199');
  const result=await f.remove();assert.equal(result.status,400);assert.match(result.data.error,/找不到本機 ComfyUI 輸出資料夾/);
  assert.deepEqual(fs.readFileSync(f.picture),PNG);assert.deepEqual(f.store.read().jobs[0].images,[f.image]);
});

test('目前目錄也不存在時，刪除失敗並保留成果紀錄',async t=>{
  const f=await fixture(t);fs.renameSync(f.comfyOutputDir,path.join(f.temporary,'moved-output'));
  const result=await f.remove();assert.equal(result.status,400);assert.match(result.data.error,/找不到本機 ComfyUI 輸出資料夾/);
  assert.deepEqual(f.store.read().jobs[0].images,[f.image]);
});

test('永久刪除也使用更正後的同一主機目錄並清理中間成果',async t=>{
  const f=await fixture(t),intermediate={...f.image,filename:'intermediate.png'};
  const intermediateFile=path.join(path.dirname(f.picture),intermediate.filename);fs.writeFileSync(intermediateFile,PNG);
  const job={...f.job,stageResults:{base:{images:[intermediate]}}};
  assert.equal(purgeJobOutputs({...f.store.read(),jobs:[job]},[job],f.comfyOutputDir),2);
  assert.equal(fs.existsSync(f.picture),false);assert.equal(fs.existsSync(intermediateFile),false);
});
