import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DEFAULT_COMFY_OUTPUT_DIR} from './outputs.js';
import {cameraVersion} from '../shared/camera-version.js';
import {normalizeVideoModels,VIDEO_MODEL_LABELS} from '../shared/photo-video.js';

export const BUNDLE_DIR = fileURLToPath(new URL('../bundles/comfyui/',import.meta.url));
export const BUNDLED_WORKFLOW_PATH = 'PhotoCreate/02 Qwen Image 2.1 Uncensored 5090 High Quality - 圖生圖.json';
export const BUNDLED_CAMERA_PATH = 'PhotoCreate/01 Qwen 2511 - 單圖 3D 相機換角度.json';
const active = job => ['installing','downloading','verifying'].includes(job?.status);
const digest = data => createHash('sha256').update(data).digest('hex');
const contained = (root,target) => {const relative=path.relative(root,target);return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..'+path.sep);};

export function validateComfyDirectory(directory) {
  if(typeof directory !== 'string' || !directory.trim() || !path.isAbsolute(directory.trim())) throw new Error('請選擇 ComfyUI 的完整目錄。');
  let root;try {root=fs.realpathSync(directory.trim());} catch {throw new Error('找不到此 ComfyUI 目錄，請重新選擇。');}
  if(!fs.statSync(root).isDirectory() || !fs.statSync(path.join(root,'main.py'),{throwIfNoEntry:false})?.isFile() || !fs.statSync(path.join(root,'comfy'),{throwIfNoEntry:false})?.isDirectory()) throw new Error('請選擇包含 main.py 與 comfy 資料夾的 ComfyUI 目錄。');
  return root;
}

export async function pickComfyDirectory(initial='') {
  if(process.platform!=='win32') throw new Error('此環境請直接輸入 ComfyUI 的完整目錄。');
  const script=`Add-Type -AssemblyName System.Windows.Forms
$picker = New-Object System.Windows.Forms.FolderBrowserDialog
$picker.Description = 'Select the ComfyUI folder containing main.py'
$picker.ShowNewFolderButton = $false
$picker.SelectedPath = $env:PHOTOCREATE_PICKER_DIR
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
try {
  if ($picker.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($picker.SelectedPath)))
  }
} finally { $picker.Dispose(); $owner.Dispose() }`;
  const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-STA','-WindowStyle','Hidden','-Command',script],{windowsHide:true,env:{...process.env,PHOTOCREATE_PICKER_DIR:initial},timeout:600000,maxBuffer:32768});
  return stdout.trim() ? validateComfyDirectory(Buffer.from(stdout.trim(),'base64').toString('utf8')) : null;
}

// Existing models get a bounded format/size check. Newly downloaded models also
// undergo a complete SHA-256 check before being moved into their final location.
export function hasSafetensorsHeader(file,size) {
  let handle;
  try {
    handle=fs.openSync(file,'r');const length=Buffer.alloc(8);
    if(fs.readSync(handle,length,0,8,0)!==8) return false;
    const headerSize=Number(length.readBigUInt64LE());
    if(!Number.isSafeInteger(headerSize) || headerSize<2 || headerSize>16*1024*1024 || headerSize+8>=size) return false;
    const header=Buffer.alloc(headerSize);if(fs.readSync(handle,header,0,headerSize,8)!==headerSize) return false;
    const tensors=Object.entries(JSON.parse(header.toString('utf8'))).filter(([key])=>key!=='__metadata__');
    return tensors.length>0 && tensors.every(([,tensor])=>typeof tensor.dtype==='string' && Array.isArray(tensor.shape) && Array.isArray(tensor.data_offsets) && tensor.data_offsets.length===2 && tensor.data_offsets.every(Number.isSafeInteger) && tensor.data_offsets[0]>=0 && tensor.data_offsets[0]<=tensor.data_offsets[1] && tensor.data_offsets[1]<=size-8-headerSize);
  } catch {return false;} finally {if(handle!==undefined) fs.closeSync(handle);}
}

export function defaultComfyDirectory(settings={}) {
  if(settings.environmentDraft?.comfyDirectory) return settings.environmentDraft.comfyDirectory;
  if(settings.comfyDirectory) return settings.comfyDirectory;
  for(const candidate of [process.env.PHOTOCREATE_COMFY_DIR,path.dirname(DEFAULT_COMFY_OUTPUT_DIR)]) {
    try {if(candidate) return validateComfyDirectory(candidate);} catch { /* no local installation at this candidate */ }
  }
  return '';
}

export function comfyOutputDirectory(settings={}) {
  return process.env.PHOTOCREATE_COMFY_OUTPUT_DIR || (settings.comfyDirectory ? path.join(settings.comfyDirectory,'output') : process.env.PHOTOCREATE_COMFY_DIR ? path.join(process.env.PHOTOCREATE_COMFY_DIR,'output') : DEFAULT_COMFY_OUTPUT_DIR);
}

// Check each existing ancestor, including directory junctions and file symlinks,
// before any install write, rename or backup inside the explicitly selected root.
export function environmentPath(root,relative) {
  if(typeof relative !== 'string' || !relative || path.isAbsolute(relative) || /[\\:\0]/.test(relative) || relative.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('環境套件路徑無效。');
  const target=path.resolve(root,...relative.split('/'));
  if(!contained(root,target)) throw new Error('環境套件超出設定的 ComfyUI 目錄。');
  let current=root;
  for(const part of relative.split('/')) {
    current=path.join(current,part);
    if(fs.existsSync(current) && !contained(root,fs.realpathSync(current))) throw new Error('目錄連結超出設定的 ComfyUI 目錄，未寫入任何檔案。');
    if(!fs.existsSync(current)) {
      try {if(fs.lstatSync(current).isSymbolicLink()) throw new Error('環境目錄包含無效的連結。');} catch(error) {if(error.code !== 'ENOENT') throw error;}
    }
  }
  return target;
}

export function createEnvironmentManager({dataDir,bundleDir=BUNDLE_DIR,manifest=JSON.parse(fs.readFileSync(path.join(bundleDir,'manifest.json'),'utf8')),videoManifest=manifest.videoManifest ? JSON.parse(fs.readFileSync(environmentPath(fs.realpathSync(bundleDir),manifest.videoManifest),'utf8')) : null,fetchImpl=fetch}) {
  const journal=path.join(dataDir,'environment-install.json');
  let job=null,controller=null,lastSave=0,closed=false;
  if(fs.existsSync(journal)) {
    try {job=JSON.parse(fs.readFileSync(journal,'utf8'));if(active(job)) Object.assign(job,{status:'paused',message:'程式重開後已保留下載進度，按繼續安裝可接續。'});} catch {job=null;}
  }
  const save = (force=false) => {
    if(closed || !job || !force && Date.now()-lastSave < 500) return;
    fs.mkdirSync(dataDir,{recursive:true});
    const temporary=journal+'.tmp';fs.writeFileSync(temporary,JSON.stringify(job));fs.renameSync(temporary,journal);lastSave=Date.now();
  };
  const update = values => {Object.assign(job,values,{updatedAt:new Date().toISOString()});save(true);};
  const status = () => job ? structuredClone(job) : null;
  const videoCatalog = () => structuredClone(videoManifest?.resources.filter(row=>row.kind==='model') || []);
  const plan = (directory,{cameraVersion:version='2511',purpose='photo',videoModels}={}) => {
    if(!['photo','video','studio'].includes(purpose)) throw new Error('環境安裝類型無效。');
    cameraVersion(version);
    const root=validateComfyDirectory(directory);
    let selected=manifest.resources.filter(resource => !resource.cameraVersions || resource.cameraVersions.includes(version));
    if(purpose!=='photo') {
      if(!videoManifest) throw new Error('此版本尚未包含 H3 安裝套件，請更新 PhotoCreate。');
      const folders={unet:'diffusion_models',videoVae:'vae',audioVae:'vae',clip:'text_encoders',latentUpscaler:'latent_upscale_models'},models=normalizeVideoModels(videoModels),generationVersion=models.latentUpscaler ? 'two-pass' : 'single';
      const video=[...videoManifest.resources.filter(row=>row.kind!=='model' && (!row.generationVersions || row.generationVersions.includes(generationVersion))),...Object.entries(models).map(([role,fileName])=>{
        const known=videoManifest.resources.find(row=>row.kind==='model' && row.role===role && row.fileName===fileName);
        return known || {id:'video-custom-'+role,kind:'model',role,fileName,label:fileName,target:`models/${folders[role]}/${fileName.replaceAll('\\','/')}`,size:0,downloadable:false};
      })];
      selected=purpose==='video' ? video : [...selected.map(row=>({...row,section:'photo'})),...video.map(row=>({...row,section:'video'}))];
    }
    selected=[...new Map(selected.map(row=>[row.target,row])).values()];
    if(purpose==='studio') selected.sort((a,b)=>({node:0,workflow:1,model:2}[a.kind])-({node:0,workflow:1,model:2}[b.kind]));
    const resources=selected.map(resource => {
      const file=environmentPath(root,resource.target),exists=fs.existsSync(file);
      if(exists && !fs.statSync(file).isFile()) throw new Error('安裝位置不是檔案：'+resource.target);
      const size=exists ? fs.statSync(file).size : 0;
      let customized=false;
      if(exists && purpose==='studio' && resource.kind==='workflow') try {const ui=JSON.parse(fs.readFileSync(file,'utf8'));customized=Array.isArray(ui.nodes) && ui.nodes.some(node=>!['Note','MarkdownNote'].includes(node.type)) && Array.isArray(ui.links) && digest(fs.readFileSync(file))!==resource.sha256;} catch { /* repair malformed files, keeping a backup */ }
      const installed=customized || exists && (resource.downloadable===false || size===resource.size) && (resource.kind==='model' ? hasSafetensorsHeader(file,size) : digest(fs.readFileSync(file))===resource.sha256);
      const partial=resource.kind==='model' ? environmentPath(root,resource.target+'.photocreate.part') : null;
      const partialBytes=partial && fs.existsSync(partial) ? fs.statSync(partial).size : 0;
      return {...resource,...(resource.downloadable===false && installed ? {size} : {}),customized,status:installed ? 'installed' : exists ? 'different' : 'missing',existingBytes:size,partialBytes:Math.min(partialBytes,resource.size)};
    });
    const models=resources.filter(row => row.kind==='model'),missing=models.filter(row => row.status!=='installed');
    let freeBytes=null;try {const disk=fs.statfsSync(root);freeBytes=disk.bavail*disk.bsize;} catch { /* report unknown, not zero */ }
    return {directory:root,purpose,name:purpose==='video' ? videoManifest.name : manifest.name,resources,manualModels:missing.filter(row=>row.downloadable===false).map(row=>VIDEO_MODEL_LABELS[row.role]),missingModelBytes:missing.reduce((sum,row) => sum+row.size-row.partialBytes,0),modelBytes:models.reduce((sum,row)=>sum+row.size,0),freeBytes,modelsReady:!missing.length,filesReady:resources.filter(row=>row.kind!=='model').every(row=>row.status==='installed'),enhancements:manifest.enhancements};
  };

  function backup(root,relative) {
    const target=environmentPath(root,relative);
    if(!fs.existsSync(target)) return;
    const destination=environmentPath(root,`.photocreate-backups/${job.id}/${relative}`);
    fs.mkdirSync(path.dirname(destination),{recursive:true});fs.renameSync(target,destination);
    job.backups.push(relative);save(true);
    return destination;
  }

  function replace(root,relative,temporaryRelative) {
    const target=environmentPath(root,relative),temporary=environmentPath(root,temporaryRelative),previous=backup(root,relative);
    try {fs.renameSync(temporary,target);} catch(error) {
      // Windows can refuse a rename when a file is held open. Restore the old
      // file if replacement failed, while keeping the verified download.
      if(previous && fs.existsSync(previous) && !fs.existsSync(target)) {
        environmentPath(root,relative);fs.renameSync(previous,target);
        job.backups=job.backups.filter(value=>value!==relative);save(true);
      }
      throw error;
    }
  }

  async function download(root,resource,signal) {
    const target=environmentPath(root,resource.target),partial=environmentPath(root,resource.target+'.photocreate.part');
    fs.mkdirSync(path.dirname(target),{recursive:true});
    let offset=fs.existsSync(partial) ? fs.statSync(partial).size : 0;
    if(offset > resource.size) {fs.truncateSync(partial,0);offset=0;}
    update({status:'downloading',current:resource.id,currentName:resource.label,currentBytes:offset,currentTotal:resource.size});
    if(offset < resource.size) {
      const response=await fetchImpl(resource.url,{headers:offset ? {Range:`bytes=${offset}-`} : {},signal});
      if(!response.ok || !response.body) throw new Error(`模型下載失敗 (${response.status})：${resource.label}`);
      if(offset && response.status===206) {
        if(!response.headers.get('content-range')?.startsWith(`bytes ${offset}-`)) throw new Error('伺服器回傳的續傳範圍無效。');
      } else {if(response.status!==200) throw new Error('模型下載回應無效。');offset=0;job.currentBytes=0;}
      const counter=new Transform({transform(chunk,encoding,callback) {
        job.currentBytes+=chunk.length;
        if(job.currentBytes > resource.size) return callback(new Error('模型下載超過預期大小。'));
        save();callback(null,chunk);
      }});
      await pipeline(Readable.fromWeb(response.body),counter,fs.createWriteStream(partial,{flags:offset ? 'a' : 'w'}),{signal});
    }
    if(fs.statSync(partial).size!==resource.size) throw new Error('下載尚未完整，保留進度供下次接續：'+resource.label);
    update({status:'verifying',message:'驗證模型完整性',verificationBytes:0});
    const hash=createHash('sha256');
    for await(const chunk of fs.createReadStream(partial,{highWaterMark:4*1024*1024})) {signal.throwIfAborted();hash.update(chunk);job.verificationBytes+=chunk.length;save();}
    if(hash.digest('hex')!==resource.sha256) {environmentPath(root,resource.target+'.photocreate.part');fs.truncateSync(partial,0);throw new Error('模型驗證失敗，已清除損壞的下載暫存，現有模型已保留。按繼續安裝可重新下載：'+resource.label);}
    signal.throwIfAborted();environmentPath(root,resource.target);environmentPath(root,resource.target+'.photocreate.part');
    replace(root,resource.target,resource.target+'.photocreate.part');
  }

  async function execute(snapshot,signal) {
    try {
      for(const resource of snapshot.resources.filter(row=>row.status!=='installed' && (row.kind!=='model' || job.includeModels))) {
        signal.throwIfAborted();
        update({status:'installing',current:resource.id,currentName:resource.label,currentBytes:0,currentTotal:resource.size,message:''});
        if(resource.kind==='model') await download(snapshot.directory,resource,signal);
        else {
          const source=environmentPath(fs.realpathSync(bundleDir),resource.source),bytes=fs.readFileSync(source);
          if(bytes.length!==resource.size || digest(bytes)!==resource.sha256) throw new Error('內附環境套件驗證失敗：'+resource.label);
          const target=environmentPath(snapshot.directory,resource.target),temporary=environmentPath(snapshot.directory,resource.target+'.photocreate.tmp');
          fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(temporary,bytes);
          replace(snapshot.directory,resource.target,resource.target+'.photocreate.tmp');
          // Retire only the exact API-only file previously installed by us.
          // Edited files remain in place; retired files remain recoverable.
          for(const old of resource.retires || []) {
            const file=environmentPath(snapshot.directory,old.target);
            if(fs.existsSync(file) && fs.statSync(file).isFile() && digest(fs.readFileSync(file))===old.sha256) backup(snapshot.directory,old.target);
          }
          if(resource.kind==='node' && /\.(py|js)$/.test(resource.target)) job.restartRequired=true;
        }
        job.completed.push(resource.id);job.completedBytes+=resource.size;save(true);
      }
      update({status:'completed',finishedAt:new Date().toISOString(),message:job.purpose==='studio' ? '缺少的環境檔案已補齊，正在檢查工作流。' : job.purpose==='video' ? 'H3 工作流與模型安裝完成。請按「檢查 H3 環境」；若 ComfyUI 尚未列出新模型，請重新啟動 ComfyUI。' : job.restartRequired ? '安裝完成，請重新啟動 ComfyUI 後按「檢查並載入」。' : '安裝完成，可按「檢查並載入」。'});
    } catch(error) {update({status:signal.aborted ? 'paused' : 'failed',error:signal.aborted ? '' : error.message,message:signal.aborted ? '已暫停，下載進度已保留。' : error.message});}
    finally {controller=null;}
  }

  return {
    plan,videoCatalog,status,isActive:()=>active(job),
    activated() {if(job) update({restartRequired:false,message:'環境已就緒，工作流已載入。'});},
    start(directory,{includeModels=true,cameraVersion:version='2511',purpose='photo',videoModels}={}) {
      if(active(job)) throw new Error('環境安裝正在進行，請先暫停。');
      if(typeof includeModels!=='boolean') throw new Error('下載模型設定無效。');
      const snapshot=plan(directory,{cameraVersion:version,purpose,videoModels}),selected=snapshot.resources.filter(row=>row.status!=='installed' && (row.kind!=='model' || includeModels));
      if(includeModels && snapshot.manualModels.length) throw new Error('無法自動下載所選模型，請改選清單中可下載的模型：'+snapshot.manualModels.join('、'));
      if(includeModels && snapshot.freeBytes!==null && snapshot.missingModelBytes>snapshot.freeBytes) throw new Error('磁碟可用空間不足，請換到空間足夠的 ComfyUI 目錄。');
      const restartRequired=Boolean(job?.directory===snapshot.directory && job?.restartRequired);
      job={id:randomUUID(),directory:snapshot.directory,status:'installing',includeModels,cameraVersion:version,purpose,...(purpose!=='photo' ? {videoModels:normalizeVideoModels(videoModels)} : {}),createdAt:new Date().toISOString(),completed:[],backups:[],completedBytes:0,totalBytes:selected.reduce((sum,row)=>sum+row.size,0),resourceCount:selected.length,restartRequired};
      controller=new AbortController();save(true);
      const result=status();void execute(snapshot,controller.signal);return result;
    },
    pause() {controller?.abort();return status();},
    close() {if(active(job)){controller?.abort();update({status:'paused',message:'程式已關閉，下載進度已保留。'});}closed=true;},
  };
}
