import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DEFAULT_VIDEO_PROMPT,DEFAULT_TWO_PASS_UNET,DEFAULT_LATENT_UPSCALER} from '../shared/photo-video.js';
import {comfyInputFields,isComfyWidget,widgetDefault} from '../shared/comfy-widgets.js';

const directory=new URL('../bundles/comfyui/',import.meta.url);
const first='workflows/MiniMax H3/01 FastH3 Trim - 圖生影片';
const second='workflows/MiniMax H3/02 FastH3 Trim－升頻二採（5090 NVFP4）';
const single=JSON.parse(fs.readFileSync(new URL(first+'.api.json',directory),'utf8'));
single.resolution.inputs.megapixels=1;
const two=structuredClone(single);
two.model.inputs.unet_name=DEFAULT_TWO_PASS_UNET;
two.resolution.inputs.megapixels=0.4;
two.sample.inputs.sigmas=['sigmas_first',0];
Object.assign(two,{
  sigmas_first:{class_type:'SplitSigmas',inputs:{sigmas:['schedule',0],step:4}},
  separate:{class_type:'LTXVSeparateAVLatent',inputs:{av_latent:['sample',1]}},
  resolution_high:{class_type:'ResolutionSelector',inputs:{...single.resolution.inputs,megapixels:1}},
  encode_high:{class_type:'MiniMaxH3ImageToVideo',inputs:{...single.encode.inputs,width:['resolution_high',0],height:['resolution_high',1]}},
  upscale:{class_type:'MinimaxH3LatentUpscaler3D',inputs:{latent:['separate',0],model_name:DEFAULT_LATENT_UPSCALER,mode:'target dimensions','mode.width':['resolution_high',0],'mode.height':['resolution_high',1],align:32,enable_temporal_chunking:true,force_unload:true,device:'cuda',precision:'fp16'}},
  concat:{class_type:'LTXVConcatAVLatent',inputs:{video_latent:['upscale',0],audio_latent:['separate',1]}},
  guider_high:{class_type:'BasicGuider',inputs:{model:['sparse',0],conditioning:['encode_high',0]}},
  sigmas_refine:{class_type:'ManualSigmas',inputs:{sigmas:'0.9035, 0.6316, 0.3158, 0.0000'}},
  sample_refine:{class_type:'SamplerCustomAdvanced',inputs:{noise:['noise',0],guider:['guider_high',0],sampler:['sampler',0],sigmas:['sigmas_refine',0],latent_image:['concat',0]}},
});
two.decode.inputs.samples=['sample_refine',0];two.decode_audio.inputs.samples=['sample_refine',0];
for(const [source,api] of [[first,single],[second,two]]) fs.writeFileSync(new URL(source+'.api.json',directory),JSON.stringify(api,null,2)+'\n');
const schemas=await (await fetch(process.env.PHOTOCREATE_COMFY_URL || 'http://127.0.0.1:8188/object_info')).json();
const manifestUrl=new URL('video-manifest.json',directory),manifest=JSON.parse(fs.readFileSync(manifestUrl,'utf8'));
for(const [prefix,api,generationVersion] of [[first,single,'single'],[second,two,'two-pass']]) {
const source=prefix+'.json';
const ids=Object.fromEntries(Object.keys(api).map((key,index)=>[key,index+1])),nodes=[],links=[];
const positions={source:[40,100],video_vae:[40,450],audio_vae:[40,700],clip:[40,950],resolution:[420,100],model:[420,440],noise:[420,660],sampler:[420,830],schedule:[420,1010],encode:[820,100],shift:[820,750],attention:[820,990],sparse:[1160,990],guider:[1170,100],sample:[1540,100],decode:[1890,100],decode_audio:[1890,550],trim_frames:[2220,100],trim_audio:[2220,550],combine:[2600,200],save:[2930,200]};
if(generationVersion==='two-pass') Object.assign(positions,{sigmas_first:[1170,450],separate:[1890,100],resolution_high:[420,1350],encode_high:[820,1350],upscale:[2220,100],concat:[2550,100],guider_high:[1170,1350],sigmas_refine:[1540,1350],sample_refine:[2890,100],decode:[3230,100],decode_audio:[3230,550],trim_frames:[3560,100],trim_audio:[3560,550],combine:[3890,200],save:[4220,200]});
for(const [role,node] of Object.entries(api)) {
  const schema=schemas[node.class_type];if(!schema) throw new Error('Missing schema: '+node.class_type);
  const inputs=[],widgets=[],chosen={};
  for(const [name,spec] of comfyInputFields(schema,name=>chosen[name])) {
    const [type,options={}]=spec,value=node.inputs[name],widget=isComfyWidget(spec);
    const linked=Array.isArray(value);
    if(options.socketless || options.hidden) continue;
    if(linked || !widget || !options.forceInput) {
      const link=linked ? links.length+1 : null;
      inputs.push({name,type:Array.isArray(type) ? 'COMBO' : type,link,...(widget ? {widget:{name}} : {})});
      if(linked) links.push([link,ids[value[0]],value[1],ids[role],inputs.length-1,type]);
    }
    if(widget && !options.forceInput) {
      const fallback=widgetDefault(spec);
      chosen[name]=role==='source' && name==='image' ? '' : ['encode','encode_high'].includes(role) && name==='prompt' ? DEFAULT_VIDEO_PROMPT : linked ? fallback : value ?? fallback;
      widgets.push(chosen[name]);
      if(options.control_after_generate) widgets.push('fixed');
    }
  }
  if(role==='source') widgets.push('image');
  nodes.push({id:ids[role],type:node.class_type,title:role==='resolution' ? 'Resolution Selector (Size)' : role==='resolution_high' ? 'Resolution Selector · 二採輸出尺寸' : node.class_type,pos:positions[role],size:[300,['encode','encode_high'].includes(role) ? 530 : ['sparse','upscale'].includes(role) ? 400 : 220],flags:{},order:nodes.length,mode:0,inputs,outputs:schema.output.map((type,index)=>({name:schema.output_name?.[index] || type,type,links:[],slot_index:index})),properties:{'Node name for S&R':node.class_type,photocreate_role:role},widgets_values:widgets});
}
for(const [id,sourceId,slot] of links) nodes.find(node=>node.id===sourceId).outputs[slot].links.push(id);
nodes.push({id:nodes.length+1,type:'Note',title:'PhotoCreate · 編輯後請儲存工作流',pos:[820,generationVersion==='two-pass' ? 1950 : 1350],size:[650,230],flags:{},order:nodes.length,mode:0,inputs:[],outputs:[],properties:{},widgets_values:['可調整 KSamplerSelect、BasicScheduler 與 Resolution Selector (Size) 的 Megapixels。\n在 ComfyUI 儲存後，PhotoCreate 每次產新影片會讀取所選工作流。\nPhotoCreate 會填入照片、官方／自訂提詞、5／7／10 秒、來源照片比例、模型與輸出位置；已排入的影片使用自己的工作流快照。'+(generationVersion==='two-pass' ? '\n二採：Simple 8 步排程取前 4 步 → Latent 升頻 → ManualSigmas 3 步細化。預設 0.4 MP → 1 MP。' : '\n一採：Euler / Simple / 8 步 / 1 MP。')]});
const ui={last_node_id:nodes.length,last_link_id:links.length,nodes,links,groups:[],config:{},extra:{ds:{scale:0.6,offset:[40,40]}},version:0.4};
const bytes=Buffer.from(JSON.stringify(ui,null,2)+'\n');fs.writeFileSync(new URL(source,directory),bytes);
let resource=manifest.resources.find(row=>row.id===(generationVersion==='single' ? 'video-workflow' : 'video-workflow-two-pass'));
if(!resource) {resource={id:'video-workflow-two-pass',kind:'workflow',label:'FastH3 Trim 升頻二採（5090 NVFP4）工作流',source};manifest.resources.push(resource);}
const retires=resource.source.endsWith('.api.json') ? [{target:resource.target,sha256:resource.sha256}] : resource.retires;
Object.assign(resource,{source,target:'user/default/workflows/PhotoCreate/'+path.posix.basename(source),size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),retires,generationVersions:[generationVersion]});
console.log({nodes:nodes.length,links:links.length,source});
}
fs.writeFileSync(manifestUrl,JSON.stringify(manifest,null,2)+'\n');
