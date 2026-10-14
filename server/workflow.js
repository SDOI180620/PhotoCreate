import { getOutputSize } from '../shared/domain.js';
import {withSingleSubjectPrompt,withSingleSubjectNegative} from '../shared/subject.js';
import {isPromptGarment} from '../shared/garments.js';
import {comfyInputFields,isComfyWidget,widgetDefault} from '../shared/comfy-widgets.js';
import {TURNAROUND_MIN_CFG} from '../shared/character-turnaround.js';

export const WORKFLOW_NAME = '02 Qwen Image 2.1 Uncensored 5090 High Quality - 圖生圖';
export const WORKFLOW_PATH = `Qwen Image 2.1/${WORKFLOW_NAME}.json`;

// Convert only explicit links and schema-defined widgets. Seed controls and
// upload buttons are frontend widgets, and never belong in the API inputs.
export function convertWorkflow(uiWorkflow, objectInfo, {validate = validateTemplate,serializedLinkedWidgets=false} = {}) {
  if (!Array.isArray(uiWorkflow?.nodes)) throw new Error('工作流必須包含 nodes。');
  const links = new Map((uiWorkflow.links || []).map(link => [link[0], [String(link[1]), link[2]]]));
  const graph = {};
  for (const node of uiWorkflow.nodes) {
    if (['MarkdownNote','Note'].includes(node.type)) continue;
    if (node.mode !== undefined && node.mode !== 0) throw new Error(`節點 ${node.id} 是停用或 bypass 模式，請先匯出 API 格式。`);
    const schema = objectInfo[node.type];
    if (!schema) throw new Error(`ComfyUI 缺少節點：${node.type}`);
    const inputs = {};
    for (const entry of node.inputs || []) {
      if (entry.link !== null && entry.link !== undefined) {
        const connection = links.get(entry.link);
        if (!connection) throw new Error(`找不到節點 ${node.id} 的連線 ${entry.link}`);
        inputs[entry.name] = connection;
      }
    }
    let widgetIndex = 0;
    for (const [name,spec,required] of comfyInputFields(schema,name=>inputs[name])) {
      const [type, options = {}] = spec;
      const isWidget = isComfyWidget(spec);
      if (inputs[name] !== undefined) {
        // ComfyUI keeps serialized values for widgets converted into linked
        // sockets. Consume those placeholders so subsequent widgets stay aligned.
        if(serializedLinkedWidgets && isWidget && node.inputs?.some(entry=>entry.name===name && entry.widget)) widgetIndex+=1+(options.control_after_generate ? 1 : 0);
        continue;
      }
      if (!isWidget || options.forceInput) continue;
      const value = node.widgets_values?.[widgetIndex++];
      if (value !== undefined) inputs[name] = value;
      else if (options.default !== undefined || type==='COMFY_DYNAMICCOMBO_V3') inputs[name] = widgetDefault(spec);
      else if (required) throw new Error(`節點 ${node.id} 缺少 ${name}。`);
      if (options.control_after_generate) widgetIndex++;
    }
    graph[String(node.id)] = { class_type: node.type, inputs, _meta: { title: node.title || schema.display_name || node.type } };
  }
  validate(graph);
  return graph;
}

export function validateTemplate(graph) {
  if (!graph || Array.isArray(graph) || typeof graph !== 'object' || !Object.keys(graph).length) throw new Error('工作流格式無效。');
  for (const [id, node] of Object.entries(graph)) {
    if (!node || typeof node.class_type !== 'string' || !node.inputs || typeof node.inputs !== 'object') throw new Error(`節點 ${id} 缺少 class_type 或 inputs。`);
    for (const value of Object.values(node.inputs)) {
      if (Array.isArray(value) && value.length === 2 && typeof value[1] === 'number' && !graph[String(value[0])]) throw new Error(`節點 ${id} 連到不存在的節點 ${value[0]}。`);
    }
  }
  for (const type of ['TextEncodeQwenImage21','KSampler','SaveImage']) {
    const matches = Object.entries(graph).filter(([,node]) => node.class_type === type);
    if (matches.length !== 1) throw new Error(`此工作檯需要一個 ${type} 節點；目前有 ${matches.length} 個。`);
  }
  const text = Object.values(graph).find(node => node.class_type === 'TextEncodeQwenImage21');
  if (!Array.isArray(text.inputs.clip) || !Array.isArray(text.inputs.vae)) throw new Error('Qwen 提詞節點必須連接 CLIP 與 VAE。');
  return graph;
}

