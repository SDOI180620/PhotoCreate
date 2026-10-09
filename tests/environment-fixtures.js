import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {TEMPLATE} from './fixtures.js';
import {CAMERA_TEMPLATE} from './camera-fixtures.js';
import {BUNDLED_WORKFLOW_PATH,BUNDLED_CAMERA_PATH} from '../server/environment.js';

export function environmentFixture() {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-env-'));
  const root=path.join(temporary,'ComfyUI'),bundleDir=path.join(temporary,'bundle'),dataDir=path.join(temporary,'data');
  fs.mkdirSync(path.join(root,'comfy'),{recursive:true});fs.writeFileSync(path.join(root,'main.py'),'# ComfyUI fixture');
  fs.mkdirSync(bundleDir,{recursive:true});
  const graphNodes=[...Object.values(TEMPLATE),...Object.values(CAMERA_TEMPLATE),
    {class_type:'LatentUpscale',inputs:{samples:['12',2],upscale_method:'nearest-exact',width:1024,height:576,crop:'disabled'}},
    {class_type:'ImageScale',inputs:{image:['7',0],upscale_method:'lanczos',width:2048,height:1152,crop:'disabled'}},
    {class_type:'ImageScaleToTotalPixels',inputs:{image:['7',0],upscale_method:'lanczos',megapixels:2.359296,resolution_steps:32}}];
  const schemas={};
  const integers=new Set(['horizontal_angle','seed','steps','resolution','width','height','resolution_steps']);
  const modelNames=new Set(['unet_name','clip_name','vae_name','lora_name']);
  for(const node of graphNodes) {
    const schema=schemas[node.class_type] ||= {input:{required:{},optional:{}},output:['*','*','*']};
    for(const [name,value] of Object.entries(node.inputs)) {
      const fields=schema.input.required;
      if(modelNames.has(name)) {fields[name] ||= [[],{}];if(!fields[name][0].includes(value)) fields[name][0].push(value);}
      else if(!fields[name]) fields[name]=[Array.isArray(value) ? name==='prompt' ? 'STRING' : 'LINK' : typeof value==='boolean' ? 'BOOLEAN' : typeof value==='number' ? integers.has(name) ? 'INT' : 'FLOAT' : 'STRING',{default:Array.isArray(value) ? undefined : value}];
    }
  }
  const camera=schemas.QwenMultiangleCameraNode.input.required;
  camera.vertical_angle=['FLOAT',{default:0,min:-90,max:60}];camera.zoom=['FLOAT',{default:5,min:0,max:10}];
  // These sockets are optional in ComfyUI, and are absent from some encoders.
  for(const [type,names] of [['TextEncodeQwenImage21',['images.image_1']],['TextEncodeQwenImageEditPlus',['vae','image1']]]) {
    for(const name of names) {schemas[type].input.optional[name]=schemas[type].input.required[name];delete schemas[type].input.required[name];}
  }
  for(const schema of Object.values(schemas)) schema.input_order={required:Object.keys(schema.input.required),optional:Object.keys(schema.input.optional)};
  function toUi(graph) {
    const links=[],nodes=[];let linkId=0;
    for(const [id,node] of Object.entries(graph)) {
      const schema=schemas[node.class_type],fields={...schema.input.required,...schema.input.optional},inputs=[],widgets=[];
      for(const [name,value] of Object.entries(node.inputs)) if(Array.isArray(value)) {
        links.push([++linkId,Number(value[0]),value[1],Number(id),inputs.length,'*']);inputs.push({name,link:linkId});
      }
      for(const [name,[type,options]] of Object.entries(fields)) {
        if(Array.isArray(node.inputs[name]) || type==='LINK') continue;
        widgets.push(node.inputs[name] ?? options.default ?? (Array.isArray(type) ? type[0] : ''));
      }
      nodes.push({id:Number(id),type:node.class_type,inputs,widgets_values:widgets,mode:0});
    }
    return {nodes,links};
  }
  const baseUi=toUi(TEMPLATE),cameraUi=toUi(CAMERA_TEMPLATE),resources=[];
  function addFile(id,kind,source,target,bytes) {
    const file=path.join(bundleDir,source);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);
    resources.push({id,kind,label:id,source,target,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  addFile('base','workflow','workflows/Qwen Image 2.1/02 Qwen Image 2.1 Uncensored 5090 High Quality - 圖生圖.json','user/default/workflows/'+BUNDLED_WORKFLOW_PATH,Buffer.from(JSON.stringify(baseUi)));
  addFile('angle','workflow','workflows/Qwen Multiangle/01 Qwen 2511 - 單圖 3D 相機換角度.json','user/default/workflows/'+BUNDLED_CAMERA_PATH,Buffer.from(JSON.stringify(cameraUi)));
  addFile('camera-node','node','custom_nodes/ComfyUI-qwenmultiangle/nodes.py','custom_nodes/ComfyUI-qwenmultiangle/nodes.py',Buffer.from('# enhanced camera fixture'));
  const payload=Buffer.alloc(256*1024,42),header=Buffer.from(JSON.stringify({weight:{dtype:'U8',shape:[payload.length],data_offsets:[0,payload.length]}})),length=Buffer.alloc(8);length.writeBigUInt64LE(BigInt(header.length));
  const model=Buffer.concat([length,header,payload]);
  resources.push({id:'model',kind:'model',label:'fixture.safetensors',target:'models/diffusion_models/fixture.safetensors',size:model.length,sha256:createHash('sha256').update(model).digest('hex'),url:'https://models.test/fixture.safetensors',sourceUrl:'https://models.test/fixture'});
  const manifest={name:'PhotoCreate environment fixture',version:1,resources};fs.writeFileSync(path.join(bundleDir,'manifest.json'),JSON.stringify(manifest));
  const controls={missingModel:false,missingCamera:false,legacyCamera:false,foreignQueue:false,queueError:false,queueOffline:false,requests:[]};
  const fetchImpl=async (url,options={}) => {
    controls.requests.push({url,method:options.method || 'GET'});
    const parsed=new URL(url),route=decodeURIComponent(parsed.pathname);
    if(parsed.hostname==='models.test') return new Response(model);
    if(route==='/system_stats') return Response.json({devices:[{name:'Fixture GPU'}]});
    if(route==='/queue') {
      if(controls.queueOffline) throw Object.assign(new Error('fetch failed'),{cause:{code:'ECONNREFUSED'}});
      if(controls.queueError) return Response.json({error:'temporary upstream error'},{status:500});
      return Response.json({queue_running:controls.foreignQueue ? [[0,'foreign-job']] : [],queue_pending:[]});
    }
    if(route==='/userdata') return Response.json(resources.filter(resource=>resource.kind==='workflow' && fs.existsSync(path.join(root,resource.target))).map(resource=>resource.target.replace('user/default/workflows/','')));
    if(route.startsWith('/userdata/')) {
      const file=path.join(root,'user/default',route.slice('/userdata/'.length));
      return fs.existsSync(file) ? Response.json(JSON.parse(fs.readFileSync(file,'utf8'))) : new Response('',{status:404});
    }
    if(route.startsWith('/object_info/')) {
      const type=route.split('/').at(-1),schema=structuredClone(schemas[type]);
      if(!schema) return Response.json({});
      if(controls.missingCamera && type==='QwenMultiangleCameraNode') return Response.json({});
      if(controls.missingModel && type==='UNETLoader') schema.input.required.unet_name[0]=['unrelated-model.safetensors'];
      if(controls.legacyCamera && type==='QwenMultiangleCameraNode') {schema.input.required.vertical_angle[1].min=-30;schema.input.required.zoom[1].max=8;}
      return Response.json({[type]:schema});
    }
    throw new Error('Unexpected ComfyUI request: '+route);
  };
  return {temporary,root,bundleDir,dataDir,manifest,model,schemas,baseUi,cameraUi,controls,fetchImpl};
}

export async function settleInstall(manager,statuses=['completed','failed','paused']) {
  for(let attempts=0;attempts<300;attempts++) {
    if(statuses.includes(manager.status()?.status)) return manager.status();
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw new Error('Installation did not finish in fixture deadline');
}
