import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createStore } from './store.js';
import {createImagePreviews} from './image-previews.js';
import {createPhotoStorage,angleInputImage} from './photo-storage.js';
import {createBackupManager} from './backups.js';
import { createTransferManager } from './transfer.js';
import { LIMITS } from './transfer-schema.js';
import { workbenchAccess } from './access.js';
import { createAuthentication } from './auth.js';
import { createVisitorRouter } from './visitors.js';
import { createPhotoFolders } from './photo-folders.js';
import { belongsToStudio,operatorState,jobSummary } from './studio-ownership.js';
import { photoPromptDetails } from './photo-prompts.js';
import { createCustomerRecipe, customerProductionState, customerRecipeSummary } from './customer-recipe.js';
import { CATEGORIES, buildShotPlans, getOutputSize, normalizePresetImport, referenceOnlyPrompt } from '../shared/domain.js';
import { ACTIVE_STATUSES, RETRYABLE_STATUSES, STOPPABLE_STATUSES, defaultBatchName } from '../shared/batches.js';
import { jobUpdateFromComfy } from './job-status.js';
import { createStageRunner } from './stage-runner.js';
import {createPresetPreviews,relatedPresetPhotos,relatedGarmentPhotos} from './preset-previews.js';
import {GARMENT_SOURCES_VERSION,garmentFields} from '../shared/garments.js';
import {createCharacterTurnarounds,characterTurnaroundRouter} from './character-turnarounds.js';
import {createCharacterPromptProfiles} from './character-prompt-profiles.js';
import {createGalleryMusic} from './gallery-music.js';
import {createPhotoVideos} from './photo-videos.js';
import {loadVideoWorkflow,videoUiTemplate} from './video-workflow.js';
import {PHOTO_VIDEO_VERSION,normalizeVideoModels} from '../shared/photo-video.js';
import {DEFAULT_PIANO_CAPTION,DEFAULT_PIANO_DURATION_CAP} from '../shared/gallery-music.js';
import { buildRemakePlans } from '../shared/remakes.js';
import { resolveSelectedPhotoSource,photoCameraSettings } from '../shared/camera-source.js';
import { PHOTO_CUSTOMIZATION_VERSION,PHOTO_CHANGE_FIELDS,PHOTO_PRESET_CATEGORIES,normalizePhotoCustomization,customPhotoPrompt,clothingDescription } from '../shared/photo-customization.js';
import { reconcileLibrarySelections,reconcileDraftCandidates } from '../shared/library-selections.js';
import { CAMERA_FRAMING_VERSION, cameraPreset, normalizeCameraAngle, cameraPrompt, REFINE_PROMPT, REFINE_STEPS } from '../shared/camera.js';
import {cameraVersion,cameraWorkflowPath,cameraWorkflowVersion} from '../shared/camera-version.js';
import {productionStages,isPhotoSourceJob,PHOTO_REFINEMENT_VERSION} from '../shared/production.js';
import {characterProfile,uploadedCharacterProfiles} from '../shared/character-profile.js';
import { validateCameraWorkflow, buildCameraPipeline, buildCameraStage } from './camera-workflow.js';
import { purgeJobOutputs,resolveOutputFile,outputDirectoryForJob } from './outputs.js';
import { createEnvironmentManager,defaultComfyDirectory,validateComfyDirectory,pickComfyDirectory,comfyOutputDirectory,BUNDLED_WORKFLOW_PATH } from './environment.js';
import { normalizeComfyUrl,testComfyConnection,publicConnectionTest } from './connection.js';
import { WORKFLOW_NAME, WORKFLOW_PATH, convertWorkflow, validateTemplate, buildComfyPrompt, referenceKinds, workflowSummary } from './workflow.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kinds = ['garments','characters','scenes'];
const fail = (message,status = 400) => Object.assign(new Error(message),{ status });
const safeText = (value, max, label) => {
  if (typeof value !== 'string' || value.length > max) throw fail(`${label}格式不正確或過長。`);
  return value.trim();
};
const assetFields = body => {
  const name = safeText(body.name,200,'名稱');
  if (!name) throw fail('請輸入名稱。');
  const description = safeText(body.description ?? '',20000,'描述');
  const tags = body.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 50 || tags.some(tag => typeof tag !== 'string' || tag.length > 100)) throw fail('標籤格式不正確。');
  return {name, description, tags: tags.map(tag => tag.trim()).filter(Boolean)};
};

