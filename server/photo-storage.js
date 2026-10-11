import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import sharp from 'sharp';
import {comfyOutputDirectory} from './environment.js';
import {outputDirectoryForJob,resolveOutputFile} from './outputs.js';

const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
const sourceKey=(base,image)=>hash(JSON.stringify([String(base).replace(/\/$/,''),image.type || 'output',String(image.subfolder || '').replaceAll('\\','/'),image.filename]));
const imageError=message=>new Error(message);
export const angleInputImage=job=>{
  if(!job.sourceInput || !job.sourceInputComfyUrl) return null;
  const input=String(job.sourceInput).replaceAll('\\','/');
  return {filename:path.posix.basename(input),subfolder:path.posix.dirname(input)==='.' ? '' : path.posix.dirname(input),type:'input'};
};

export function photoReferences(state,defaultOutputDir) {
  const rows=[],settings=state.settings;
  for(const job of state.jobs) {
    const add=(image,stage,index,base=job.comfyUrl || settings.comfyUrl)=>{
      if(!image || (image.type || 'output')!=='output' && !(stage==='source' && image.type==='input')) return;
      rows.push({jobId:job.id,ownerId:job.visitorId || 'admin',stage,index,base,image,
        directory:outputDirectoryForJob({...job,comfyUrl:base},settings,defaultOutputDir || comfyOutputDirectory(settings))});
    };
    if(!job.outputsDeletedAt) {
      (job.images || []).forEach((image,index)=>add(image,'result',index));
      for(const [stage,result] of Object.entries(job.stageResults || {})) if(result.completed) (result.images || []).forEach((image,index)=>add(image,stage,index,result.comfyUrl || job.comfyUrl || settings.comfyUrl));
    }
    add(job.sourceImage,'source',0,job.sourceComfyUrl || job.comfyUrl || settings.comfyUrl);
    add(job.cameraSource?.image,'source',1,job.cameraSource?.comfyUrl || job.sourceComfyUrl || job.comfyUrl || settings.comfyUrl);
    add(angleInputImage(job),'source',2,job.sourceInputComfyUrl);
  }
  return rows;
}

