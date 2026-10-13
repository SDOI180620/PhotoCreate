import { buildComfyPrompt, validateTemplate } from './workflow.js';
import { normalizeCameraAngle, cameraPrompt, cameraZoomLevel, REFINE_PROMPT, REFINE_NEGATIVE, REFINE_STEPS } from '../shared/camera.js';
import {productionStages,isPhotoSourceJob} from '../shared/production.js';
import {withSingleSubjectPrompt,withSingleSubjectNegative} from '../shared/subject.js';
import {cameraWorkflowVersion,cameraVersion} from '../shared/camera-version.js';

export const CAMERA_WORKFLOW_PATH = 'Qwen Multiangle/01 Qwen 2511 - 單圖 3D 相機換角度.json';

export function validateCameraWorkflow(graph) {
  if(!graph || typeof graph !== 'object' || Array.isArray(graph)) throw new Error('相機工作流格式無效。');
  for(const [id,node] of Object.entries(graph)) {
    if(!node?.class_type || !node.inputs) throw new Error(`相機節點 ${id} 格式無效。`);
    for(const value of Object.values(node.inputs)) if(Array.isArray(value) && value.length === 2 && typeof value[1] === 'number' && !graph[String(value[0])]) throw new Error(`相機節點 ${id} 的連線不存在。`);
  }
  for(const type of ['QwenMultiangleCameraNode','KSampler','SaveImage','LoadImage']) if(Object.values(graph).filter(node => node.class_type === type).length !== 1) throw new Error(`相機工作流須包含一個 ${type}。`);
  const sampler = Object.values(graph).find(node => node.class_type === 'KSampler');
  const encoder = graph[sampler.inputs.positive?.[0]];
  if(!['TextEncodeQwenImageEditPlus','TextEncodeQwenImage21'].includes(encoder?.class_type)) throw new Error('相機工作流缺少 Qwen 2511 或 2.1 正面提詞編碼器。');
  if(encoder.class_type === 'TextEncodeQwenImage21' && (!Array.isArray(encoder.inputs.vae) || !Array.isArray(encoder.inputs.clip))) throw new Error('Qwen 2.1 相機編碼器必須連接 CLIP 與 VAE。');
  return graph;
}

function namespace(graph,prefix) {
  return Object.fromEntries(Object.entries(structuredClone(graph)).map(([id,node]) => {
    for(const [key,value] of Object.entries(node.inputs)) if(Array.isArray(value) && value.length === 2 && graph[String(value[0])]) node.inputs[key] = [`${prefix}${value[0]}`,value[1]];
    return [`${prefix}${id}`,node];
  }));
}
const nodeId = (graph,type) => Object.keys(graph).find(id => graph[id].class_type === type);

function keepOutput(graph,output) {
  const reachable = new Set();
  const visit = id => {
    if(reachable.has(id)) return;
    if(!graph[id]) throw new Error(`製作流程缺少節點 ${id}。`);
    reachable.add(id);
    for(const value of Object.values(graph[id].inputs)) if(Array.isArray(value) && value.length === 2 && typeof value[1] === 'number') visit(String(value[0]));
  };
  visit(output);
  return Object.fromEntries(Object.entries(graph).filter(([id]) => reachable.has(id)));
}

export function buildCameraStage(template,cameraTemplate,shot,stage,images) {
  if(!['base','angle','refine'].includes(stage)) throw new Error('製作階段無效。');
  if(stage === 'base') {
    const graph = buildComfyPrompt(template,shot,images);
    if(productionStages(shot).length > 1) graph[nodeId(graph,'SaveImage')].inputs.filename_prefix = `PhotoCreate/_stages/${shot.id}/base`;
    return graph;
  }
  const graph = buildCameraPipeline(template,cameraTemplate,{...shot,jobKind:stage === 'angle' ? 'angle-edit' : 'refine-edit',cameraEnabled:stage === 'angle'},images);
  if(stage === 'angle') {
    graph.angle_save = {class_type:'SaveImage',inputs:{images:graph.refine_size.inputs.image,filename_prefix:`PhotoCreate/_stages/${shot.id}/angle`}};
    return keepOutput(graph,'angle_save');
  }
  graph.refine_size.inputs.image = ['source',0];
  return keepOutput(graph,nodeId(graph,'SaveImage'));
}