export function createApp({ dataDir = path.join(rootDir,'data'), fetchImpl = fetch, comfyOutputDir, environmentOptions = {}, presetPreviewOptions = {}, characterTurnaroundOptions = {}, musicOptions = {}, photoVideoOptions = {}, photoStorageOptions = {}, directoryPicker = pickComfyDirectory, publicUrl = process.env.PHOTOCREATE_PUBLIC_URL } = {}) {
  const access=workbenchAccess({publicUrl});
  const store = createStore(dataDir);
  const imagePreviews=createImagePreviews();
  const photoStorage=createPhotoStorage({dataDir,store,defaultOutputDir:comfyOutputDir,intervalMs:fetchImpl===fetch ? 1500 : 0,
    loadImage:async(base,image)=>Buffer.from(await (await comfyAt(base,`/view?${new URLSearchParams({filename:image.filename,subfolder:image.subfolder || '',type:image.type || 'output'})}`)).arrayBuffer()),...photoStorageOptions});
  const characterPromptProfiles=createCharacterPromptProfiles(store);
  const photoFolders=createPhotoFolders(store);
  const authentication=createAuthentication({dataDir,publicUrl,claimLegacyStudio:(legacyOwner,ownerId)=>{
    store.mutate(state=>{for(const collection of ['characters','jobs','batches']) for(const row of state[collection]) if(row.visitorId===legacyOwner) row.visitorId=ownerId;});
  }});
  const environment = createEnvironmentManager({dataDir,fetchImpl,...environmentOptions});
  const transfer = createTransferManager({dataDir,store});
  let activeWrites=0;
  const backups=createBackupManager({dataDir,photoStorage,assertIdle:()=>{
    assertEnvironmentIdle();if(activeWrites || transfer.isBusy() || syncing) throw fail('請先完成資料保存、搬移或拍攝更新，再建立完整備份。',409);
  }});
  const closeStore=store.close;store.close=()=>{photoVideos?.close();backups.close();photoStorage.close();imagePreviews.clear();transfer.close();environment.close();authentication.close();closeStore();};
  const outputDir = () => comfyOutputDir || comfyOutputDirectory(store.read(state=>state.settings));
  const app = express();
  app.disable('x-powered-by');
  app.use(access);
  app.use(express.json({limit: '10mb'}));
  app.use((req,res,next)=>{
    if(['GET','HEAD'].includes(req.method) || !req.path.startsWith('/api/') || req.path==='/api/auth/logout') return next();
    if(backups.isBusy()) return next(fail('正在建立完整備份，請稍後再修改資料。',409));
    if(req.path!=='/api/backups/export') {
      activeWrites++;let finished=false;
      const release=()=>{if(!finished) {finished=true;activeWrites--;}};
      res.once('finish',release);res.once('close',release);
    }
    next();
  });
  app.use(authentication.attach);
  app.use('/api/auth',authentication.router);
  app.use('/api/accounts',authentication.accountsRouter);
  app.get('/login',(req,res,next)=>req.account ? res.redirect(req.account.role==='admin' ? '/admin' : '/') : next());
  app.use('/admin',authentication.page);
  app.use('/uploads',authentication.requireAdmin,async(req,res,next)=>{
    const fileName=req.path.slice(1);
    const allowed=store.read(state=>[...state.characters,...state.garments,...state.scenes,
      ...state.jobs.filter(job=>belongsToStudio(job)).flatMap(job=>[job.character,job.garment,job.scene])]
      .some(row=>row && belongsToStudio(row) && row.fileName===fileName));
    if(!allowed) return next(fail('找不到圖片。',404));
    if(req.query.thumbnail!==undefined && !req.query.download) return imagePreviews.send(res,{key:`upload:${fileName}`,file:path.join(dataDir,'uploads',fileName),size:req.query.thumbnail});
    next();
  },express.static(path.join(dataDir,'uploads'),{ dotfiles: 'deny' }));
  const upload = multer({ storage: multer.memoryStorage(), limits: {fileSize: 25 * 1024 * 1024, files: 50} });
  let submitting = false;
  let syncing = false;
  let submission = null;
  let pickingDirectory = false;
  let presetPreviews;
  let characterTurnarounds;
  let galleryMusic;
  let photoVideos;
  const assertEnvironmentIdle = () => {
    if(environment.isActive() || submitting || presetPreviews?.hasWork() || characterTurnarounds?.hasWork() || galleryMusic?.hasWork() || photoVideos?.hasWork() || store.read().jobs.some(job=>ACTIVE_STATUSES.includes(job.status))) throw fail('請先完成或暫停環境安裝、拍攝、影片、角色轉圖與音樂製作，再切換環境。',409);
  };
  const rememberOutputLocations = state => {
    const directory=outputDir();
    for(const job of state.jobs) {
      const url=job.comfyUrl || state.settings.comfyUrl;
      if(!job.comfyOutputDir && url===state.settings.comfyUrl && ['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname)) job.comfyOutputDir=directory;
    }
  };
  const stopAttempts = new Map();
  const getCustomerRecipe=()=>{
    const existing=store.read(state=>state.customerRecipe);
    if(existing) return existing;
    const state=store.read();
    // Existing installations keep their current choices on first upgrade.
    // Once captured, saving an operator draft never changes this recipe.
    try {
      const recipe=createCustomerRecipe(state,state.workbenchDrafts?.random || state.draft || {});
      store.mutate(current=>{current.customerRecipe=recipe;});
      return recipe;
    } catch {return null;}
  };
  app.use('/api/studio',authentication.requireCustomer,createVisitorRouter({store,dataDir,
    getCharacterTurnarounds:()=>characterTurnarounds,
    getGalleryMusic:()=>galleryMusic,
    getPhotoVideos:()=>photoVideos,
    photoFolders,
    getCustomerRecipe,
    isInstalling:()=>environment.isActive() || galleryMusic?.hasWork() || photoVideos?.hasWork(),
    uploadCharacter:(files,visitorId,profiles)=>saveAssetUploads('characters',files,visitorId,profiles),
    uploadGarment:(files,visitorId)=>saveAssetUploads('garments',files,visitorId),
    createShots,remakeShots,angleShot,refineShot,customShot,queueShots,stopShots,
    purgeOutputs:(jobs,requireLocal=false)=>purgeOwnedOutputs(store.read(),jobs,requireLocal),
    sendImage:serveJobImage,sendAngleSource:serveAngleSource,sendCharacterReference:serveCharacterReference,sendAssetImage:serveAssetImage,
  }));
  app.use('/api',(req,res,next)=>req.method==='GET' && req.path==='/health' ? next() : authentication.requireAdmin(req,res,next));
  app.use('/api/character-turnarounds',characterTurnaroundRouter(()=>characterTurnarounds,()=>'admin'));
  const publicState = () => {
    const customerRecipe=getCustomerRecipe();
    const state = store.read(current=>{
      const own=operatorState(current),{workflow,cameraWorkflow,...view}=own;
      return {...view,jobs:own.jobs.map(jobSummary),workflow:workflowSummary(workflow,own.workflowName || WORKFLOW_NAME),
        cameraWorkflow:{ready:Boolean(cameraWorkflow),name:own.cameraWorkflowName || cameraWorkflowPath(own.settings.cameraVersion),version:cameraWorkflowVersion(cameraWorkflow),error:own.cameraWorkflowError || ''}};
    });
    const workflow=state.workflow;
    state.photoFolders=photoFolders.list('admin');
    return {...state,videos:photoVideos.list('admin'),videoSettings:photoVideos.settings(),publishedVideoSettings:photoVideos.publicSettings(),customerRecipeSummary:customerRecipeSummary(customerRecipe),workflow,features:{authentication:true,photoVideo:PHOTO_VIDEO_VERSION,garmentSources:GARMENT_SOURCES_VERSION,imagePreviews:1,managedPhotos:1,fullBackups:1,photoFolders:true,stopJobs:true,stagedProduction:true,optionalCamera:true,optionalPresetPools:true,characterPools:true,characterProfile:1,characterPromptSettings:1,characterPromptProfiles:1,characterTurnaround:1,gpuMemoryControl:true,presetPreviews:1,presetPreviewRatios:1,presetReview:1,photoCustomization:PHOTO_CUSTOMIZATION_VERSION,photoRefinement:PHOTO_REFINEMENT_VERSION,cameraFraming:CAMERA_FRAMING_VERSION},storage:{engine:'SQLite',search:'FTS5',presetCount:state.presets.length}};
  };
  const adminJob=(id,state)=>{
    const job=state ? state.jobs.find(row=>row.id===id && belongsToStudio(row))
      : store.read(current=>current.jobs.find(row=>row.id===id && belongsToStudio(row)));
    if(!job) throw fail('找不到你的拍攝任務。',404);
    return job;
  };
  const adminJobs=ids=>{const state=store.read();return ids.map(id=>adminJob(id,state));};
  async function comfyAt(base,endpoint,options = {}) {
    const imageQuery=endpoint.startsWith('/view?') ? new URLSearchParams(endpoint.slice(6)) : null;
    const image=imageQuery && {filename:imageQuery.get('filename'),subfolder:imageQuery.get('subfolder') || '',type:imageQuery.get('type') || 'output'};
    const saved=image && photoStorage.find(base,image);
    if(saved) return new Response(await fs.promises.readFile(saved.file),{headers:{'content-type':saved.mime}});
    let response;
    try { response = await fetchImpl(`${base}${endpoint}`,{...options,signal: AbortSignal.timeout(30000)}); }
    catch (error) { throw Object.assign(fail(`無法連接 ComfyUI（${base}）：${error.message}`,502),{connectionUnavailable:['ECONNREFUSED','ENOTFOUND','EHOSTUNREACH'].includes(error.cause?.code || error.code)}); }
    if (!response.ok) {
      const archived=image && photoStorage.find(base,image);
      if(archived) return new Response(await fs.promises.readFile(archived.file),{headers:{'content-type':archived.mime}});
      const text = await response.text();
      let message = text;
      try { const data = JSON.parse(text); message = [data.error?.message || data.error, ...Object.entries(data.node_errors || {}).map(([id,detail]) => `節點 ${id}: ${detail.errors?.map(e => e.details || e.message).join('; ')}`)].filter(Boolean).join(' · ') || text; } catch { /* upstream text response */ }
      throw fail(`ComfyUI ${response.status}: ${message.slice(0,2000)}`,502);
    }
    return response;
  }
  const comfyJson = async (endpoint,options = {},base = store.read().settings.comfyUrl) => (await comfyAt(base,endpoint,options)).json();
  function purgeOwnedOutputs(state,jobs,requireLocal=false) {
    const removeVideos=photoVideos.preparePurge(jobs);
    const removeManaged=photoStorage.preparePurge(state,jobs);
    const partition=managed=>jobs.map(job=>{
      const keep=(image,base=job.comfyUrl || state.settings.comfyUrl)=>Boolean(photoStorage.find(base,image))===managed;
      return {...job,images:(job.images || []).filter(image=>keep(image)),
        stageResults:Object.fromEntries(Object.entries(job.stageResults || {}).map(([stage,result])=>[stage,{...result,images:(result.images || []).filter(image=>keep(image,result.comfyUrl || job.comfyUrl || state.settings.comfyUrl))}])),
        sourceImage:job.sourceImage && keep(job.sourceImage,job.sourceComfyUrl || job.comfyUrl || state.settings.comfyUrl) ? job.sourceImage : undefined,
        cameraSource:job.cameraSource && keep(job.cameraSource.image,job.cameraSource.comfyUrl || job.sourceComfyUrl || job.comfyUrl || state.settings.comfyUrl) ? job.cameraSource : undefined};
    });
    const legacy=purgeJobOutputs(state,partition(false),outputDir(),{requireLocal});
    const rawManaged=purgeJobOutputs(state,partition(true),outputDir());
    return legacy+rawManaged+removeManaged()+removeVideos();
  }
  async function loadWorkflow(workflowPath = WORKFLOW_PATH) {
    if (typeof workflowPath !== 'string' || !workflowPath.endsWith('.json') || workflowPath.includes('..')) throw fail('工作流路徑無效。');
    const base = store.read().settings.comfyUrl;
    const uiWorkflow = await comfyJson(`/userdata/${encodeURIComponent(`workflows/${workflowPath}`)}`,{},base);
    const classes = [...new Set(uiWorkflow.nodes?.map(node => node.type).filter(type => !['MarkdownNote','Note'].includes(type)) || [])];
    if (!classes.length) throw fail('工作流沒有可執行的節點。');
    const schemas = await Promise.all(classes.map(type => comfyJson(`/object_info/${encodeURIComponent(type)}`,{},base)));
    const graph = convertWorkflow(uiWorkflow,Object.assign({},...schemas));
    fs.writeFileSync(path.join(dataDir,'workflow-source.json'),JSON.stringify(uiWorkflow,null,2));
    store.mutate(state => { state.workflow = graph; state.workflowName = workflowPath.split('/').pop().replace(/\.json$/,''); });
    return workflowSummary(graph,store.read().workflowName);
  }

  async function loadCameraWorkflow(workflowPath) {
    const state = store.read();
    workflowPath ||= state.settings.cameraWorkflowPath && state.settings.cameraWorkflowPath !== 'bundled' ? state.settings.cameraWorkflowPath : state.cameraWorkflowName?.endsWith('.json') ? state.cameraWorkflowName : cameraWorkflowPath(state.settings.cameraVersion);
    if(typeof workflowPath !== 'string' || !workflowPath.endsWith('.json') || workflowPath.includes('..')) throw fail('相機工作流路徑無效。');
    const base = state.settings.comfyUrl;
    const ui = await comfyJson(`/userdata/${encodeURIComponent(`workflows/${workflowPath}`)}`,{},base);
    const classes = [...new Set(ui.nodes?.map(node => node.type).filter(type => !['MarkdownNote','Note'].includes(type)) || [])];
    const schemas = await Promise.all(classes.map(type => comfyJson(`/object_info/${encodeURIComponent(type)}`,{},base)));
    const graph = convertWorkflow(ui,Object.assign({},...schemas),{validate:validateCameraWorkflow});
    fs.writeFileSync(path.join(dataDir,'camera-workflow-source.json'),JSON.stringify(ui,null,2));
    store.mutate(state => {state.cameraWorkflow = graph;state.cameraWorkflowName = workflowPath;state.settings.cameraWorkflowPath = workflowPath;state.settings.cameraVersion=cameraWorkflowVersion(graph);delete state.cameraWorkflowError;});
    return {ready:true,name:workflowPath};
  }
  app.post('/api/camera-workflow/load',async (req,res) => res.json(await loadCameraWorkflow(req.body.path)));
  app.post('/api/camera-workflow/import',(req,res) => {
    const graph = validateCameraWorkflow(req.body.workflow);
    store.mutate(state => {state.cameraWorkflow = graph;state.cameraWorkflowName = safeText(req.body.name || '相機角度',200,'名稱');state.settings.cameraVersion=cameraWorkflowVersion(graph);delete state.cameraWorkflowError;});
    res.json({ready:true});
  });
  app.put('/api/camera-workflow/version',async (req,res) => {
    const version=cameraVersion(req.body.cameraVersion ?? null).id;
    assertEnvironmentIdle();
    const snapshot=store.read();
    if(!snapshot.workflow) throw fail('請先載入角色與服裝工作流。');
    const result=await testComfyConnection({comfyUrl:snapshot.settings.comfyUrl,cameraWorkflowPath:'bundled',cameraVersion:version},comfyJson,{...connectionOptions,baseWorkflow:snapshot.workflow});
    if(!result.ready) return res.status(400).json({...publicConnectionTest(result),error:result.error || result.stages.flatMap(stage=>stage.errors).join(' · ')});
    assertEnvironmentIdle();
    const current=store.read();
    if(current.settings.comfyUrl!==snapshot.settings.comfyUrl || current.settings.cameraVersion!==snapshot.settings.cameraVersion || JSON.stringify(current.workflow)!==JSON.stringify(snapshot.workflow)) throw fail('連線或工作流設定已變更，請重新切換拍攝版本。',409);
    fs.writeFileSync(path.join(dataDir,'camera-workflow-source.json'),JSON.stringify(result.angle.ui,null,2));
    store.mutate(state=>{
      state.cameraWorkflow=result.angle.graph;state.cameraWorkflowName=cameraVersion(version).label+' · 3D 相機工作流';
      Object.assign(state.settings,{cameraVersion:version,cameraWorkflowPath:'bundled'});delete state.cameraWorkflowError;
      if(state.settings.environmentDraft?.comfyUrl===snapshot.settings.comfyUrl) state.settings.environmentDraft.cameraVersion=version;
    });
    res.json(publicConnectionTest(result));
  });
  const jobPrompt = (state,job,images) => buildCameraPipeline(job.workflowSnapshot || state.workflow,job.cameraWorkflowSnapshot || state.cameraWorkflow,job,images);
  app.get('/api/health',(req,res) => res.json({ok:true,app:'PhotoCreate'}));
  app.get('/api/state',(req,res) => res.json(publicState()));
  app.get('/api/photo-storage',(req,res)=>res.json(photoStorage.status()));
  app.post('/api/backups/export',async(req,res)=>res.json(await backups.exportZip()));
  app.get('/api/backups/:token',(req,res,next)=>{
    const archive=backups.download(req.params.token);
    res.download(archive.path,archive.name,error=>{archive.cleanup();if(error && !res.headersSent) next(error);});
  });
  app.put('/api/character-prompt-settings',(req,res)=>res.json(characterPromptProfiles.saveActive(req.body)));
  app.get('/api/character-prompt-profiles',(req,res)=>res.json(characterPromptProfiles.read()));
  app.post('/api/character-prompt-profiles',(req,res)=>res.status(201).json(characterPromptProfiles.create(req.body)));
  app.put('/api/character-prompt-profiles/:id',(req,res)=>res.json(characterPromptProfiles.update(req.params.id,req.body)));
  app.delete('/api/character-prompt-profiles/:id',(req,res)=>res.json(characterPromptProfiles.remove(req.params.id)));
  app.get('/api/photo-folders',(req,res)=>res.json(photoFolders.list('admin')));
  app.post('/api/photo-folders',(req,res)=>res.status(201).json(photoFolders.create('admin',req.body?.name)));
  app.patch('/api/photo-folders/:id',(req,res)=>res.json(photoFolders.rename('admin',req.params.id,req.body?.name)));
  app.delete('/api/photo-folders/:id',(req,res)=>res.json(photoFolders.remove('admin',req.params.id)));
  app.post('/api/jobs/move',(req,res)=>res.json(photoFolders.move('admin',req.body?.ids,req.body?.folderId)));
  app.post('/api/transfer/export',async (req,res) => res.json(await transfer.exportZip()));
  app.get('/api/transfer/export/:token',(req,res,next) => {
    const archive=transfer.download(req.params.token);
    res.download(archive.path,archive.name,error=>{archive.cleanup();if(error && !res.headersSent) next(error);});
  });
  const transferUpload=multer({storage:multer.diskStorage({destination:transfer.uploadDir,filename:(req,file,callback)=>callback(null,`${randomUUID()}.zip`)}),limits:{fileSize:LIMITS.archive,files:1,fields:0,parts:1}}).single('archive');
  app.post('/api/transfer/preview',(req,res,next)=> {
    if(Number(req.headers['content-length'])>LIMITS.archive+1024**2) return next(fail('資料 ZIP 最多 2 GB。',413));
    transferUpload(req,res,async error=> {
      if(error) {if(req.file) fs.rmSync(req.file.path,{force:true});return next(fail(error.code==='LIMIT_FILE_SIZE' ? '資料 ZIP 最多 2 GB。' : '請選擇一個資料 ZIP。'));}
      if(!req.file) return next(fail('請選擇資料 ZIP。'));
      try {res.json(await transfer.prepare(req.file.path));} catch(error) {fs.rmSync(req.file.path,{force:true});next(error);}
    });
  });
  app.post('/api/transfer/import',async (req,res)=> {
    if(req.body.applyDraft && store.read().jobs.some(job=>ACTIVE_STATUSES.includes(job.status))) throw fail('拍攝進行中，請先保留目前拍攝設定，或暫停後再套用。',409);
    res.json(await transfer.commit(req.body.token,{applyDraft:req.body.applyDraft ?? false}));
  });
  app.delete('/api/transfer/preview/:token',(req,res)=>{transfer.discard(req.params.token);res.json({ok:true});});
  app.put('/api/draft',(req,res) => {
    const draft=req.body?.draft ?? req.body,modeDrafts=req.body?.modeDrafts ?? {};
    if (!draft || typeof draft !== 'object' || Array.isArray(draft) || !modeDrafts || typeof modeDrafts!=='object' || Array.isArray(modeDrafts)) throw fail('拍攝設定格式不正確。');
    for(const [mode,value] of Object.entries(modeDrafts)) if(!['random','combinations'].includes(mode) || !value || typeof value!=='object' || Array.isArray(value) || value.mode!==mode) throw fail('拍攝模式設定格式不正確。');
    store.mutate(state => {state.draft = reconcileDraftCandidates(state,draft);state.workbenchDrafts={...state.workbenchDrafts,...Object.fromEntries(Object.entries(modeDrafts).map(([mode,value])=>[mode,reconcileDraftCandidates(state,value)])),[draft.mode || 'combinations']:state.draft};});
    res.json({ok:true});
  });
  app.put('/api/customer-recipe',(req,res)=>{
    if(!req.body || typeof req.body!=='object' || Array.isArray(req.body) || req.body.mode!=='random') throw fail('請在隨機寫真中設定顧客候選。');
    let recipe;
    try {const state=store.read();recipe=createCustomerRecipe(state,reconcileDraftCandidates(state,req.body));} catch(error) {throw fail(error.message);}
    store.mutate(state=>{state.customerRecipe=recipe;});
    photoVideos.publish();
    res.json(customerRecipeSummary(recipe));
  });
  app.put('/api/settings',(req,res) => {
    if(req.body.releaseGpuMemory!==undefined && typeof req.body.releaseGpuMemory!=='boolean') throw fail('GPU 記憶體釋放設定須為勾選或取消勾選。');
    const comfyUrl = normalizeComfyUrl(req.body.comfyUrl);
    if(environment.isActive() && (comfyUrl !== store.read().settings.comfyUrl || req.body.comfyDirectory !== undefined && req.body.comfyDirectory !== store.read().settings.comfyDirectory)) throw fail('請先暫停環境安裝，再變更目錄或連線。',409);
    const directory = req.body.comfyDirectory === undefined ? undefined : req.body.comfyDirectory === '' ? '' : validateComfyDirectory(req.body.comfyDirectory);
    if(comfyUrl!==store.read().settings.comfyUrl || directory!==undefined && directory!==store.read().settings.comfyDirectory) assertEnvironmentIdle();
    store.mutate(state => {rememberOutputLocations(state);state.settings.comfyUrl = comfyUrl;if(req.body.releaseGpuMemory!==undefined) state.settings.releaseGpuMemory=req.body.releaseGpuMemory;if(directory !== undefined) {state.settings.comfyDirectory = directory;state.settings.connectionMode='directory';}});
    res.json(store.read().settings);
  });
  app.get('/api/environment/install',(req,res) => res.json({job:environment.status()}));
  const installationSettings = () => store.read().settings.environmentDraft || store.read().settings;
  app.put('/api/environment/settings',(req,res) => {
    const comfyUrl=normalizeComfyUrl(req.body.comfyUrl),comfyDirectory=validateComfyDirectory(req.body.comfyDirectory);
    const previous=installationSettings();
    const version=cameraVersion(req.body.cameraVersion ?? previous.cameraVersion ?? store.read().settings.cameraVersion).id;
    if(previous.comfyUrl!==comfyUrl || previous.comfyDirectory!==comfyDirectory || previous.cameraVersion!==version) assertEnvironmentIdle();
    store.mutate(state=>{state.settings.environmentDraft={comfyUrl,comfyDirectory,cameraVersion:version};});
    res.json(store.read().settings);
  });
  app.post('/api/environment/directory/pick',async (req,res) => {
    if(pickingDirectory) throw fail('目錄選擇視窗已開啟。',409);
    pickingDirectory=true;
    try {res.json({directory:await directoryPicker(defaultComfyDirectory(store.read().settings))});} finally {pickingDirectory=false;}
  });
  app.get('/api/environment/plan',async (req,res) => {
    const directory=req.query.directory || defaultComfyDirectory(store.read().settings);
    if(!directory) return res.json({directory:'',resources:[],missingCoreNodes:[],connectionError:'',message:'選擇 ComfyUI 目錄後，即可檢查環境。'});
    const version=cameraVersion(req.query.cameraVersion ?? installationSettings().cameraVersion ?? store.read().settings.cameraVersion).id;
    const purpose=req.query.purpose || 'photo';if(!['photo','studio'].includes(purpose)) throw fail('環境安裝類型無效。');
    let videoModels=photoVideos.settings().effectiveModels;
    if(purpose==='studio' && req.query.videoModels) try {videoModels=normalizeVideoModels(JSON.parse(req.query.videoModels));} catch {throw fail('影片模型設定格式不正確。');}
    const plan=environment.plan(directory,{cameraVersion:version,purpose,videoModels:purpose==='studio' ? videoModels : undefined}),missingCoreNodes=[];let connectionError='',cameraReady=false;
    const base=req.query.url ? normalizeComfyUrl(req.query.url) : installationSettings().comfyUrl;
    try {
      for(const type of ['TextEncodeQwenImage21','QwenImage21Cache','QwenMultiangleCameraNode']) {
        const info=await comfyJson(`/object_info/${type}`,{},base);
        if(!info[type]) {if(type!=='QwenMultiangleCameraNode') missingCoreNodes.push(type);}
        else if(type==='QwenMultiangleCameraNode') {
          const fields={...info[type].input?.required,...info[type].input?.optional};
          cameraReady=fields.vertical_angle?.[1]?.min<=-90 && fields.zoom?.[1]?.max>=10;
        }
      }
    } catch(error) {connectionError=error.message;}
    const videoAvailability=purpose==='studio' ? await photoVideos.availability({models:videoModels,generationVersion:videoModels.latentUpscaler ? 'two-pass' : 'single'},base) : undefined;
    const videoCatalog=purpose==='studio' ? environment.videoCatalog() : undefined;
    const videoChoices=purpose==='studio' ? Object.fromEntries(Object.keys(videoModels).map(role=>[role,[...new Set([videoModels[role],...videoCatalog.filter(row=>row.role===role).map(row=>row.fileName),...(videoAvailability.choices?.[role] || [])])]])) : undefined;
    res.json({...plan,missingCoreNodes,connectionError,cameraReady,videoAvailability,videoCatalog,videoChoices});
  });
  app.get('/api/environment/video/plan',async (req,res) => {
    let input;
    try {input=req.query.models ? JSON.parse(req.query.models) : photoVideos.settings().effectiveModels;} catch {throw fail('影片模型設定格式不正確。');}
    const models=normalizeVideoModels(input),catalog=environment.videoCatalog();
    const base=req.query.url ? normalizeComfyUrl(req.query.url) : installationSettings().comfyUrl;
    const availability=await photoVideos.availability({models,generationVersion:models.latentUpscaler ? 'two-pass' : 'single'},base);
    const choices=Object.fromEntries(Object.keys(models).map(role=>[role,[...new Set([models[role],...catalog.filter(row=>row.role===role).map(row=>row.fileName),...(availability.choices?.[role] || [])])]]));
    const directory=req.query.local==='false' ? '' : req.query.directory || defaultComfyDirectory(store.read().settings);
    const plan=directory ? environment.plan(directory,{purpose:'video',videoModels:models}) : {directory:'',resources:[],modelsReady:false,filesReady:false,missingModelBytes:0,freeBytes:null,manualModels:[]};
    res.json({...plan,models,catalog,choices,availability,comfyUrl:base,active:base===store.read().settings.comfyUrl});
  });
  app.post('/api/environment/install',async (req,res) => {
    const purpose=req.body.purpose ?? 'photo';
    if(!['photo','video','studio'].includes(purpose)) throw fail('環境安裝類型無效。');
    if(store.read().jobs.some(job=>ACTIVE_STATUSES.includes(job.status))) throw fail('請先暫停拍攝製作，再安裝環境。',409);
    const settings=installationSettings(),directory=validateComfyDirectory(req.body.directory || settings.comfyDirectory);
    if(directory !== settings.comfyDirectory) throw fail('請先保存 ComfyUI 目錄設定。');
    const videoModels=purpose!=='photo' ? photoVideos.settings().effectiveModels : undefined;
    if(purpose!=='photo' && req.body.videoModels && JSON.stringify(normalizeVideoModels(req.body.videoModels))!==JSON.stringify(videoModels)) throw fail('請先保存 H3 模型選擇。',409);
    try {const queue=await comfyJson('/queue',{},settings.comfyUrl);if(queue.queue_running?.length || queue.queue_pending?.length) throw fail('ComfyUI 仍有製作中的任務，請等佇列完成後安裝。',409);} catch(error) {if(!error.connectionUnavailable) throw error;}
    assertEnvironmentIdle();
    if(directory!==installationSettings().comfyDirectory || settings.comfyUrl!==installationSettings().comfyUrl) throw fail('環境設定已變更，請重新檢查。',409);
    if(purpose!=='photo' && JSON.stringify(videoModels)!==JSON.stringify(photoVideos.settings().effectiveModels)) throw fail('H3 模型設定已變更，請重新檢查。',409);
    res.status(202).json({job:environment.start(directory,{includeModels:req.body.includeModels ?? true,cameraVersion:settings.cameraVersion ?? store.read().settings.cameraVersion,purpose,videoModels})});
  });
  app.post('/api/environment/pause',(req,res) => {
    if(req.body?.jobId && req.body.jobId!==environment.status()?.id) throw fail('安裝任務已變更，請重新檢查。',409);
    res.json({job:environment.pause()});
  });
  app.get('/api/environment/connection/workflows',async (req,res) => {
    const url=normalizeComfyUrl(req.query.url);
    const files=await comfyJson('/userdata?dir=workflows&recurse=true&split=false',{},url);
    res.json(files.filter(file=>typeof file==='string' && file.endsWith('.json')));
  });
  const connectionOptions={bundleDir:environmentOptions.bundleDir};
  app.post('/api/environment/connection/test',async (req,res) => res.json(publicConnectionTest(await testComfyConnection(req.body,comfyJson,connectionOptions))));
  function bindEnvironment(result,mode,directory) {
    assertEnvironmentIdle();
    fs.writeFileSync(path.join(dataDir,'workflow-source.json'),JSON.stringify(result.base.ui,null,2));
    fs.writeFileSync(path.join(dataDir,'camera-workflow-source.json'),JSON.stringify(result.angle.ui,null,2));
    store.mutate(state=> {
      rememberOutputLocations(state);
      Object.assign(state.settings,{comfyUrl:result.comfyUrl,connectionMode:mode,workflowPath:result.workflowPath,cameraWorkflowPath:result.cameraWorkflowPath,cameraVersion:result.cameraVersion,connectionCheckedAt:result.checkedAt});
      delete state.settings.environmentDraft;
      if(mode==='directory') state.settings.comfyDirectory=directory;else delete state.settings.comfyDirectory;
      state.workflow=result.base.graph;state.workflowName=result.workflowPath==='bundled' ? 'PhotoCreate 角色與服裝工作流' : result.workflowPath;
      state.cameraWorkflow=result.angle.graph;state.cameraWorkflowName=result.cameraWorkflowPath==='bundled' ? cameraVersion(result.cameraVersion).label+' · 3D 相機工作流' : result.cameraWorkflowPath;delete state.cameraWorkflowError;
    });
  }
  app.post('/api/environment/connection/bind',async (req,res) => {
    assertEnvironmentIdle();
    const result=await testComfyConnection(req.body,comfyJson,connectionOptions);
    if(!result.ready) return res.status(400).json({...publicConnectionTest(result),error:result.error || result.stages.flatMap(stage=>stage.errors).join(' · ')});
    bindEnvironment(result,'url');
    res.json(publicConnectionTest(result));
  });
  app.post('/api/environment/activate',async (req,res) => {
    assertEnvironmentIdle();
    const settings=installationSettings(),version=settings.cameraVersion ?? store.read().settings.cameraVersion,purpose=req.body?.purpose==='studio' ? 'studio' : 'photo',plan=environment.plan(settings.comfyDirectory,{cameraVersion:version,purpose,videoModels:purpose==='studio' ? photoVideos.settings().effectiveModels : undefined});
    if(!plan.modelsReady || !plan.filesReady) throw fail('仍有缺少或不同版本的環境檔案，請先完成安裝。');
    const result=await testComfyConnection({comfyUrl:settings.comfyUrl,workflowPath:BUNDLED_WORKFLOW_PATH,cameraWorkflowPath:cameraWorkflowPath(version),cameraVersion:version},comfyJson,connectionOptions);
    if(!result.ready) return res.status(400).json({...publicConnectionTest(result),error:result.error || result.stages.flatMap(stage=>stage.errors).join(' · ')});
    if(purpose==='studio') {const video=await photoVideos.availability(undefined,settings.comfyUrl);if(!video.ready) throw fail(video.error,503);}
    if(installationSettings().comfyDirectory!==plan.directory || installationSettings().comfyUrl!==settings.comfyUrl || installationSettings().cameraVersion!==settings.cameraVersion) throw fail('環境設定已變更，請重新檢查。',409);
    bindEnvironment(result,'directory',plan.directory);
    environment.activated();res.json({ready:true});
  });
  app.post('/api/garments',(req,res) => {
    const fields=garmentFields(req.body);
    if(fields.sourceType!=='prompt') throw fail('新增文字服裝請使用提詞版。');
    const row={id:randomUUID(),...fields,createdAt:new Date().toISOString()};
    store.mutate(state=>state.garments.unshift(row));
    res.status(201).json(row);
  });
  app.post('/api/assets/:kind',(req,res,next) => {
    if (!kinds.includes(req.params.kind)) return next(fail('圖庫類型無效。'));
    if (Number(req.headers['content-length']) > 150 * 1024 * 1024) return next(fail('每批上傳最多 150 MB。'));
    next();
  },upload.array('images',50), (req,res) => res.status(201).json(saveAssetUploads(req.params.kind,req.files,undefined,req.body?.profiles)));
  function saveAssetUploads(kind,files,visitorId,rawProfiles) {
    if (!files?.length) throw fail('請選擇 PNG、JPG 或 WebP 圖片。');
    const profiles=kind==='characters' ? uploadedCharacterProfiles(rawProfiles,files.length) : [];
    const detected = files.map(file => {
      const b = file.buffer;
      if (b.length >= 24 && b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return {ext:'.png',mime:'image/png'};
      if (b.length >= 12 && b[0] === 255 && b[1] === 216 && b[2] === 255) return {ext:'.jpg',mime:'image/jpeg'};
      if (b.length >= 12 && b.toString('ascii',0,4) === 'RIFF' && b.toString('ascii',8,12) === 'WEBP') return {ext:'.webp',mime:'image/webp'};
      throw fail('只支援有效的 PNG、JPG 或 WebP 圖片。');
    });
    const rows = files.map((file,index) => {
      const id = randomUUID();
      const fileName = `${id}${detected[index].ext}`;
      // Multer decodes filenames as latin1; browser FormData sends UTF-8.
      const originalName = /[^\x00-\x7f]/.test(file.originalname) ? Buffer.from(file.originalname,'latin1').toString('utf8') : file.originalname;
      fs.writeFileSync(path.join(dataDir,'uploads',fileName),file.buffer);
      return { id, name: path.parse(originalName).name.slice(0,200) || '未命名', description:visitorId && kind==='characters' ? 'Preserve the character identity shown in <image1>, including facial features, hair, and body proportions.' : '',tags:[],image:`/uploads/${fileName}`,fileName,mime:detected[index].mime,createdAt:new Date().toISOString(),...profiles[index],...(visitorId ? {visitorId} : {}) };
    });
    try {store.mutate(state => {state[kind].unshift(...rows);});}
    catch(error) {for(const row of rows) fs.rmSync(path.join(dataDir,'uploads',row.fileName),{force:true});throw error;}
    return rows;
  }
  app.patch('/api/assets/:kind/:id',(req,res) => {
    if (!kinds.includes(req.params.kind)) throw fail('圖庫類型無效。');
    const fields = req.params.kind==='garments' ? null : assetFields(req.body);
    const profile=req.params.kind==='characters' ? characterProfile(req.body) : {};
    const row = store.mutate(state => {
      const item = state[req.params.kind].find(item => item.id === req.params.id && belongsToStudio(item));
      if (!item) throw fail('找不到圖庫項目。',404);
      if(req.params.kind==='garments') {
        const garment=garmentFields({...item,...req.body});
        if(garment.sourceType==='image' && !item.fileName) throw fail('圖片版服裝需要先匯入參考圖。');
        return Object.assign(item,garment);
      }
      if(req.params.kind==='characters') for(const key of ['cupSize','heightCm']) if(Object.hasOwn(req.body,key)) {if(Object.hasOwn(profile,key)) item[key]=profile[key];else delete item[key];}
      return Object.assign(item,fields);
    });
    res.json(row);
  });
  app.delete('/api/assets/:kind/:id',(req,res) => {
    if (!kinds.includes(req.params.kind)) throw fail('圖庫類型無效。');
    if(!store.read()[req.params.kind].some(row=>row.id===req.params.id && belongsToStudio(row))) throw fail('找不到圖片。',404);
    const customerRecipeUpdated=store.mutate(state => {state[req.params.kind] = state[req.params.kind].filter(row => row.id !== req.params.id);return reconcileLibrarySelections(state);});
    // Files remain available for saved shot snapshots.
    res.json({ok:true,customerRecipeUpdated});
  });
  app.post('/api/presets',(req,res) => {
    const [preset] = normalizePresetImport([req.body]);
    store.mutate(state => {
      const index = state.presets.findIndex(row => row.id === preset.id);
      if (index === -1) state.presets.push(preset); else {
        if(preset.reviewed===undefined && state.presets[index].reviewed!==undefined) preset.reviewed=state.presets[index].reviewed;
        state.presets[index] = preset;
      }
      reconcileLibrarySelections(state);
    });
    res.json(preset);
  });
  app.post('/api/presets/import',(req,res) => {
    const rows = normalizePresetImport(req.body);
    store.mutate(state => {
      const merged = new Map(state.presets.map(row => [row.id,row]));
      for (const row of rows) merged.set(row.id,{...(merged.get(row.id)?.reviewed===undefined ? {} : {reviewed:merged.get(row.id).reviewed}),...row});
      state.presets = [...merged.values()];
      reconcileLibrarySelections(state);
    });
    res.json({count:rows.length});
  });
  app.get('/api/presets/search',(req,res) => {
    const q = String(req.query.q || '').slice(0,300);
    const category = String(req.query.category || '');
    if(category && !Object.hasOwn(CATEGORIES,category)) throw fail('提詞分類無效。');
    const limit = Math.max(1,Math.min(100,Number(req.query.limit) || 60));
    const offset = Math.max(0,Number(req.query.offset) || 0);
    res.json(store.searchPresets({q,category,limit:Math.floor(limit),offset:Math.floor(offset)}));
  });
  app.patch('/api/presets/:id/review',(req,res)=>{
    if(typeof req.body?.reviewed!=='boolean') throw fail('確認狀態須為勾選或取消勾選。');
    let preset;
    store.mutate(state=>{
      preset=state.presets.find(row=>row.id===req.params.id);
      if(!preset) throw fail('找不到這個提詞。',404);
      preset.reviewed=req.body.reviewed;
    });
    res.json(preset);
  });
  app.delete('/api/presets/:id',(req,res) => {
    const customerRecipeUpdated=store.mutate(state => {state.presets = state.presets.filter(row => row.id !== req.params.id);return reconcileLibrarySelections(state);});
    res.json({ok:true,customerRecipeUpdated});
  });

  app.get('/api/comfy/status',async (req,res) => {
    try {
      const stats = await comfyJson('/system_stats');
      res.json({connected:true,device:stats.devices?.[0]?.name || 'ComfyUI',version:stats.system?.comfyui_version});
    } catch (error) {res.json({connected:false,error:error.message});}
  });
  app.get('/api/comfy/workflows',async (req,res) => {
    const files = await comfyJson('/userdata?dir=workflows&recurse=true&split=false');
    res.json(files.filter(file => typeof file === 'string' && file.endsWith('.json')));
  });
  app.post('/api/workflow/load',async (req,res) => res.json(await loadWorkflow(req.body.path || WORKFLOW_PATH)));
  app.post('/api/workflow/import',async (req,res) => {
    let graph = req.body.workflow;
    if (graph?.nodes) {
      const types = [...new Set(graph.nodes.map(node => node.type).filter(type => !['MarkdownNote','Note'].includes(type)))];
      const schemas = await Promise.all(types.map(type => comfyJson(`/object_info/${encodeURIComponent(type)}`)));
      graph = convertWorkflow(graph,Object.assign({},...schemas));
    }
    graph = validateTemplate(graph?.prompt || graph);
    const name = safeText(req.body.name || WORKFLOW_NAME,200,'工作流名稱');
    store.mutate(state => {state.workflow = graph;state.workflowName = name;});
    res.json(workflowSummary(graph,name));
  });
  app.get('/api/workflow/export',(req,res) => {
    const state = store.read();
    if (!state.workflow) throw fail('請先載入工作流。');
    res.json(state.workflow);
  });

  app.post('/api/shots/preview',(req,res) => res.json(buildShotPlans(operatorState(store.read()),req.body)));
  function createShots(body,{visitorId,requestId,customerRecipe} = {}) {
    const state=store.read();
    const folderId=photoFolders.requireFolder(visitorId || 'admin',body.folderId);
    const plans = buildShotPlans(customerRecipe ? customerProductionState(state,customerRecipe) : operatorState(state),body);
    if(plans.some(job => productionStages(job).includes('angle')) && !store.read().cameraWorkflow) throw fail('請先載入 3D 相機換角度工作流。');
    const name = safeText(body.batchName ?? '',200,'拍攝組名稱') || defaultBatchName(plans);
    const batch = {id:randomUUID(),name,createdAt:new Date().toISOString(),...(visitorId ? {visitorId,visitorRequestId:requestId,characterId:body.characterId,count:plans.length,aspectRatio:body.aspectRatio,cameraEnabled:body.cameraEnabled !== false,folderId} : {})};
    const shots = plans.map(shot => ({...shot,batchId:batch.id,status:'draft',createdAt:batch.createdAt,images:[],...(productionStages(shot).includes('angle') ? {cameraVersion:cameraWorkflowVersion(state.cameraWorkflow),cameraWorkflowSnapshot:structuredClone(state.cameraWorkflow)} : {}),...(visitorId ? {visitorId} : {}),...(folderId ? {[visitorId ? 'folderId' : 'adminFolderId']:folderId} : {})}));
    store.mutate(state => {state.batches.unshift(batch);state.jobs.unshift(...shots);});
    return shots;
  }
  app.post('/api/jobs', (req,res) => res.status(201).json(createShots(req.body)));
  function remakeShots(body,{visitorId} = {}) {
    const {requestId,ids,deleteSourceOnComplete = false} = body;
    if(typeof requestId !== 'string' || !/^[\w-]{1,120}$/.test(requestId)) throw fail('重製請求 ID 無效。');
    if(!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string')) throw fail('請選擇 1–100 張已完成的成果。');
    if(typeof deleteSourceOnComplete !== 'boolean') throw fail('刪除舊圖設定無效。');
    const state = store.read();
    if(ids.some(id=>!state.jobs.some(job=>job.id===id && belongsToStudio(job,visitorId || 'admin')))) throw fail('找不到你的拍攝任務。',404);
    const existing = state.jobs.filter(job => job.remakeRequestId === requestId && belongsToStudio(job,visitorId || 'admin'));
    if(existing.length) {
      const requested = [...new Set(ids)].sort();
      if(JSON.stringify(existing.map(job => job.sourceJobId).sort()) !== JSON.stringify(requested) || existing.some(job => job.deleteSourceOnComplete !== deleteSourceOnComplete)) throw fail('此重製請求 ID 已用於另一組照片。',409);
      return {jobs:existing,created:false};
    }
    const createdAt = new Date().toISOString();
    const jobs = buildRemakePlans(state,ids,{requestId,deleteSourceOnComplete}).map(shot => ({...shot,status:'draft',createdAt,images:[],...(visitorId ? {visitorId} : {})}));
    store.mutate(current => {current.jobs.unshift(...jobs);});
    return {jobs,created:true};
  }
  app.post('/api/jobs/remake',(req,res) => {const result=remakeShots(req.body);res.status(result.created ? 201 : 200).json(result);});
  function angleShot(id,body,{visitorId} = {}) {
    const {requestId,angle,name = '自訂角度',imageIndex = 0,deleteSourceOnComplete = true,angleSteps = 20,refineDenoise = 0.2} = body;
    if(typeof requestId !== 'string' || !/^[\w-]{1,120}$/.test(requestId)) throw fail('換角度請求 ID 無效。');
    const cameraAngle = normalizeCameraAngle(angle);
    if(typeof deleteSourceOnComplete !== 'boolean' || !Number.isInteger(angleSteps) || angleSteps < 1 || angleSteps > 100 || typeof refineDenoise !== 'number' || !Number.isFinite(refineDenoise) || refineDenoise < 0.05 || refineDenoise > 0.4) throw fail('換角度製作設定無效。');
    const cameraName = safeText(name,200,'角度名稱');if(!cameraName) throw fail('請輸入角度名稱。');
    const state = store.read(),source = state.jobs.find(job => job.id === id && belongsToStudio(job,visitorId || 'admin'));
    if(!source) throw fail('找不到你的拍攝任務。',404);
    if(!state.cameraWorkflow || !state.workflow) throw fail('請先載入相機與 Qwen 2.1 工作流。');
    const existing = state.jobs.find(job => job.remakeRequestId === requestId && belongsToStudio(job,visitorId || 'admin'));
    if(existing) {
      if(existing.jobKind !== 'angle-edit' || existing.sourceJobId !== id || existing.sourceImageIndex !== imageIndex || JSON.stringify(existing.camera?.angle) !== JSON.stringify(cameraAngle) || existing.camera?.name !== cameraName || existing.angleSteps !== angleSteps || existing.refineDenoise !== refineDenoise || existing.deleteSourceOnComplete !== deleteSourceOnComplete) throw fail('此請求 ID 已用於另一個角度。',409);
      return {job:existing,created:false};
    }
    if(!source || !Number.isInteger(imageIndex) || imageIndex < 0 || !source.images?.[imageIndex]) throw fail('請選擇有成果圖的拍攝。');
    const cameraSource = resolveSelectedPhotoSource(state,source,imageIndex);
    const [plan] = buildRemakePlans(state,[source.id],{requestId,deleteSourceOnComplete,cameraSource});
    const version=cameraWorkflowVersion(state.cameraWorkflow);
    const job = {...plan,seed:cameraSource.seed ?? source.seed,jobKind:'angle-edit',cameraMode:'multiangle',cameraVersion:version,cameraEnabled:true,executionMode:'staged',camera:{id:`angle-${requestId}`,category:'camera',name:cameraName,angle:cameraAngle,prompt:cameraPrompt(cameraAngle,version),tags:[]},angleSteps,refineSteps:REFINE_STEPS,refineDenoise,
      workflowSnapshot:structuredClone(state.workflow),cameraWorkflowSnapshot:structuredClone(state.cameraWorkflow),cameraSource,sourceImage:structuredClone(cameraSource.image),sourceImageIndex:imageIndex,sourceComfyUrl:cameraSource.comfyUrl || state.settings.comfyUrl,
      name:`${source.garment.name} · ${cameraName} · 重製 ${plan.remakeVersion}`,prompt:`${cameraPrompt(cameraAngle,version)}\n\n高清修正：${REFINE_PROMPT}`,status:'draft',createdAt:new Date().toISOString(),images:[],...(visitorId ? {visitorId} : {})};
    delete job.sourceInput;
    delete job.sourceInputComfyUrl;
    store.mutate(current => current.jobs.unshift(job));
    return {job,created:true};
  }
  app.post('/api/jobs/:id/angle',(req,res) => {const result=angleShot(req.params.id,req.body);res.status(result.created ? 201 : 200).json(result);});
  function refineShot(id,body,{visitorId} = {}) {
    const {requestId,imageIndex=0}=body || {};
    if(typeof requestId!=='string' || !/^[\w-]{1,120}$/.test(requestId)) throw fail('畫質優化請求 ID 無效。');
    if(!Number.isInteger(imageIndex) || imageIndex<0 || imageIndex>99) throw fail('照片索引無效。');
    const state=store.read(),source=state.jobs.find(job=>job.id===id && belongsToStudio(job,visitorId || 'admin') && !job.visitorDeletedAt);
    if(!source) throw fail('找不到你的拍攝成果。',404);
    if(!state.workflow) throw fail('請先載入 Qwen 2.1 工作流。');
    const existing=state.jobs.find(job=>job.remakeRequestId===requestId && belongsToStudio(job,visitorId || 'admin'));
    if(existing) {
      if(existing.jobKind!=='refine-edit' || existing.sourceJobId!==id || existing.sourceImageIndex!==imageIndex) throw fail('此請求 ID 已用於另一個畫質優化。',409);
      return {job:existing,created:false};
    }
    const cameraSource=resolveSelectedPhotoSource(state,source,imageIndex);
    const [plan]=buildRemakePlans(state,[id],{requestId,deleteSourceOnComplete:false,cameraSource});
    const job={...plan,seed:cameraSource.seed ?? source.seed,jobKind:'refine-edit',cameraMode:'multiangle',cameraEnabled:false,executionMode:'staged',refineSteps:REFINE_STEPS,refineDenoise:0.2,
      workflowSnapshot:structuredClone(state.workflow),cameraSource,sourceImage:structuredClone(cameraSource.image),sourceImageIndex:imageIndex,sourceComfyUrl:cameraSource.comfyUrl || state.settings.comfyUrl,
      name:`${source.originalName || source.name} · 畫質優化 ${plan.remakeVersion}`,status:'draft',createdAt:new Date().toISOString(),images:[],...(visitorId ? {visitorId} : {})};
    for(const key of ['sourceInput','sourceInputComfyUrl','cameraWorkflowSnapshot']) delete job[key];
    store.mutate(current=>current.jobs.unshift(job));
    return {job,created:true};
  }
  app.post('/api/jobs/:id/refine',(req,res)=>{const result=refineShot(req.params.id,req.body);res.status(result.created ? 201 : 200).json(result);});
  function customShot(id,body,{visitorId} = {}) {
    const {requestId,imageIndex=0} = body || {};
    if(typeof requestId!=='string' || !/^[\w-]{1,120}$/.test(requestId)) throw fail('自訂拍攝請求 ID 無效。');
    if(!Number.isInteger(imageIndex) || imageIndex<0 || imageIndex>99) throw fail('照片索引無效。');
    const customization=normalizePhotoCustomization(body.customization);
    const state=store.read(),source=state.jobs.find(job=>job.id===id && belongsToStudio(job,visitorId || 'admin'));
    if(!source || source.visitorDeletedAt) throw fail('找不到你的拍攝成果。',404);
    if(!state.workflow) throw fail('請先載入 Qwen 2.1 工作流。');
    const existing=state.jobs.find(job=>job.remakeRequestId===requestId && belongsToStudio(job,visitorId || 'admin'));
    if(existing) {
      if(existing.jobKind!=='photo-edit' || existing.sourceJobId!==id || existing.sourceImageIndex!==imageIndex || JSON.stringify(normalizePhotoCustomization(existing.photoCustomization))!==JSON.stringify(customization)) throw fail('此請求 ID 已用於另一個自訂拍攝。',409);
      return {job:existing,created:false};
    }
    const photoSource=resolveSelectedPhotoSource(state,source,imageIndex);
    const recipe=visitorId ? getCustomerRecipe() : null,selectedPresets={};
    const garments=visitorId ? [...(recipe?.pools.garment || []),...state.garments.filter(row=>row.visitorId===visitorId)] : state.garments.filter(row=>belongsToStudio(row));
    const garment=customization.clothingMode==='reference' ? garments.find(row=>row.id===customization.garmentId) : null;
    if(customization.clothingMode==='reference' && !garment) throw fail('請選擇官方服裝或你上傳的服裝。');
    for(const [key,presetId] of Object.entries(customization.presetIds)) {
      const pool=visitorId ? recipe?.pools[key==='scene' ? 'interaction' : key] : state.presets;
      const row=pool?.find(row=>row.id===presetId && row.category===PHOTO_PRESET_CATEGORIES[key]);
      if(!row) throw fail(`請選擇攝影棚提供的${PHOTO_CHANGE_FIELDS[key]}官方選項。`);
      selectedPresets[key]=row;
    }
    const [plan]=buildRemakePlans(state,[id],{requestId,deleteSourceOnComplete:false,cameraSource:photoSource});
    let baseline=source;
    const visited=new Set();
    while(isPhotoSourceJob(baseline) && !visited.has(baseline.id)) {
      visited.add(baseline.id);
      const previous=state.jobs.find(row=>row.id===baseline.sourceJobId && belongsToStudio(row,visitorId || 'admin'));
      if(!previous) break;
      baseline=previous;
    }
    const cameraSettings=photoCameraSettings(state,source);
    if(cameraSettings.cameraEnabled) validateCameraWorkflow(cameraSettings.cameraWorkflowSnapshot);
    const job={...plan,jobKind:'photo-edit',cameraMode:'multiangle',cameraEnabled:false,executionMode:'staged',...cameraSettings,
      photoCustomization:customization,photoSource,sourceImageIndex:imageIndex,
      workflowSnapshot:structuredClone(state.workflow),prompt:customPhotoPrompt(customization,baseline,selectedPresets,garment),
      name:`${source.originalName || source.name} · 自訂拍攝 ${plan.remakeVersion}`,status:'draft',createdAt:new Date().toISOString(),images:[],...(visitorId ? {visitorId} : {})};
    for(const key of ['sourceImage','sourceComfyUrl','sourceInput','sourceInputComfyUrl','cameraSource']) delete job[key];
    if(!job.cameraEnabled) delete job.cameraWorkflowSnapshot;
    if(garment) job.garment=structuredClone(garment);
    else if(customization.changes.clothing) job.garment={id:`custom-clothing-${job.id}`,name:customization.changes.clothing.slice(0,80),sourceType:'prompt',prompt:clothingDescription(customization.changes.clothing),input:customization.changes.clothing,description:clothingDescription(customization.changes.clothing)};
    for(const key of Object.keys(PHOTO_PRESET_CATEGORIES)) {
      const field=key==='scene' ? 'interaction' : key;
      if(selectedPresets[key]) job[field]=structuredClone(selectedPresets[key]);
      else if(customization.changes[key]) job[field]={id:`custom-${key}-${job.id}`,name:customization.changes[key].slice(0,80),prompt:customization.changes[key]};
    }
    if(customization.changes.scene || selectedPresets.scene) {job.sceneInteraction='';delete job.scene;}
    if(customization.aspectRatio!=='original') {
      const size=getOutputSize(customization.aspectRatio,job.resolution);
      Object.assign(job,{aspectRatio:customization.aspectRatio,outputWidth:size.width,outputHeight:size.height});
    }
    store.mutate(current=>current.jobs.unshift(job));
    return {job,created:true};
  }
  app.post('/api/jobs/:id/custom',(req,res)=>{const result=customShot(req.params.id,req.body);res.status(result.created ? 201 : 200).json(result);});
  const deleteOutputs = (ids,replacedByJobId = null) => {
    const state = store.read();
    const jobs = [...new Set(ids)].map(id => state.jobs.find(job => job.id === id));
    if(jobs.some(job => !job || job.status !== 'completed')) throw fail('只能刪除已完成的成果。');
    const selected = new Set(ids);
    const imageKey = image => JSON.stringify([image.type || 'output',String(image.subfolder || '').replaceAll('\\','/'),image.filename]);
    const retained = new Set(state.jobs.filter(job => !selected.has(job.id)).flatMap(job => job.images || []).map(imageKey));
    const replacement = state.jobs.find(job => job.id === replacedByJobId);
    // A basic shoot's final output is also its original camera source.
    // Hide a replaced result while retaining the original for later angles.
    if(replacement?.jobKind === 'angle-edit' && replacement.cameraSource?.stage === 'base') retained.add(imageKey(replacement.cameraSource.image));
    const deleting=jobs.map(job=>({...job,images:(job.images || []).filter(image=>!retained.has(imageKey(image)))}));
    const deletedFiles = purgeOwnedOutputs(state,deleting,true);
    const deletedAt = new Date().toISOString();
    store.mutate(current => {
      for(const source of jobs) {
        const job = current.jobs.find(row => row.id === source.id);
        job.images = [];job.outputsDeletedAt = deletedAt;
        if(replacedByJobId) job.replacedByJobId = replacedByJobId;
      }
    });
    return {deletedJobs:jobs.length,deletedFiles};
  };
  const cleanupRemakes = () => {
    const jobs = store.read().jobs.filter(job => job.status === 'completed' && job.images?.length && job.sourceJobId && job.deleteSourceOnComplete && !job.sourceCleanupAt);
    for(const job of jobs) {
      try {
        const source = store.read().jobs.find(row => row.id === job.sourceJobId);
        if(source?.images?.length) deleteOutputs([source.id],job.id);
        store.mutate(state => {Object.assign(state.jobs.find(row => row.id === job.id),{sourceCleanupAt:new Date().toISOString(),sourceCleanupError:null});});
      } catch(error) {
        store.mutate(state => {const current = state.jobs.find(row => row.id === job.id);if(current) current.sourceCleanupError = error.message;});
      }
    }
  };
  app.post('/api/jobs/outputs/delete',(req,res) => {
    const {ids} = req.body;
    if(!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string')) throw fail('請選擇 1–100 張成果。');
    adminJobs(ids);
    res.json(deleteOutputs(ids));
  });
  app.get('/api/batches/:id/export',(req,res)=>{
    const result=store.read(state=>{
      const batch=state.batches.find(row=>row.id===req.params.id && belongsToStudio(row));
      if(!batch) throw fail('找不到拍攝組。',404);
      const {id,name,createdAt}=batch;
      return {version:1,batch:{id,name,createdAt},shots:state.jobs.filter(job=>job.batchId===id && belongsToStudio(job))};
    });
    res.json(result);
  });
  app.patch('/api/batches/:id',(req,res) => {
    const name = safeText(req.body.name,200,'拍攝組名稱');
    if(!name) throw fail('請輸入拍攝組名稱。');
    const batch = store.mutate(state => {
      const item = state.batches.find(row => row.id === req.params.id && belongsToStudio(row));
      if(!item) throw fail('找不到拍攝組。',404);
      item.name = name;return item;
    });
    res.json(batch);
  });
  app.delete('/api/batches/:id',(req,res) => {
    const deleting=operatorState(store.read()).jobs.filter(job=>job.batchId===req.params.id);
    if(deleting.some(job=>ACTIVE_STATUSES.includes(job.status) || submission?.ids.has(job.id))) throw fail('這組仍有傳送、生成或停止中的照片，請等處理完成後再移除。');
    photoVideos.preparePurge(deleting)();
    store.mutate(state => {
      if(!operatorState(state).batches.some(row => row.id === req.params.id)) throw fail('找不到拍攝組。',404);
      const jobs = state.jobs.filter(job => job.batchId === req.params.id);
      if(jobs.some(job => ACTIVE_STATUSES.includes(job.status) || submission?.ids.has(job.id))) throw fail('這組仍有傳送、生成或停止中的照片，請等處理完成後再移除。');
      state.jobs = state.jobs.filter(job => job.batchId !== req.params.id);
      state.batches = state.batches.filter(batch => batch.id !== req.params.id);
    });
    res.json({ok:true});
  });
  app.delete('/api/jobs/:id',(req,res) => {
    const deleting=adminJob(req.params.id);
    if(ACTIVE_STATUSES.includes(deleting.status) || submission?.ids.has(deleting.id)) throw fail('請等任務完成或確認停止後再移除。');
    photoVideos.preparePurge([deleting])();
    store.mutate(state => {
      const job = state.jobs.find(row => row.id === req.params.id);
      if (job && (ACTIVE_STATUSES.includes(job.status) || submission?.ids.has(job.id))) throw fail('請等任務完成或確認停止後再移除。');
      state.jobs = state.jobs.filter(row => row.id !== req.params.id);
      if(job?.batchId && !state.jobs.some(row => row.batchId === job.batchId)) state.batches = state.batches.filter(batch => batch.id !== job.batchId);
    });
    res.json({ok:true});
  });
  async function uploadReference(asset,base) {
    if (!asset?.fileName || path.basename(asset.fileName) !== asset.fileName) throw fail('參考圖檔名無效。');
    const buffer = fs.readFileSync(path.join(dataDir,'uploads',asset.fileName));
    const form = new FormData();
    form.append('image',new Blob([buffer],{type:asset.mime}),asset.fileName);
    form.append('type','input');
    form.append('subfolder','PhotoCreate');
    const result = await (await comfyAt(base,'/upload/image',{method:'POST',body:form})).json();
    return result.subfolder ? `${result.subfolder}/${result.name}` : result.name;
  }
  const uploadedAngleInputs=new Set();
  async function uploadAngleSource(job,base) {
    const cached=angleInputImage(job),cacheKey=JSON.stringify([job.id,base,job.sourceInput]);
    if(job.sourceInput && job.sourceInputComfyUrl === base && (uploadedAngleInputs.has(cacheKey) || !photoStorage.manageOutputs && !photoStorage.find(base,cached))) return job.sourceInput;
    const cachedInput = job.sourceInput && job.sourceInputComfyUrl;
    const source = cachedInput ? {filename:path.posix.basename(job.sourceInput),subfolder:path.posix.dirname(job.sourceInput) === '.' ? '' : path.posix.dirname(job.sourceInput),type:'input'} : job.sourceImage;
    if(!source?.filename || !['input','output','temp'].includes(source.type || 'output')) throw fail('原始成果圖資料無效。');
    const response = await comfyAt(cachedInput ? job.sourceInputComfyUrl : job.sourceComfyUrl || base,`/view?${new URLSearchParams({filename:source.filename,subfolder:source.subfolder || '',type:source.type || 'output'})}`);
    const blob = new Blob([await response.arrayBuffer()],{type:response.headers.get('content-type') || 'image/png'});
    const form = new FormData();form.append('image',blob,`angle-source-${job.id}.png`);form.append('type','input');form.append('subfolder','PhotoCreate');
    const result = await (await comfyAt(base,'/upload/image',{method:'POST',body:form})).json();
    if(!result.name) throw fail('原始成果圖上傳失敗。');
    const input = result.subfolder ? `${result.subfolder}/${result.name}` : result.name;
    store.mutate(state => Object.assign(state.jobs.find(row => row.id === job.id),{sourceInput:input,sourceInputComfyUrl:base}));
    uploadedAngleInputs.add(JSON.stringify([job.id,base,input]));
    return input;
  }
  const stopRequested = id => Boolean(store.read().jobs.find(job => job.id === id)?.stopRequestedAt);
  const waitingForSubmission = id => submission?.currentId === id && submission.phase === 'sending' || stageRunner.sending(id);
  const reconcileJob = (job,queue,history) => job.executionMode === 'staged' ? stageRunner.reconcile(job,queue,history) : store.mutate(state => {
    const current = state.jobs.find(row => row.id === job.id);
    if (!current || current.promptId !== job.promptId || ['completed','stopped'].includes(current.status)) return;
    // A sync started before Stop must not overwrite the newer stop state.
    if (current.stopRequestedAt && !job.stopRequestedAt) return;
    Object.assign(current,jobUpdateFromComfy(current,queue,history));
  });
  async function stopRemoteJob(job) {
    const key = `${job.id}:${job.promptId}`;
    if (stopAttempts.has(key)) return stopAttempts.get(key);
    const promise = (async () => {
      const base = job.comfyUrl || store.read().settings.comfyUrl;
      // ComfyUI's per-job API checks the running prompt atomically. Never use
      // a global interrupt or clear the shared ComfyUI queue.
      const result = await comfyJson(`/api/jobs/${encodeURIComponent(job.promptId)}/cancel`,{method:'POST'},base);
      if (typeof result.cancelled !== 'boolean') throw fail('ComfyUI 未確認取消結果，請更新狀態或再次停止。',502);
      if (result.cancelled) store.mutate(state => {
        const current = state.jobs.find(row => row.id === job.id);
        if (current?.promptId === job.promptId) current.stopDispatchedAt = new Date().toISOString();
      });
      const [queue,history] = await Promise.all([comfyJson('/queue',{},base),comfyJson(`/history/${encodeURIComponent(job.promptId)}`,{},base)]);
      const current = store.read().jobs.find(row => row.id === job.id);
      if(current?.promptId === job.promptId) reconcileJob(current,queue,history);
      return store.read().jobs.find(row => row.id === job.id);
    })();
    stopAttempts.set(key,promise);
    try {return await promise;} finally {stopAttempts.delete(key);}
  }
  const stageRunner = createStageRunner({store,comfyJson,comfyAt,uploadReference,uploadAngleSource,onCompleted:cleanupRemakes,onStop:stopRemoteJob,
    hasStoredImage:(base,image)=>photoStorage.manageOutputs || Boolean(photoStorage.find(base,image))});
  presetPreviews=createPresetPreviews({dataDir,store,outputDir,comfyJson,comfyAt,uploadReference,...presetPreviewOptions});
  characterTurnarounds=createCharacterTurnarounds({dataDir,store,outputDir,comfyJson,comfyAt,isInstalling:()=>environment.isActive() || galleryMusic?.hasWork() || photoVideos?.hasWork(),...characterTurnaroundOptions});
  galleryMusic=createGalleryMusic({dataDir,comfyJson,comfyAt,comfyUrl:()=>store.read().settings.comfyUrl,isBusy:()=>environment.isActive() || submitting || photoVideos?.hasWork() || presetPreviews.hasWork() || characterTurnarounds.hasWork() || stageRunner.hasWork() || store.read().jobs.some(job=>ACTIVE_STATUSES.includes(job.status)),...musicOptions});
  photoVideos=createPhotoVideos({dataDir,store,comfyJson,comfyAt,outputDir,isBusy:()=>environment.isActive() || submitting || backups.isBusy() || galleryMusic.hasWork() || presetPreviews.hasWork() || characterTurnarounds.hasWork() || store.read(state=>state.jobs.some(job=>ACTIVE_STATUSES.includes(job.status))),...photoVideoOptions});
  app.get('/api/photo-videos/settings',(req,res)=>res.json(photoVideos.settings()));
  app.get('/api/photo-videos/parameters',async(req,res)=>res.json(await photoVideos.parameters(req.query.generationVersion)));
  app.get('/api/photo-videos/test-images',(req,res)=> {
    const limit=Math.max(1,Math.min(24,Number(req.query.limit) || 12)),offset=Math.max(0,Number(req.query.offset) || 0),query=String(req.query.q || '').toLocaleLowerCase();
    const items=store.read(state=>state.jobs.filter(job=>belongsToStudio(job) && job.status==='completed' && !job.videoTestSourceId && !job.previewSessionId && !job.visitorDeletedAt && !job.outputsDeletedAt && (!query || (job.name || job.garment?.name || '').toLocaleLowerCase().includes(query))).flatMap(job=>(job.images || []).map((image,imageIndex)=>({jobId:job.id,imageIndex,name:job.name || job.garment?.name || '照片',image:'/api/jobs/'+job.id+'/image?index='+imageIndex}))));
    res.json({items:items.slice(offset,offset+limit),total:items.length});
  });
  app.get('/api/photo-videos/tests',(req,res)=>res.json(photoVideos.list('admin',undefined,{tests:true,sessionId:req.query.sessionId})));
  const videoTestUpload=multer({storage:multer.memoryStorage(),limits:{fileSize:25*1024*1024,files:1,fields:12}});
  app.post('/api/photo-videos/tests',videoTestUpload.single('image'),async(req,res)=> {
    if(environment.isActive()) throw fail('請先完成或暫停環境安裝，再測試影片。',409);
    const result=await photoVideos.testVideo(req.body,req.file);res.status(result.created ? 202 : 200).json(result);
  });
  app.post('/api/photo-videos/prompts',(req,res)=>res.status(201).json(photoVideos.savePrompt(req.body)));
  app.patch('/api/photo-videos/prompts/:id',(req,res)=>res.json(photoVideos.savePrompt(req.body,req.params.id)));
  app.delete('/api/photo-videos/prompts/:id',(req,res)=>res.json(photoVideos.removePrompt(req.params.id)));
  app.patch('/api/photo-videos/selection',(req,res)=> {
    if(!Array.isArray(req.body?.selectedPromptIds)) throw fail('請選擇要開放的影片提詞。');
    res.json(photoVideos.selectPrompts(req.body.selectedPromptIds));
  });
  app.post('/api/photo-videos/publish',(req,res)=>res.json(photoVideos.publish()));
  app.get('/api/photo-videos/workflows',async(req,res)=> {
    const base=req.query.url ? normalizeComfyUrl(req.query.url) : store.read().settings.comfyUrl;
    const paths=await comfyJson('/userdata?dir=workflows&recurse=true&split=false',{},base);
    res.json(paths.filter(value=>typeof value==='string' && value.endsWith('.json') && !value.endsWith('.api.json')));
  });
  app.get('/api/photo-videos/workflow/file',(req,res)=>{const version=req.query.generationVersion || photoVideos.settings().generationVersion;if(!['single','two-pass'].includes(version)) throw fail('影片版本無效。');res.attachment(version==='two-pass' ? '02 FastH3 Trim－升頻二採（5090 NVFP4）.json' : '01 FastH3 Trim - 圖生影片.json').json(videoUiTemplate(version));});
  app.get('/api/photo-videos/workflow',async(req,res)=> {
    const base=req.query.url ? normalizeComfyUrl(req.query.url) : store.read().settings.comfyUrl;
    res.json((await loadVideoWorkflow(comfyJson,{base,workflowPath:req.query.path || photoVideos.settings().workflowPath,generationVersion:req.query.generationVersion || photoVideos.settings().generationVersion})).workflow);
  });
  app.patch('/api/photo-videos/workflow',async(req,res)=> {
    if(environment.isActive()) throw fail('請先暫停環境安裝，再變更影片工作流。',409);
    if(req.body?.url && normalizeComfyUrl(req.body.url)!==store.read().settings.comfyUrl) throw fail('請先綁定此 ComfyUI，再套用影片工作流。',409);
    res.json(await photoVideos.saveWorkflow(req.body));
  });
  app.put('/api/photo-videos/settings',async(req,res)=> {
    if(environment.isActive() && (req.body.generationVersion!==undefined || req.body.workflowPath!==undefined)) throw fail('請先暫停環境安裝，再變更影片版本。',409);
    if(req.body.workflowParameters && environment.isActive()) throw fail('請先暫停環境安裝，再變更影片參數。',409);
    if(req.body.models && environment.isActive() && JSON.stringify(normalizeVideoModels(req.body.models))!==JSON.stringify(photoVideos.settings().models)) throw fail('請先暫停環境安裝，再變更 H3 模型。',409);
    res.json(await photoVideos.saveSettings(req.body));
  });
  app.patch('/api/photo-videos/models',(req,res)=> {
    if(environment.isActive()) throw fail('請先暫停環境安裝，再變更 H3 模型。',409);
    res.json(photoVideos.saveModels(req.body?.models));
  });
  app.get('/api/photo-videos/availability',async(req,res)=>res.json(await photoVideos.availability()));
  app.get('/api/jobs/:id/videos',(req,res)=>{adminJob(req.params.id);res.json(photoVideos.list('admin',req.params.id));});
  app.post('/api/jobs/:id/video',async(req,res)=>{const result=await photoVideos.generate('admin',req.params.id,req.body);res.status(result.created ? 202 : 200).json(result);});
  app.post('/api/photo-videos/:id/stop',async(req,res)=>res.json(await photoVideos.stop('admin',req.params.id)));
  app.delete('/api/photo-videos/:id',(req,res)=>res.json(photoVideos.remove('admin',req.params.id)));
  app.get('/api/photo-videos/:id/video',(req,res)=>{const file=photoVideos.file('admin',req.params.id);res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});if(req.query.download) res.attachment(`${req.params.id}.mp4`);res.type('video/mp4').sendFile(file);});
  const closeWithStages=store.close;
  store.close=()=>{galleryMusic.close();characterTurnarounds.close();presetPreviews.close();closeWithStages();};
  app.get('/api/music',(req,res)=>res.set('Cache-Control','no-store').json(galleryMusic.list()));
  app.get('/api/music/availability',async(req,res)=>res.json(await galleryMusic.availability()));
  app.put('/api/music/:id',async(req,res)=>res.status(202).json(await galleryMusic.generate(req.params.id,req.body)));
  app.post('/api/music/upload',multer({storage:multer.memoryStorage(),limits:{fileSize:80*1024*1024,files:1,fields:2,parts:3}}).single('audio'),(req,res)=>res.status(201).json(galleryMusic.upload(req.file,req.body)));
  app.patch('/api/music/:id',(req,res)=>res.json(galleryMusic.update(req.params.id,req.body)));
  app.delete('/api/music/:id',(req,res)=>res.json(galleryMusic.remove(req.params.id)));
  app.post('/api/music/:id/stop',async(req,res)=>res.json(await galleryMusic.cancel(req.params.id)));
  app.get('/api/music/:id/audio',(req,res)=>res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}).sendFile(galleryMusic.audio(req.params.id)));
  app.get('/api/presets/:id/photos',(req,res)=>res.set('Cache-Control','no-store').json(relatedPresetPhotos(store.read(),req.params.id,{limit:Number(req.query.limit ?? 5),offset:Number(req.query.offset ?? 0),sample:req.query.sample==='1'})));
  app.get('/api/garments/:id/photos',(req,res)=>res.set('Cache-Control','no-store').json(relatedGarmentPhotos(store.read(),req.params.id,{limit:Number(req.query.limit ?? 5),offset:Number(req.query.offset ?? 0),sample:req.query.sample==='1'})));
  app.put('/api/preset-previews/:id',(req,res)=>res.set('Cache-Control','no-store').json(presetPreviews.open(req.params.id,req.body.presetId,req.body.garmentId)));
  app.get('/api/preset-previews/:id',(req,res)=>res.set('Cache-Control','no-store').json(presetPreviews.status(req.params.id)));
  app.post('/api/preset-previews/:id/shots',(req,res)=>{if(galleryMusic.hasWork() || photoVideos.hasWork()) throw fail('音樂或影片製作中，請完成後再試拍。',409);res.status(202).set('Cache-Control','no-store').json(presetPreviews.shoot(req.params.id,req.body));});
  app.delete('/api/preset-previews/:id',(req,res)=>res.json(presetPreviews.stop(req.params.id)));
  app.get('/api/preset-previews/:id/jobs/:jobId/image/:index',(req,res)=>{
    const file=presetPreviews.imageFile(req.params.id,req.params.jobId,Number(req.params.index));
    res.set('Cache-Control','no-store').type(path.extname(file)).send(fs.readFileSync(file));
  });
  function queueShots(ids) {
    if(environment.isActive() || galleryMusic.hasWork() || photoVideos.hasWork()) throw fail('攝影棚正在準備影片、音樂或環境，請稍後再拍攝。',503);
    const snapshot=store.read();
    if(!snapshot.workflow || ids.some(id=>{const job=snapshot.jobs.find(row=>row.id===id);return job && productionStages(job).includes('angle') && !job.cameraWorkflowSnapshot && !snapshot.cameraWorkflow;})) throw fail('攝影棚尚未就緒，請稍後再試。',503);
    if(ids.some(id=>!snapshot.jobs.some(job=>job.id===id && RETRYABLE_STATUSES.includes(job.status)))) throw fail('這張照片已在拍攝中。',409);
    store.mutate(state=>{for(const job of state.jobs) if(ids.includes(job.id)) job.comfyOutputDir=outputDir();});
    // Stage runs persist their queue before awaiting uploads and advance on their own timer.
    // A visitor can leave the page while the shared GPU finishes the queued shoots.
    stageRunner.start(ids,snapshot).catch(error=>{
      store.mutate(state=>{for(const job of state.jobs) if(ids.includes(job.id) && !job.promptId && job.status!=='completed') Object.assign(job,{status:'failed',error:error.message});});
    });
  }
  async function stopShots(body,{visitorId} = {}) {
    const {ids,batchId,all} = body || {};
    if ([ids !== undefined,batchId !== undefined,all !== undefined].filter(Boolean).length !== 1) throw fail('請指定任務、拍攝組或全部製作。');
    const snapshot = store.read();
    const owned = snapshot.jobs.filter(job => belongsToStudio(job,visitorId || 'admin') && !job.visitorDeletedAt);
    let selected;
    if (all !== undefined) {
      if (all !== true) throw fail('全部停止參數無效。');
      selected = owned;
    } else if (batchId !== undefined) {
      if (typeof batchId !== 'string' || !snapshot.batches.some(batch => batch.id === batchId)) throw fail('找不到拍攝組。',404);
      selected = owned.filter(job => job.batchId === batchId);
      if(!selected.length) throw fail('找不到你的拍攝組。',404);
    } else {
      if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string')) throw fail('請選擇 1–100 個任務。');
      selected = [...new Set(ids)].map(id => owned.find(job => job.id === id));
      if (selected.some(job => !job)) throw fail('找不到拍攝任務。',404);
    }
    const targets = selected.filter(job => job.status !== 'completed' && (STOPPABLE_STATUSES.includes(job.status) || submission?.waiting.has(job.id) || submission?.currentId === job.id));
    store.mutate(state => {
      for (const target of targets) {
        const job = state.jobs.find(row => row.id === target.id);
        job.stopRequestedAt ||= new Date().toISOString();
        const unsent = stageRunner.waiting(job.id) || submission?.waiting.has(job.id) || (submission?.currentId === job.id && submission.phase === 'uploading');
        Object.assign(job,{status:unsent ? 'stopped' : 'stopping',error:null,...(unsent ? {finishedAt:new Date().toISOString()} : {})});
      }
    });
    const results = [];
    for (const target of targets) {
      const job = store.read().jobs.find(row => row.id === target.id);
      if (job.status === 'stopped' || waitingForSubmission(job.id)) {results.push({id:job.id,ok:true,status:job.status});continue;}
      try {
        if (!job.promptId) throw fail('任務沒有 ComfyUI ID，尚無法確認停止。',409);
        const current = await stopRemoteJob(job);
        results.push({id:job.id,ok:current.status !== 'uncertain',status:current.status,error:current.error});
      } catch (error) {
        store.mutate(state => {const current = state.jobs.find(row => row.id === job.id);if (current?.promptId === job.promptId) Object.assign(current,{status:'uncertain',error:`停止尚未確認：${error.message}`});});
        results.push({id:job.id,ok:false,error:error.message});
      }
    }
    cleanupRemakes();
    return {results};
  }
  app.post('/api/jobs/stop',async (req,res) => {
    const result = await stopShots(req.body);
    res.json({...result,jobs:publicState().jobs});
  });
  app.post('/api/jobs/submit',async (req,res) => {
    if(environment.isActive() || galleryMusic.hasWork() || photoVideos.hasWork()) throw fail('環境、影片或音樂製作進行中，請完成後再生成。',409);
    if (submitting) throw fail('正在送出另一批任務，請稍候。',409);
    if (!Array.isArray(req.body.ids) || !req.body.ids.length || req.body.ids.length > 100 || req.body.ids.some(id => typeof id !== 'string')) throw fail('請選擇 1–100 個草稿。');
    const snapshot = store.read();
    if (!snapshot.workflow) throw fail('請先載入 Qwen 工作流。');
    const ids = [...new Set(req.body.ids)];
    adminJobs(ids);
    const jobs = ids.map(id => {
      const job = snapshot.jobs.find(row => row.id === id);
      if (!job || !RETRYABLE_STATUSES.includes(job.status)) throw fail('只能送出草稿、失敗或已停止的任務。');
      return job;
    });
    store.mutate(state=>{for(const job of state.jobs) if(ids.includes(job.id)) job.comfyOutputDir=outputDir();});
    if(jobs.some(job => job.cameraMode === 'multiangle')) {
      if(jobs.some(job => job.cameraMode !== 'multiangle')) throw fail('請將原有拍攝與分階段拍攝分開送出。');
      submitting = true;
      try {return res.json(await stageRunner.start(ids,snapshot));} finally {submitting = false;}
    }
    if(stageRunner.hasWork()) throw fail('分階段製作中，請完成或暫停後再送出原有拍攝。',409);
    submitting = true;
    submission = {ids:new Set(ids),waiting:new Set(ids),currentId:null,phase:null};
    // A retry is a new attempt. Clear only old stop markers before the loop;
    // requests made during this submission must remain effective.
    store.mutate(state => {for (const job of state.jobs) if (submission.ids.has(job.id)) {delete job.stopRequestedAt;delete job.stopDispatchedAt;}});
    const results = [];
    const uploaded = new Map();
    try {
      for (const job of jobs) {
        if (stopRequested(job.id)) {results.push({id:job.id,ok:false,stopped:true});continue;}
        submission.waiting.delete(job.id);
        submission.currentId = job.id;
        submission.phase = 'uploading';
        store.mutate(state => {const current = state.jobs.find(row => row.id === job.id);delete current.promptId;delete current.finishedAt;Object.assign(current,{status:'submitting',error:null});});
        let attemptedPrompt = false;
        try {
          const images = {};
          if(isPhotoSourceJob(job)) images.source = await uploadAngleSource(job,snapshot.settings.comfyUrl);
          for (const kind of isPhotoSourceJob(job) ? [] : referenceKinds(job)) {
            const asset = job[kind];
            if (!uploaded.has(asset.id)) uploaded.set(asset.id,await uploadReference(asset,snapshot.settings.comfyUrl));
            images[kind] = uploaded.get(asset.id);
            if (stopRequested(job.id)) break;
          }
          if (stopRequested(job.id)) {results.push({id:job.id,ok:false,stopped:true});continue;}
          const prompt = jobPrompt(snapshot,job,images);
          if(job.cameraMode === 'multiangle') store.mutate(state => Object.assign(state.jobs.find(row => row.id === job.id),{workflowSnapshot:job.workflowSnapshot || structuredClone(snapshot.workflow),cameraWorkflowSnapshot:job.cameraWorkflowSnapshot || structuredClone(snapshot.cameraWorkflow)}));
          // Save the exact graph before submitting. A stable prompt_id allows
          // reconciliation if ComfyUI receives the request but the reply is lost.
          const promptId = randomUUID();
          store.mutate(state => {Object.assign(state.jobs.find(row => row.id === job.id),{promptId,comfyUrl:snapshot.settings.comfyUrl,apiPrompt:prompt});});
          attemptedPrompt = true;
          submission.phase = 'sending';
          const result = await comfyJson('/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt,prompt_id:promptId,client_id:'photocreate-studio'})},snapshot.settings.comfyUrl);
          if (!result.prompt_id) throw fail('ComfyUI 回應缺少 prompt_id。',502);
          submission.phase = 'queued';
          store.mutate(state => {const current = state.jobs.find(row => row.id === job.id);Object.assign(current,{status:current.stopRequestedAt ? 'stopping' : 'queued',promptId:result.prompt_id,submittedAt:new Date().toISOString()});});
          if (stopRequested(job.id)) {
            const current = await stopRemoteJob(store.read().jobs.find(row => row.id === job.id));
            results.push(current.status === 'uncertain' ? {id:job.id,ok:false,error:current.error} : current.status === 'completed' ? {id:job.id,ok:true} : {id:job.id,ok:false,stopped:true});
          } else results.push({id:job.id,ok:true});
        } catch (error) {
          // An ambiguous network result must never become a retryable draft.
          const ambiguous = attemptedPrompt && !/^ComfyUI 4\d\d:/.test(error.message);
          store.mutate(state => {Object.assign(state.jobs.find(row => row.id === job.id),{status:ambiguous ? 'uncertain' : 'failed',error:error.message});});
          submission.phase = 'queued';
          if (stopRequested(job.id) && !attemptedPrompt) store.mutate(state => {Object.assign(state.jobs.find(row => row.id === job.id),{status:'stopped',error:null,finishedAt:new Date().toISOString()});});
          results.push({id:job.id,ok:false,error:error.message});
          break;
        }
      }
    } finally { submitting = false;submission = null; }
    res.json({results});
  });
  app.post('/api/jobs/sync',async (req,res) => {
    if (syncing) return res.json(publicState().jobs);
    syncing = true;
    try {
      await stageRunner.tick();
      await photoVideos.tick();
      const jobs = store.read().jobs.filter(job => job.executionMode !== 'staged' && ['queued','running','stopping','uncertain'].includes(job.status) && job.promptId);
      const queues = new Map();
      for (const job of jobs) {
        const base = job.comfyUrl || store.read().settings.comfyUrl;
        try {
          if (waitingForSubmission(job.id)) continue;
          if(job.executionMode === 'staged' && job.stageWaiting) continue;
          if (job.stopRequestedAt) {await stopRemoteJob(job);continue;}
          if (!queues.has(base)) queues.set(base,await comfyJson('/queue',{},base));
          const history = await comfyJson(`/history/${encodeURIComponent(job.promptId)}`,{},base);
          reconcileJob(job,queues.get(base),history);
        } catch { /* Preserve status during connection outages. */ }
      }
      cleanupRemakes();
      res.json(publicState().jobs);
    } finally { syncing = false; }
  });
  app.get('/api/jobs/:id/prompts',(req,res) => {
    const job=adminJob(req.params.id);
    if(!job) throw fail('找不到這張照片。',404);
    res.json(photoPromptDetails(store.read(),job,{apiBase:'/api'}));
  });
  app.get('/api/jobs/:id/prompt',(req,res) => {
    const state = store.read();
    const job = adminJob(req.params.id);
    if (!job) throw fail('找不到拍攝任務。',404);
    if(job.executionMode === 'staged') {
      const names = productionStages(job);
      const templates = [job.workflowSnapshot || state.workflow,job.cameraWorkflowSnapshot || state.cameraWorkflow];
      const references = Object.fromEntries(referenceKinds(job).map(kind => [kind,`PhotoCreate/${job[kind].fileName}`]));
      const sourceFor = stage => {
        if(isPhotoSourceJob(job) && stage===names[0]) return job.sourceInput || `PhotoCreate/angle-source-${job.id}.png`;
        const previous = stage === 'angle' ? 'base' : 'angle',image = job.stageResults?.[previous]?.images?.[0];
        return job.stageInputs?.[stage]?.image || (image ? `${image.subfolder ? image.subfolder+'/' : ''}${image.filename} [${image.type || 'output'}]` : `PhotoCreate/_stages/${job.id}/${previous}_00001_.png [output]`);
      };
      const stages = names.map(stage => ({stage,prompt:job.stageResults?.[stage]?.apiPrompt || buildCameraStage(...templates,job,stage,stage === 'base' ? references : {source:sourceFor(stage)})}));
      return res.json({executionMode:'staged',prompt:job.apiPrompt || stages[0].prompt,stages,note:'工作檯依整組分階段執行，階段間釋放模型。手動執行時須依序完成每階段，再使用實際的中間圖檔名。'});
    }
    if (job.apiPrompt) return res.json({prompt:job.apiPrompt});
    if (!state.workflow) throw fail('請先載入工作流。');
    const images = isPhotoSourceJob(job) ? {source:job.sourceInput || `PhotoCreate/angle-source-${job.id}.png`} : Object.fromEntries(referenceKinds(job).map(kind => [kind,`PhotoCreate/${job[kind].fileName}`]));
    res.json({prompt:jobPrompt(state,job,images),note:isPhotoSourceJob(job) ? '由工作檯送出會自動上傳選取的成果圖。' : `執行前請將 ${referenceKinds(job).length} 張參考圖放進 ComfyUI/input/PhotoCreate，或直接由工作檯送出。`});
  });
  async function serveAngleSource(id,index,res) {
    const state = store.read(),job = state.jobs.find(row => row.id === id);
    if(!job) throw fail('找不到拍攝任務。',404);
    index = Number(index ?? 0);
    if(!Number.isInteger(index) || index < 0 || index > 99) throw fail('原圖索引無效。');
    const source = resolveSelectedPhotoSource(state,job,index),image = source.image;
    const saved=photoStorage.find(source.comfyUrl || state.settings.comfyUrl,image);
    if(saved) return res.set('Cache-Control','private, no-cache').type(saved.mime).sendFile(saved.file);
    const response = await comfyAt(source.comfyUrl || state.settings.comfyUrl,`/view?${new URLSearchParams({filename:image.filename,subfolder:image.subfolder || '',type:image.type || 'output'})}`);
    res.set('Content-Type',response.headers.get('content-type') || 'image/png');
    res.send(Buffer.from(await response.arrayBuffer()));
  }
  app.get('/api/jobs/:id/angle-source',async (req,res) => {adminJob(req.params.id);await serveAngleSource(req.params.id,req.query.index,res);});
  async function serveAssetImage(row,{thumbnail,download}={},res) {
    if(!row?.fileName || path.basename(row.fileName)!==row.fileName) throw fail('找不到參考圖片。',404);
    const file=path.join(dataDir,'uploads',row.fileName);
    if(!fs.existsSync(file)) throw fail('參考圖片已不存在。',404);
    if(thumbnail!==undefined && !download) return imagePreviews.send(res,{key:`upload:${row.fileName}`,file,size:thumbnail});
    res.type(['image/png','image/jpeg','image/webp'].includes(row.mime) ? row.mime : 'image/png').sendFile(file);
  }
  async function serveCharacterReference(id,res,query={}) {
    const row=store.read(state=>state.jobs.find(job=>job.id===id)?.character);
    await serveAssetImage(row,query,res);
  }
  app.get('/api/jobs/:id/character-reference',async(req,res)=>{adminJob(req.params.id);await serveCharacterReference(req.params.id,res,req.query);});
  async function serveJobImage(id,index,{stage,download,thumbnail},res) {
    const job = store.read(state=>state.jobs.find(row => row.id === id));
    if(stage !== undefined && !['base','angle'].includes(stage)) throw fail('圖片階段無效。');
    const source = stage === undefined ? job : job?.stageResults?.[stage];
    const image = job && !job.outputsDeletedAt && (stage === undefined || source?.completed) ? source?.images?.[Number(index)] : null;
    if (!image) throw fail('找不到輸出圖片。',404);
    const query = new URLSearchParams({filename:image.filename,subfolder:image.subfolder || '',type:image.type || 'output'});
    const settings=store.read(state=>state.settings),base=source.comfyUrl || job.comfyUrl || settings.comfyUrl;
    const saved=photoStorage.find(base,image);
    if(thumbnail!==undefined && !download) {
      let file=saved?.file;
      if(!file && ['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname) && (image.type || 'output')==='output' && /^PhotoCreate(?:[\\/]|$)/.test(image.subfolder || '')) {
        file=resolveOutputFile(outputDirectoryForJob({...job,comfyUrl:base},settings,comfyOutputDir || comfyOutputDirectory(settings)),image);
      }
      return imagePreviews.send(res,{key:JSON.stringify([base,image,stage]),file,size:thumbnail,load:async()=>Buffer.from(await (await comfyAt(base,`/view?${query}`)).arrayBuffer())});
    }
    if(saved) {
      if(download) res.attachment(path.basename(image.filename));
      return res.set('Cache-Control','private, no-cache').type(saved.mime).sendFile(saved.file);
    }
    const response = await comfyAt(base,`/view?${query}`);
    res.set('Content-Type',response.headers.get('content-type') || 'image/png');
    if (download) res.attachment(path.basename(image.filename));
    res.send(Buffer.from(await response.arrayBuffer()));
  }
  app.get('/api/jobs/:id/image/:index',async (req,res) => {adminJob(req.params.id);await serveJobImage(req.params.id,req.params.index,req.query,res);});

  if (fs.existsSync(path.join(rootDir,'dist'))) {
    app.use(express.static(path.join(rootDir,'dist')));
    app.get('/{*path}',(req,res) => res.sendFile(path.join(rootDir,'dist','index.html')));
  }
  app.use((error,req,res,next) => {
    const message = error instanceof multer.MulterError ? (req.path==='/api/music/upload' ? '請選擇一首 80 MB 以下的音樂檔案。' : error.code === 'LIMIT_FILE_SIZE' ? '每張圖片最多 25 MB。' : '每批最多 50 張圖片，請分批匯入。') : error.message;
    res.status(error.status || 400).json({error:message});
  });
  // A process restart cannot determine if a request was received by ComfyUI.
  store.mutate(state => {for (const job of state.jobs) if(job.status === 'submitting') {job.status = job.promptId ? 'uncertain' : 'failed';job.error = '工作檯曾中斷，請重新整理 ComfyUI 任務狀態。';}});
  // Unsubmitted drafts can adopt the corrected reference format; submitted records retain their actual prompt.
  store.mutate(state => {for (const job of state.jobs) if(job.status === 'draft' && !job.promptId && !job.apiPrompt) job.prompt = referenceOnlyPrompt(job);});
  return {app,store,authentication,loadWorkflow,loadCameraWorkflow,stageRunner,environment,transfer,presetPreviews,characterTurnarounds,galleryMusic,photoVideos,photoStorage,backups};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {app,store,loadWorkflow,loadCameraWorkflow,galleryMusic} = createApp({dataDir:process.env.PHOTOCREATE_DATA_DIR || undefined});
  const port = Number(process.env.PHOTOCREATE_PORT || 8764);
  const host = process.env.PHOTOCREATE_HOST || '0.0.0.0';
  app.listen(port,host,() => console.log(`PhotoCreate: http://${host}:${port}`));
  if(store.read().settings.cameraWorkflowPath!=='bundled') loadCameraWorkflow().catch(error => {store.mutate(state => {state.cameraWorkflowError = error.message;});console.log('相機工作流：' + error.message);});
  if (!store.read().workflow) loadWorkflow(store.read().settings.workflowPath || WORKFLOW_PATH).then(() => console.log('Qwen workflow loaded: character and clothing references')).catch(error => console.log(error.message));
  // Explicit operator bootstrap, using this server's sole music journal writer.
  // Wait for a shared engine to become idle without cancelling other projects.
  if(process.argv.includes('--generate-piano')) {
    const id=randomUUID(),until=Date.now()+45*60*1000;
    const seed=async()=>{
      if(galleryMusic.list().some(row=>row.kind==='piano' && row.status==='completed' && row.enabled)) return;
      try {
        if(galleryMusic.hasWork()) throw fail('Music is already active.',409);
        const track=await galleryMusic.generate(id,{name:'森林微光 · 鋼琴',kind:'piano',durationCap:DEFAULT_PIANO_DURATION_CAP,caption:DEFAULT_PIANO_CAPTION});console.log('鋼琴配樂任務：'+track.id);
      } catch(error) {
        if(error.status===409 && Date.now()<until) {const timer=setTimeout(seed,30000);timer.unref();}
        else console.log('鋼琴配樂：'+error.message);
      }
    };
    seed();
  }
}