// Original descriptors and prompt snapshots stay intact in studio.sqlite.
// This catalogue binds managed files to their jobs and stable account owners.
export function createPhotoStorage({dataDir,store,loadImage,defaultOutputDir,intervalMs=1500,manageOutputs=intervalMs>0}={}) {
  const root=path.join(fs.realpathSync(dataDir),'photos');fs.mkdirSync(root,{recursive:true});
  if(fs.realpathSync(root)!==root) throw imageError('照片資料夾不能是目錄連結。');
  const db=new DatabaseSync(path.join(dataDir,'photos.sqlite'));db.exec(`
    PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS photos(source_key TEXT PRIMARY KEY,file_name TEXT NOT NULL,sha256 TEXT NOT NULL,size INTEGER NOT NULL,mime TEXT NOT NULL,archived_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS photo_links(job_id TEXT NOT NULL,stage TEXT NOT NULL,image_index INTEGER NOT NULL,owner_id TEXT NOT NULL,source_key TEXT NOT NULL REFERENCES photos(source_key),PRIMARY KEY(job_id,stage,image_index));
    CREATE INDEX IF NOT EXISTS photo_owner ON photo_links(owner_id,job_id);
    CREATE TABLE IF NOT EXISTS archive_failures(source_key TEXT PRIMARY KEY,detail TEXT NOT NULL,failed_at INTEGER NOT NULL);
  `);
  const get=db.prepare('SELECT * FROM photos WHERE source_key=?');
  const put=db.prepare('INSERT OR REPLACE INTO photos VALUES(?,?,?,?,?,?)');
  const link=db.prepare('INSERT INTO photo_links VALUES(?,?,?,?,?) ON CONFLICT(job_id,stage,image_index) DO UPDATE SET owner_id=excluded.owner_id,source_key=excluded.source_key WHERE photo_links.source_key<>excluded.source_key OR photo_links.owner_id<>excluded.owner_id');
  let closed=false,dbClosed=false,task=null,paused=0;
  const checkedFile=name=>{
    if(!/^[a-f0-9]{64}\.(png|jpg|webp)$/.test(name)) throw imageError('照片儲存路徑無效。');
    const file=path.join(root,name);
    if(!fs.existsSync(file)) return null;
    if(fs.realpathSync(file)!==file || !fs.statSync(file).isFile()) throw imageError('照片路徑不是工作室內的檔案。');
    return file;
  };
  const find=(base,image)=>{
    const row=get.get(sourceKey(base,image));if(!row) return null;
    const file=checkedFile(row.file_name);return file ? {file,mime:row.mime,size:row.size,sha256:row.sha256} : null;
  };
  const references=()=>store.read(state=>photoReferences(state,defaultOutputDir));
  const localSource=row=>{
    if((row.image.type || 'output')!=='output' || !['127.0.0.1','localhost','[::1]'].includes(new URL(row.base).hostname) || !/^PhotoCreate(?:[\\/]|$)/.test(row.image.subfolder || '')) return null;
    return resolveOutputFile(row.directory,row.image);
  };
  const currentLinks=(key,rows)=>{
    const current=store.read(state=>rows.flatMap(row=>{
      const job=state.jobs.find(job=>job.id===row.jobId);if(!job) return [];
      const image=row.stage==='result' ? !job.outputsDeletedAt && job.images?.[row.index]
        : row.stage==='source' ? row.index===0 ? job.sourceImage : row.index===1 ? job.cameraSource?.image : angleInputImage(job)
        : !job.outputsDeletedAt && job.stageResults?.[row.stage]?.images?.[row.index];
      return image && sourceKey(row.base,image)===key ? [{...row,ownerId:job.visitorId || 'admin'}] : [];
    }));
    return current;
  };
  const bind=(key,rows)=>{for(const row of currentLinks(key,rows)) link.run(row.jobId,row.stage,row.index,row.ownerId,key);};
  async function save(key,rows) {
    const row=rows[0],existing=find(row.base,row.image);
    if(existing) {
      bind(key,rows);
      const file=localSource(row);
      if(file) {
        if(hash(fs.readFileSync(existing.file))!==existing.sha256) throw imageError('已儲存的照片校驗失敗，保留 ComfyUI 原圖。');
        if(hash(fs.readFileSync(file))===existing.sha256) fs.unlinkSync(file);
      }
      db.prepare('DELETE FROM archive_failures WHERE source_key=?').run(key);return;
    }
    const local=localSource(row),buffer=local ? await fs.promises.readFile(local) : await loadImage(row.base,row.image);
    if(!buffer.length || buffer.length>128*1024*1024) throw imageError('成果照片大小無效。');
    const decoder=sharp(buffer,{limitInputPixels:64*1024*1024}),metadata=await decoder.metadata();
    const type={png:['png','image/png'],jpeg:['jpg','image/jpeg'],webp:['webp','image/webp']}[metadata.format];
    if(!type) throw imageError('成果照片格式不支援。');
    await decoder.stats(); // Validate the complete pixel data before accepting an original.
    if(closed || !currentLinks(key,rows).length) return;
    const sha256=hash(buffer),fileName=`${sha256}.${type[0]}`,target=path.join(root,fileName),temporary=path.join(root,`.tmp-${randomUUID()}`);
    let created=false;
    try {
      if(!checkedFile(fileName)) {
        await fs.promises.writeFile(temporary,buffer,{flag:'wx'});
        if(hash(await fs.promises.readFile(temporary))!==sha256) throw imageError('照片複製校驗失敗。');
        await fs.promises.rename(temporary,target);created=true;
      } else if(hash(await fs.promises.readFile(target))!==sha256) throw imageError('已儲存的照片校驗失敗。');
      if(closed || !currentLinks(key,rows).length) {if(created) fs.unlinkSync(target);return;}
      db.exec('BEGIN IMMEDIATE');
      try {put.run(key,fileName,sha256,buffer.length,type[1],new Date().toISOString());bind(key,rows);db.prepare('DELETE FROM archive_failures WHERE source_key=?').run(key);db.exec('COMMIT');}
      catch(error) {db.exec('ROLLBACK');if(created) fs.unlinkSync(target);throw error;}
      // Only registered local PhotoCreate outputs are removed. The verified file
      // and database relation have already been committed before this point.
      if(local && fs.existsSync(local) && hash(fs.readFileSync(local))===sha256) fs.unlinkSync(local);
    } finally {if(fs.existsSync(temporary)) fs.unlinkSync(temporary);}
  }
  async function archive({limit=Infinity}={}) {
    if(closed || paused) return;
    if(task) {await task;if(limit!==Infinity || closed || paused) return;}
    task=(async()=>{
      const groups=new Map();for(const row of references()) {const key=sourceKey(row.base,row.image);if(!groups.has(key)) groups.set(key,[]);groups.get(key).push(row);}
      let attempted=0;const unavailable=new Set();
      for(const [key,rows] of groups) {
        if(closed || paused) break;
        const existing=find(rows[0].base,rows[0].image),failed=db.prepare('SELECT failed_at FROM archive_failures WHERE source_key=?').get(key);
        if(!existing && (attempted>=limit || failed && Date.now()-failed.failed_at<60000 || unavailable.has(rows[0].base))) continue;
        if(!existing) attempted++;
        try {await save(key,rows);} catch(error) {
          if(closed) break;
          if(error.connectionUnavailable) unavailable.add(rows[0].base);
          db.prepare('INSERT OR REPLACE INTO archive_failures VALUES(?,?,?)').run(key,String(error.message).slice(0,2000),Date.now());
        }
      }
    })();
    try {await task;} finally {task=null;if(closed && !dbClosed) {db.close();dbClosed=true;}}
  }
  const status=()=>{
    const {files,bytes}=db.prepare('SELECT COUNT(*) files,COALESCE(SUM(size),0) bytes FROM (SELECT file_name,MAX(size) size FROM photos GROUP BY file_name)').get();
    const missing=new Set(references().filter(row=>row.stage==='result' && !find(row.base,row.image)).map(row=>sourceKey(row.base,row.image)));
    return {files,bytes,links:db.prepare('SELECT COUNT(*) count FROM photo_links').get().count,failed:db.prepare('SELECT COUNT(*) count FROM archive_failures').get().count,missing:missing.size,archiving:Boolean(task)};
  };
  function preparePurge(state,jobs) {
    const selected=new Set(jobs.map(row=>row.id)),rows=photoReferences(state,defaultOutputDir);
    const removed=rows.filter(row=>selected.has(row.jobId)),retained=new Set(rows.filter(row=>!selected.has(row.jobId)).map(row=>sourceKey(row.base,row.image)));
    const keys=[...new Set(removed.map(row=>sourceKey(row.base,row.image)))].filter(key=>!retained.has(key));
    const records=keys.map(key=>get.get(key)).filter(Boolean),fileNames=new Set(records.map(row=>row.file_name));
    const removing=new Set(keys),files=[];
    for(const name of fileNames) if(!db.prepare('SELECT source_key FROM photos WHERE file_name=?').all(name).some(row=>!removing.has(row.source_key))) {
      const file=checkedFile(name);if(file) files.push(file);
    }
    return ()=>{
      for(const file of files) fs.unlinkSync(file);
      db.exec('BEGIN IMMEDIATE');
      try {
        for(const job of jobs) db.prepare('DELETE FROM photo_links WHERE job_id=?').run(job.id);
        for(const key of keys) {db.prepare('DELETE FROM photo_links WHERE source_key=?').run(key);db.prepare('DELETE FROM photos WHERE source_key=?').run(key);db.prepare('DELETE FROM archive_failures WHERE source_key=?').run(key);}
        db.exec('COMMIT');
      } catch(error) {db.exec('ROLLBACK');throw error;}
      return files.length;
    };
  }
  const timer=intervalMs>0 ? setInterval(()=>archive({limit:8}).catch(()=>{}),intervalMs) : null;timer?.unref();
  return {find,archive,status,preparePurge,manageOutputs,
    pause() {paused++;return ()=>{paused--;};},
    async idle() {if(task) await task;},
    close() {closed=true;clearInterval(timer);if(!task && !dbClosed) {db.close();dbClosed=true;}},
  };
}
