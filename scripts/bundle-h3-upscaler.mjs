import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {DEFAULT_TWO_PASS_UNET,DEFAULT_LATENT_UPSCALER} from '../shared/photo-video.js';

const directory=new URL('../bundles/comfyui/',import.meta.url),manifestUrl=new URL('video-manifest.json',directory);
const manifest=JSON.parse(fs.readFileSync(manifestUrl,'utf8'));
const nodeRevision='40316cf008b2fd8663263270669eb4da23f89d2c';
const files=['LICENSE','__init__.py','nodes/__init__.py','nodes/MMH3_Split_Upscale.py','nodes/minimax_h3_latent_upscaler_2d.py','nodes/minimax_h3_latent_upscaler_3d.py'];
for(const file of files) {
  const url=`https://raw.githubusercontent.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler/${nodeRevision}/${file}`;
  const response=await fetch(url);if(!response.ok) throw new Error(`${response.status}: ${url}`);
  const bytes=Buffer.from(await response.arrayBuffer()),source='custom_nodes/Comfyui_Minimax_h3_latent_Upscaler/'+file,target=new URL(source,directory);
  fs.mkdirSync(new URL('.',target),{recursive:true});fs.writeFileSync(target,bytes);
  const id='video-upscaler-node-'+file.replaceAll('/','-');
  manifest.resources=manifest.resources.filter(row=>row.id!==id);
  manifest.resources.push({id,kind:'node',label:'H3 Latent 升頻節點 · '+file,source,target:source,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),generationVersions:['two-pass'],sourceUrl:`https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler/blob/${nodeRevision}/${file}`});
}
const unet=structuredClone(manifest.resources.find(row=>row.role==='unet'));
Object.assign(unet,{id:'video-model-fastvideo_fasth3_trim_8step_nvfp4',fileName:DEFAULT_TWO_PASS_UNET,label:DEFAULT_TWO_PASS_UNET,target:'models/diffusion_models/'+DEFAULT_TWO_PASS_UNET,size:11894623166,sha256:'748b2bcc9c4b7bf7b23406987b42d4ac40362070c164cf11092482be6a863455'});
unet.url=`https://huggingface.co/${unet.repository}/resolve/${unet.revision}/diffusion_models/${unet.fileName}`;
unet.sourceUrl=`https://huggingface.co/${unet.repository}/blob/${unet.revision}/diffusion_models/${unet.fileName}`;
const repository='LBH-123-AI/Minimax_h3_latent_Upscaler',revision='3f941d5d182014dd5c0a5e16330420ee2d4aa0c6',file='minimax_h3_latent_upscaler_3d_conv_v1/'+DEFAULT_LATENT_UPSCALER;
const upscale={id:'video-model-h3-upscaler-3d-conv-v1-fp16',kind:'model',role:'latentUpscaler',fileName:DEFAULT_LATENT_UPSCALER,label:DEFAULT_LATENT_UPSCALER,target:'models/latent_upscale_models/'+DEFAULT_LATENT_UPSCALER,size:690592672,sha256:'043e5a48e161610ef6c3ea974645220354d06fa618abca15f76d084812eb55c2',repository,revision,url:`https://huggingface.co/${repository}/resolve/${revision}/${file}`,sourceUrl:`https://huggingface.co/${repository}/blob/${revision}/${file}`};
for(const resource of [unet,upscale]) {manifest.resources=manifest.resources.filter(row=>row.id!==resource.id);manifest.resources.push(resource);}
fs.writeFileSync(manifestUrl,JSON.stringify(manifest,null,2)+'\n');
console.log({nodeRevision,files:files.length,models:[unet.fileName,upscale.fileName]});
