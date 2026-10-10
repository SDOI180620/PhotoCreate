import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {crc32} from 'node:zlib';
import yauzl from 'yauzl';
import yazl from 'yazl';
import {ACTIVE_STATUSES} from '../shared/batches.js';
import {ASSET_KINDS,LIMITS,transferError,textField,tagsField,imageType,portablePresets,portableDraft,validateManifest,remapDraft} from './transfer-schema.js';

const libraryRevision = state => createHash('sha256').update(JSON.stringify([state.garments,state.characters,state.scenes,state.presets])).digest('hex');
const assetKey = (kind,row,digest) => JSON.stringify([kind,row.name,row.description || '',row.tags || [],row.mime,digest]);
const presetKey = row => JSON.stringify([row.category,row.name,row.prompt,row.tags,row.angle ?? null]);

// Only registered uploads are exported; generated outputs and machine settings are separate.
function registeredFile(dataDir,row) {
  if(typeof row.fileName!=='string' || !/^[\w-]+\.(png|jpg|jpeg|webp)$/i.test(row.fileName)) throw transferError(`「${row.name}」的圖片路徑無效。`);
  const root=fs.realpathSync(path.join(dataDir,'uploads')),file=fs.realpathSync(path.join(root,row.fileName));
  if(path.dirname(file)!==root || !fs.statSync(file).isFile()) throw transferError(`「${row.name}」的圖片路徑無效。`);
  return file;
}
async function measureFile(file,max,{target,signal,expectedCrc}={}) {
  let size=0,crc=0,header=Buffer.alloc(0);const digest=createHash('sha256');
  const meter=new Transform({transform(chunk,encoding,callback) {
    size+=chunk.length;
    if(size>max) return callback(transferError('資料包解壓後超過允許大小。'));
    digest.update(chunk);crc=crc32(chunk,crc);
    if(header.length<24) header=Buffer.concat([header,chunk.subarray(0,24-header.length)]);
    callback(null,target ? chunk : undefined);
  }});
  const source=typeof file==='string' ? fs.createReadStream(file) : file;
  if(target) await pipeline(source,meter,fs.createWriteStream(target,{flags:'wx'}),{signal});
  else {meter.resume();await pipeline(source,meter,{signal});}
  if(expectedCrc!==undefined && crc!==expectedCrc) throw transferError('ZIP 校驗失敗，檔案可能已損壞。');
  return {size,sha256:digest.digest('hex'),header};
}

