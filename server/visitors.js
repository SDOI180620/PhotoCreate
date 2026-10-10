import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import {OUTPUT_RATIOS} from '../shared/domain.js';
import {STOPPABLE_STATUSES,RETRYABLE_STATUSES} from '../shared/batches.js';
import {photoPromptDetails} from './photo-prompts.js';
import {customerDraft,customerCharacters} from './customer-recipe.js';
import {productionStages} from '../shared/production.js';
import {CAMERA_FRAMING_VERSION} from '../shared/camera.js';
import {PHOTO_CUSTOMIZATION_VERSION,PHOTO_PRESET_CATEGORIES,photoSettings} from '../shared/photo-customization.js';
import {createFeaturedGallery} from './featured-gallery.js';

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const publicCharacter=(row,visitorId)=>({id:row.id,name:row.name,image:`/api/studio/characters/${row.id}/image`,owned:row.visitorId===visitorId});
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
export function createVisitorRouter({store,dataDir,photoFolders,isInstalling,getCustomerRecipe,uploadCharacter,createShots,remakeShots,angleShot,customShot,queueShots,stopShots,purgeOutputs,sendImage,sendAngleSource,sendCharacterReference}) {
  const router=express.Router();
  const gallery=createFeaturedGallery(store);
  const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:25*1024*1024,files:1,fields:0,parts:1}}).single('image');
  router.use((req,res,next)=>{
    if(req.account?.role!=='customer') return next(fail('請先登入顧客帳號。',401));
    req.visitorId=req.account.owner_id;
    res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
    next();
  });
  const ownedJob=(id,visitorId,includeDeleted=false)=>{
    const job=store.read().jobs.find(row=>row.id===id && row.visitorId===visitorId && (includeDeleted || !row.visitorDeletedAt));
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
  const requestId=(value,visitorId)=>{
    if(typeof value!=='string' || !/^[\w-]{8,48}$/.test(value)) throw fail('請重新整理後再試一次。');
    return `${visitorId}-${value}`;
  };
  const assertReady=(cameraEnabled=false)=>{
    const state=store.read();
    if(!state.workflow || cameraEnabled && !state.cameraWorkflow || isInstalling()) throw fail('攝影棚正在準備，請稍後再試。',503);
  };
  const stateFor=visitorId=>{
    const recipe=getCustomerRecipe();
    const state=store.read();
    return {characters:customerCharacters(state,recipe,visitorId).map(row=>publicCharacter(row,visitorId)),
      folders:photoFolders.list(visitorId),
      gallery:gallery.list(visitorId),galleryFolders:gallery.folders(visitorId),
      jobs:state.jobs.filter(job=>job.visitorId===visitorId && !job.visitorDeletedAt).map(publicJob),
      trash:state.jobs.filter(job=>job.visitorId===visitorId && job.visitorDeletedAt).map(job=>({...publicJob(job),deletedAt:job.visitorDeletedAt})),
      ready:Boolean(recipe && ['garment','pose','lighting','color','quality'].every(key=>recipe.pools[key]?.length) && state.workflow && !isInstalling()),cameraReady:Boolean(state.workflow && state.cameraWorkflow && !isInstalling()),
      wardrobeCount:recipe?.pools.garment.length || 0,maxCount:24,canQueueShoots:true,photoCustomization:PHOTO_CUSTOMIZATION_VERSION,cameraFraming:CAMERA_FRAMING_VERSION,
      garments:(recipe?.pools.garment || []).map(row=>({id:row.id,name:row.name,image:`/api/studio/garments/${row.id}/image`})),
      presets:Object.entries(PHOTO_PRESET_CATEGORIES).flatMap(([key,category])=>(recipe?.pools[key==='scene' ? 'interaction' : key] || []).filter(row=>row.category===category).map(row=>({id:row.id,category,name:row.name}))),
      cameras:(recipe?.pools.camera || []).map(row=>({id:row.id,name:row.name,angle:row.angle})),
    };
  };
  router.get('/state',(req,res)=>res.json(stateFor(req.visitorId)));
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
  router.delete('/folders/:id',(req,res)=>res.json(photoFolders.remove(req.visitorId,req.params.id)));
  router.post('/photos/move',(req,res)=>res.json(photoFolders.move(req.visitorId,req.body?.ids,req.body?.folderId)));
  router.post('/photos/delete',(req,res)=>{
    const jobs=selectedFamilies(req),ids=new Set(jobs.map(job=>job.id)),deletedAt=new Date().toISOString();
    store.mutate(state=>{for(const job of state.jobs) if(ids.has(job.id) && job.visitorId===req.visitorId) job.visitorDeletedAt ||= deletedAt;});
    res.json({ok:true,count:jobs.length});
  });
  router.post('/photos/purge',(req,res)=>{
    const jobs=selectedFamilies(req,true),ids=new Set(jobs.map(job=>job.id));
    let deletedFiles;
    try {deletedFiles=purgeOutputs(jobs);} catch {throw fail('照片檔案暫時無法清理，請稍後再試或聯絡攝影棚管理員。');}
    store.mutate(state=>{
      state.jobs=state.jobs.filter(job=>!ids.has(job.id) || job.visitorId!==req.visitorId);
      state.galleryEntries=(state.galleryEntries || []).filter(row=>row.ownerId!==req.visitorId || !ids.has(row.jobId));
      const batches=new Set(jobs.map(job=>job.batchId));
      state.batches=state.batches.filter(batch=>batch.visitorId!==req.visitorId || !batches.has(batch.id) || state.jobs.some(job=>job.batchId===batch.id));
    });
    res.json({ok:true,count:jobs.length,deletedFiles});
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
    if(jobs.some(row=>STOPPABLE_STATUSES.includes(row.status))) throw fail('照片正在拍攝，完成後才能刪除。',409);
    const ids=new Set(jobs.map(row=>row.id)),deletedAt=new Date().toISOString();
    store.mutate(state=>{for(const row of state.jobs) if(ids.has(row.id) && row.visitorId===req.visitorId) {if(deleting) row.visitorDeletedAt ||= deletedAt;else delete row.visitorDeletedAt;}});
    res.json({ok:true,count:jobs.length});
  };
  router.delete('/jobs/:id',(req,res)=>changeDeleted(req,res,true));
  router.post('/jobs/:id/restore',(req,res)=>changeDeleted(req,res,false));
  router.post('/characters',upload,(req,res)=>{
    if(!req.file) throw fail('請選擇 PNG、JPG 或 WebP 圖片。');
    const [character]=uploadCharacter([req.file],req.visitorId);
    res.status(201).json(publicCharacter(character,req.visitorId));
  });
  router.delete('/characters/:id',(req,res)=>{
    if(!store.read().characters.some(row=>row.id===req.params.id && row.visitorId===req.visitorId)) throw fail('找不到你的角色。',404);
    // Keep reference files for existing job snapshots and unfinished shoots.
    store.mutate(state=>{state.characters=state.characters.filter(row=>row.id!==req.params.id || row.visitorId!==req.visitorId);});
    res.json({ok:true});
  });
  router.get('/characters/:id/image',(req,res)=>{
    const row=customerCharacters(store.read(),getCustomerRecipe(),req.visitorId).find(row=>row.id===req.params.id);
    if(!row || !row.fileName || path.basename(row.fileName)!==row.fileName) throw fail('找不到角色圖片。',404);
    const file=path.join(dataDir,'uploads',row.fileName);
    if(!fs.existsSync(file)) throw fail('角色圖片已不存在。',404);
    res.type(['image/png','image/jpeg','image/webp'].includes(row.mime) ? row.mime : 'image/png').send(fs.readFileSync(file));
  });
  router.get('/garments/:id/image',(req,res)=>{
    const row=getCustomerRecipe()?.pools.garment.find(row=>row.id===req.params.id);
    if(!row?.fileName || path.basename(row.fileName)!==row.fileName) throw fail('找不到服裝圖片。',404);
    const file=path.join(dataDir,'uploads',row.fileName);
    if(!fs.existsSync(file)) throw fail('服裝圖片已不存在。',404);
    res.type(['image/png','image/jpeg','image/webp'].includes(row.mime) ? row.mime : 'image/png').send(fs.readFileSync(file));
  });
  router.post('/shoots',(req,res)=>{
    const body=req.body || {},key=requestId(body.requestId,req.visitorId),count=body.count,aspectRatio=body.aspectRatio || '9:16',cameraEnabled=body.cameraEnabled ?? false;
    const folderId=photoFolders.requireFolder(req.visitorId,body.folderId);
    if(typeof cameraEnabled!=='boolean') throw fail('鏡頭設定無效。');
    if(!Number.isInteger(count) || count<1 || count>24) throw fail('每次可以拍攝 1–24 張照片。');
    if(!Object.hasOwn(OUTPUT_RATIOS,aspectRatio)) throw fail('請選擇有效的照片比例。');
    const state=store.read(),character=customerCharacters(state,getCustomerRecipe(),req.visitorId).find(row=>row.id===body.characterId);
    if(!character) throw fail('請先上傳或選擇你的角色。');
    const existing=state.batches.find(row=>row.visitorId===req.visitorId && row.visitorRequestId===key);
    if(existing) {
      if(existing.characterId!==character.id || existing.count!==count || existing.aspectRatio!==aspectRatio || (existing.cameraEnabled ?? true)!==cameraEnabled || (existing.folderId || '')!==folderId) throw fail('這次拍攝設定已變更，請重新送出。',409);
      return res.json({jobs:state.jobs.filter(job=>job.batchId===existing.id && job.visitorId===req.visitorId).map(publicJob),created:false});
    }
    assertReady(cameraEnabled);
    const recipe=getCustomerRecipe();
    if(!recipe) throw fail('攝影棚正在準備，請稍後再試。',503);
    const draft=customerDraft(recipe,{count,characterId:character.id,aspectRatio,batchName:`${character.name}的攝影棚`,cameraEnabled});
    const jobs=createShots({...draft,folderId},{visitorId:req.visitorId,requestId:key,customerRecipe:recipe});
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
    const result=customShot(req.params.id,{requestId:requestId(body.requestId,req.visitorId),imageIndex:body.imageIndex ?? 0,customization:body.customization},{visitorId:req.visitorId});
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
  const stopResponse=async(req,res,ids)=>{
    const {results}=await stopShots({ids},{visitorId:req.visitorId});
    res.json({results:results.map(row=>({id:row.id,ok:row.ok,status:row.status || 'uncertain',...(row.ok ? {} : {error:'尚未確認停止，請更新狀態或再試一次。'})}))});
  };
  router.post('/jobs/stop',async(req,res)=>stopResponse(req,res,selectedJobs(req).map(job=>job.id)));
  router.post('/jobs/:id/stop',async(req,res)=>stopResponse(req,res,[ownedJob(req.params.id,req.visitorId).id]));
  router.get('/jobs/:id/image/:index',async(req,res)=>{
    ownedJob(req.params.id,req.visitorId,true);
    if(!/^\d{1,2}$/.test(req.params.index)) throw fail('找不到這張照片。',404);
    await sendImage(req.params.id,Number(req.params.index),req.query,res);
  });
  router.get('/jobs/:id/angle-source',async(req,res)=>{
    ownedJob(req.params.id,req.visitorId);await sendAngleSource(req.params.id,req.query.index,res);
  });
  router.get('/jobs/:id/character-reference',(req,res)=>{
    ownedJob(req.params.id,req.visitorId);sendCharacterReference(req.params.id,res);
  });
  router.use((req,res)=>res.status(404).json({error:'找不到這個攝影棚功能。'}));
  return router;
}
