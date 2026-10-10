import fs from 'node:fs';
import path from 'node:path';
import {randomInt} from 'node:crypto';
import {buildShotPlans,composePrompt,normalizePresetImport,OUTPUT_RATIOS,PRESET_SELECTION_FIELDS} from '../shared/domain.js';
import {DEFAULT_DRAFT} from '../shared/draft.js';
import {productionStatus} from '../shared/production.js';
import {belongsToStudio,operatorState} from './studio-ownership.js';
import {resolveOutputFile} from './outputs.js';
import {createStageRunner} from './stage-runner.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRESET_KEYS = ['pose','expression','clothingState','interaction','camera','lighting','color','quality'];
const ACTIVE = ['queued','running','submitting','stopping','uncertain'];
const fail = (message,status=400) => Object.assign(new Error(message),{status});
const validId = id => {if(!UUID.test(id)) throw fail('臨時試拍識別碼無效。');return id;};
const localUrl = base => {try {return ['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname);} catch {return false;}};

export function relatedPresetPhotos(state,id,{limit=5,offset=0,sample=false}={}) {
  if(!state.presets.some(row=>row.id===id)) throw fail('找不到提詞。',404);
  if(!Number.isInteger(limit) || limit<1 || limit>100 || !Number.isInteger(offset) || offset<0) throw fail('關聯照片分頁無效。');
  const rows=state.jobs.filter(job=>belongsToStudio(job) && job.status==='completed' && !job.outputsDeletedAt && PRESET_KEYS.some(key=>job[key]?.id===id))
    .sort((a,b)=>String(b.finishedAt || b.createdAt).localeCompare(String(a.finishedAt || a.createdAt)) || b.id.localeCompare(a.id))
    .flatMap(job=>(job.images || []).map((image,index)=>({id:`${job.id}:${index}`,jobId:job.id,imageIndex:index,src:`/api/jobs/${encodeURIComponent(job.id)}/image/${index}`,name:job.name || `${job.garment?.name || '照片'} · ${job.pose?.name || ''}`,createdAt:job.finishedAt || job.createdAt,version:job.remakeVersion || 0})));
  if(sample) {
    // A partial shuffle samples without duplicates, without changing history order.
    const count=Math.min(5,limit,rows.length);
    for(let i=0;i<count;i++) {const index=randomInt(i,rows.length);[rows[i],rows[index]]=[rows[index],rows[i]];}
    return {items:rows.slice(0,count),total:rows.length,offset:0,limit:count};
  }
  return {items:rows.slice(offset,offset+limit),total:rows.length,offset,limit};
}

// This directory is exclusively owned by one preview session. Check the exact
// namespace and every link before recursive removal; a junction must never turn
// a preview cleanup into a deletion of another photo or an external directory.
export function removePreviewDirectory(outputDir,id) {
  validId(id);
  if(!outputDir) return;
  const root=path.resolve(outputDir),target=path.resolve(root,'PhotoCreate','_previews',id);
  if(path.relative(root,target)!==path.join('PhotoCreate','_previews',id)) throw fail('臨時圖片目錄無效。');
  if(!fs.statSync(root,{throwIfNoEntry:false})?.isDirectory()) throw fail('找不到臨時圖片的本機輸出目錄。');
  const realRoot=fs.realpathSync(root);
  for(const directory of [path.join(root,'PhotoCreate'),path.join(root,'PhotoCreate','_previews'),target]) {
    const stat=fs.lstatSync(directory,{throwIfNoEntry:false});
    if(!stat) return;
    if(stat.isSymbolicLink() || !stat.isDirectory() || path.relative(realRoot,fs.realpathSync(directory))!==path.relative(root,directory)) throw fail('臨時圖片目錄含有連結，無法安全清理。');
  }
  const checkTree=directory=>{
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
      const file=path.join(directory,entry.name),stat=fs.lstatSync(file);
      if(stat.isSymbolicLink()) throw fail('臨時圖片目錄含有連結，無法安全清理。');
      if(stat.isDirectory()) checkTree(file);
    }
  };
  checkTree(target);
  fs.rmSync(target,{recursive:true});
}

// Jobs and workflows live only in memory. The small durable journal contains
// cancellation IDs and the owned directory, so a restart cleans rather than
// resumes a preview, including requests whose ComfyUI reply was lost.
export function createPresetPreviews({dataDir,store,outputDir,comfyJson,comfyAt,uploadReference,clock=Date.now,sessionTtl=90000,cleanupGrace=60000}) {
  const journalFile=path.join(dataDir,'preset-previews.json'),sessions=new Map();
  const memory={jobs:[],pipelineRuns:[]};
  let closed=false,cleaning=false,timer;
  const persist=()=>{
    const records=[...sessions.values()].map(({id,presetId,createdAt,closedAt,comfyUrl,outputDir,promptIds,lastPromptAt})=>({id,presetId,createdAt,closedAt,comfyUrl,outputDir,promptIds,lastPromptAt}));
    fs.writeFileSync(journalFile+'.tmp',JSON.stringify({version:1,sessions:records}));
    fs.renameSync(journalFile+'.tmp',journalFile);
  };
  if(fs.existsSync(journalFile)) {
    const journal=JSON.parse(fs.readFileSync(journalFile,'utf8'));
    if(journal.version!==1 || !Array.isArray(journal.sessions)) throw fail('臨時試拍清理紀錄無效。');
    for(const record of journal.sessions) {
      validId(record.id);
      if(record.comfyUrl && !localUrl(record.comfyUrl) || !Array.isArray(record.promptIds) || record.promptIds.some(id=>!UUID.test(id))) throw fail('臨時試拍清理紀錄無效。');
      sessions.set(record.id,{...record,closedAt:clock(),touchedAt:clock(),promptIds:[...new Set(record.promptIds)]});
    }
  }
  const memoryStore={read:()=>structuredClone(memory),mutate:callback=>{
    const next=structuredClone(memory),result=callback(next);
    for(const job of next.jobs) if(job.promptId && !UUID.test(job.promptId)) throw fail('ComfyUI 臨時任務識別碼無效。');
    Object.assign(memory,next);
    for(const job of next.jobs) {
      const session=sessions.get(job.previewSessionId);
      if(job.promptId && session && !session.promptIds.includes(job.promptId)) {
        session.promptIds.push(job.promptId);session.lastPromptAt=clock();
      }
    }
    persist();return result;
  },close:()=>{}};

  async function cancel(job) {
    const session=sessions.get(job.previewSessionId);
    if(!session?.closedAt || !job.promptId) return;
    const result=await comfyJson(`/api/jobs/${encodeURIComponent(job.promptId)}/cancel`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'},session.comfyUrl);
    if(typeof result.cancelled!=='boolean') throw fail('ComfyUI 不支援單一試拍任務取消，將繼續重試清理。');
  }
  const runner=createStageRunner({store:memoryStore,comfyJson,comfyAt,uploadReference,onCompleted:()=>{},onStop:cancel,
    preparePrompt:(prompt,job,stage)=>{
      for(const node of Object.values(prompt)) if(node.class_type==='SaveImage') node.inputs.filename_prefix=`PhotoCreate/_previews/${job.previewSessionId}/${job.id}/${stage}`;
      return prompt;
    },
  });

  const sessionFor=(id,{touch=true}={})=>{
    validId(id);
    const session=sessions.get(id);
    if(!session || session.closedAt || closed) throw fail('臨時試拍已結束，請重新開啟提詞視窗。',410);
    if(touch) session.touchedAt=clock();
    return session;
  };
  const view=session=>({id:session.id,jobs:memory.jobs.filter(job=>job.previewSessionId===session.id).map(job=>({
    id:job.id,status:job.status,progress:productionStatus(job),error:job.error,createdAt:job.createdAt,
    character:job.character.name,garment:job.garment.name,aspectRatio:job.aspectRatio,outputWidth:job.outputWidth,outputHeight:job.outputHeight,
    presets:PRESET_KEYS.flatMap(key=>job[key]?.id ? [{category:job[key].category,name:job[key].name,id:job[key].id}] : []),
    images:(job.images || []).map((image,index)=>({id:`${job.id}:${index}`,name:`${session.presetName || '提詞'} · 臨時試拍`,src:`/api/preset-previews/${session.id}/jobs/${job.id}/image/${index}`})),
  }))});
  function open(id,presetId) {
    validId(id);
    if(closed || sessions.get(id)?.closedAt) throw fail('臨時試拍已結束，請重新開啟提詞視窗。',410);
    if(presetId!==undefined && presetId!==null && !store.read().presets.some(row=>row.id===presetId)) throw fail('找不到提詞。',404);
    const existing=sessions.get(id);
    if(existing) {
      if(existing.presetId!==(presetId || null)) throw fail('臨時試拍已綁定其他提詞。',409);
      existing.touchedAt=clock();return view(existing);
    }
    if([...sessions.values()].filter(row=>!row.closedAt).length>=20) throw fail('開啟的試拍視窗過多，請先關閉不用的視窗。',409);
    const session={id,presetId:presetId || null,createdAt:clock(),touchedAt:clock(),promptIds:[]};
    sessions.set(id,session);persist();return view(session);
  }
  function stop(id) {
    validId(id);
    // A close may arrive before its opening request. Keep a tombstone so that
    // delayed requests (including React StrictMode cleanup) cannot reopen it.
    let session=sessions.get(id);
    if(!session) {session={id,createdAt:clock(),promptIds:[]};sessions.set(id,session);}
    session.closedAt ||= clock();
    for(const job of memory.jobs.filter(row=>row.previewSessionId===id)) {
      job.stopRequestedAt ||= new Date(clock()).toISOString();
      if(ACTIVE.includes(job.status)) job.status='stopped';
    }
    for(const run of memory.pipelineRuns.filter(row=>row.jobIds.some(jobId=>memory.jobs.some(job=>job.id===jobId && job.previewSessionId===id)))) run.status='paused';
    persist();
    try {removePreviewDirectory(session.outputDir,id);delete session.cleanupError;} catch(error) {session.cleanupError=error.message;}
    if(!closed) tick().catch(()=>{});
    return {closed:true};
  }
  function shoot(id,{preset,requestId,aspectRatio}={}) {
    const session=sessionFor(id);validId(requestId);
    const existing=memory.jobs.find(job=>job.previewSessionId===id && job.requestId===requestId);
    if(existing) return view(session);
    if(memory.jobs.some(job=>job.previewSessionId===id && ACTIVE.includes(job.status))) throw fail('請等目前這張試拍完成。',409);
    if(memory.jobs.filter(job=>job.previewSessionId===id).length>=24) throw fail('這個視窗已試拍 24 張，請關閉後重新開啟。',409);
    const bound=normalizePresetImport([preset])[0];
    if(session.presetId && (bound.id!==session.presetId || !store.read().presets.some(row=>row.id===session.presetId))) throw fail('試拍提詞已被移除，請重新開啟視窗。',409);
    const snapshot=operatorState(store.read()),directory=outputDir();
    if(!localUrl(snapshot.settings.comfyUrl) || !directory || !fs.statSync(directory,{throwIfNoEntry:false})?.isDirectory()) throw fail('臨時試拍需要可存取的本機 ComfyUI 輸出目錄，請在工作流設定檢查輸出資料夾。');
    if(!snapshot.workflow) throw fail('請先載入拍攝工作流。');
    if(session.comfyUrl && (session.comfyUrl!==snapshot.settings.comfyUrl || session.outputDir!==path.resolve(directory))) throw fail('試拍期間不能切換 ComfyUI，請重新開啟視窗。',409);
    snapshot.presets=snapshot.presets.filter(row=>row.id!==bound.id).concat(bound);
    const saved=snapshot.draft || DEFAULT_DRAFT;
    if(aspectRatio!==undefined && (typeof aspectRatio!=='string' || !Object.hasOwn(OUTPUT_RATIOS,aspectRatio))) throw fail('請選擇有效的試拍比例。');
    const draft={...DEFAULT_DRAFT,steps:saved.steps,resolution:saved.resolution,aspectRatio:aspectRatio===undefined ? saved.aspectRatio : aspectRatio,
      mode:'random',randomPoolMode:'selected',randomCount:1,copies:1,seed:-1,cameraEnabled:false,
      characterIds:snapshot.characters.map(row=>row.id),garmentIds:snapshot.garments.map(row=>row.id),
    };
    for(const [category,field] of Object.entries(PRESET_SELECTION_FIELDS)) draft[field]=category===bound.category ? [bound.id] : snapshot.presets.filter(row=>row.category===category).map(row=>row.id);
    const [job]=buildShotPlans(snapshot,draft);
    // Camera presets can be tried as text in the original-image model. Every
    // preview ends at base, regardless of the installed 3D camera workflow.
    if(bound.category==='camera') Object.assign(job,{camera:structuredClone(bound),prompt:composePrompt({...job,camera:bound,cameraMode:'prompt'})});
    Object.assign(job,{previewSessionId:id,requestId,status:'draft',images:[],createdAt:new Date(clock()).toISOString(),comfyOutputDir:path.resolve(directory)});
    Object.assign(session,{comfyUrl:snapshot.settings.comfyUrl,outputDir:path.resolve(directory),presetName:bound.name});
    memory.jobs.push(job);persist();
    // Queue asynchronously so a close can cancel an upload or an in-flight POST.
    runner.start([job.id],{...snapshot,settings:{...snapshot.settings,releaseGpuMemory:false}}).catch(error=>{
      if(!closed) memoryStore.mutate(state=>{const current=state.jobs.find(row=>row.id===job.id);if(current && !current.stopRequestedAt) Object.assign(current,{status:'failed',error:error.message});});
    });
    return view(session);
  }
  function imageFile(id,jobId,index) {
    const session=sessionFor(id),job=memory.jobs.find(row=>row.previewSessionId===id && row.id===jobId);
    const image=Number.isInteger(index) && index>=0 ? job?.images?.[index] : null;
    if(!image || String(image.subfolder || '').replaceAll('\\','/')!==`PhotoCreate/_previews/${id}/${job.id}` || !/^(base|angle|refine)_/.test(image.filename)) throw fail('找不到臨時成果。',404);
    const file=resolveOutputFile(session.outputDir,image);
    if(!file) throw fail('臨時成果已清除。',404);
    if(file!==path.join(fs.realpathSync(session.outputDir),'PhotoCreate','_previews',id,job.id,image.filename)) throw fail('臨時成果連結到其他圖片。',404);
    return file;
  }
  async function tick() {
    if(closed || cleaning) return;
    cleaning=true;
    try {
      for(const session of sessions.values()) if(!session.closedAt && clock()-session.touchedAt>sessionTtl) stop(session.id);
      for(const session of [...sessions.values()].filter(row=>row.closedAt)) {
        try {
          // Files can be removed while the engine is offline. A filesystem
          // problem must not prevent cancellation of this session's prompts.
          let outputError;
          try {removePreviewDirectory(session.outputDir,session.id);} catch(error) {outputError=error;}
          let absent=true;
          for(const promptId of session.promptIds) {
            const result=await comfyJson(`/api/jobs/${encodeURIComponent(promptId)}/cancel`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'},session.comfyUrl);
            if(typeof result.cancelled!=='boolean') throw fail('ComfyUI 無法確認試拍已取消。');
          }
          if(session.promptIds.length) {
            const queue=await comfyJson('/queue',{},session.comfyUrl);
            if(!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) throw fail('無法確認 ComfyUI 試拍佇列。');
            absent=![...queue.queue_running,...queue.queue_pending].some(row=>session.promptIds.includes(row[1]));
          }
          try {removePreviewDirectory(session.outputDir,session.id);outputError=null;} catch(error) {outputError=error;}
          if(outputError) throw outputError;
          delete session.cleanupError;
          const inFlight=memory.jobs.some(job=>job.previewSessionId===session.id && runner.processing(job.id));
          session.cancelSettled=absent && !inFlight;
          if(absent && !inFlight && clock()-Math.max(session.closedAt,session.lastPromptAt || 0)>cleanupGrace) {
            const ids=new Set(memory.jobs.filter(job=>job.previewSessionId===session.id).map(job=>job.id));
            memory.jobs=memory.jobs.filter(job=>!ids.has(job.id));memory.pipelineRuns=memory.pipelineRuns.filter(run=>!run.jobIds.some(id=>ids.has(id)));
            sessions.delete(session.id);persist();
          }
        } catch(error) {session.cleanupError=error.message;}
      }
    } finally {cleaning=false;}
  }
  function close() {
    if(closed) return;
    for(const session of sessions.values()) if(!session.closedAt) stop(session.id);
    closed=true;clearInterval(timer);memoryStore.close();persist();
  }
  timer=setInterval(()=>{tick().catch(()=>{});},1500);timer.unref();
  // Orphaned sessions are cleaned immediately on boot; they are never resumed.
  tick().catch(()=>{});
  return {open,shoot,stop,status:id=>view(sessionFor(id)),imageFile,tick,sync:runner.tick,close,
    hasWork:()=>memory.jobs.some(job=>ACTIVE.includes(job.status)) || [...sessions.values()].some(row=>row.closedAt && row.promptIds.length && !row.cancelSettled),
  };
}
