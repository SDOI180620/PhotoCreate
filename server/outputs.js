import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_COMFY_OUTPUT_DIR = process.env.PHOTOCREATE_COMFY_OUTPUT_DIR || 'Z:/AI/comfulUI/ComfyUI-Easy-Install/ComfyUI/output';

const inside = (root,target) => {
  const relative = path.relative(root,target);
  return relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
};

// An unavailable saved path can belong to an installation that was moved.
// Use the corrected directory only for the same local ComfyUI connection;
// available historical directories keep ownership of their original files.
export function outputDirectoryForJob(job,settings,defaultOutputDir) {
  const saved=job.comfyOutputDir;
  if(!saved || fs.existsSync(saved)) return saved || defaultOutputDir;
  let recorded,current;
  try {recorded=new URL(job.comfyUrl || settings.comfyUrl);current=new URL(settings.comfyUrl);} catch {return saved;}
  if(recorded.origin!==current.origin || !['127.0.0.1','localhost','[::1]'].includes(current.hostname)) return saved;
  return defaultOutputDir && fs.statSync(defaultOutputDir,{throwIfNoEntry:false})?.isDirectory() ? defaultOutputDir : saved;
}

// Delete only files recorded as this workbench's own ComfyUI outputs. Resolve
// both lexical and real paths so traversal and linked folders cannot escape.
export function resolveOutputFile(outputDir,image) {
  if((image.type || 'output') !== 'output') throw new Error('只能刪除成果輸出圖片。');
  const folder = String(image.subfolder || '').replaceAll('\\','/');
  const filename = image.filename;
  if(typeof filename !== 'string' || !filename || /[\\/:\0]/.test(filename) || !/\.(png|jpe?g|webp)$/i.test(filename)) throw new Error('成果檔名無效。');
  const parts = folder.split('/');
  if(parts[0] !== 'PhotoCreate' || parts.some(part => !part || part === '.' || part === '..' || part.includes('\0') || part.includes(':'))) throw new Error('只能刪除 PhotoCreate 產生的成果檔案。');
  const root = path.resolve(outputDir);
  const target = path.resolve(root,...parts,filename);
  if(!inside(root,target)) throw new Error('成果圖片超出輸出資料夾。');
  // Missing files are already deleted; never follow a missing directory to
  // another location. The metadata may still be cleared in this case.
  if(!fs.existsSync(target)) return null;
  const realRoot = fs.realpathSync(root);
  const realTarget = fs.realpathSync(target);
  if(!inside(realRoot,realTarget)) throw new Error('成果圖片連結到輸出資料夾以外。');
  if(!fs.statSync(realTarget).isFile()) throw new Error('成果路徑不是圖片檔案。');
  return realTarget;
}

export function deleteOutputFiles(outputDir,images) {
  if(!fs.existsSync(outputDir) || !fs.statSync(outputDir).isDirectory()) throw new Error('找不到本機 ComfyUI 輸出資料夾，請檢查 PHOTOCREATE_COMFY_OUTPUT_DIR。');
  const files = [...new Set(images.map(image => resolveOutputFile(outputDir,image)).filter(Boolean))];
  for(const file of files) fs.unlinkSync(file);
  return files.length;
}

// Purging a photo also clears intermediate results, but only unreferenced local
// PhotoCreate files. Other jobs may still need an output for a saved camera shoot.
export function purgeJobOutputs(state,jobs,defaultOutputDir,{requireLocal=false}={}) {
  const selected=new Set(jobs.map(job=>job.id));
  const key=image=>JSON.stringify([image.type || 'output',String(image.subfolder || '').replaceAll('\\','/'),image.filename]);
  const outputs=job=>job.outputsDeletedAt ? [] : [...(job.images || []),...Object.values(job.stageResults || {}).flatMap(stage=>stage.images || [])];
  const references=job=>[job.sourceImage,job.cameraSource?.image].filter(image=>image && (image.type || 'output')==='output' && /^PhotoCreate(?:[\\/]|$)/.test(String(image.subfolder || '')));
  const retained=new Set(state.jobs.filter(job=>!selected.has(job.id)).flatMap(job=>[
    ...outputs(job),...(job.sourceInput && job.sourceInputComfyUrl ? [] : [job.sourceImage,job.cameraSource?.image].filter(Boolean)),
  ]).map(key));
  const files=new Set();
  for(const job of jobs) {
    const images=[...outputs(job),...references(job)].filter(image=>!retained.has(key(image)));
    if(!images.length) continue;
    let host;
    try {host=new URL(job.comfyUrl || state.settings.comfyUrl).hostname;} catch {if(requireLocal) throw new Error('無法確認成果輸出位置。');continue;}
    if(!['127.0.0.1','localhost','[::1]'].includes(host)) {if(requireLocal) throw new Error('無法清理遠端成果檔案。');continue;}
    const directory=outputDirectoryForJob(job,state.settings,defaultOutputDir);
    if(!directory || !fs.existsSync(directory)) {if(requireLocal) throw new Error('找不到本機 ComfyUI 輸出資料夾，請檢查連線與輸出目錄設定。');continue;}
    for(const image of images) {
      if((image.type || 'output')!=='output' || !/^PhotoCreate(?:[\\/]|$)/.test(String(image.subfolder || ''))) {if(requireLocal) throw new Error('成果輸出路徑無效。');continue;}
      const file=resolveOutputFile(directory,image);
      if(file) files.add(file);
    }
  }
  // Resolve every path before deleting any file, so invalid metadata cannot
  // partially purge a batch or reach another folder through a junction.
  for(const file of files) fs.unlinkSync(file);
  return files.size;
}
