export const PHOTO_VIDEO_VERSION=1;
export const VIDEO_DURATIONS=[5,7,10];
export const VIDEO_FPS=24;
export const VIDEO_ASPECT_RATIOS={'reference':'沿用照片','1:1':'方形 1:1','16:9':'橫式 16:9','9:16':'直式 9:16'};
export const LEGACY_VIDEO_PROMPT='照這圖片自然演繹後續動畫。';
export const DEFAULT_VIDEO_PROMPT='The subject gently sways their body. The camera slowly moves closer and settles on an upper-body framing, preserving the person\'s appearance and the original scene with smooth, natural motion.';
export const DEFAULT_VIDEO_WORKFLOW_PATH='PhotoCreate/01 FastH3 Trim - 圖生影片.json';
export const VIDEO_GENERATION_VERSIONS={single:'一採版', 'two-pass':'二採升頻版（5090 NVFP4）'};
export const TWO_PASS_WORKFLOW_PATH='PhotoCreate/02 FastH3 Trim－升頻二採（5090 NVFP4）.json';
export const DEFAULT_TWO_PASS_UNET='fastvideo_fasth3_trim_8step_nvfp4.safetensors';
export const DEFAULT_LATENT_UPSCALER='minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors';
export const videoModelsFor=config=>config.generationVersion==='two-pass' ? {...config.models,unet:config.twoPassUnet,latentUpscaler:config.latentUpscaler} : config.models;
export function normalizeVideoWorkflowPath(value='bundled') {
  if(value==='bundled') return value;
  if(typeof value!=='string' || value.length>300 || !value.endsWith('.json') || /[\\:\0]/.test(value) || value.split('/').some(part=>!part || part==='..' || part==='.') || value.endsWith('.api.json')) throw fail('請選擇可編輯的 ComfyUI 影片工作流（.json）。');
  return value;
}
export const DEFAULT_VIDEO_MODELS={
  unet:'fastvideo_fasth3_trim_8step_int8_convrot.safetensors',
  videoVae:'minimax_h3_video_vae_int8_convrot.safetensors',
  audioVae:'minimax_h3_audio_vae_fp32.safetensors',
  clip:'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
};
export const VIDEO_MODEL_LABELS={unet:'FastH3 Trim 8 步模型',videoVae:'影片 VAE',audioVae:'音訊 VAE',clip:'文字編碼器',latentUpscaler:'二採 Latent 升頻模型'};
export function normalizeVideoModels(input={}) {
  if(!input || typeof input!=='object' || Array.isArray(input)) throw fail('影片模型設定格式不正確。');
  const models={...DEFAULT_VIDEO_MODELS,...input};
  const keys=[...Object.keys(DEFAULT_VIDEO_MODELS),...(input.latentUpscaler===undefined ? [] : ['latentUpscaler'])];
  for(const key of keys) if(typeof models[key]!=='string' || !models[key] || models[key].length>300 || models[key].split(/[\\/]/).some(part=>part==='..' || part==='.' || !part) || /[:\0]/.test(models[key])) throw fail('影片模型檔名無效。');
  return Object.fromEntries(keys.map(key=>[key,models[key]]));
}
export const videoIsActive=row=>['queued','submitting','running','archiving','stopping','uncertain'].includes(row.status);
export const completedVideoCount=(rows=[],imageIndex)=>rows.filter(row=>row.status==='completed' && (imageIndex===undefined || row.imageIndex===imageIndex)).length;
export const videoStatus=row=>({queued:'等候產影片',submitting:'正在準備影片',running:'正在產影片',archiving:'正在保存影片',stopping:'正在停止影片',uncertain:'正在確認影片狀態',completed:'影片已完成',failed:'影片未完成',stopped:'影片已停止'}[row.status] || '等候產影片');
const fail=message=>Object.assign(new Error(message),{status:400});
export function defaultVideoSettings() {
  return {defaultDuration:5,defaultAspectRatio:'reference',prompts:[{id:'natural',name:'自然演繹',prompt:DEFAULT_VIDEO_PROMPT}],selectedPromptIds:['natural'],models:{...DEFAULT_VIDEO_MODELS},workflowPath:'bundled',generationVersion:'single',twoPassUnet:DEFAULT_TWO_PASS_UNET,latentUpscaler:DEFAULT_LATENT_UPSCALER};
}
export function normalizeVideoSettings(input) {
  if(!input || typeof input!=='object' || Array.isArray(input)) throw fail('影片設定格式不正確。');
  if(!VIDEO_DURATIONS.includes(input.defaultDuration)) throw fail('預設影片秒數請選擇 5、7 或 10 秒。');
  const defaultAspectRatio='reference';
  if(input.defaultAspectRatio!==undefined && !Object.hasOwn(VIDEO_ASPECT_RATIOS,input.defaultAspectRatio)) throw fail('影片比例固定沿用來源照片。');
  if(!Array.isArray(input.prompts) || input.prompts.length>10000) throw fail('官方影片提詞最多 10,000 個。');
  const ids=new Set(),prompts=input.prompts.map(row=>{
    if(!row || typeof row.id!=='string' || !/^[\w-]{1,120}$/.test(row.id) || ids.has(row.id)) throw fail('官方影片提詞 ID 無效或重複。');
    ids.add(row.id);
    if(typeof row.name!=='string' || !row.name.trim() || row.name.trim().length>200) throw fail('官方影片提詞名稱需為 1–200 個字。');
    if(typeof row.prompt!=='string' || !row.prompt.trim() || row.prompt.length>16000) throw fail('影片提詞需為 1–16000 個字。');
    return {id:row.id,name:row.name.trim(),prompt:row.prompt.trim()};
  });
  const selectedPromptIds=input.selectedPromptIds ?? prompts.map(row=>row.id);
  if(!Array.isArray(selectedPromptIds) || selectedPromptIds.length>10000 || new Set(selectedPromptIds).size!==selectedPromptIds.length || selectedPromptIds.some(id=>!ids.has(id))) throw fail('請選擇有效的官方影片提詞。');
  const generationVersion=input.generationVersion ?? 'single';if(!Object.hasOwn(VIDEO_GENERATION_VERSIONS,generationVersion)) throw fail('請選擇一採或二採影片版本。');
  const twoPassUnet=input.twoPassUnet ?? DEFAULT_TWO_PASS_UNET,latentUpscaler=input.latentUpscaler ?? DEFAULT_LATENT_UPSCALER;normalizeVideoModels({unet:twoPassUnet,latentUpscaler});
  return {defaultDuration:input.defaultDuration,defaultAspectRatio,prompts,selectedPromptIds:[...selectedPromptIds],models:normalizeVideoModels(input.models),workflowPath:normalizeVideoWorkflowPath(input.workflowPath),generationVersion,twoPassUnet,latentUpscaler};
}
export function videoPublicationMatches(config,published) {
  if(!config || !published) return false;
  const ids=config.selectedPromptIds || config.prompts.map(row=>row.id);
  return JSON.stringify(config.prompts.filter(row=>ids.includes(row.id)))===JSON.stringify(published.prompts);
}
export function videoRequest(body,settings=defaultVideoSettings()) {
  if(!body || typeof body!=='object' || Array.isArray(body)) throw fail('影片請求格式不正確。');
  const {requestId,imageIndex=0,duration=settings.defaultDuration,aspectRatio=settings.defaultAspectRatio || 'reference',mode='official',presetId=settings.prompts[0]?.id,prompt=''}=body;
  if(typeof requestId!=='string' || !/^[\w-]{8,80}$/.test(requestId)) throw fail('請重新整理後再送出影片。');
  if(!Number.isInteger(imageIndex) || imageIndex<0 || imageIndex>99) throw fail('照片索引無效。');
  if(!VIDEO_DURATIONS.includes(duration)) throw fail('影片秒數請選擇 5、7 或 10 秒。');
  if(typeof aspectRatio!=='string' || !Object.hasOwn(VIDEO_ASPECT_RATIOS,aspectRatio)) throw fail('影片比例請選擇沿用照片、方形、橫式或直式。');
  if(!['official','custom'].includes(mode)) throw fail('請選擇官方提詞或自行輸入。');
  if(mode==='custom' && (typeof prompt!=='string' || !prompt.trim() || prompt.length>16000)) throw fail('請輸入 1–16000 個字的影片提詞。');
  if(mode==='official' && (typeof presetId!=='string' || !presetId)) throw fail('請選擇官方影片提詞。');
  return {requestId,imageIndex,duration,aspectRatio:'reference',mode,...(mode==='official' ? {presetId} : {prompt:prompt.trim()})};
}
