import { DEFAULT_PRESETS } from '../shared/domain.js';
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==','base64');
export const TEMPLATE = {
  '1':{class_type:'UNETLoader',inputs:{unet_name:'qwen-image-2.1-UC-int8_convrot.safetensors',weight_dtype:'default'}},
  '2':{class_type:'CLIPLoader',inputs:{clip_name:'qwen3vl_8b_bf16.safetensors',type:'qwen_image',device:'default'}},
  '3':{class_type:'VAELoader',inputs:{vae_name:'qwen_image_2.1_vae_bf16.safetensors'}},
  '4':{class_type:'QwenImage21Cache',inputs:{model:['1',0],device:'auto',dtype:'default'}},
  '7':{class_type:'KSampler',inputs:{model:['4',0],positive:['12',0],negative:['12',1],latent_image:['12',2],seed:1,steps:40,cfg:1,sampler_name:'euler',scheduler:'simple',denoise:1}},
  '8':{class_type:'VAEDecode',inputs:{samples:['7',0],vae:['3',0]}},
  '9':{class_type:'SaveImage',inputs:{images:['8',0],filename_prefix:'Qwen'}},
  '11':{class_type:'LoadImage',inputs:{image:'0.png'}},
  '12':{class_type:'TextEncodeQwenImage21',inputs:{clip:['2',0],vae:['3',0],'images.image_1':['11',0],prompt:'source prompt',negative_prompt:'',resolution:1536}},
};
export const DRAFT = {characterId:'character',sceneInteraction:'',garmentIds:['garment-a','garment-b'],poseIds:['pose-standing','pose-sitting'],cameraId:'camera-full',lightingId:'light-window',colorId:'color-natural',qualityId:'quality-editorial',copies:2,seed:100,resolution:1536,steps:40,extra:'保持刺繡细節。',negative:'blurry'};
export function fixtureState() {
  const asset = (id,name) => ({id,name,description:`${name}的描述`,tags:[],fileName:`${id}.png`,image:`/uploads/${id}.png`,mime:'image/png',createdAt:'2026-10-08T00:00:00.000Z'});
  return {characters:[asset('character','角色')],garments:[asset('garment-a','白色洋裝'),asset('garment-b','黑色外套')],scenes:[asset('scene','海邊')],presets:structuredClone(DEFAULT_PRESETS)};
}