export function createTransferManager({dataDir,store,now=()=>Date.now(),limits=LIMITS}) {
  const dataRoot=fs.realpathSync(dataDir),transferRoot=path.join(dataRoot,'transfers');
  fs.mkdirSync(transferRoot,{recursive:true});
  if(fs.realpathSync(transferRoot)!==transferRoot) throw transferError('資料搬移暫存目錄不能是目錄連結。');
  // Clean this feature's abandoned crash leftovers after a day; never scan uploads or backups.
  for(const name of fs.readdirSync(transferRoot)) if(/^run-[a-zA-Z0-9]{6}$/.test(name)) {
    const abandoned=path.resolve(transferRoot,name),stat=fs.lstatSync(abandoned);
    if(stat.isDirectory() && !stat.isSymbolicLink() && now()-stat.mtimeMs>24*60*60000 && path.dirname(abandoned)===transferRoot && fs.realpathSync(abandoned)===abandoned) fs.rmSync(abandoned,{recursive:true,force:true});
  }
  const workDir=fs.mkdtempSync(path.join(transferRoot,'run-'));
  const controller=new AbortController(),exports=new Map();let busy=false,closed=false,preview=null;
  const tempFile=ext=>path.join(workDir,`${randomUUID()}${ext}`);
  const removeFile=file=>{if(path.dirname(path.resolve(file))!==workDir) throw transferError('暫存檔路徑無效。');fs.rmSync(file,{force:true});};
  const cleanupPreview=()=>{if(!preview) return;for(const file of preview.files.values()) removeFile(file.path);preview=null;};
  const purgeExpired=()=>{
    if(preview && now()>preview.expiresAt) cleanupPreview();
    for(const [token,archive] of exports) if(!archive.downloading && now()>archive.expiresAt) {removeFile(archive.path);exports.delete(token);}
  };
  const timer=setInterval(purgeExpired,60000);timer.unref();
  function cleanupWork() {
    // Verify the absolute target is this instance's generated directory before recursive removal.
    if(path.dirname(path.resolve(workDir))===transferRoot && fs.existsSync(workDir) && fs.realpathSync(workDir)===workDir) fs.rmSync(workDir,{recursive:true,force:true});
  }
  async function exclusive(action) {
    if(closed) throw transferError('工作檯已關閉。',503);
    if(busy) throw transferError('正在處理另一個資料包，請稍候。',409);
    busy=true;try {purgeExpired();return await action();} finally {busy=false;if(closed) cleanupWork();}
  }
  async function exportZip() {return exclusive(async()=> {
    if(exports.size>=3) throw transferError('尚有 ZIP 等待下載，請先完成下載。',409);
    const snapshot=store.read(),assets={},files=new Map(),temporary=[];let total=0;
    for(const kind of ASSET_KINDS) snapshot[kind]=snapshot[kind].filter(row=>!row.visitorId);
    const zipPath=tempFile('.zip');temporary.push(zipPath);
    try {
      if(ASSET_KINDS.reduce((sum,kind)=>sum+snapshot[kind].length,0)>limits.assets) throw transferError('每包最多 10,000 張圖片。');
      for(const kind of ASSET_KINDS) {
        assets[kind]=[];
        for(const row of snapshot[kind]) {
          let file;try {file=registeredFile(dataDir,row);} catch(error) {throw transferError(`無法讀取「${row.name}」的原圖，請先重新上傳。`);}
          if(fs.statSync(file).size>limits.image) throw transferError(`「${row.name}」超過每張 25 MB。`);
          const copy=tempFile('.image');temporary.push(copy);
          const measured=await measureFile(file,limits.image,{target:copy,signal:controller.signal});
          const type=imageType(measured.header),imageFile=`images/${measured.sha256}${type.ext}`;
          if(!files.has(imageFile)) {files.set(imageFile,copy);total+=measured.size;}
          else removeFile(copy);
          if(total>limits.total) throw transferError('資料包超過 2 GB，請先整理圖庫。');
          assets[kind].push({id:row.id,name:textField(row.name,200,'名稱',true),description:textField(row.description ?? '',20000,'圖片提詞'),tags:tagsField(row.tags ?? []),createdAt:row.createdAt,mime:type.mime,imageFile,sha256:measured.sha256,size:measured.size});
        }
      }
      const presets=portablePresets(snapshot.presets);
      const manifest=validateManifest({format:'PhotoCreate-library',version:1,createdAt:new Date(now()).toISOString(),assets,presets,draft:portableDraft(snapshot.draft ?? {},assets,presets)});
      const metadata=Buffer.from(JSON.stringify(manifest,null,2));
      if(metadata.length>limits.manifest) throw transferError('名稱與提詞資料超過 10 MB，請先整理提詞庫。');
      if(total+metadata.length>limits.total) throw transferError('資料包超過 2 GB，請先整理圖庫。');
      const zip=new yazl.ZipFile();
      const writing=pipeline(zip.outputStream,fs.createWriteStream(zipPath,{flags:'wx'}),{signal:controller.signal});
      zip.on('error',error=>zip.outputStream.destroy(error));
      zip.addBuffer(metadata,'photocreate.json');
      for(const [name,file] of files) zip.addFile(file,name,{compress:false});
      zip.end();await writing;
      if(fs.statSync(zipPath).size>limits.archive) throw transferError('ZIP 超過 2 GB，請先整理圖庫。');
      const token=randomUUID(),name=`PhotoCreate-data-${new Date(now()).toISOString().slice(0,10)}.zip`,size=fs.statSync(zipPath).size;
      exports.set(token,{path:zipPath,name,expiresAt:now()+30*60000,downloading:false});
      return {token,name,size};
    } catch(error) {removeFile(zipPath);throw error;}
    finally {for(const file of temporary) if(file!==zipPath) removeFile(file);}
  });}
  async function readArchive(archive) {
    let zip,total=0,count=0;const files=new Map(),names=new Set();let manifest;
    try {
      if(fs.statSync(archive).size>limits.archive) throw transferError('ZIP 最多 2 GB。');
      zip=await yauzl.openPromise(archive,{lazyEntries:true,strictFileNames:true,validateEntrySizes:true});
      // eachEntry() attaches the error listener before asynchronous entry reads.
      for await(const entry of zip.eachEntry()) {
        if(++count>limits.assets+2) throw transferError('ZIP 檔案數量過多。');
        const name=entry.fileName;
        if(names.has(name)) throw transferError('ZIP 有重複的檔案名稱。');names.add(name);
        const unixType=(entry.externalFileAttributes>>>16)&0xf000;
        if(unixType && ![0x8000,0x4000].includes(unixType)) throw transferError('ZIP 不可包含連結或特殊檔案。');
        if(name==='images/' && entry.uncompressedSize===0 && unixType!==0x8000) continue;
        if(unixType===0x4000 || entry.generalPurposeBitFlag&1 || !['photocreate.json',name.match(/^images\/[a-f0-9]{64}\.(png|jpg|webp)$/)?.[0]].includes(name)) throw transferError('ZIP 包含不支援的檔案或路徑。');
        const max=name==='photocreate.json' ? limits.manifest : limits.image;
        if(!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize>max || (total+=entry.uncompressedSize)>limits.total) throw transferError('ZIP 解壓大小超過允許範圍。');
        const stream=await zip.openReadStreamPromise(entry),file=tempFile('.entry');
        files.set(name,{path:file});
        const measured=await measureFile(stream,max,{target:file,signal:controller.signal,expectedCrc:entry.crc32});
        files.set(name,{path:file,...measured});
        if(name==='photocreate.json') {
          try {manifest=validateManifest(JSON.parse(fs.readFileSync(file,'utf8')));} catch(error) {throw transferError(`資料包內容無效：${error.message}`);}
        }
      }
      if(!manifest) throw transferError('ZIP 缺少 PhotoCreate 資料清單。');
      const expected=new Set(['photocreate.json']);
      for(const kind of ASSET_KINDS) for(const row of manifest.assets[kind]) {
        expected.add(row.imageFile);const file=files.get(row.imageFile);
        if(!file || file.sha256!==row.sha256 || file.size!==row.size) throw transferError(`「${row.name}」的圖片遺失或校驗失敗。`);
        if(imageType(file.header).mime!==row.mime) throw transferError(`「${row.name}」的圖片格式不符。`);
      }
      for(const name of files.keys()) if(!expected.has(name)) throw transferError('ZIP 含有未登記的檔案。');
      return {manifest,files};
    } catch(error) {
      for(const file of files.values()) removeFile(file.path);
      throw transferError(`無法匯入 ZIP：${error.message}`);
    } finally {zip?.close();}
  }
  async function mergePlan(manifest,files) {
    const state=store.read(),existingAssets=new Map(),existingPresets=new Map(),assetMap=new Map(),presetMap=new Map(),newAssets={},newPresets=[],duplicates={},counts={};
    const usedAssetIds=new Set(ASSET_KINDS.flatMap(kind=>state[kind].map(row=>row.id))),usedPresetIds=new Set(state.presets.map(row=>row.id));
    const currentHashes=new Map();
    for(const kind of ASSET_KINDS) for(const row of state[kind].filter(row=>!row.visitorId)) {
      try {
        const file=registeredFile(dataDir,row);let digest=currentHashes.get(file);
        if(!digest) {digest=(await measureFile(file,limits.image,{signal:controller.signal})).sha256;currentHashes.set(file,digest);}
        existingAssets.set(assetKey(kind,row,digest),row.id);
      } catch(error) {if(controller.signal.aborted) throw error;/* Missing local images can be recovered as new records. */}
    }
    // Stored presets may contain legacy fields. Compare only portable content.
    for(const row of portablePresets(state.presets)) existingPresets.set(presetKey(row),row.id);
    for(const kind of ASSET_KINDS) {
      newAssets[kind]=[];duplicates[kind]=0;counts[kind]=manifest.assets[kind].length;
      for(const row of manifest.assets[kind]) {
        const key=assetKey(kind,row,row.sha256);let id=existingAssets.get(key);
        if(id) duplicates[kind]++;
        else {id=usedAssetIds.has(row.id) ? randomUUID() : row.id;usedAssetIds.add(id);existingAssets.set(key,id);newAssets[kind].push({...row,id,sourcePath:files.get(row.imageFile).path});}
        assetMap.set(row.id,id);
      }
    }
    duplicates.presets=0;counts.presets=manifest.presets.length;
    for(const row of manifest.presets) {
      const key=presetKey(row);let id=existingPresets.get(key);
      if(id) duplicates.presets++;
      else {id=usedPresetIds.has(row.id) ? `import-${randomUUID()}` : row.id;usedPresetIds.add(id);existingPresets.set(key,id);newPresets.push({...row,id});}
      presetMap.set(row.id,id);
    }
    return {revision:libraryRevision(state),newAssets,newPresets,draft:remapDraft(manifest.draft,assetMap,presetMap),summary:{counts,duplicates,added:Object.fromEntries([...ASSET_KINDS,'presets'].map(kind=>[kind,counts[kind]-duplicates[kind]]))}};
  }
  const publicPreview=(value,plan)=>({token:value.token,createdAt:value.manifest.createdAt,expiresAt:new Date(value.expiresAt).toISOString(),...plan.summary,draft:{mode:value.manifest.draft.mode,steps:value.manifest.draft.steps,angleSteps:value.manifest.draft.angleSteps,refineDenoise:value.manifest.draft.refineDenoise,resolution:value.manifest.draft.resolution,aspectRatio:value.manifest.draft.aspectRatio},bytes:[...value.files.values()].reduce((sum,file)=>sum+file.size,0)});
  async function prepare(archive) {return exclusive(async()=> {
    cleanupPreview();let candidate;
    try {
      candidate=await readArchive(archive);
      const plan=await mergePlan(candidate.manifest,candidate.files);
      preview={...candidate,token:randomUUID(),expiresAt:now()+30*60000};
      return publicPreview(preview,plan);
    } catch(error) {if(candidate) for(const file of candidate.files.values()) removeFile(file.path);throw error;}
    finally {removeFile(archive);}
  });}
  async function commit(token,{applyDraft=false}={}) {return exclusive(async()=> {
    if(!preview || typeof token!=='string' || preview.token!==token) throw transferError('資料包預覽已過期，請重新選擇 ZIP。',410);
    if(typeof applyDraft!=='boolean') throw transferError('拍攝設定選項無效。');
    const draftBefore=JSON.stringify(store.read().draft),plan=await mergePlan(preview.manifest,preview.files),copied=[];
    if(controller.signal.aborted) throw transferError('工作檯已關閉。',503);
    if(libraryRevision(store.read())!==plan.revision) throw transferError('圖庫或提詞剛剛有變更，請再按一次匯入。',409);
    try {
      // Copy each unique image once, so repeated references cannot multiply disk usage.
      // Final revision checks and the synchronous transaction prevent a racing edit being lost.
      const additions={},imageFiles=new Map(),uploads=path.join(dataRoot,'uploads');
      if(fs.realpathSync(uploads)!==uploads) throw transferError('匯入圖片目錄不能是目錄連結。');
      for(const kind of ASSET_KINDS) {
        additions[kind]=[];
        for(const row of plan.newAssets[kind]) {
          let fileName=imageFiles.get(row.imageFile);
          if(!fileName) {
            fileName=`${randomUUID()}${path.extname(row.imageFile)}`;const target=path.join(uploads,fileName);
            await fs.promises.copyFile(row.sourcePath,target,fs.constants.COPYFILE_EXCL);copied.push(target);imageFiles.set(row.imageFile,fileName);
          }
          const {sourcePath,imageFile,sha256,size,...asset}=row;
          additions[kind].push({...asset,fileName,image:`/uploads/${fileName}`});
        }
      }
      if(controller.signal.aborted) throw transferError('工作檯已關閉。',503);
      const current=store.read();
      if(libraryRevision(current)!==plan.revision || applyDraft && JSON.stringify(current.draft)!==draftBefore) throw transferError('資料剛剛有變更，請再按一次匯入。',409);
      if(applyDraft && current.jobs.some(job=>ACTIVE_STATUSES.includes(job.status))) throw transferError('拍攝進行中，請先保留目前拍攝設定，或暫停後再套用。',409);
      store.mutate(state=> {
        for(const kind of ASSET_KINDS) state[kind].push(...additions[kind]);
        state.presets.push(...plan.newPresets);
        if(applyDraft) state.draft=plan.draft;
      });
    } catch(error) {for(const file of copied) fs.rmSync(file,{force:true});throw error;}
    cleanupPreview();return {...plan.summary,draftApplied:applyDraft};
  });}
  return {uploadDir:workDir,exportZip,prepare,commit,
    download(token) {
      purgeExpired();const archive=exports.get(token);
      if(!archive || archive.downloading) throw transferError('ZIP 下載已過期，請重新匯出。',410);
      archive.downloading=true;
      return {...archive,cleanup:()=>{removeFile(archive.path);exports.delete(token);}};
    },
    discard(token) {if(busy) throw transferError('資料包正在處理，請稍候。',409);if(preview?.token===token) cleanupPreview();},
    close() {
      closed=true;clearInterval(timer);controller.abort();
      if(!busy) cleanupWork();
    },
  };
}
