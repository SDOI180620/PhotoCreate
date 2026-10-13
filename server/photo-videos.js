import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,randomInt,createHash} from 'node:crypto';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import sharp from 'sharp';
import {belongsToStudio} from './studio-ownership.js';
import {outputDirectoryForJob} from './outputs.js';
import {normalizeVideoSettings,normalizeVideoModels,normalizeVideoWorkflowPath,videoModelsFor,videoRequest,videoIsActive} from '../shared/photo-video.js';
import {buildVideoPrompt,videoSize,videoAvailability,videoTemplate,loadVideoWorkflow,videoParameterChoices,updateVideoWorkflowParameters} from './video-workflow.js';
import {migrateVideoPromptLibrary,videoSettingsFromLibrary,storeVideoSettings} from './video-presets.js';
import {reconcileLibrarySelections} from '../shared/library-selections.js';
const workflowRevision=ui=>createHash('sha256').update(JSON.stringify(ui)).digest('hex');

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const now=()=>new Date().toISOString();
const VIDEO_LIMIT=512*1024**2;
const folderFor=row=>`PhotoCreate/_videos/${row.id}`;
const sameImage=(a,b)=>JSON.stringify([a?.filename,a?.subfolder || '',a?.type || 'output'])===JSON.stringify([b?.filename,b?.subfolder || '',b?.type || 'output']);
const localUrl=base=>['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname);
function recordedFile(root,descriptor,row,{input=false}={}) {
  if(!/^[\w-]{8,80}$/.test(row.id) || !descriptor || descriptor.type!==(input ? 'input' : 'output') || String(descriptor.subfolder).replaceAll('\\','/')!==folderFor(row) || typeof descriptor.filename!=='string' || /[\\/:\0]/.test(descriptor.filename) || !(input ? /\.png$/i : /\.mp4$/i).test(descriptor.filename)) throw fail('影片成果路徑無效。');
  if(!root || !fs.existsSync(root)) return null;
  const target=path.resolve(root,...folderFor(row).split('/'),descriptor.filename);
  if(!fs.existsSync(target)) return null;
  const expected=path.resolve(fs.realpathSync(root),...folderFor(row).split('/'),descriptor.filename);
  if(fs.realpathSync(target)!==expected || !fs.statSync(target).isFile()) throw fail('影片檔案路徑指向其他資料夾。');
  return target;
}

// Video jobs live beside photos in SQLite, and keep a source/version/index
// snapshot. Stable prompt IDs reconcile a lost reply without another generation.
export function createPhotoVideos({store,dataDir,comfyJson,comfyAt,outputDir,isBusy,intervalMs=1500}) {
  const root=path.resolve(dataDir,'photo-videos');fs.mkdirSync(root,{recursive:true});
  if(fs.realpathSync(root)!==root) throw fail('影片儲存資料夾不能是目錄連結。');
  const testRoot=path.join(root,'test-sources');fs.mkdirSync(testRoot,{recursive:true});
  if(fs.realpathSync(testRoot)!==testRoot) throw fail('測試圖片資料夾不能是目錄連結。');
  const testSourceFile=id=>{if(!/^[\w-]{8,80}$/.test(id)) throw fail('測試圖片 ID 無效。');const file=path.join(testRoot,id+'.png');if(fs.existsSync(file) && (fs.realpathSync(file)!==file || !fs.statSync(file).isFile())) throw fail('測試圖片路徑無效。');return file;};
  let busy=false,closed=false,creating=0,currentId=null,writingWorkflow=false;
  const shutdown=new AbortController();
  const settings=()=>{const config=store.read(videoSettingsFromLibrary);return {...config,effectiveModels:videoModelsFor(config)};};
  const withVersion=(config,generationVersion=config.generationVersion)=>normalizeVideoSettings({...config,generationVersion,workflowPath:generationVersion===config.generationVersion ? config.workflowPath : 'bundled'});
  const publicSettings=()=> {
    const config=settings(),published=store.read(state=>state.settings.photoVideoPublished);
    return {defaultDuration:config.defaultDuration,defaultAspectRatio:config.defaultAspectRatio,generationVersion:config.generationVersion,prompts:structuredClone(published?.prompts || []),publishedAt:published?.publishedAt};
  };
  const rows=()=>store.read(state=>state.photoVideos || []);
  const jobFor=(ownerId,id,includeDeleted=false)=>{
    const job=store.read(state=>state.jobs.find(job=>job.id===id && belongsToStudio(job,ownerId) && (includeDeleted || !job.visitorDeletedAt)));
    if(!job) throw fail('找不到你的照片。',404);
    return job;
  };
  const requireRow=(ownerId,id)=>{
    const row=rows().find(row=>row.id===id && row.ownerId===ownerId);
    if(!row) throw fail('找不到你的影片。',404);
    jobFor(ownerId,row.jobId);
    return row;
  };
  const update=(id,changes)=>{if(!closed) store.mutate(state=>{const row=state.photoVideos.find(row=>row.id===id);if(row) Object.assign(row,changes);});};
  const dto=row=>({id:row.id,jobId:row.jobId,imageIndex:row.imageIndex,status:row.status,duration:row.duration,aspectRatio:row.aspectRatio || 'reference',generationVersion:row.workflow?.generationVersion || 'single',width:row.width,height:row.height,mode:row.mode,presetId:row.presetId,presetName:row.presetName,prompt:row.prompt,createdAt:row.createdAt,finishedAt:row.finishedAt,error:row.error ? row.ownerId==='admin' ? row.error : row.status==='failed' ? '影片製作未完成，請重新產生或聯絡攝影棚管理員。' : '正在重新確認影片狀態，請稍候；也可以確認停止後再產生。' : '',
    ...(row.status==='completed' ? {video:`/api${row.ownerId==='admin' ? '' : '/studio'}/photo-videos/${row.id}/video`} : {})});
  const list=(ownerId,jobId,{tests=false,sessionId}={})=>store.read(state=>{
    const jobs=new Set(state.jobs.filter(job=>belongsToStudio(job,ownerId) && !job.visitorDeletedAt && !job.outputsDeletedAt).map(job=>job.id));
    return (state.photoVideos || []).filter(row=>row.ownerId===ownerId && jobs.has(row.jobId) && Boolean(row.isTest)===tests && (!sessionId || row.testSessionId===sessionId) && (!jobId || row.jobId===jobId)).map(dto);
  });
  store.mutate(state=>{
    state.photoVideos ||= [];migrateVideoPromptLibrary(state);state.settings.photoVideo.defaultAspectRatio='reference';reconcileLibrarySelections(state);
    for(const row of state.photoVideos) if(row.status==='submitting') Object.assign(row,{status:row.promptId ? 'uncertain' : 'queued',error:row.promptId ? '服務曾中斷，正在確認影片狀態。' : ''});
  });
  async function prepare(config,base) {
    const info=await comfyJson('/object_info',{},base),models=videoModelsFor(config),available=videoAvailability(info,models,videoTemplate(config.generationVersion));
    if(available.missingNodes.length) return {availability:available};
    const loaded=await loadVideoWorkflow(comfyJson,{workflowPath:config.workflowPath,generationVersion:config.generationVersion,base,objectInfo:info});
    if(loaded.workflow.generationVersion!==config.generationVersion) throw fail('所選工作流與影片版本不一致，請重新套用影片工作流。');
    return {template:loaded.template,availability:{...videoAvailability(info,models,loaded.template),workflow:loaded.workflow}};
  }
  async function availability(modelSettings=settings(),base) {
    try {const previous=settings(),version=modelSettings.generationVersion || (modelSettings.models?.latentUpscaler ? 'two-pass' : previous.generationVersion),config={...withVersion(previous,version),...modelSettings};if(version==='two-pass' && modelSettings.models) Object.assign(config,{twoPassUnet:modelSettings.models.unet,latentUpscaler:modelSettings.models.latentUpscaler || config.latentUpscaler});return (await prepare(config,base)).availability;}
    catch(error) {return {ready:false,error:error.message,missingNodes:[],missingModels:[],choices:{}};}
  }
  async function parameters(generationVersion) {
    const config=withVersion(settings(),generationVersion),loaded=await loadVideoWorkflow(comfyJson,{workflowPath:config.workflowPath,generationVersion:config.generationVersion});
    return {...loaded.workflow,...videoParameterChoices(loaded.objectInfo),revision:workflowRevision(loaded.ui)};
  }
  async function saveParameters(values,revision,config=settings()) {
    if(writingWorkflow) throw fail('影片參數正在保存，請稍候。',409);
    if(!values || typeof values.sampler!=='string' || typeof values.scheduler!=='string' || !Number.isInteger(values.steps) || typeof values.megapixels!=='number' || !/^[a-f0-9]{64}$/.test(revision || '')) throw fail('影片參數格式無效，請重新讀取工作流。');
    writingWorkflow=true;
    try {
      const previous=settings(),base=store.read(state=>state.settings.comfyUrl),loaded=await loadVideoWorkflow(comfyJson,{workflowPath:config.workflowPath,generationVersion:config.generationVersion,base});
      if(loaded.workflow.generationVersion!==config.generationVersion) throw fail('影片版本與工作流不一致，請重新選擇。');
      if(workflowRevision(loaded.ui)!==revision) throw fail('ComfyUI 工作流已被修改，請重新讀取後再保存。',409);
      let ui;try {ui=updateVideoWorkflowParameters(loaded.ui,loaded.objectInfo,values);} catch(error) {throw fail(error.message);}
      const write=(file,value,overwrite)=>comfyJson('/userdata/'+encodeURIComponent(file)+'?overwrite='+overwrite,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)},base);
      if(loaded.workflow.source==='comfy') await write('photocreate-backups/'+randomUUID()+'/'+loaded.workflow.resolvedPath,loaded.ui,false);
      if(base!==store.read(state=>state.settings.comfyUrl) || previous.workflowPath!==settings().workflowPath || previous.generationVersion!==settings().generationVersion) throw fail('工作流或連線已變更，請重新讀取。',409);
      await write('workflows/'+loaded.workflow.resolvedPath,ui,true);
      return {...loaded.workflow,...values,revision:workflowRevision(ui)};
    } finally {writingWorkflow=false;}
  }
  async function testVideo(body,file) {
    if(typeof body?.sessionId!=='string' || !/^[\w-]{8,80}$/.test(body.sessionId)) throw fail('影片測試工作階段無效。');
    const request=videoRequest({...body,mode:'custom',duration:Number(body.duration),imageIndex:Number(body.imageIndex ?? 0)});
    const hash=createHash('sha256').update(JSON.stringify({...request,jobId:body.jobId || '',sessionId:body.sessionId})).update(file?.buffer || '').digest('hex');
    const existing=rows().find(row=>row.ownerId==='admin' && row.requestId===request.requestId);
    if(existing) {if(!existing.isTest || existing.testRequestHash!==hash) throw fail('這次測試設定已變更，請重新送出。',409);return {video:dto(existing),created:false};}
    let jobId=body.jobId,testSourceId;
    try {
      if(file) {
        if(body.jobId) throw fail('請選擇一種測試圖片來源。');
        if(!['image/png','image/jpeg','image/webp'].includes(file.mimetype)) throw fail('測試圖片請使用 PNG、JPG 或 WebP。');
        let png;try {png=await sharp(file.buffer,{limitInputPixels:32*1024*1024}).rotate().png().toBuffer();} catch {throw fail('測試圖片無法讀取，請換一張圖片。');}
        testSourceId=randomUUID();jobId='video-test-'+testSourceId;
        fs.writeFileSync(testSourceFile(testSourceId),png,{flag:'wx'});
        store.mutate(state=>state.jobs.unshift({id:jobId,videoTestSourceId:testSourceId,name:'影片提詞臨時測試',status:'completed',createdAt:now(),comfyUrl:state.settings.comfyUrl,images:[{filename:testSourceId+'.png',subfolder:'PhotoCreate/_video-test-sources',type:'input'}]}));
      } else if(typeof jobId!=='string') throw fail('請選擇已產出的照片，或上傳一張測試圖片。');
      return await generate('admin',jobId,request,{isTest:true,testSessionId:body.sessionId,testRequestHash:hash});
    } catch(error) {
      if(testSourceId) {store.mutate(state=>{state.jobs=state.jobs.filter(row=>row.id!==jobId);});const source=testSourceFile(testSourceId);if(fs.existsSync(source)) fs.unlinkSync(source);}
      throw error;
    }
  }
  function sourceFor(ownerId,jobId,imageIndex) {
    const job=jobFor(ownerId,jobId);
    if(job.status!=='completed' || job.outputsDeletedAt || !job.images?.[imageIndex]) throw fail('請選擇已完成的照片來產影片。',409);
    return job;
  }
  async function generate(ownerId,jobId,body,{isTest=false,testSessionId,testRequestHash,publishedSettings}={}) {
    const config=settings(),published=ownerId==='admin' ? config : publishedSettings ?? publicSettings(),request=videoRequest(body,published),signature=JSON.stringify({jobId,...request,requestId:undefined});
    sourceFor(ownerId,jobId,request.imageIndex);
    const existing=rows().find(row=>row.ownerId===ownerId && row.requestId===request.requestId);
    if(existing) {
      if(existing.signature!==signature) throw fail('這次影片設定已變更，請重新送出。',409);
      return {video:dto(existing),created:false};
    }
    const preset=request.mode==='official' && published.prompts.find(row=>row.id===request.presetId);
    if(request.mode==='official' && !preset) throw fail('官方影片提詞已變更，請重新選擇。');
    creating++;
    try {
      const prepared=await prepare(config),result=prepared.availability;if(!result.ready) throw fail(result.error,503);
      if(closed) throw fail('服務正在關閉。',503);
      // Recheck ownership, source and duplication after the upstream request.
      const job=sourceFor(ownerId,jobId,request.imageIndex),state=store.read();
      const repeat=(state.photoVideos || []).find(row=>row.ownerId===ownerId && row.requestId===request.requestId);
      if(repeat) {if(repeat.signature!==signature) throw fail('這次影片設定已變更，請重新送出。',409);return {video:dto(repeat),created:false};}
      if(state.photoVideos.some(row=>row.jobId===jobId && row.imageIndex===request.imageIndex && videoIsActive(row))) throw fail('這張照片正在產影片，請完成或停止後再產生。',409);
      const row={id:randomUUID(),ownerId,jobId,...request,signature,...(isTest ? {isTest,testSessionId,testRequestHash,testSourceId:job.videoTestSourceId} : {}),prompt:preset ? preset.prompt : request.prompt,presetName:preset ? preset.name : '自行輸入',models:videoModelsFor(config),
        workflowSnapshot:prepared.template,workflow:result.workflow,status:'queued',createdAt:now(),seed:randomInt(2**48-1),sourceImage:job.images[request.imageIndex],sourceComfyUrl:job.comfyUrl || state.settings.comfyUrl,
        comfyUrl:state.settings.comfyUrl,comfyOutputDir:outputDir()};
      store.mutate(state=>state.photoVideos.unshift(row));
      return {video:dto(row),created:true};
    } finally {creating--;}
  }
  const dataFile=row=>{
    if(!/^[\w-]{8,80}$/.test(row.id)) throw fail('影片檔名無效。');
    const file=path.join(root,`${row.id}.mp4`);
    if(fs.existsSync(file) && (fs.realpathSync(file)!==file || !fs.statSync(file).isFile())) throw fail('影片檔案路徑無效。');
    return file;
  };
  function cleanupInput(row) {
    if(!row.input || !localUrl(row.comfyUrl)) return;
    const directory=outputDirectoryForJob(row,store.read(state=>state.settings),outputDir());
    if(!directory) return;
    const file=recordedFile(path.resolve(directory,'..','input'),row.input,row,{input:true});
    if(file) fs.unlinkSync(file);
  }
  async function archive(row) {
    const target=dataFile(row),temporary=target+'.part';
    if(fs.existsSync(temporary)) {if(fs.realpathSync(temporary)!==temporary) throw fail('影片暫存路徑無效。');fs.unlinkSync(temporary);}
    if(!fs.existsSync(target)) {
      const response=await comfyAt(row.comfyUrl,`/view?${new URLSearchParams({...row.output})}`);
      if(!response.body) throw fail('影片回應沒有內容。',502);
      let size=0;
      const meter=new Transform({transform(chunk,encoding,done) {size+=chunk.length;done(size>VIDEO_LIMIT ? fail('影片檔案超過 512 MB。') : null,chunk);}});
      try {
        await pipeline(Readable.fromWeb(response.body),meter,fs.createWriteStream(temporary,{flags:'wx'}),{signal:shutdown.signal});
        const header=Buffer.alloc(12),fd=fs.openSync(temporary,'r');try {fs.readSync(fd,header,0,12,0);} finally {fs.closeSync(fd);}
        if(size<12 || header.toString('ascii',4,8)!=='ftyp') throw fail('ComfyUI 沒有回傳有效的 MP4 影片。',502);
        fs.renameSync(temporary,target);
      } catch(error) {if(fs.existsSync(temporary) && fs.realpathSync(temporary)===temporary) fs.unlinkSync(temporary);throw error;}
    }
    update(row.id,{status:rows().find(item=>item.id===row.id)?.stopRequestedAt ? 'stopped' : 'completed',finishedAt:now(),error:''});
    try {cleanupInput(row);} catch { /* A missing historical input never hides a saved video. */ }
  }
  async function reconcile(row) {
    const history=await comfyJson(`/history/${encodeURIComponent(row.promptId)}`,{},row.comfyUrl),item=history[row.promptId];
    if(item && item.status?.completed!==false) {
      const messages=item.status?.messages || [],detail=messages.find(([type])=>type==='execution_error')?.[1];
      const stopped=messages.some(([type])=>type==='execution_interrupted') || detail?.exception_type?.endsWith('InterruptProcessingException');
      const output=item.outputs?.save || {},candidates=[...(output.images || []),...(output.videos || []),...(output.gifs || [])];
      const descriptor=candidates.find(file=>typeof file.filename==='string' && /\.mp4$/i.test(file.filename));
      if(descriptor) {
        const clean={filename:descriptor.filename,subfolder:descriptor.subfolder || '',type:descriptor.type || 'output'};
        // Validate the descriptor even on a remote engine, before persisting it.
        try {recordedFile(null,clean,row);} catch(error) {update(row.id,{status:'failed',finishedAt:now(),error:error.message});return;}
        row={...row,output:clean};update(row.id,{output:clean});
      }
      if(stopped || item.status?.status_str==='error') {
        update(row.id,{status:stopped ? 'stopped' : 'failed',finishedAt:now(),error:stopped ? '' : detail?.exception_message || 'ComfyUI 影片製作失敗。'});
        try {cleanupInput(row);} catch { /* Purging the photo retries input cleanup. */ }
      } else {
        if(!row.output) {update(row.id,{status:'failed',finishedAt:now(),error:'這次製作沒有產生 MP4 影片。'});return;}
        update(row.id,{status:'archiving',generatedAt:now(),error:''});await archive(row);
      }
      return;
    }
    const queue=await comfyJson('/queue',{},row.comfyUrl),running=queue.queue_running?.some(entry=>entry[1]===row.promptId),pending=queue.queue_pending?.some(entry=>entry[1]===row.promptId);
    if(running || pending) {update(row.id,{status:row.stopRequestedAt ? 'stopping' : running ? 'running' : 'queued',error:''});return;}
    if(row.stopDispatchedAt) {update(row.id,{status:'stopped',finishedAt:now(),error:''});try {cleanupInput(row);} catch { /* Purge retries cleanup. */ }return;}
    update(row.id,{status:'uncertain',error:'ComfyUI 尚未確認影片任務，請檢查連線；確認停止後可重新產生。'});
  }
  async function tick() {
    if(closed || busy) return;
    busy=true;
    let row,attempted=false;
    try {
      row=rows().find(row=>videoIsActive(row) && row.promptId) || rows().filter(row=>videoIsActive(row)).at(-1);
      if(!row) return;
      currentId=row.id;
      if(row.stopRequestedAt && row.generatedAt) {update(row.id,{status:'stopped',finishedAt:now(),error:''});try {cleanupInput(row);} catch { /* Purging retries input cleanup. */ }return;}
      if(row.status==='archiving' && row.output) {await archive(row);return;}
      if(row.promptId) {
        if(row.stopRequestedAt && !row.stopDispatchedAt) {
          const result=await comfyJson(`/api/jobs/${encodeURIComponent(row.promptId)}/cancel`,{method:'POST'},row.comfyUrl);
          if(typeof result.cancelled!=='boolean') throw fail('ComfyUI 尚未確認停止影片。',502);
          if(result.cancelled) {row={...row,stopDispatchedAt:now()};update(row.id,{stopDispatchedAt:row.stopDispatchedAt});}
        }
        await reconcile(row);return;
      }
      if(row.stopRequestedAt) {update(row.id,{status:'stopped',finishedAt:now(),error:''});return;}
      if(isBusy()) return;
      const queue=await comfyJson('/queue',{},row.comfyUrl);
      if(queue.queue_running?.length || queue.queue_pending?.length || closed) return;
      const source=sourceFor(row.ownerId,row.jobId,row.imageIndex);
      if(!sameImage(source.images[row.imageIndex],row.sourceImage)) throw fail('來源照片已變更，請重新選擇。',409);
      update(row.id,{status:'submitting',error:''});
      const buffer=row.testSourceId ? fs.readFileSync(testSourceFile(row.testSourceId)) : Buffer.from(await (await comfyAt(row.sourceComfyUrl,`/view?${new URLSearchParams({filename:row.sourceImage.filename,subfolder:row.sourceImage.subfolder || '',type:row.sourceImage.type || 'output'})}`)).arrayBuffer());
      const metadata=await sharp(buffer).metadata(),size=videoSize(metadata.width,metadata.height,row.aspectRatio || 'reference',row.workflow);
      const refined=row.workflowSnapshot?.upscale ? videoSize(metadata.width,metadata.height,'reference',{megapixels:row.workflow.refineMegapixels,multiple:row.workflow.refineMultiple}) : size;
      const form=new FormData();form.append('image',new Blob([await sharp(buffer).png().toBuffer()],{type:'image/png'}),'source.png');form.append('type','input');form.append('subfolder',folderFor(row));form.append('overwrite','true');
      const upload=await comfyJson('/upload/image',{method:'POST',body:form},row.comfyUrl);
      const input={filename:upload.name,subfolder:upload.subfolder || '',type:'input'};recordedFile(null,input,row,{input:true});update(row.id,{input});
      if(closed) return;
      if(rows().find(item=>item.id===row.id)?.stopRequestedAt) {update(row.id,{status:'stopped',finishedAt:now()});cleanupInput({...row,input});return;}
      const prompt=buildVideoPrompt({...row,...size,refineWidth:refined.width,refineHeight:refined.height,image:`${input.subfolder}/${input.filename}`}),promptId=randomUUID();
      update(row.id,{promptId,apiPrompt:prompt,...refined});attempted=true;
      const result=await comfyJson('/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt,prompt_id:promptId,client_id:'photocreate-studio'})},row.comfyUrl);
      if(!result.prompt_id) throw fail('ComfyUI 回應缺少影片 prompt_id。',502);
      const stopped=rows().find(item=>item.id===row.id)?.stopRequestedAt;
      update(row.id,{promptId:result.prompt_id,status:stopped ? 'stopping' : 'queued',submittedAt:now()});
    } catch(error) {
      if(row && !closed) {
        const current=rows().find(item=>item.id===row.id),ambiguous=attempted && !/^ComfyUI 4\d\d:/.test(error.message);
        // A download failure remains archiving and retries without generating.
        const status=current?.status==='archiving' ? 'archiving' : current?.promptId && (!attempted || ambiguous) ? 'uncertain' : 'failed';
        update(row.id,{status,error:error.message});
      }
    } finally {busy=false;currentId=null;}
  }
  function preparePurge(jobs) {
    const ids=new Set(jobs.map(job=>job.id)),selected=rows().filter(row=>ids.has(row.jobId)),files=new Set();
    if(selected.some(videoIsActive)) throw fail('請先停止這張照片的影片，確認停止後再刪除。',409);
    for(const row of selected) {
      const file=dataFile(row);if(fs.existsSync(file)) files.add(file);
      if(localUrl(row.comfyUrl)) {
        const directory=outputDirectoryForJob(row,store.read(state=>state.settings),outputDir());
        if(row.output) {const output=recordedFile(directory,row.output,row);if(output) files.add(output);}
        if(row.input && directory) {const input=recordedFile(path.resolve(directory,'..','input'),row.input,row,{input:true});if(input) files.add(input);}
      }
    }
    return ()=>{
      for(const file of files) fs.unlinkSync(file);
      if(!closed && selected.length) store.mutate(state=>{state.photoVideos=state.photoVideos.filter(row=>!ids.has(row.jobId));});
      return files.size;
    };
  }
  const timer=intervalMs>0 ? setInterval(()=>{tick().catch(()=>{});},intervalMs) : null;timer?.unref();
  return {settings,publicSettings,list,availability,parameters,testVideo,generate,tick,hasWork:()=>creating>0 || writingWorkflow || rows().some(videoIsActive),preparePurge,
    saveSettings(body) {
      if(body?.prompts!==undefined && !Array.isArray(body.prompts)) throw fail('影片提詞格式無效。');
      const previous=settings(),prompts=body?.prompts ?? previous.prompts,ids=new Set(prompts.map(row=>row.id));
      const changingVersion=body?.generationVersion!==undefined && body.generationVersion!==previous.generationVersion;
      const config=normalizeVideoSettings({...previous,...body,workflowPath:body?.workflowPath ?? (changingVersion ? 'bundled' : previous.workflowPath),prompts,selectedPromptIds:body?.selectedPromptIds ?? previous.selectedPromptIds.filter(id=>ids.has(id))});
      const save=()=>{const latest=settings(),livePrompts=body?.prompts ?? latest.prompts,liveIds=new Set(livePrompts.map(row=>row.id)),current=normalizeVideoSettings({...config,prompts:livePrompts,selectedPromptIds:body?.selectedPromptIds ?? latest.selectedPromptIds.filter(id=>liveIds.has(id)),models:body?.models ?? latest.models,workflowPath:changingVersion ? config.workflowPath : body?.workflowPath ?? latest.workflowPath,generationVersion:body?.generationVersion ?? latest.generationVersion,twoPassUnet:body?.twoPassUnet ?? latest.twoPassUnet,latentUpscaler:body?.latentUpscaler ?? latest.latentUpscaler});store.mutate(state=>{storeVideoSettings(state,current,{replacePrompts:body?.prompts!==undefined});reconcileLibrarySelections(state);});return settings();};
      return body?.workflowParameters ? saveParameters(body.workflowParameters,body.workflowRevision,config).then(save) : save();
    },
    selectPrompts(ids) {const config=normalizeVideoSettings({...settings(),selectedPromptIds:ids});store.mutate(state=>storeVideoSettings(state,config));return config;},
    publish() {const config=settings(),published={prompts:structuredClone(config.prompts.filter(row=>config.selectedPromptIds.includes(row.id))),publishedAt:now()};store.mutate(state=>{state.settings.photoVideoPublished=published;});return publicSettings();},
    savePrompt(body,id) {
      const config=settings();if(id && !config.prompts.some(row=>row.id===id)) throw fail('找不到影片提詞。',404);
      const row={id:id || randomUUID(),name:body?.name,prompt:body?.prompt},prompts=id ? config.prompts.map(item=>item.id===id ? row : item) : [...config.prompts,row];
      const normalized=normalizeVideoSettings({...config,prompts});store.mutate(state=>{storeVideoSettings(state,normalized,{replacePrompts:true});reconcileLibrarySelections(state);});return normalized.prompts.find(item=>item.id===row.id);
    },
    removePrompt(id) {const config=settings();if(!config.prompts.some(row=>row.id===id)) throw fail('找不到影片提詞。',404);store.mutate(state=>{state.presets=state.presets.filter(row=>row.id!==id);reconcileLibrarySelections(state);});return {ok:true};},
    saveModels(body) {if(!body) throw fail('請選擇 H3 模型。');const previous=settings(),models=normalizeVideoModels(body),config=normalizeVideoSettings({...previous,models:previous.generationVersion==='two-pass' ? {...models,unet:previous.models.unet,latentUpscaler:undefined} : models,...(previous.generationVersion==='two-pass' ? {twoPassUnet:models.unet,latentUpscaler:models.latentUpscaler ?? previous.latentUpscaler} : {})});store.mutate(state=>storeVideoSettings(state,config));return settings();},
    async saveWorkflow(body) {
      if(typeof body?.workflowPath!=='string') throw fail('請選擇影片工作流。');
      const workflowPath=normalizeVideoWorkflowPath(body.workflowPath),base=store.read(state=>state.settings.comfyUrl);
      const previous=settings(),loaded=await loadVideoWorkflow(comfyJson,{workflowPath,generationVersion:previous.generationVersion,base});
      if(base!==store.read(state=>state.settings.comfyUrl)) throw fail('ComfyUI 連線已變更，請重新檢查。',409);
      const config={...settings(),workflowPath,generationVersion:loaded.workflow.generationVersion};store.mutate(state=>storeVideoSettings(state,config));return settings();
    },
    async stop(ownerId,id) {
      const row=requireRow(ownerId,id);
      if(videoIsActive(row)) {update(id,{stopRequestedAt:now(),status:!row.promptId && currentId!==id ? 'stopped' : 'stopping'});await tick();}
      return dto(requireRow(ownerId,id));
    },
    remove(ownerId,id) {const row=requireRow(ownerId,id);if(videoIsActive(row)) throw fail('請先停止影片，確認停止後再刪除。',409);
      const others=rows().filter(item=>item.jobId===row.jobId && item.id!==id);
      // Use the same file validation as a photo purge, restricted to one clip.
      if(others.some(videoIsActive)) throw fail('這張照片還有影片製作中，請完成後再刪除。',409);
      const file=dataFile(row),files=new Set(fs.existsSync(file) ? [file] : []);
      if(row.testSourceId && !others.length) {const source=testSourceFile(row.testSourceId);if(fs.existsSync(source)) files.add(source);}
      if(localUrl(row.comfyUrl)) {const directory=outputDirectoryForJob(row,store.read(state=>state.settings),outputDir());if(row.output) {const output=recordedFile(directory,row.output,row);if(output) files.add(output);}if(row.input && directory) {const input=recordedFile(path.resolve(directory,'..','input'),row.input,row,{input:true});if(input) files.add(input);}}
      for(const file of files) fs.unlinkSync(file);
      store.mutate(state=>{state.photoVideos=state.photoVideos.filter(item=>item.id!==id);if(row.testSourceId && !others.length) state.jobs=state.jobs.filter(job=>job.id!==row.jobId);state.galleryEntries=(state.galleryEntries || []).filter(entry=>entry.ownerId!==ownerId || entry.mediaType!=='video' || entry.videoId!==id);});return {ok:true,deletedFiles:files.size};
    },
    testSourceImage(jobId) {const job=jobFor('admin',jobId);if(!job.videoTestSourceId) throw fail('找不到測試圖片。',404);const file=testSourceFile(job.videoTestSourceId);if(!fs.existsSync(file)) throw fail('測試圖片已不存在。',404);return file;},
    file(ownerId,id) {const row=requireRow(ownerId,id),job=jobFor(ownerId,row.jobId);if(row.status!=='completed' || job.outputsDeletedAt) throw fail('影片尚未完成或已刪除。',404);const file=dataFile(row);if(!fs.existsSync(file)) throw fail('影片檔案已不存在。',404);return file;},
    close() {closed=true;shutdown.abort();if(timer) clearInterval(timer);},
  };
}
