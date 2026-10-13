import fs from 'node:fs';
import {VIDEO_DURATIONS,VIDEO_FPS,DEFAULT_VIDEO_MODELS,DEFAULT_VIDEO_WORKFLOW_PATH,TWO_PASS_WORKFLOW_PATH,VIDEO_GENERATION_VERSIONS,normalizeVideoWorkflowPath} from '../shared/photo-video.js';
import {convertWorkflow} from './workflow.js';
import {comfyInputFields,isComfyWidget} from '../shared/comfy-widgets.js';

export const FASTH3_SOURCE='https://github.com/amao2001/ganloss-latent-space/tree/main/workflow/2026-10-12%20fastH3%20trim';
export const VIDEO_WORKFLOW_PATH=new URL('../bundles/comfyui/workflows/MiniMax H3/01 FastH3 Trim - 圖生影片.api.json',import.meta.url);
export const VIDEO_UI_PATH=new URL('../bundles/comfyui/workflows/MiniMax H3/01 FastH3 Trim - 圖生影片.json',import.meta.url);
export const TWO_PASS_API_PATH=new URL('../bundles/comfyui/workflows/MiniMax H3/02 FastH3 Trim－升頻二採（5090 NVFP4）.api.json',import.meta.url);
export const TWO_PASS_UI_PATH=new URL('../bundles/comfyui/workflows/MiniMax H3/02 FastH3 Trim－升頻二採（5090 NVFP4）.json',import.meta.url);
export const videoTemplate=(version='single')=>JSON.parse(fs.readFileSync(version==='two-pass' ? TWO_PASS_API_PATH : VIDEO_WORKFLOW_PATH,'utf8'));
export const videoUiTemplate=(version='single')=>JSON.parse(fs.readFileSync(version==='two-pass' ? TWO_PASS_UI_PATH : VIDEO_UI_PATH,'utf8'));
const aspectNames={'1:1':'1:1 (Square)','16:9':'16:9 (Widescreen)','9:16':'9:16 (Portrait Widescreen)'};
const types={source:'LoadImage',model:'UNETLoader',clip:'CLIPLoader',noise:'RandomNoise',encode:'MiniMaxH3ImageToVideo',sampler:'KSamplerSelect',schedule:'BasicScheduler',decode_audio:'VAEDecodeAudio',trim_frames:'ImageFromBatch',trim_audio:'TrimAudioDuration',combine:'CreateVideo',save:'SaveVideo',resolution:'ResolutionSelector'};
const bundledNodeSchemas=JSON.parse(fs.readFileSync(new URL('../bundles/comfyui/video-node-schemas.json',import.meta.url),'utf8'));