export function buildCameraPipeline(template,cameraTemplate,shot,images) {
  if(shot.cameraMode !== 'multiangle') return buildComfyPrompt(template,shot,images);
  if(shot.cameraEnabled === false && !isPhotoSourceJob(shot)) return buildComfyPrompt(template,shot,images);
  validateTemplate(template);
  const cameraEnabled = shot.cameraEnabled !== false;
  if(cameraEnabled) validateCameraWorkflow(cameraTemplate);
  if((cameraEnabled && (!Number.isInteger(shot.angleSteps) || shot.angleSteps < 1 || shot.angleSteps > 100)) || !Number.isFinite(shot.refineDenoise) || shot.refineDenoise < 0.05 || shot.refineDenoise > 0.4) throw new Error('相機製作參數無效。');
  let graph,source;
  if(isPhotoSourceJob(shot)) {
    if(!images.source) throw new Error('找不到選取的成果圖。');
    graph = {source:{class_type:'LoadImage',inputs:{image:images.source},_meta:{title:shot.jobKind==='refine-edit' ? '目前選取的照片 · 畫質優化' : '已完成成果 · 僅調整相機'}}};source = ['source',0];
  } else {
    graph = buildComfyPrompt(template,shot,images);
    const save = nodeId(graph,'SaveImage');source = graph[save].inputs.images;delete graph[save];
  }
  let refineSource = source;
  if(cameraEnabled) {
    const version = cameraWorkflowVersion(cameraTemplate);
    const angle = normalizeCameraAngle(shot.camera?.angle),camera = namespace(cameraTemplate,'angle_');
    const loader = nodeId(camera,'LoadImage'),save = nodeId(camera,'SaveImage'),sampler = nodeId(camera,'KSampler');
    refineSource = camera[save].inputs.images;
    for(const node of Object.values(camera)) for(const [key,value] of Object.entries(node.inputs)) if(Array.isArray(value) && value[0] === loader) node.inputs[key] = source;
    delete camera[loader];delete camera[save];
    Object.assign(camera[nodeId(camera,'QwenMultiangleCameraNode')].inputs,{horizontal_angle:angle.horizontalAngle,vertical_angle:angle.verticalAngle,zoom:angle.zoom,default_prompts:true,camera_view:false});
    if(Object.hasOwn(camera[nodeId(camera,'QwenMultiangleCameraNode')].inputs,'model_version')) camera[nodeId(camera,'QwenMultiangleCameraNode')].inputs.model_version = version;
    Object.assign(camera[sampler].inputs,{seed:shot.seed + 1,steps:shot.angleSteps});
    const positiveEncoder = camera[camera[sampler].inputs.positive?.[0]];
    if(!['TextEncodeQwenImageEditPlus','TextEncodeQwenImage21'].includes(positiveEncoder?.class_type)) throw new Error('相機工作流缺少正面提詞編碼器。');
    // Materialize the installed camera node's prompt so every submission can
    // include the subject constraint without requiring another custom node.
    positiveEncoder.inputs.prompt = withSingleSubjectPrompt(cameraPrompt(angle,version));
    positiveEncoder._meta = {title:'不同角度拍攝 · 正面提詞',cameraAngle:angle,cameraVersion:version};
    const negativeEncoder = camera[camera[sampler].inputs.negative?.[0]];
    const negativeField = negativeEncoder?.class_type === 'TextEncodeQwenImage21' ? 'negative_prompt' : 'prompt';
    if(['TextEncodeQwenImageEditPlus','TextEncodeQwenImage21'].includes(negativeEncoder?.class_type) && typeof negativeEncoder.inputs[negativeField] === 'string') {
      negativeEncoder.inputs[negativeField] = withSingleSubjectNegative(negativeEncoder.inputs[negativeField]);
      if(cameraZoomLevel(angle).max===10) negativeEncoder.inputs[negativeField] += ', wide shot, full-body framing, distant subject';
      if(negativeEncoder !== positiveEncoder) negativeEncoder._meta = {title:'不同角度拍攝 · 負面提詞'};
    }
    camera[sampler]._meta = {title:`${cameraVersion(version).label} · 換角度`,cameraVersion:version};
    Object.assign(graph,camera);
  }

  const refine = namespace(template,'refine_');
  const encoderId = nodeId(refine,'TextEncodeQwenImage21'),refineSampler = nodeId(refine,'KSampler'),refineSave = nodeId(refine,'SaveImage');
  const encoder = refine[encoderId];
  for(const key of Object.keys(encoder.inputs)) if(key === 'images' || key.startsWith('images.')) delete encoder.inputs[key];
  const explicitSize = shot.outputWidth && shot.outputHeight;
  if(explicitSize && [shot.outputWidth,shot.outputHeight].some(value => !Number.isInteger(value) || value < 128 || value > 4096 || value % 32)) throw new Error('高清輸出尺寸無效。');
  graph.refine_size = explicitSize
    ? {class_type:'ImageScale',inputs:{image:refineSource,upscale_method:'lanczos',width:shot.outputWidth,height:shot.outputHeight,crop:'disabled'}}
    : {class_type:'ImageScaleToTotalPixels',inputs:{image:refineSource,upscale_method:'lanczos',megapixels:shot.resolution ** 2 / 1e6,resolution_steps:32}};
  graph.refine_size._meta = {title:'恢復指定解析度'};
  Object.assign(encoder.inputs,{prompt:REFINE_PROMPT,negative_prompt:REFINE_NEGATIVE,resolution:0,'images.image_1':['refine_size',0]});
  graph.refine_latent = {class_type:'VAEEncode',inputs:{pixels:['refine_size',0],vae:encoder.inputs.vae},_meta:{title:'沿用目前照片 · 低強度修正'}};
  Object.assign(refine[refineSampler].inputs,{seed:shot.seed + 2,steps:REFINE_STEPS,denoise:shot.refineDenoise,latent_image:['refine_latent',0]});
  refine[refineSampler]._meta = {title:'Qwen 2.1 · 場景融合與畫質修復'};
  const date = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei'}).format(new Date());
  refine[refineSave].inputs.filename_prefix = `PhotoCreate/${date}/${shot.id}`;
  Object.assign(graph,refine);
  // Only the final HD result is saved and appears in the gallery.
  return keepOutput(graph,refineSave);
}
