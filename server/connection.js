import fs from 'node:fs';
import path from 'node:path';
import {convertWorkflow} from './workflow.js';
import {validateCameraWorkflow,buildCameraStage} from './camera-workflow.js';
import {BUNDLE_DIR} from './environment.js';

export function normalizeComfyUrl(value) {
  let url;try {url=new URL(value);} catch {throw new Error('請輸入完整的 ComfyUI 網址。');}
  if(!['http:','https:'].includes(url.protocol) || url.username || url.password || url.pathname!=='/' || url.search || url.hash) throw new Error('請輸入 http 或 https 的 ComfyUI 主機網址。');
  return url.origin;
}

export function checkGraphAvailability(graph,schemas) {
  const errors=[];
  for(const [id,node] of Object.entries(graph)) {
    const schema=schemas[node.class_type];
    if(!schema) {errors.push(`缺少節點：${node.class_type}`);continue;}
    const fields={...schema.input?.required,...schema.input?.optional};
    for(const name of Object.keys(schema.input?.required || {})) {
      if(!Object.hasOwn(node.inputs,name) && !Object.keys(node.inputs).some(key=>key.startsWith(name+'.'))) errors.push(`${node.class_type} 缺少必要輸入：${name}`);
    }
    for(const [name,value] of Object.entries(node.inputs)) {
      const field=fields[name],options=field?.[1] || {};
      if(Array.isArray(value) && graph[String(value[0])]) {
        const outputs=schemas[graph[String(value[0])].class_type]?.output;
        if(outputs && (value[1]<0 || value[1]>=outputs.length)) errors.push(`節點 ${id} 的 ${name} 連到無效輸出。`);
        continue;
      }
      if(node.class_type==='LoadImage' && name==='image') continue;
      if(Array.isArray(field?.[0]) && !field[0].includes(value)) errors.push(`${node.class_type} 缺少或不支援 ${name}：${value}`);
      if(typeof value==='number' && (options.min!==undefined && value<options.min || options.max!==undefined && value>options.max)) errors.push(`${node.class_type} 的 ${name} 不支援 ${value}。`);
      if(field?.[0]==='INT' && !Number.isInteger(value)) errors.push(`${node.class_type} 的 ${name} 必須為整數。`);
    }
  }
  return [...new Set(errors)];
}

export async function testComfyConnection({comfyUrl,workflowPath='bundled',cameraWorkflowPath='bundled'},comfyJson,{bundleDir=BUNDLE_DIR}={}) {
  const url=normalizeComfyUrl(comfyUrl),schemas={},requests=new Map();
  const schemaFor=type => {
    if(!requests.has(type)) requests.set(type,comfyJson(`/object_info/${encodeURIComponent(type)}`,{},url).then(info => {Object.assign(schemas,info);return info;}));
    return requests.get(type);
  };
  const read = async (workflowPath,kind) => {
    if(typeof workflowPath!=='string' || workflowPath!=='bundled' && (!workflowPath.endsWith('.json') || /\.\.|[\\\0]/.test(workflowPath))) throw new Error('工作流路徑無效。');
    const relative=kind==='base' ? 'workflows/Qwen Image 2.1/02 Qwen Image 2.1 Uncensored 5090 High Quality - 圖生圖.json' : 'workflows/Qwen Multiangle/01 Qwen 2511 - 單圖 3D 相機換角度.json';
    const ui=workflowPath==='bundled' ? JSON.parse(fs.readFileSync(path.join(bundleDir,relative),'utf8')) : await comfyJson(`/userdata/${encodeURIComponent('workflows/'+workflowPath)}`,{},url);
    const types=[...new Set(ui.nodes?.filter(node=>!['MarkdownNote','Note'].includes(node.type)).map(node=>node.type) || [])];
    if(!types.length) throw new Error('工作流沒有可執行的節點。');
    await Promise.all(types.map(schemaFor));
    return {ui,graph:convertWorkflow(ui,schemas,kind==='angle' ? {validate:validateCameraWorkflow} : {})};
  };
  let base,angle;
  const stages=[];
  try {
    const stats=await comfyJson('/system_stats',{},url);
    [base,angle]=await Promise.all([read(workflowPath,'base'),read(cameraWorkflowPath,'angle')]);
    const shot={id:'environment-check',cameraMode:'multiangle',camera:{angle:{horizontalAngle:133,verticalAngle:-90,zoom:10}},angleSteps:20,refineDenoise:0.2,steps:40,seed:1,resolution:1536,aspectRatio:'16:9',outputWidth:2048,outputHeight:1152,prompt:'1 girl\n\nPhotographic portrait.',negative:'blurry'};
    for(const [stage,name,images] of [['base','原圖',{character:'PhotoCreate/check-character.png',garment:'PhotoCreate/check-garment.png'}],['angle','換角度',{source:'PhotoCreate/check-original.png'}],['refine','高清修正',{source:'PhotoCreate/check-angle.png'}]]) {
      const graph=buildCameraStage(base.graph,angle.graph,shot,stage,images);
      await Promise.all([...new Set(Object.values(graph).map(node=>node.class_type))].map(schemaFor));
      const errors=checkGraphAvailability(graph,schemas);
      if(stage==='angle') {
        const upper=structuredClone(graph),camera=Object.values(upper).find(node=>node.class_type==='QwenMultiangleCameraNode');
        Object.assign(camera.inputs,{horizontal_angle:360,vertical_angle:60,zoom:0});errors.push(...checkGraphAvailability(upper,schemas));
      }
      stages.push({stage,name,ready:!errors.length,errors:[...new Set(errors)]});
    }
    // Also verify the alternate reference-ratio resize used by the workbench.
    await schemaFor('ImageScaleToTotalPixels');
    const errors=checkGraphAvailability({resize:{class_type:'ImageScaleToTotalPixels',inputs:{image:['image',0],upscale_method:'lanczos',megapixels:2.359296,resolution_steps:32}},image:{class_type:'LoadImage',inputs:{image:'PhotoCreate/check.png'}}},schemas);
    if(errors.length) {stages[2].errors.push(...errors);stages[2].ready=false;}
    return {ready:stages.every(stage=>stage.ready),comfyUrl:url,device:stats.devices?.[0]?.name || 'ComfyUI',stages,workflowPath,cameraWorkflowPath,checkedAt:new Date().toISOString(),base,angle};
  } catch(error) {return {ready:false,comfyUrl:url,stages,error:error.message,workflowPath,cameraWorkflowPath};}
}

export function publicConnectionTest(result) {
  const {base,angle,...summary}=result;return summary;
}
