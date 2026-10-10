const inputImage = input => {
  const parts = String(input).replaceAll('\\','/').split('/');
  return {filename:parts.pop(),subfolder:parts.join('/'),type:'input'};
};

// A new camera request always starts from the visible, selected output.
export function resolveSelectedPhotoSource(state,job,imageIndex = 0) {
  if(!Number.isInteger(imageIndex) || imageIndex < 0) throw new Error('照片索引無效。');
  const image = !job?.outputsDeletedAt && job?.images?.[imageIndex];
  if(!image?.filename) throw new Error('找不到選取的照片，請選擇尚未刪除的成果。');
  return {image:structuredClone(image),comfyUrl:job.comfyUrl || state.settings?.comfyUrl,jobId:job.id,stage:'source',imageIndex,seed:job.seed};
}

// Repeating an existing angle job uses its saved input. Legacy jobs retain
// their original-source behavior; new camera requests use the helper above.
export function resolveCameraSource(state,job,imageIndex = 0) {
  if(!job || !Number.isInteger(imageIndex) || imageIndex < 0) throw new Error('原圖索引無效。');
  const records = new Map(state.jobs.map(row => [row.id,row])),visited = new Set(),edits = [];
  const descriptor = (row,image,comfyUrl,stage,index = imageIndex) => ({image:structuredClone(image),comfyUrl:comfyUrl || row.comfyUrl || state.settings?.comfyUrl,jobId:row.id,stage,imageIndex:index,seed:row.seed});
  let current = job,index = imageIndex;
  while(current && !visited.has(current.id)) {
    visited.add(current.id);
    const base = current.stageResults?.base;
    if(base?.completed && base.images?.length) return descriptor(current,base.images[index] || base.images[0],base.comfyUrl,'base',base.images[index] ? index : 0);
    if(current.cameraSource?.image) {
      const source = structuredClone(current.cameraSource);
      source.seed ??= records.get(source.jobId)?.seed ?? current.seed;
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
    if(image?.filename) return {image:structuredClone(image),comfyUrl:edit.sourceInput && edit.sourceInputComfyUrl || edit.sourceComfyUrl || edit.comfyUrl || state.settings?.comfyUrl,jobId:edit.sourceJobId || edit.id,stage:'source',imageIndex:edit.sourceImageIndex || 0,seed:records.get(edit.sourceJobId)?.seed ?? edit.seed};
  }
  throw new Error('找不到首次生成的原圖，請保留原拍攝紀錄或重新生成。');
}