export function referenceKinds(shot) {
  if(shot.jobKind==='character-turnaround') return ['character'];
  if(shot.jobKind==='photo-edit') return ['character',...(!isPromptGarment(shot.garment) && shot.garment?.fileName ? ['garment'] : [])];
  return ['character',...(shot.garment && !isPromptGarment(shot.garment) ? ['garment'] : []),...(shot.scene ? ['scene'] : [])];
}

export function buildComfyPrompt(template, shot, images) {
  validateTemplate(template);
  const graph = structuredClone(template);
  const textId = Object.keys(graph).find(id => graph[id].class_type === 'TextEncodeQwenImage21');
  const samplerId = Object.keys(graph).find(id => graph[id].class_type === 'KSampler');
  const saveId = Object.keys(graph).find(id => graph[id].class_type === 'SaveImage');
  const nextId = Math.max(0, ...Object.keys(graph).map(Number).filter(Number.isFinite)) + 1;
  const text = graph[textId];
  for (const key of Object.keys(text.inputs)) if (key === 'images' || key.startsWith('images.')) delete text.inputs[key];
  referenceKinds(shot).forEach((kind,index) => {
    if (typeof images[kind] !== 'string' || !images[kind]) throw new Error(`缺少 ${kind} 圖片。`);
    const id = String(nextId + index);
    graph[id] = { class_type: 'LoadImage', inputs: { image: images[kind] }, _meta: { title: `<image${index + 1}> · ${kind}` } };
    text.inputs[`images.image_${index + 1}`] = [id,0];
  });
  text.inputs.prompt = shot.jobKind==='character-turnaround' ? shot.prompt : withSingleSubjectPrompt(shot.prompt);
  text.inputs.negative_prompt = shot.jobKind==='character-turnaround' ? shot.negative : withSingleSubjectNegative(shot.negative);
  text.inputs.resolution = shot.resolution;
  graph[samplerId].inputs.seed = shot.seed;
  graph[samplerId].inputs.steps = shot.steps;
  // CFG 1 skips negative conditioning; turnaround layout exclusions need it.
  if(shot.jobKind==='character-turnaround') graph[samplerId].inputs.cfg=Math.max(TURNAROUND_MIN_CFG,Number(graph[samplerId].inputs.cfg) || 1);
  const outputSize = shot.outputWidth === undefined && shot.outputHeight === undefined
    ? getOutputSize(shot.aspectRatio ?? 'reference',shot.resolution)
    : {width:shot.outputWidth,height:shot.outputHeight};
  if (outputSize) {
    if ([outputSize.width,outputSize.height].some(value => !Number.isInteger(value) || value < 128 || value > 4096 || value % 32)) throw new Error('輸出寬高須為 128–4096 之間的 32 倍數。');
    const sizeId = String(nextId + referenceKinds(shot).length);
    // Qwen 2.1's empty latent has 64 channels and a 16-pixel spatial stride.
    // LatentUpscale divides its width/height by 8, so pass half the pixel size.
    graph[sizeId] = {class_type:'LatentUpscale',inputs:{samples:[textId,2],upscale_method:'nearest-exact',width:outputSize.width / 2,height:outputSize.height / 2,crop:'disabled'},_meta:{title:`Output ${outputSize.width} × ${outputSize.height}`}};
    graph[samplerId].inputs.latent_image = [sizeId,0];
  } else if (shot.aspectRatio === 'reference') {
    graph[samplerId].inputs.latent_image = [textId,2];
  }
  const localDate = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei'}).format(new Date());
  graph[saveId].inputs.filename_prefix = `PhotoCreate/${localDate}/${shot.id}`;
  // Remove unreachable nodes, including the original one-picture loader.
  const reachable = new Set();
  const visit = id => {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const value of Object.values(graph[id].inputs)) if (Array.isArray(value) && value.length === 2 && graph[String(value[0])]) visit(String(value[0]));
  };
  visit(saveId);
  return Object.fromEntries(Object.entries(graph).filter(([id]) => reachable.has(id)));
}

export function workflowSummary(graph, name = WORKFLOW_NAME) {
  if (!graph) return { ready: false, name };
  const values = Object.values(graph);
  const sampler = values.find(node => node.class_type === 'KSampler')?.inputs;
  const encoder = values.find(node => node.class_type === 'TextEncodeQwenImage21')?.inputs;
  return {
    ready: true, name, referenceCount: 2, nodeCount: values.length,
    steps: sampler?.steps, cfg: sampler?.cfg, sampler: sampler?.sampler_name,
    scheduler: sampler?.scheduler, denoise: sampler?.denoise, resolution: encoder?.resolution,
    model: values.find(node => node.class_type === 'UNETLoader')?.inputs.unet_name,
  };
}