export function convertVideoWorkflow(ui,objectInfo) {
  if(!Array.isArray(ui?.nodes) || ui.nodes.length>2000) throw new Error('請使用可在 ComfyUI 編輯的 H3 工作流，必須包含 nodes 與 links。');
  const raw=convertWorkflow(ui,objectInfo,{validate:graph=>graph,serializedLinkedWidgets:true}),roles={};
  for(const node of Object.values(raw)) for(const [name,,required] of comfyInputFields(objectInfo[node.class_type],name=>node.inputs[name])) if(required && !Object.hasOwn(node.inputs,name)) throw new Error(`H3 節點 ${node.class_type} 缺少必要輸入：${name}`);
  for(const [role,type] of Object.entries(types)) {
    const tagged=ui.nodes.filter(node=>node.properties?.photocreate_role===role && raw[String(node.id)]?.class_type===type);
    const matches=tagged.length ? tagged.map(node=>String(node.id)) : Object.keys(raw).filter(id=>raw[id].class_type===type);
    if(matches.length!==1) throw new Error(`H3 工作流需要一個可辨識的 ${type} 節點。`);
    roles[role]=matches[0];
  }
  for(const [role,nodeId] of [['video_vae',roles.encode],['audio_vae',roles.decode_audio]]) {
    const id=raw[nodeId].inputs.vae?.[0];
    if(raw[id]?.class_type!=='VAELoader') throw new Error('H3 影片與音訊 VAE 必須連接 VAELoader。');
    roles[role]=String(id);
  }
  const canonical={...videoTemplate(),...videoTemplate('two-pass')};
  for(const node of ui.nodes) {
    const role=node.properties?.photocreate_role;
    if(canonical[role] && !roles[role] && raw[String(node.id)]?.class_type===canonical[role].class_type) roles[role]=String(node.id);
  }
  const names=Object.fromEntries(Object.entries(raw).map(([id])=>[id,Object.keys(roles).find(role=>roles[role]===id) || 'node-'+id]));
  const graph=Object.fromEntries(Object.entries(raw).map(([id,node])=>[names[id],{...node,inputs:Object.fromEntries(Object.entries(node.inputs).map(([key,value])=> {
    if(Array.isArray(value)) {if(!names[value[0]]) throw new Error('H3 工作流連到不存在的節點。');return [key,[names[value[0]],value[1]]];}
    return [key,value];
  }))}]));
  if(Object.values(graph).some(node=>node.class_type==='MinimaxH3LatentUpscaler3D')) for(const key of ['upscale','encode_high','resolution_high','sample_refine','sigmas_first','sigmas_refine','separate','concat','guider_high']) if(!graph[key]) throw new Error('二採工作流缺少可辨識的 '+key+' 節點。');
  videoWorkflowParameters(graph,objectInfo);return graph;
}
export function videoWorkflowParameters(graph,objectInfo) {
  const sampler=graph.sampler?.inputs.sampler_name,scheduler=graph.schedule?.inputs.scheduler,steps=graph.schedule?.inputs.steps;
  const {megapixels,multiple}=graph.resolution?.inputs || {};
  if(typeof sampler!=='string' || typeof scheduler!=='string' || !Number.isInteger(steps) || steps<1 || steps>1000) throw new Error('請在 H3 工作流設定採樣器、排程器與採樣步數。');
  if(typeof megapixels!=='number' || !Number.isFinite(megapixels) || megapixels<0.1 || megapixels>16 || !Number.isInteger(multiple) || multiple<32 || multiple>128 || multiple%32) throw new Error('Resolution Selector 的 Megapixels 請設為 0.1–16，multiple 請設為 32、64、96 或 128。');
  if(objectInfo) for(const [type,key,value] of [['KSamplerSelect','sampler_name',sampler],['BasicScheduler','scheduler',scheduler]]) {
    const spec=objectInfo[type]?.input?.required?.[key],options=Array.isArray(spec?.[0]) ? spec[0] : spec?.[1]?.options;
    if(Array.isArray(options) && !options.includes(value)) throw new Error(`此 ComfyUI 不支援 ${key}：${value}`);
  }
  const generationVersion=graph.upscale ? 'two-pass' : 'single';
  if(generationVersion==='two-pass') {
    const refineMegapixels=graph.resolution_high.inputs.megapixels,refineMultiple=graph.resolution_high.inputs.multiple,firstPassSteps=graph.sigmas_first.inputs.step,sigmas=graph.sigmas_refine.inputs.sigmas.split(',').map(Number);
    if(!Number.isFinite(refineMegapixels) || refineMegapixels<0.1 || refineMegapixels>16 || !Number.isInteger(refineMultiple) || refineMultiple<32 || refineMultiple>128 || refineMultiple%32 || !Number.isInteger(firstPassSteps) || firstPassSteps<1 || firstPassSteps>steps || sigmas.length<2 || sigmas.some(value=>!Number.isFinite(value) || value<0)) throw new Error('二採升頻解析度或採樣設定無效。');
    return {sampler,scheduler,steps,megapixels,multiple,generationVersion,refineMegapixels,refineMultiple,firstPassSteps,refineSteps:sigmas.length-1};
  }
  return {sampler,scheduler,steps,megapixels,multiple,generationVersion};
}
export async function loadVideoWorkflow(comfyJson,{workflowPath='bundled',generationVersion='single',base,objectInfo}={}) {
  normalizeVideoWorkflowPath(workflowPath);
  if(!Object.hasOwn(VIDEO_GENERATION_VERSIONS,generationVersion)) throw new Error('影片版本無效。');
  const info=objectInfo || await comfyJson('/object_info',{},base),path=workflowPath==='bundled' ? generationVersion==='two-pass' ? TWO_PASS_WORKFLOW_PATH : DEFAULT_VIDEO_WORKFLOW_PATH : workflowPath;
  let ui,source='comfy';
  try {ui=await comfyJson('/userdata/'+encodeURIComponent('workflows/'+path),{},base);}
  catch(error) {if(workflowPath!=='bundled' || !/ComfyUI 404:/.test(error.message)) throw error;ui=videoUiTemplate(generationVersion);source='bundled';}
  // The pinned upscaler schema lets a new machine configure/install two-pass
  // before the custom node exists. Readiness always checks the live info only.
  const conversionInfo={...bundledNodeSchemas,...info},template=convertVideoWorkflow(ui,conversionInfo);
  return {ui,template,objectInfo:conversionInfo,workflow:{workflowPath,resolvedPath:path,source,...videoWorkflowParameters(template,info)}};
}
export function videoParameterChoices(info) {
  const choices=(type,key)=>{const spec=info[type]?.input?.required?.[key];return Array.isArray(spec?.[0]) ? spec[0] : spec?.[1]?.options || [];};
  return {samplers:choices('KSamplerSelect','sampler_name'),schedulers:choices('BasicScheduler','scheduler')};
}
export function updateVideoWorkflowParameters(ui,info,parameters) {
  const graph=convertVideoWorkflow(ui,info),next=structuredClone(ui);
  const fields=[['sampler','KSamplerSelect','sampler_name',parameters.sampler],['schedule','BasicScheduler','scheduler',parameters.scheduler],['schedule','BasicScheduler','steps',parameters.steps],['resolution','ResolutionSelector','megapixels',parameters.megapixels],...(graph.upscale ? [['resolution_high','ResolutionSelector','megapixels',parameters.refineMegapixels]] : [])];
  for(const [role,type,key,value] of fields) {
    const matches=next.nodes.filter(node=>node.type===type),node=matches.find(node=>node.properties?.photocreate_role===role) || (matches.length===1 ? matches[0] : null);
    if(!node) throw new Error('無法找到可編輯的 '+type+' 節點。');
    let index=0,found=false;
    for(const [name,spec] of comfyInputFields(info[type],name=>graph[role].inputs[name])) {
      if(!isComfyWidget(spec) || spec[1]?.forceInput) continue;
      const linked=node.inputs?.find(input=>input.name===name && input.link!=null);
      if(linked && !linked.widget) continue;
      if(name===key) {if(linked) throw new Error(key+' 已由連線控制，請先在 ComfyUI 改成數值欄位。');node.widgets_values ||= [];node.widgets_values[index]=value;found=true;break;}
      index+=1+(spec[1]?.control_after_generate ? 1 : 0);
    }
    if(!found) throw new Error('工作流缺少可編輯的 '+key+' 欄位。');
  }
  convertVideoWorkflow(next,info);
  return next;
}
export function buildVideoPrompt({id,prompt,duration,image,width,height,refineWidth,refineHeight,seed,models=DEFAULT_VIDEO_MODELS,workflowSnapshot,aspectRatio='reference'}) {
  if(!/^[\w-]{8,80}$/.test(id) || !VIDEO_DURATIONS.includes(duration) || typeof prompt!=='string' || !prompt.trim() || typeof image!=='string' || !image) throw new Error('影片生成參數無效。');
  if([width,height].some(value=>!Number.isInteger(value) || value<128 || value>16384 || value%32)) throw new Error('影片尺寸無效。');
  if(aspectRatio!=='reference' && !aspectNames[aspectRatio]) throw new Error('影片比例無效。');
  const graph=structuredClone(workflowSnapshot || videoTemplate()),frames=duration*VIDEO_FPS;
  graph.encode.inputs={...graph.encode.inputs,prompt,width,height,length:frames+(5-frames%17+17)%17};
  if(graph.upscale) {
    if([refineWidth,refineHeight].some(value=>!Number.isInteger(value) || value<128 || value>16384 || value%32)) throw new Error('二採影片尺寸無效。');
    graph.encode_high.inputs={...graph.encode_high.inputs,prompt,width:refineWidth,height:refineHeight,length:graph.encode.inputs.length};
    graph.upscale.inputs.model_name=models.latentUpscaler;graph.upscale.inputs.mode='target dimensions';graph.upscale.inputs['mode.width']=refineWidth;graph.upscale.inputs['mode.height']=refineHeight;
  }
  if(aspectRatio!=='reference' && graph.resolution) {
    graph.resolution.inputs.aspect_ratio=aspectNames[aspectRatio];
    graph.encode.inputs.width=['resolution',0];graph.encode.inputs.height=['resolution',1];
  }
  graph.source.inputs.image=image;
  graph.noise.inputs.noise_seed=seed;
  graph.trim_frames.inputs.length=frames;
  graph.trim_audio.inputs.duration=duration;
  graph.save.inputs.filename_prefix=`PhotoCreate/_videos/${id}/clip`;
  graph.save.inputs.format='mp4';graph.save.inputs['format.codec']='h264';graph.combine.inputs.fps=VIDEO_FPS;
  graph.model.inputs.unet_name=models.unet;
  graph.video_vae.inputs.vae_name=models.videoVae;
  graph.audio_vae.inputs.vae_name=models.audioVae;
  graph.clip.inputs.clip_name=models.clip;
  return graph;
}
export function videoSize(width,height,aspectRatio='reference',{megapixels=1,multiple=32}={}) {
  const ratios={'1:1':[1,1],'16:9':[16,9],'9:16':[9,16]};
  if(Object.hasOwn(ratios,aspectRatio)) [width,height]=ratios[aspectRatio];
  else if(aspectRatio!=='reference') throw new Error('影片比例無效。');
  if(!Number.isFinite(width) || !Number.isFinite(height) || width<=0 || height<=0) throw new Error('無法讀取影片來源照片的尺寸。');
  if(!Number.isFinite(megapixels) || megapixels<0.1 || megapixels>16 || !Number.isInteger(multiple) || multiple%32 || multiple<32 || multiple>128) throw new Error('影片 Megapixels 或解析度倍數無效。');
  const scale=Math.sqrt(megapixels*1024*1024/(width*height));
  const round=value=>value%1===0.5 ? Math.round(value/2)*2 : Math.round(value);
  return {width:Math.max(128,round(width*scale/multiple)*multiple),height:Math.max(128,round(height*scale/multiple)*multiple)};
}
export function videoAvailability(objectInfo,models=DEFAULT_VIDEO_MODELS,graph=videoTemplate()) {
  const missingNodes=[...new Set(Object.values(graph).map(row=>row.class_type))].filter(name=>!objectInfo[name]);
  const fields={unet:['UNETLoader','unet_name'],videoVae:['VAELoader','vae_name'],audioVae:['VAELoader','vae_name'],clip:['CLIPLoader','clip_name'],...(graph.upscale ? {latentUpscaler:['MinimaxH3LatentUpscaler3D','model_name']} : {})};
  const choices={},missingModels=[];
  for(const [key,[type,field]] of Object.entries(fields)) {
    const spec=objectInfo[type]?.input?.required?.[field] || objectInfo[type]?.input?.optional?.[field];
    const list=Array.isArray(spec?.[0]) ? spec[0] : spec?.[1]?.options;
    const compatible={unet:/fast.*h3.*trim.*8step/i,videoVae:/(?:minimax.*h3).*video.*vae/i,audioVae:/(?:minimax.*h3).*audio.*vae/i,clip:/qwen3.*minimax.*h3/i,latentUpscaler:/minimax.*h3.*upscal.*3d/i};
    choices[key]=Array.isArray(list) ? list.filter(value=>typeof value==='string' && compatible[key].test(value)) : [];
    if(!choices[key].includes(models[key])) missingModels.push(models[key]);
  }
  const missing=[...missingNodes,...missingModels];
  return {ready:!missing.length,missingNodes,missingModels,choices,error:missing.length ? `影片工作流缺少：${missing.join('、')}。請在 ComfyUI 安裝對應節點與模型，或在後台選擇已安裝的相容模型。` : '',source:FASTH3_SOURCE};
}
