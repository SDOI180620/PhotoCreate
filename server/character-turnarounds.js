import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import express from 'express';
import multer from 'multer';
import {characterProfile} from '../shared/character-profile.js';
import {characterTurnaroundPrompt,characterTurnaroundNegative} from '../shared/character-turnaround.js';
import {getOutputSize} from '../shared/domain.js';
import {createStageRunner} from './stage-runner.js';
import {validateTemplate} from './workflow.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE=['queued','running','submitting','stopping','uncertain'];
const MAX_IMAGE=25*1024*1024;
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const validId=id=>{if(typeof id!=='string' || !UUID.test(id)) throw fail('三視圖識別碼無效。');return id.toLowerCase();};
const localUrl=base=>['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname);

export function turnaroundImageType(buffer) {
  if(!Buffer.isBuffer(buffer) || !buffer.length || buffer.length>MAX_IMAGE) throw fail('角色圖片最多 25 MB，請選擇有效的 PNG、JPG 或 WebP 圖片。');
  if(buffer.length>=24 && buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return {mime:'image/png',ext:'.png'};
  if(buffer.length>=12 && buffer[0]===255 && buffer[1]===216 && buffer[2]===255) return {mime:'image/jpeg',ext:'.jpg'};
  if(buffer.length>=12 && buffer.toString('ascii',0,4)==='RIFF' && buffer.toString('ascii',8,12)==='WEBP') return {mime:'image/webp',ext:'.webp'};
  throw fail('只支援有效的 PNG、JPG 或 WebP 圖片。');
}

// Both caches are exclusive UUID namespaces. Check their full trees and links
// before removal, including the ComfyUI namespace that can receive late results.
export function removeTurnaroundDirectory(rootDir,segments) {
  if(!rootDir) return;
  const root=path.resolve(rootDir),target=path.resolve(root,...segments);
  validId(segments.at(-1));
  if(![1,3].includes(segments.length) || segments.length===3 && (segments[0]!=='PhotoCreate' || segments[1]!=='_character_turnarounds') || path.relative(root,target)!==path.join(...segments)) throw fail('三視圖暫存目錄無效。');
  if(!fs.existsSync(root)) return;
  const realRoot=fs.realpathSync(root);
  for(let i=1;i<=segments.length;i++) {
    const directory=path.join(root,...segments.slice(0,i)),stat=fs.lstatSync(directory,{throwIfNoEntry:false});
    if(!stat) return;
    if(stat.isSymbolicLink() || !stat.isDirectory() || path.relative(realRoot,fs.realpathSync(directory))!==path.relative(root,directory)) throw fail('三視圖暫存含有連結，無法安全清理。');
  }
  const check=directory=>{
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
      const file=path.join(directory,entry.name),stat=fs.lstatSync(file);
      if(stat.isSymbolicLink()) throw fail('三視圖暫存含有連結，無法安全清理。');
      if(stat.isDirectory()) check(file);
    }
  };
  check(target);fs.rmSync(target,{recursive:true});
}

async function imageBytes(response) {
  if(Number(response.headers.get('content-length'))>MAX_IMAGE) throw fail('三視圖超過 25 MB，請降低參考解析度後重試。');
  const reader=response.body.getReader(),chunks=[];let total=0;
  try {
    while(true) {const {done,value}=await reader.read();if(done) break;total+=value.length;if(total>MAX_IMAGE) {await reader.cancel();throw fail('三視圖超過 25 MB，請降低參考解析度後重試。');}chunks.push(Buffer.from(value));}
  } finally {reader.releaseLock();}
  return Buffer.concat(chunks,total);
}

export function createCharacterTurnarounds({dataDir,store,outputDir,comfyJson,comfyAt,isInstalling=()=>false,clock=Date.now,sessionTtl=600000,cleanupGrace=60000}) {
  const cacheRoot=path.resolve(dataDir,'character-turnarounds'),journalFile=path.join(dataDir,'character-turnarounds.json'),sessions=new Map();
  const memory={jobs:[],pipelineRuns:[]};let closed=false,busy=false,timer;
  const cacheDirectory=(id,create=false)=>{
    const realData=fs.realpathSync(dataDir);
    for(const relative of ['character-turnarounds',path.join('character-turnarounds',id)]) {
      const directory=path.join(dataDir,relative);let stat=fs.lstatSync(directory,{throwIfNoEntry:false});
      if(!stat && create) {fs.mkdirSync(directory);stat=fs.lstatSync(directory);}
      if(!stat) break;
      if(stat.isSymbolicLink() || !stat.isDirectory() || path.relative(realData,fs.realpathSync(directory))!==relative) throw fail('三視圖暫存含有連結，無法安全存取。');
    }
    return path.join(cacheRoot,id);
  };
  const persist=()=>{
    if(closed) return;
    const records=[...sessions.values()].map(({id,owner,createdAt,closedAt,comfyUrl,outputRoot,promptIds,lastPromptAt})=>({id,owner,createdAt,closedAt,comfyUrl,outputRoot,promptIds,lastPromptAt}));
    fs.writeFileSync(journalFile+'.tmp',JSON.stringify({version:1,sessions:records}));fs.renameSync(journalFile+'.tmp',journalFile);
  };
  if(fs.existsSync(journalFile)) {
    const journal=JSON.parse(fs.readFileSync(journalFile,'utf8'));
    if(journal.version!==1 || !Array.isArray(journal.sessions)) throw fail('三視圖清理紀錄無效。');
    for(const row of journal.sessions) {
      const id=validId(row.id);
      if(typeof row.owner!=='string' || !Array.isArray(row.promptIds) || row.promptIds.some(id=>!UUID.test(id))) throw fail('三視圖清理紀錄無效。');
      sessions.set(id,{...row,id,closedAt:clock(),touchedAt:clock()});
    }
  }
  const sessionFor=(id,owner,touch=true)=>{
    const session=sessions.get(validId(id));
    if(!session || session.owner!==owner) throw fail('找不到這張三視圖。',404);
    if(closed || session.closedAt) throw fail('三視圖預覽已結束，請重新轉圖。',410);
    if(touch) session.touchedAt=clock();return session;
  };
  const memoryStore={read:(select=value=>value)=>structuredClone(select(memory)),mutate:callback=>{
    const next=structuredClone(memory),result=callback(next);Object.assign(memory,next);
    for(const job of memory.jobs) if(job.promptId) {
      const session=sessions.get(job.id);if(session && !session.promptIds.includes(job.promptId)) {session.promptIds.push(job.promptId);session.lastPromptAt=clock();}
    }
    persist();return result;
  },close:()=>{}};
  const cancel=async session=>{
    for(const id of session.promptIds) {
      const response=await comfyJson(`/api/jobs/${encodeURIComponent(id)}/cancel`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'},session.comfyUrl);
      if(typeof response.cancelled!=='boolean') throw fail('正在確認三視圖任務已取消。');
    }
  };
  const runner=createStageRunner({store:memoryStore,comfyAt,
    comfyJson:async(endpoint,options,base)=>{
      const result=await comfyJson(endpoint,options,base);
      if(endpoint==='/prompt' && result.prompt_id!==JSON.parse(options.body).prompt_id) throw fail('三視圖送出回應待確認，正在同步。');
      return result;
    },
    uploadReference:async(asset,base)=>{
      const session=sessions.get(asset.id);if(!session || session.closedAt || !session.source) throw fail('三視圖預覽已結束。',410);
      const form=new FormData();form.append('image',new Blob([session.source],{type:session.sourceType.mime}),`${session.id}${session.sourceType.ext}`);form.append('type','input');form.append('subfolder','PhotoCreate/character-turnarounds');
      const result=await comfyJson('/upload/image',{method:'POST',body:form},base);
      if(typeof result.name!=='string' || !result.name || /[\\/:\0]/.test(result.name)) throw fail('角色參考圖上傳失敗。');
      session.source=null;return result.subfolder ? `${result.subfolder}/${result.name}` : result.name;
    },onCompleted:()=>{},onStop:job=>cancel(sessions.get(job.id)),
    preparePrompt:(prompt,job)=>{for(const node of Object.values(prompt)) if(node.class_type==='SaveImage') node.inputs.filename_prefix=`PhotoCreate/_character_turnarounds/${job.id}/sheet`;return prompt;},
  });
  const view=session=>{
    const job=memory.jobs.find(row=>row.id===session.id),status=session.result ? 'completed' : session.resultError ? 'failed' : job?.status==='completed' ? 'downloading' : job?.status || 'queued';
    const prefix=session.owner==='admin' ? '/api' : '/api/studio';
    return {id:session.id,status,profile:session.profile,prompt:session.prompt,negative:session.negative,image:session.result ? `${prefix}/character-turnarounds/${session.id}/image` : null,
      error:session.resultError || (job?.error ? session.owner==='admin' ? job.error : '轉圖暫時未完成，請確認攝影棚連線後再試。' : '')};
  };
  function start(id,file,input,owner,{characterPromptSettings,generationSettings}={}) {
    id=validId(id);const profile=characterProfile(input),sourceType=turnaroundImageType(file?.buffer);
    const hash=createHash('sha256').update(file.buffer).update(JSON.stringify(profile)).digest('hex'),existing=sessions.get(id);
    if(existing) {sessionFor(id,owner);if(existing.hash!==hash) throw fail('這個轉圖請求已用於另一張圖片或資料。',409);return view(existing);}
    if(closed) throw fail('三視圖服務已關閉。',410);
    if([...sessions.values()].filter(row=>!row.closedAt).length>=100 || [...sessions.values()].filter(row=>!row.closedAt && row.owner===owner).length>=50) throw fail('待確認的三視圖過多，請先確認或關閉部分圖片。',409);
    if([...sessions.values()].reduce((sum,row)=>sum+(row.source?.length || 0),file.buffer.length)>150*1024*1024) throw fail('待轉圖的角色圖片超過 150 MB，請先等部分轉圖完成。',409);
    const snapshot=store.read();if(isInstalling() || !snapshot.workflow) throw fail('請先完成環境設定並載入圖轉圖工作流。',503);validateTemplate(snapshot.workflow);
    const saved=generationSettings || snapshot.draft || {},resolution=[1024,1536,2048].includes(Number(saved.resolution)) ? Number(saved.resolution) : 1536,steps=Number.isInteger(Number(saved.steps)) && Number(saved.steps)>=1 && Number(saved.steps)<=100 ? Number(saved.steps) : 40;
    const directory=outputDir(),outputRoot=localUrl(snapshot.settings.comfyUrl) && directory && fs.statSync(directory,{throwIfNoEntry:false})?.isDirectory() ? path.resolve(directory) : undefined;
    const promptSettings=characterPromptSettings || snapshot.settings.characterPrompts,prompt=characterTurnaroundPrompt(profile,promptSettings),negative=characterTurnaroundNegative(promptSettings);
    const session={id,owner,hash,profile,prompt,negative,source:file.buffer,sourceType,createdAt:clock(),touchedAt:clock(),comfyUrl:snapshot.settings.comfyUrl,outputRoot,promptIds:[]};
    const job={id,jobKind:'character-turnaround',character:{id,...profile},prompt,negative,seed:Math.floor(Math.random()*2**48),resolution,steps,aspectRatio:'16:9',outputWidth:getOutputSize('16:9',resolution).width,outputHeight:getOutputSize('16:9',resolution).height,cameraEnabled:false,executionMode:'staged',status:'draft',images:[],createdAt:new Date(clock()).toISOString()};
    sessions.set(id,session);memory.jobs.push(job);persist();
    runner.start([id],{...snapshot,settings:{...snapshot.settings,releaseGpuMemory:false}}).catch(error=>{if(!closed) memoryStore.mutate(state=>{const current=state.jobs.find(row=>row.id===id);if(current && !current.stopRequestedAt) Object.assign(current,{status:'failed',error:error.message});});});
    return view(session);
  }
  const cleanFiles=session=>{cacheDirectory(session.id);removeTurnaroundDirectory(cacheRoot,[session.id]);removeTurnaroundDirectory(session.outputRoot,['PhotoCreate','_character_turnarounds',session.id]);};
  function discard(id,owner) {
    id=validId(id);let session=sessions.get(id);
    if(session && session.owner!==owner) throw fail('找不到這張三視圖。',404);
    if(!session) {session={id,owner,createdAt:clock(),promptIds:[]};sessions.set(id,session);}
    session.closedAt ||= clock();session.source=null;
    const job=memory.jobs.find(row=>row.id===id);if(job) {job.stopRequestedAt ||= new Date(clock()).toISOString();job.status='stopped';}
    for(const run of memory.pipelineRuns.filter(row=>row.jobIds.includes(id))) run.status='paused';
    persist();try {cleanFiles(session);} catch(error) {session.cleanupError=error.message;}
    if(!closed) tick().catch(()=>{});return {closed:true};
  }
  async function tick() {
    if(closed || busy) return;busy=true;
    try {
      await runner.tick();
      for(const session of [...sessions.values()]) {
        if(!session.closedAt && clock()-session.touchedAt>sessionTtl) discard(session.id,session.owner);
        const job=memory.jobs.find(row=>row.id===session.id);
        if(!session.closedAt && job?.status==='completed' && !session.result && !session.resultError) {
          try {
            const image=job.images?.[0];
            if(!image || /[\\/:\0]/.test(image.filename || '') || image.type!=='output' || String(image.subfolder || '').replaceAll('\\','/')!==`PhotoCreate/_character_turnarounds/${session.id}` || !image.filename.startsWith('sheet_')) throw fail('三視圖輸出不正確，請重新轉圖。');
            const response=await comfyAt(session.comfyUrl,`/view?${new URLSearchParams({filename:image.filename,subfolder:image.subfolder,type:'output'})}`),buffer=await imageBytes(response),type=turnaroundImageType(buffer);
            if(closed || session.closedAt) continue;
            const file=path.join(cacheDirectory(session.id,true),'result'+type.ext);
            if(fs.lstatSync(file,{throwIfNoEntry:false})?.isSymbolicLink()) throw fail('三視圖暫存含有連結，無法安全存取。');
            fs.writeFileSync(file,buffer);session.result={file,mime:type.mime};session.source=null;
          } catch(error) {session.resultError=session.owner==='admin' ? error.message : '無法取得三視圖，請重新轉圖或沿用原圖。';}
        }
        if(session.closedAt) {
          try {
            cleanFiles(session);await cancel(session);
            const queue=session.promptIds.length ? await comfyJson('/queue',{},session.comfyUrl) : {queue_running:[],queue_pending:[]};
            const absent=![...(queue.queue_running || []),...(queue.queue_pending || [])].some(row=>session.promptIds.includes(row[1]));
            cleanFiles(session);session.cancelSettled=absent && !runner.processing(session.id);delete session.cleanupError;
            if(session.cancelSettled && clock()-Math.max(session.closedAt,session.lastPromptAt || 0)>cleanupGrace) {
              memory.jobs=memory.jobs.filter(row=>row.id!==session.id);memory.pipelineRuns=memory.pipelineRuns.filter(row=>!row.jobIds.includes(session.id));sessions.delete(session.id);persist();
            }
          } catch(error) {session.cleanupError=error.message;}
        }
      }
    } finally {busy=false;}
  }
  function image(id,owner) {
    const session=sessionFor(id,owner),result=session.result;cacheDirectory(session.id);
    if(!result || !fs.existsSync(result.file)) throw fail('三視圖尚未完成或已清除。',404);
    if(fs.lstatSync(result.file).isSymbolicLink()) throw fail('三視圖暫存含有連結，無法安全存取。');
    return result;
  }
  function close() {if(closed) return;for(const session of sessions.values()) if(!session.closedAt) discard(session.id,session.owner);persist();closed=true;clearInterval(timer);memoryStore.close();}
  timer=setInterval(()=>{tick().catch(()=>{});},1500);timer.unref();tick().catch(()=>{});
  return {start,discard,image,tick,close,status:async(id,owner)=>{const session=sessionFor(id,owner);await tick();return view(session);},hasWork:()=>memory.jobs.some(row=>ACTIVE.includes(row.status)) || [...sessions.values()].some(row=>row.closedAt && row.promptIds.length && !row.cancelSettled)};
}

export function characterTurnaroundRouter(getManager,owner,settingsFor=()=>({})) {
  const router=express.Router(),upload=multer({storage:multer.memoryStorage(),limits:{fileSize:MAX_IMAGE,files:1,fields:3,parts:4,fieldSize:20000}}).single('image');
  router.use((req,res,next)=>{res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});next();});
  router.put('/:id',(req,res,next)=>{if(Number(req.headers['content-length'])>MAX_IMAGE+1024*1024) return next(fail('角色圖片最多 25 MB。',413));next();},upload,(req,res)=>{
    let profile={};if(req.body.profile!==undefined) {try {profile=JSON.parse(req.body.profile);} catch {throw fail('角色資料格式不正確。');}}
    res.status(202).json(getManager().start(req.params.id,req.file,profile,owner(req),settingsFor(req)));
  });
  router.get('/:id',async(req,res)=>res.json(await getManager().status(req.params.id,owner(req))));
  router.get('/:id/image',(req,res)=>{const result=getManager().image(req.params.id,owner(req));res.type(result.mime).sendFile(result.file);});
  router.delete('/:id',(req,res)=>res.json(getManager().discard(req.params.id,owner(req))));
  return router;
}
