import { referenceOnlyPrompt,withNaturalScenePrompt } from './domain.js';
import { resolveCameraSource,photoCameraSettings } from './camera-source.js';
import {withSingleSubjectPrompt,withSingleSubjectNegative} from './subject.js';
import {isPhotoSourceJob} from './production.js';

export const PENDING_REMAKE_STATUSES = ['draft','submitting','queued','running','stopping','uncertain'];
export const rootJobId = job => job.rootJobId || job.id;

export function pendingRemakeRoots(jobs) {
  return new Set(jobs.filter(job => job.sourceJobId && PENDING_REMAKE_STATUSES.includes(job.status)).map(rootJobId));
}

export function buildRemakePlans(state,ids,{requestId,deleteSourceOnComplete = false,cameraSource} = {}) {
  if(!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string')) throw new Error('請選擇 1–100 張已完成的成果。');
  const sources = [...new Set(ids)].map(id => state.jobs.find(job => job.id === id));
  if(sources.some(job => !job || job.status !== 'completed' || !job.images?.length)) throw new Error('只能重製有成果圖的已完成拍攝。');
  const roots = sources.map(rootJobId);
  if(new Set(roots).size !== roots.length) throw new Error('同一張照片請選擇一個版本重製。');
  const pending = pendingRemakeRoots(state.jobs);
  if(roots.some(id => pending.has(id))) throw new Error('所選照片已有重製任務，請等完成或處理待確認任務。');
  const fields = ['batchId','character','characterMeasurementsPrompt','garment','scene','pose','expression','gaze','clothingState','interaction','camera','lighting','color','quality','prompt','negative','resolution','steps','sceneInteraction','aspectRatio','outputWidth','outputHeight','generationMode','cameraMode','cameraEnabled','executionMode','angleSteps','refineSteps','refineDenoise','jobKind','sourceImage','sourceImageIndex','sourceComfyUrl','sourceInput','sourceInputComfyUrl','cameraWorkflowSnapshot','photoCustomization','photoSource'];
  return sources.map(source => {
    const root = rootJobId(source);
    const remakeVersion = Math.max(0,...state.jobs.filter(job => rootJobId(job) === root).map(job => job.remakeVersion || 0)) + 1;
    let seed = Math.floor(Math.random() * 2 ** 48);
    if(seed === source.seed) seed = (seed + 1) % 2 ** 48;
    const originalName = source.originalName || source.name;
    const scene=[source.interaction?.prompt,source.sceneInteraction,source.scene?.description].filter(Boolean).join(' ');
    const prompt=referenceOnlyPrompt(source);
    const plan = {
      ...structuredClone(Object.fromEntries(fields.filter(key => source[key] !== undefined).map(key => [key,source[key]]))),
      id:globalThis.crypto.randomUUID(),name:`${originalName} · 重製 ${remakeVersion}`,originalName,seed,prompt:withSingleSubjectPrompt(isPhotoSourceJob(source) || source.generationMode==='custom' ? prompt : withNaturalScenePrompt(prompt,scene)),negative:withSingleSubjectNegative(source.negative),
      sourceJobId:source.id,rootJobId:root,remakeVersion,remakeRequestId:requestId,deleteSourceOnComplete,
      ...(source.folderId ? {folderId:source.folderId} : {}),...(source.adminFolderId ? {adminFolderId:source.adminFolderId} : {}),
      ...(source.apiPrompt || source.workflowSnapshot ? {workflowSnapshot:structuredClone(source.cameraMode === 'multiangle' ? source.workflowSnapshot : source.apiPrompt || source.workflowSnapshot)} : {}),
    };
    if(source.jobKind==='photo-edit') Object.assign(plan,photoCameraSettings(state,source));
    if(isPhotoSourceJob(source)) {
      const original = cameraSource ? structuredClone(cameraSource) : resolveCameraSource(state,source,source.sourceImageIndex || 0);
      Object.assign(plan,{cameraSource:original,sourceImage:structuredClone(original.image),sourceComfyUrl:original.comfyUrl});
      delete plan.sourceInput;delete plan.sourceInputComfyUrl;
    }
    return plan;
  });
}

export function collectGalleryItems(state,{batchId = '',query = '',latestOnly = true} = {}) {
  let jobs = state.jobs.filter(job => job.status === 'completed' && job.images?.length && (!batchId || job.batchId === batchId));
  if(latestOnly) {
    const latest = new Map();
    for(const job of jobs) if(!latest.has(rootJobId(job)) || (job.remakeVersion || 0) > (latest.get(rootJobId(job)).remakeVersion || 0)) latest.set(rootJobId(job),job);
    jobs = [...latest.values()];
  }
  const batches = new Map((state.batches || []).map(batch => [batch.id,batch.name]));
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  jobs = jobs.filter(job => {
    const text = [batches.get(job.batchId),job.name,job.character?.name,job.garment?.name,job.pose?.name,job.expression?.name,job.gaze?.name,job.clothingState?.name,job.interaction?.name].join(' ').toLowerCase();
    return terms.every(term => text.includes(term));
  }).sort((a,b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return jobs.flatMap(job => job.images.map((_,index) => ({id:`${job.id}:${index}`,job,index,batchName:batches.get(job.batchId) || '拍攝組'})));
}
