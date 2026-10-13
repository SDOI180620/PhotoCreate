import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {OUTPUT_RATIOS} from '../shared/domain.js';
import {isPromptGarment} from '../shared/garments.js';
import {STOPPABLE_STATUSES,RETRYABLE_STATUSES} from '../shared/batches.js';
import {photoPromptDetails} from './photo-prompts.js';
import {customerDraft,customerCharacters} from './customer-recipe.js';
import {CUSTOMER_MAX_SHOOT_COUNT} from '../shared/customer-recipe.js';
import {productionStages,PHOTO_REFINEMENT_VERSION} from '../shared/production.js';
import {CAMERA_FRAMING_VERSION} from '../shared/camera.js';
import {PHOTO_CUSTOMIZATION_VERSION,PHOTO_PRESET_CATEGORIES,photoSettings} from '../shared/photo-customization.js';
import {photoPresetGroupIds} from '../shared/photo-preset-groups.js';
import {createFeaturedGallery} from './featured-gallery.js';
import {characterProfile} from '../shared/character-profile.js';
import {characterTurnaroundRouter,turnaroundImageType} from './character-turnarounds.js';
import {createCustomerPrompts} from './customer-prompts.js';
import {customerShootRecipe} from './customer-shoots.js';
import {PHOTO_VIDEO_VERSION,videoIsActive} from '../shared/photo-video.js';

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const publicCharacter=(row,visitorId)=>({id:row.id,name:row.name,image:`/api/studio/characters/${row.id}/image${row.updatedAt ? `?v=${encodeURIComponent(row.updatedAt)}` : ''}`,...characterProfile(row),owned:row.visitorId===visitorId});
const publicGarment=(row,visitorId)=>({id:row.id,name:row.name,sourceType:isPromptGarment(row) ? 'prompt' : 'image',...(row.visitorId===visitorId ? {owned:true} : {}),...(!isPromptGarment(row) ? {image:`/api/studio/garments/${row.id}/image`} : {})});
const publicJob=job=>{
  const base=`/api/studio/jobs/${job.id}`;
  const images=(job.images || []).map((_,index)=>`${base}/image/${index}`);
  const previewStage=['angle','base'].find(stage=>job.stageResults?.[stage]?.completed && job.stageResults[stage].images?.length);
  return {id:job.id,rootId:job.rootJobId || job.id,batchId:job.batchId,version:job.remakeVersion || 0,
    createdAt:job.createdAt,status:job.status,stage:job.pipelineStage || 'base',images,folderId:job.folderId || '',
    preview:!job.outputsDeletedAt && previewStage ? `${base}/image/0?stage=${previewStage}` : null,
    angle:job.camera?.angle,cameraEnabled:productionStages(job).includes('angle'),garment:job.garment?.name || '',pose:job.pose?.name || '',
    width:job.outputWidth,height:job.outputHeight,aspectRatio:job.aspectRatio || 'reference',resolution:job.resolution,settings:photoSettings(job),characterReference:{name:job.character?.name || '原本選取的角色',image:`${base}/character-reference`},
    error:job.error ? job.status==='failed' ? '這張照片未完成，請重新拍攝。' : '攝影棚正在重新確認連線，請稍候。' : '',
    canRetry:RETRYABLE_STATUSES.includes(job.status),canStop:STOPPABLE_STATUSES.includes(job.status),active:STOPPABLE_STATUSES.includes(job.status)};
};

