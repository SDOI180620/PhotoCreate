import {cameraPrompt,REFINE_PROMPT,REFINE_NEGATIVE,REFINE_STEPS} from '../shared/camera.js';
import {productionStages} from '../shared/production.js';
import {referenceKinds} from './workflow.js';
import {withSingleSubjectPrompt} from '../shared/subject.js';
import {photoSettings} from '../shared/photo-customization.js';

const STAGES=[['base','原始生成'],['angle','不同角度拍攝'],['refine','細節修復']];
const nodeOf=(graph,type)=>Object.values(graph || {}).find(node=>node.class_type===type);

function textOf(value,graph,seen=new Set()) {
  if(typeof value==='string') return value;
  if(!Array.isArray(value) || value.length!==2) return null;
  const [id,output]=value,node=graph?.[id];
  if(!node || seen.has(id)) return null;
  seen.add(id);
  if(node.class_type==='QwenMultiangleCameraNode') {
    if(output!==0 || !node.inputs.default_prompts) return null;
    try {return cameraPrompt({horizontalAngle:node.inputs.horizontal_angle,verticalAngle:node.inputs.vertical_angle,zoom:node.inputs.zoom});} catch {return null;}
  }
  if(node.class_type==='ConditioningZeroOut') return '';
  const input=output===1 ? node.inputs.negative_prompt : node.inputs.prompt ?? node.inputs.text;
  return textOf(input,graph,seen);
}

function graphDetails(graph) {
  const encoder=nodeOf(graph,'TextEncodeQwenImage21') || nodeOf(graph,'TextEncodeQwenImageEditPlus');
  const sampler=nodeOf(graph,'KSampler'),camera=nodeOf(graph,'QwenMultiangleCameraNode');
  const settings=Object.fromEntries(['seed','steps','cfg','denoise','sampler_name','scheduler'].filter(key=>typeof sampler?.inputs?.[key]==='string' || Number.isFinite(sampler?.inputs?.[key])).map(key=>[key,sampler.inputs[key]]));
  const angle=camera ? {horizontalAngle:camera.inputs.horizontal_angle,verticalAngle:camera.inputs.vertical_angle,zoom:camera.inputs.zoom} : encoder?._meta?.cameraAngle;
  return {positive:textOf(encoder?.inputs?.prompt,graph),negative:textOf(encoder?.inputs?.negative_prompt ?? sampler?.inputs?.negative,graph),settings,...(angle ? {angle} : {})};
}

// Return selected text and numeric settings, never graph nodes, paths or hosts.
// Saved submissions win over the job's planning text and current library.
export function photoPromptDetails(state,job,{apiBase='/api/studio'}={}) {
  const sourceId=job.jobKind==='angle-edit' ? job.cameraSource?.jobId || job.rootJobId : job.id;
  const sourceJob=state.jobs.find(row=>row.id===sourceId && row.visitorId===job.visitorId),baseJob=sourceJob || job;
  const selectedSource=job.jobKind==='angle-edit' && job.cameraSource?.stage==='source';
  const stages=STAGES.filter(([stage])=>stage==='base' || productionStages(job).includes(stage)).map(([stage,label])=>{
    if(stage==='base' && selectedSource && !sourceJob) return {id:stage,label:'拍攝來源（已永久刪除）',source:'record',completed:true,image:null,positive:null,negative:null,settings:{},references:[]};
    const owner=stage==='base' ? baseJob : job,sourceStage=stage==='base' && selectedSource ? productionStages(owner).at(-1) : stage,result=owner.stageResults?.[sourceStage];
    const currentStage=owner.pipelineStage || 'base';
    const graph=result?.apiPrompt || (owner.promptId && !owner.stageWaiting && (currentStage===sourceStage || stage==='base' && selectedSource && owner.status==='completed') ? owner.apiPrompt : null);
    const fallback=stage==='base' ? {positive:owner.prompt || '',negative:owner.negative || '',settings:{seed:owner.seed,steps:owner.steps}}
      : stage==='angle' ? {positive:job.camera?.angle ? withSingleSubjectPrompt(cameraPrompt(job.camera.angle)) : null,negative:null,settings:{seed:job.seed+1,steps:job.angleSteps},angle:job.camera?.angle}
      : {positive:REFINE_PROMPT,negative:REFINE_NEGATIVE,settings:{seed:job.seed+2,steps:REFINE_STEPS,denoise:job.refineDenoise}};
    const completed=Boolean(result?.completed || owner.status==='completed');
    const image=owner.outputsDeletedAt ? null : stage==='base' && selectedSource
      ? owner.images?.[job.cameraSource.imageIndex || 0] ? `${apiBase}/jobs/${owner.id}/image/${job.cameraSource.imageIndex || 0}` : null
      : stage==='refine' || owner.cameraMode!=='multiangle'
      ? owner.images?.length ? `${apiBase}/jobs/${owner.id}/image/0` : null
      : result?.completed && result.images?.length ? `${apiBase}/jobs/${owner.id}/image/0?stage=${stage}` : null;
    return {id:stage,label:stage==='base' && selectedSource ? '拍攝來源' : stage==='base' && job.jobKind==='photo-edit' ? '自訂拍攝' : label,source:graph ? 'snapshot' : completed ? 'record' : 'pending',completed,image,
      ...(graph ? graphDetails(graph) : fallback),
      references:stage==='base' && !selectedSource ? referenceKinds(owner).map((kind,index)=>({label:`<image${index+1}>`,name:kind==='source' ? '選取的照片' : owner[kind]?.name || kind})) : [{label:'<image1>',name:stage==='base' || stage==='angle' && selectedSource ? '選取的照片' : stage==='angle' || !productionStages(job).includes('angle') ? '原始生成圖片' : '不同角度圖片'}]};
  });
  return {id:job.id,stages,width:job.outputWidth,height:job.outputHeight,settings:photoSettings(baseJob),
    selections:Object.fromEntries(['character','garment','pose','expression','clothingState','interaction','camera','lighting','color','quality'].filter(key=>job[key]?.name).map(key=>[key,job[key].name]))};
}
