const inputImage = input => {
  const parts = String(input).replaceAll('\\','/').split('/');
  return {filename:parts.pop(),subfolder:parts.join('/'),type:'input'};
};

// A fresh regular remake has its own base image. Angle edits inherit that
// original through their ancestry, even after replacement results are deleted.
export function resolveCameraSource(state,job,imageIndex = 0) {
  if(!job || !Number.isInteger(imageIndex) || imageIndex < 0) throw new Error('原圖索引無效。');
  const records = new Map(state.jobs.map(row => [row.id,row])),visited = new Set(),edits = [];
  const descriptor = (row,image,comfyUrl,stage,index = imageIndex) => ({image:structuredClone(image),comfyUrl:comfyUrl || row.comfyUrl || state.settings?.comfyUrl,jobId:row.id,stage,imageIndex:index});
  let current = job,index = imageIndex;
  while(current && !visited.has(current.id)) {
    visited.add(current.id);
    const base = current.stageResults?.base;
    if(base?.completed && base.images?.length) return descriptor(current,base.images[index] || base.images[0],base.comfyUrl,'base',base.images[index] ? index : 0);
    if(current.cameraSource?.image) {
      const source = structuredClone(current.cameraSource);
      if(source.stage !== 'base' && current.sourceInput && current.sourceInputComfyUrl) Object.assign(source,{image:inputImage(current.sourceInput),comfyUrl:current.sourceInputComfyUrl});
      return source;
    }
    if(current.jobKind !== 'angle-edit') {
      if(Object.values(current.apiPrompt || {}).some(node => node.class_type === 'QwenMultiangleCameraNode')) throw new Error('這張舊成果未保存轉角前的原圖，請重新生成拍攝後再調整角度。');
      if(!current.outputsDeletedAt && current.images?.[index]) return descriptor(current,current.images[index],current.comfyUrl,'source',index);
      break;
    }
    edits.push(current);
    index = current.sourceImageIndex || 0;
    current = records.get(current.sourceJobId) || records.get(current.rootJobId);
  }
  // Legacy edits predate the base-image snapshot. The first edit's uploaded
  // input remains the original after its old output has been removed.
  for(const edit of edits.reverse()) {
    if(edit.rootJobId && edit.sourceJobId !== edit.rootJobId) continue;
    const image = edit.sourceInput && edit.sourceInputComfyUrl ? inputImage(edit.sourceInput) : edit.sourceImage;
    if(image?.filename) return {image:structuredClone(image),comfyUrl:edit.sourceInput && edit.sourceInputComfyUrl || edit.sourceComfyUrl || edit.comfyUrl || state.settings?.comfyUrl,jobId:edit.sourceJobId || edit.id,stage:'source',imageIndex:edit.sourceImageIndex || 0};
  }
  throw new Error('找不到首次生成的原圖，請保留原拍攝紀錄或重新生成。');
}