// Every read and mutation checks the authenticated account's stable owner ID.
export function createVisitorRouter({store,dataDir,photoFolders,isInstalling,getCustomerRecipe,getCustomerVideoSettings,getCharacterTurnarounds,getGalleryMusic,getPhotoVideos,uploadCharacter,uploadGarment,createShots,remakeShots,angleShot,refineShot,customShot,queueShots,stopShots,purgeOutputs,sendImage,sendAngleSource,sendCharacterReference,sendAssetImage}) {
  const router=express.Router();
  const gallery=createFeaturedGallery(store,ownerId=>getPhotoVideos().list(ownerId));
  const customerPrompts=createCustomerPrompts(store);
  const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:25*1024*1024,files:1,fields:1,parts:2,fieldSize:20000}}).single('image');
  const editUpload=multer({storage:multer.memoryStorage(),limits:{fileSize:25*1024*1024,files:1,fields:3,parts:4,fieldSize:20000}}).single('image');
  router.use((req,res,next)=>{
    if(req.account?.role!=='customer') return next(fail('請先登入顧客帳號。',401));
    req.visitorId=req.account.owner_id;
    req.customerRecipe=getCustomerRecipe(req.account.customer_config_id);
    req.customerVideoSettings=getCustomerVideoSettings(req.account.customer_config_id);
    res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
    next();
  });
  router.use('/character-turnarounds',characterTurnaroundRouter(getCharacterTurnarounds,req=>req.visitorId));
  const ownedJob=(id,visitorId,includeDeleted=false)=>{
    const job=store.read(state=>state.jobs.find(row=>row.id===id && row.visitorId===visitorId && (includeDeleted || !row.visitorDeletedAt)));
    if(!job) throw fail('找不到這張照片。',404);
    return job;
  };
  const selectedJobs=(req,includeDeleted=false)=>{
    const ids=req.body?.ids;
    if(!Array.isArray(ids) || !ids.length || ids.length>100 || ids.some(id=>typeof id!=='string')) throw fail('請選擇 1–100 張照片。');
    return [...new Set(ids)].map(id=>ownedJob(id,req.visitorId,includeDeleted));
  };
  const selectedFamilies=(req,trashOnly=false)=>{
    const selected=selectedJobs(req,true);
    if(trashOnly && selected.some(job=>!job.visitorDeletedAt)) throw fail('請先把照片移到回收區。',409);
    const roots=new Set(selected.map(job=>job.rootJobId || job.id));
    const jobs=store.read().jobs.filter(job=>job.visitorId===req.visitorId && roots.has(job.rootJobId || job.id) && (!trashOnly || job.visitorDeletedAt));
    if(jobs.some(job=>STOPPABLE_STATUSES.includes(job.status))) throw fail('請先停止拍攝，確認停止後才能刪除。',409);
    return jobs;
  };
  const assertVideosStopped=jobs=>{
    const ids=new Set(jobs.map(job=>job.id));
    if(store.read(state=>(state.photoVideos || []).some(row=>ids.has(row.jobId) && videoIsActive(row)))) throw fail('請先停止這張照片的影片，確認停止後再刪除。',409);
  };
  const permanentlyDelete=(jobs,folder)=>{
    if(jobs.some(job=>STOPPABLE_STATUSES.includes(job.status))) throw fail('請先暫停拍攝，確認停止後才能永久刪除。',409);
    assertVideosStopped(jobs);
    const ids=new Set(jobs.map(job=>job.id));
    let deletedFiles;
    try {deletedFiles=purgeOutputs(jobs,true);} catch {throw fail('照片檔案暫時無法清理，請稍後再試或聯絡攝影棚管理員。');}
    store.mutate(state=>{
      state.jobs=state.jobs.filter(job=>!ids.has(job.id));
      state.galleryEntries=(state.galleryEntries || []).filter(row=>!ids.has(row.jobId));
      const batches=new Set(jobs.map(job=>job.batchId));
      state.batches=state.batches.filter(batch=>!batches.has(batch.id) || state.jobs.some(job=>job.batchId===batch.id));
      if(folder) state.photoFolders=(state.photoFolders || []).filter(row=>row.id!==folder.id || row.ownerId!==folder.ownerId);
    });
    return {ok:true,count:jobs.length,deletedFiles};
  };
  const permanentRequest=req=>{
    const permanent=req.body?.permanent ?? false;
    if(typeof permanent!=='boolean') throw fail('刪除範圍格式無效。');
    return permanent;
  };
  const requestId=(value,visitorId)=>{
    if(typeof value!=='string' || !/^[\w-]{8,48}$/.test(value)) throw fail('請重新整理後再試一次。');
    return `${visitorId}-${value}`;
  };
  const assertReady=(cameraEnabled=false)=>{
    const state=store.read();
    if(!state.workflow || cameraEnabled && !state.cameraWorkflow || isInstalling()) throw fail('攝影棚正在準備，請稍後再試。',503);
  };
  const stateFor=(visitorId,recipe,videoSettings)=>{
    const state=store.read(current=>({
      characters:customerCharacters(current,recipe,visitorId).map(row=>publicCharacter(row,visitorId)),
      garments:current.garments.filter(row=>row.visitorId===visitorId).map(row=>publicGarment(row,visitorId)),
      jobs:current.jobs.filter(job=>job.visitorId===visitorId && !job.visitorDeletedAt).map(publicJob),
      trash:current.jobs.filter(job=>job.visitorId===visitorId && job.visitorDeletedAt).map(job=>({...publicJob(job),deletedAt:job.visitorDeletedAt})),
      workflow:Boolean(current.workflow),cameraWorkflow:Boolean(current.cameraWorkflow),
    }));
    const videos=getPhotoVideos().list(visitorId);
    return {characters:state.characters,photoVideo:PHOTO_VIDEO_VERSION,videos,videoSettings:{defaultDuration:videoSettings.defaultDuration,defaultAspectRatio:videoSettings.defaultAspectRatio,prompts:videoSettings.prompts},
      folders:photoFolders.list(visitorId),
      gallery:gallery.list(visitorId),galleryFolders:gallery.folders(visitorId),
      music:getGalleryMusic().list(true),
      jobs:state.jobs.map(job=>({...job,videos:videos.filter(row=>row.jobId===job.id)})),trash:state.trash,
      ready:Boolean(recipe && ['garment','pose','lighting','color','quality'].every(key=>recipe.pools[key]?.length) && state.workflow && !isInstalling()),cameraReady:Boolean(state.workflow && state.cameraWorkflow && !isInstalling()),
      wardrobeCount:recipe?.pools.garment.length || 0,maxCount:CUSTOMER_MAX_SHOOT_COUNT,canQueueShoots:true,canStopShootBatches:true,canEditCharacters:true,canPermanentlyDeletePhotos:true,characterProfile:1,characterTurnaround:1,turnaroundReady:Boolean(state.workflow && !isInstalling()),photoCustomization:PHOTO_CUSTOMIZATION_VERSION,cameraFraming:CAMERA_FRAMING_VERSION,
      garmentSources:1,photoRefinement:PHOTO_REFINEMENT_VERSION,refineReady:Boolean(state.workflow && !isInstalling()),
      personalLibrary:1,customerPrompts:customerPrompts.list(visitorId),
      garments:[...(recipe?.pools.garment || []).map(row=>publicGarment(row,visitorId)),...state.garments],
      presets:Object.entries(PHOTO_PRESET_CATEGORIES).flatMap(([key,category])=>(recipe?.pools[key==='scene' ? 'interaction' : key] || []).filter(row=>row.category===category).map(row=>({id:row.id,category,name:row.name,groupIds:photoPresetGroupIds(row)}))),
      cameras:(recipe?.pools.camera || []).map(row=>({id:row.id,name:row.name,angle:row.angle})),
    };
  };
  router.get('/state',(req,res)=>res.json(stateFor(req.visitorId,req.customerRecipe,req.customerVideoSettings)));
  router.get('/prompts',(req,res)=>res.json(customerPrompts.list(req.visitorId)));
  router.post('/prompts',(req,res)=>{
    const result=customerPrompts.save(req.visitorId,req.body);
    res.status(result.created ? 201 : 200).json(result.prompt);
  });
  router.patch('/prompts/:id',(req,res)=>res.json(customerPrompts.save(req.visitorId,req.body,req.params.id).prompt));
  router.delete('/prompts/:id',(req,res)=>res.json(customerPrompts.remove(req.visitorId,req.params.id)));
  router.post('/garments',upload,(req,res)=>{
    if(!req.file) throw fail('請選擇 PNG、JPG 或 WebP 服裝圖片。');
    const [garment]=uploadGarment([req.file],req.visitorId);
    res.status(201).json(publicGarment(garment,req.visitorId));
  });
  router.patch('/garments/:id',(req,res)=>{
    if(typeof req.body?.name!=='string' || !req.body.name.trim() || req.body.name.trim().length>200 || Object.keys(req.body).some(key=>key!=='name')) throw fail('服裝名稱需為 1–200 個字。');
    const garment=store.mutate(state=>{
      const row=state.garments.find(row=>row.id===req.params.id && row.visitorId===req.visitorId);
      if(!row) throw fail('找不到你的服裝。',404);
      row.name=req.body.name.trim();
      return row;
    });
    res.json(publicGarment(garment,req.visitorId));
  });
  router.delete('/garments/:id',(req,res)=>{
    store.mutate(state=>{
      if(!state.garments.some(row=>row.id===req.params.id && row.visitorId===req.visitorId)) throw fail('找不到你的服裝。',404);
      // Completed and pending photographs retain their own reference snapshots.
      state.garments=state.garments.filter(row=>row.id!==req.params.id || row.visitorId!==req.visitorId);
    });
    res.json({ok:true});
  });
  router.get('/music',(req,res)=>res.json(getGalleryMusic().list(true)));
  router.get('/photo-videos/availability',async(req,res)=>{const {ready}=await getPhotoVideos().availability();res.json({ready,error:ready ? '' : '影片功能正在準備，請聯絡攝影棚管理員完成 H3 工作流與模型設定。'});});
  router.get('/jobs/:id/videos',(req,res)=>{ownedJob(req.params.id,req.visitorId);res.json(getPhotoVideos().list(req.visitorId,req.params.id));});
  router.post('/jobs/:id/video',async(req,res)=>{let result;try {result=await getPhotoVideos().generate(req.visitorId,req.params.id,req.body,{publishedSettings:req.customerVideoSettings});} catch(error) {if(error.status===503) throw fail('影片功能正在準備，請聯絡攝影棚管理員完成設定。',503);throw error;}res.status(result.created ? 202 : 200).json(result);});
  router.post('/photo-videos/:id/stop',async(req,res)=>res.json(await getPhotoVideos().stop(req.visitorId,req.params.id)));
  router.delete('/photo-videos/:id',(req,res)=>res.json(getPhotoVideos().remove(req.visitorId,req.params.id)));
  router.get('/photo-videos/:id/video',(req,res)=>{const file=getPhotoVideos().file(req.visitorId,req.params.id);if(req.query.download) res.attachment(`${req.params.id}.mp4`);res.type('video/mp4').sendFile(file);});
  router.get('/music/:id/audio',(req,res)=>res.sendFile(getGalleryMusic().audio(req.params.id,true)));
  router.get('/gallery',(req,res)=>res.json(gallery.list(req.visitorId)));
  router.post('/gallery',(req,res)=>{const result=gallery.add(req.visitorId,req.body);res.status(result.created ? 201 : 200).json(result);});
  router.post('/gallery/move',(req,res)=>res.json(gallery.move(req.visitorId,req.body?.ids,req.body?.folderId)));
  router.post('/gallery/remove',(req,res)=>res.json(gallery.remove(req.visitorId,req.body?.ids)));
  router.get('/gallery/folders',(req,res)=>res.json(gallery.folders(req.visitorId)));
  router.post('/gallery/folders',(req,res)=>res.status(201).json(gallery.createFolder(req.visitorId,req.body?.name)));
  router.patch('/gallery/folders/:id',(req,res)=>res.json(gallery.renameFolder(req.visitorId,req.params.id,req.body?.name)));
  router.delete('/gallery/folders/:id',(req,res)=>res.json(gallery.removeFolder(req.visitorId,req.params.id)));
  router.get('/folders',(req,res)=>res.json(photoFolders.list(req.visitorId)));
  router.post('/folders',(req,res)=>res.status(201).json(photoFolders.create(req.visitorId,req.body?.name)));
  router.patch('/folders/:id',(req,res)=>res.json(photoFolders.rename(req.visitorId,req.params.id,req.body?.name)));
  router.delete('/folders/:id',(req,res)=>{
    const deletePhotos=req.body?.deletePhotos ?? false;
    if(typeof deletePhotos!=='boolean') throw fail('刪除範圍格式無效。');
    if(!deletePhotos) return res.json(photoFolders.remove(req.visitorId,req.params.id));
    photoFolders.requireFolder(req.visitorId,req.params.id);
    const roots=new Set(store.read().jobs.filter(job=>job.visitorId===req.visitorId && job.folderId===req.params.id).map(job=>job.rootJobId || job.id));
    const jobs=store.read().jobs.filter(job=>job.visitorId===req.visitorId && roots.has(job.rootJobId || job.id));
    const result=permanentlyDelete(jobs,{id:req.params.id,ownerId:req.visitorId});
    res.json(result);
  });
  router.post('/photos/move',(req,res)=>res.json(photoFolders.move(req.visitorId,req.body?.ids,req.body?.folderId)));
  router.post('/photos/delete',(req,res)=>{
    if(permanentRequest(req)) return res.json(permanentlyDelete(selectedFamilies(req)));
    const jobs=selectedFamilies(req),ids=new Set(jobs.map(job=>job.id)),deletedAt=new Date().toISOString();assertVideosStopped(jobs);
    store.mutate(state=>{for(const job of state.jobs) if(ids.has(job.id) && job.visitorId===req.visitorId) job.visitorDeletedAt ||= deletedAt;});
    res.json({ok:true,count:jobs.length});
  });
  router.post('/photos/purge',(req,res)=>{
    res.json(permanentlyDelete(selectedFamilies(req,true)));
  });
  router.get('/jobs/:id/prompts',(req,res)=>{
    const job=ownedJob(req.params.id,req.visitorId,true);
    res.json(photoPromptDetails(store.read(),job));
  });
  const changeDeleted=(req,res,deleting)=>{
    const job=ownedJob(req.params.id,req.visitorId,true),allVersions=req.body?.allVersions ?? false;
    if(typeof allVersions!=='boolean') throw fail('刪除範圍格式無效。');
    const root=job.rootJobId || job.id;
    const jobs=allVersions ? store.read().jobs.filter(row=>row.visitorId===req.visitorId && (row.rootJobId || row.id)===root) : [job];
    if(deleting && permanentRequest(req)) return res.json(permanentlyDelete(jobs));
    if(deleting) assertVideosStopped(jobs);
    if(jobs.some(row=>STOPPABLE_STATUSES.includes(row.status))) throw fail('照片正在拍攝，完成後才能刪除。',409);
    const ids=new Set(jobs.map(row=>row.id)),deletedAt=new Date().toISOString();
    store.mutate(state=>{for(const row of state.jobs) if(ids.has(row.id) && row.visitorId===req.visitorId) {if(deleting) row.visitorDeletedAt ||= deletedAt;else delete row.visitorDeletedAt;}});
    res.json({ok:true,count:jobs.length});
  };
  router.delete('/jobs/:id',(req,res)=>changeDeleted(req,res,true));
  router.post('/jobs/:id/restore',(req,res)=>changeDeleted(req,res,false));
  router.post('/characters',upload,(req,res)=>{
    if(!req.file) throw fail('請選擇 PNG、JPG 或 WebP 圖片。');
    const [character]=uploadCharacter([req.file],req.visitorId,req.body?.profiles);
    res.status(201).json(publicCharacter(character,req.visitorId));
  });
  router.patch('/characters/:id',(req,res,next)=>{
    if(!store.read().characters.some(row=>row.id===req.params.id && row.visitorId===req.visitorId)) return next(fail('找不到你的角色。',404));
    next();
  },editUpload,(req,res)=>{
    const body=req.body;
    if(!body || typeof body!=='object' || Array.isArray(body) || !Object.keys(body).length || Object.keys(body).some(key=>!['name','cupSize','heightCm'].includes(key))) throw fail('角色資料格式不正確。');
    if(Object.hasOwn(body,'name') && (typeof body.name!=='string' || !body.name.trim() || body.name.trim().length>200)) throw fail('角色名稱需為 1–200 個字。');
    const profile=characterProfile(body),type=req.file && turnaroundImageType(req.file.buffer);
    const fileName=type && `${randomUUID()}${type.ext}`,file=fileName && path.join(dataDir,'uploads',fileName);
    if(file) fs.writeFileSync(file,req.file.buffer);
    let character;
    try {
      character=store.mutate(state=>{
        const row=state.characters.find(item=>item.id===req.params.id && item.visitorId===req.visitorId);
        if(!row) throw fail('找不到你的角色。',404);
        if(Object.hasOwn(body,'name')) row.name=body.name.trim();
        for(const key of ['cupSize','heightCm']) if(Object.hasOwn(body,key)) {if(Object.hasOwn(profile,key)) row[key]=profile[key];else delete row[key];}
        if(fileName) Object.assign(row,{fileName,mime:type.mime,image:`/uploads/${fileName}`});
        row.updatedAt=new Date().toISOString();
        return row;
      });
    } catch(cause) {if(file) fs.unlinkSync(file);throw cause;}
    // Existing shoots retain their original character reference file and profile.
    res.json(publicCharacter(character,req.visitorId));
  });
  router.delete('/characters/:id',(req,res)=>{
    if(!store.read().characters.some(row=>row.id===req.params.id && row.visitorId===req.visitorId)) throw fail('找不到你的角色。',404);
    // Keep reference files for existing job snapshots and unfinished shoots.
    store.mutate(state=>{state.characters=state.characters.filter(row=>row.id!==req.params.id || row.visitorId!==req.visitorId);});
    res.json({ok:true});
  });
  router.get('/characters/:id/image',async(req,res)=>{
    const recipe=req.customerRecipe;
    const row=store.read(state=>customerCharacters(state,recipe,req.visitorId).find(row=>row.id===req.params.id));
    if(!row || !row.fileName || path.basename(row.fileName)!==row.fileName) throw fail('找不到角色圖片。',404);
    const file=path.join(dataDir,'uploads',row.fileName);
    if(!fs.existsSync(file)) throw fail('角色圖片已不存在。',404);
    await sendAssetImage(row,req.query,res);
  });
  router.get('/garments/:id/image',async(req,res)=>{
    const row=store.read(state=>state.garments.find(row=>row.id===req.params.id && row.visitorId===req.visitorId)) || req.customerRecipe?.pools.garment.find(row=>row.id===req.params.id);
    if(isPromptGarment(row) || !row?.fileName || path.basename(row.fileName)!==row.fileName) throw fail('找不到服裝圖片。',404);
    const file=path.join(dataDir,'uploads',row.fileName);
    if(!fs.existsSync(file)) throw fail('服裝圖片已不存在。',404);
    await sendAssetImage(row,req.query,res);
  });
  router.post('/shoots',(req,res)=>{
    const body=req.body || {},key=requestId(body.requestId,req.visitorId),count=body.count,aspectRatio=body.aspectRatio || '9:16',cameraEnabled=body.cameraEnabled ?? false;
    const mode=body.mode ?? 'random';
    if(!['random','custom'].includes(mode)) throw fail('請選擇隨機或自定義拍攝。');
    const customerShootKey=JSON.stringify({mode,selections:mode==='custom' ? body.selections ?? {} : {}});
    const folderId=photoFolders.requireFolder(req.visitorId,body.folderId);
    if(typeof cameraEnabled!=='boolean') throw fail('鏡頭設定無效。');
    if(!Number.isInteger(count) || count<1 || count>CUSTOMER_MAX_SHOOT_COUNT) throw fail(`每次可以拍攝 1–${CUSTOMER_MAX_SHOOT_COUNT} 張照片。`);
    if(!Object.hasOwn(OUTPUT_RATIOS,aspectRatio)) throw fail('請選擇有效的照片比例。');
    const state=store.read(),character=customerCharacters(state,req.customerRecipe,req.visitorId).find(row=>row.id===body.characterId);
    if(!character) throw fail('請先上傳或選擇你的角色。');
    const existing=state.batches.find(row=>row.visitorId===req.visitorId && row.visitorRequestId===key);
    if(existing) {
      if(existing.characterId!==character.id || existing.count!==count || existing.aspectRatio!==aspectRatio || (existing.cameraEnabled ?? true)!==cameraEnabled || (existing.folderId || '')!==folderId) throw fail('這次拍攝設定已變更，請重新送出。',409);
      if((existing.customerShootKey || JSON.stringify({mode:'random',selections:{}}))!==customerShootKey) throw fail('這次拍攝候選已變更，請重新送出。',409);
      return res.json({jobs:state.jobs.filter(job=>job.batchId===existing.id && job.visitorId===req.visitorId).map(publicJob),created:false});
    }
    assertReady(cameraEnabled);
    if(!req.customerRecipe) throw fail('攝影棚正在準備，請稍後再試。',503);
    const recipe=mode==='custom' ? customerShootRecipe(req.customerRecipe,body.selections,customerPrompts.list(req.visitorId),state.garments.filter(row=>row.visitorId===req.visitorId)) : req.customerRecipe;
    const draft=customerDraft(recipe,{count,characterId:character.id,aspectRatio,batchName:`${character.name}的攝影棚`,cameraEnabled});
    const jobs=createShots({...draft,folderId},{visitorId:req.visitorId,requestId:key,customerRecipe:recipe,customerShootKey});
    queueShots(jobs.map(job=>job.id));
    res.status(202).json({jobs:store.read().jobs.filter(job=>jobs.some(row=>row.id===job.id)).map(publicJob),created:true});
  });
  router.post('/jobs/:id/remake',(req,res)=>{
    const source=ownedJob(req.params.id,req.visitorId);assertReady(productionStages(source).includes('angle'));
    const result=remakeShots({ids:[req.params.id],requestId:requestId(req.body?.requestId,req.visitorId),deleteSourceOnComplete:false},{visitorId:req.visitorId});
    if(result.created) queueShots(result.jobs.map(job=>job.id));
    res.status(result.created ? 202 : 200).json({jobs:result.jobs.map(publicJob),created:result.created});
  });
  router.post('/jobs/:id/angle',(req,res)=>{
    ownedJob(req.params.id,req.visitorId);assertReady(true);
    const body=req.body || {};
    const result=angleShot(req.params.id,{requestId:requestId(body.requestId,req.visitorId),angle:body.angle,name:'自訂角度',imageIndex:body.imageIndex ?? 0,deleteSourceOnComplete:false},{visitorId:req.visitorId});
    if(result.created) queueShots([result.job.id]);
    res.status(result.created ? 202 : 200).json({job:publicJob(result.job),created:result.created});
  });
  router.post('/jobs/:id/custom',(req,res)=>{
    ownedJob(req.params.id,req.visitorId);assertReady(false);
    const body=req.body || {};
    const result=customShot(req.params.id,{requestId:requestId(body.requestId,req.visitorId),imageIndex:body.imageIndex ?? 0,customization:body.customization},{visitorId:req.visitorId,customerRecipe:req.customerRecipe});
    if(result.created) queueShots([result.job.id]);
    res.status(result.created ? 202 : 200).json({job:publicJob(result.job),created:result.created});
  });
  router.post('/jobs/:id/refine',(req,res)=>{
    ownedJob(req.params.id,req.visitorId);assertReady(false);
    const body=req.body || {};
    const result=refineShot(req.params.id,{requestId:requestId(body.requestId,req.visitorId),imageIndex:body.imageIndex ?? 0},{visitorId:req.visitorId});
    if(result.created) queueShots([result.job.id]);
    res.status(result.created ? 202 : 200).json({job:publicJob(result.job),created:result.created});
  });
  router.post('/jobs/:id/retry',(req,res)=>{
    const job=ownedJob(req.params.id,req.visitorId);assertReady(productionStages(job).includes('angle'));
    if(!RETRYABLE_STATUSES.includes(job.status)) throw fail('這張照片正在拍攝，請稍候。',409);
    queueShots([job.id]);res.status(202).json({ok:true});
  });
  router.post('/jobs/retry',(req,res)=>{
    const jobs=selectedJobs(req);
    if(jobs.some(job=>!RETRYABLE_STATUSES.includes(job.status))) throw fail('請等停止確認後，再繼續未完成的拍攝。',409);
    assertReady(jobs.some(job=>productionStages(job).includes('angle')));
    queueShots(jobs.map(job=>job.id));res.status(202).json({ok:true});
  });
  const stopResponse=async(req,res,target)=>{
    const {results}=await stopShots(target,{visitorId:req.visitorId});
    res.json({results:results.map(row=>({id:row.id,ok:row.ok,status:row.status || 'uncertain',...(row.ok ? {} : {error:'尚未確認停止，請更新狀態或再試一次。'})}))});
  };
  router.post('/jobs/stop',async(req,res)=>stopResponse(req,res,req.body));
  router.post('/jobs/:id/stop',async(req,res)=>stopResponse(req,res,{ids:[ownedJob(req.params.id,req.visitorId).id]}));
  router.get('/jobs/:id/image/:index',async(req,res)=>{
    ownedJob(req.params.id,req.visitorId,true);
    if(!/^\d{1,2}$/.test(req.params.index)) throw fail('找不到這張照片。',404);
    await sendImage(req.params.id,Number(req.params.index),req.query,res);
  });
  router.get('/jobs/:id/angle-source',async(req,res)=>{
    ownedJob(req.params.id,req.visitorId);await sendAngleSource(req.params.id,req.query.index,res);
  });
  router.get('/jobs/:id/character-reference',async(req,res)=>{
    ownedJob(req.params.id,req.visitorId);await sendCharacterReference(req.params.id,res,req.query);
  });
  router.use((req,res)=>res.status(404).json({error:'找不到這個攝影棚功能。'}));
  return router;
}
