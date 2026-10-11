import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync,backup} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import yauzl from 'yauzl';
import yazl from 'yazl';

const MAX_TOTAL=64*1024**3,MAX_FILES=50000,MAX_MANIFEST=16*1024**2;
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const allowed=name=>/^(studio|accounts|photos)\.sqlite$/.test(name) || /^(workflow-source|camera-workflow-source|gallery-music)\.json$/.test(name)
  || /^uploads\/[\w-]+\.(png|jpe?g|webp)$/i.test(name) || /^photos\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(name)
  || /^gallery-music\/[\w-]+\.(mp3|wav|m4a|ogg)$/i.test(name);
const maxFile=name=>name.endsWith('.sqlite') ? 4*1024**3 : name.endsWith('.json') ? MAX_MANIFEST : 128*1024**2;
const targetFile=(root,name)=>{
  if(!allowed(name)) throw fail('備份內含不支援的檔案路徑。');
  const target=path.resolve(root,...name.split('/'));
  if(!target.startsWith(root+path.sep)) throw fail('備份路徑超出資料目錄。');
  return target;
};
const regularFile=(root,name)=>{
  const file=targetFile(root,name);
  if(!fs.existsSync(file) || fs.realpathSync(file)!==file || !fs.statSync(file).isFile()) throw fail('備份檔案遺失或指向資料目錄以外。');
  return file;
};
async function measure(source,max,target) {
  let size=0;const hash=createHash('sha256');
  const meter=new Transform({transform(chunk,encoding,callback) {
    size+=chunk.length;if(size>max) return callback(fail('備份檔案超過允許大小。'));
    hash.update(chunk);callback(null,target ? chunk : undefined);
  }});
  const input=typeof source==='string' ? fs.createReadStream(source) : source;
  if(target) await pipeline(input,meter,fs.createWriteStream(target,{flags:'wx'}));
  else {meter.resume();await pipeline(input,meter);}
  return {size,sha256:hash.digest('hex')};
}
function removeTemporary(parent,dir) {
  if(path.dirname(path.resolve(dir))!==parent || !path.basename(dir).startsWith('PhotoCreate-backup-') || fs.realpathSync(dir)!==dir) throw fail('備份暫存路徑無效。');
  fs.rmSync(dir,{recursive:true,force:true});
}

export function createBackupManager({dataDir,photoStorage,assertIdle,now=()=>Date.now()}) {
  const dataRoot=fs.realpathSync(dataDir),root=path.join(dataRoot,'backups');fs.mkdirSync(root,{recursive:true});
  if(fs.realpathSync(root)!==root) throw fail('備份資料夾不能是目錄連結。');
  const archives=new Map();let busy=false,closed=false;
  const discard=token=>{const value=archives.get(token);if(value) {removeTemporary(root,value.directory);archives.delete(token);}};
  const expiry=setInterval(()=>{for(const [token,value] of archives) if(!value.downloading && now()>value.expiresAt) discard(token);},60000);expiry.unref();
  async function exportZip() {
    if(busy || archives.size>=2) throw fail('請先完成目前的備份下載。',409);
    if(closed) throw fail('服務已關閉。',503);
    assertIdle();busy=true;let directory,resume;
    try {
      await photoStorage.archive();resume=photoStorage.pause();await photoStorage.idle();
      directory=fs.mkdtempSync(path.join(root,'PhotoCreate-backup-'));
      const files=[],sources=new Map();let total=0;
      for(const name of ['studio.sqlite','accounts.sqlite','photos.sqlite']) {
        const source=new DatabaseSync(regularFile(dataRoot,name),{readOnly:true}),target=path.join(directory,name);
        try {await backup(source,target);} finally {source.close();}
        sources.set(name,target);
      }
      // Restored accounts keep their owner IDs and passwords, but require a new login.
      const accounts=new DatabaseSync(sources.get('accounts.sqlite'));accounts.exec('DELETE FROM sessions; PRAGMA wal_checkpoint(TRUNCATE)');accounts.close();
      for(const name of ['workflow-source.json','camera-workflow-source.json','gallery-music.json']) if(fs.existsSync(path.join(dataRoot,name))) sources.set(name,regularFile(dataRoot,name));
      for(const folder of ['uploads','photos','gallery-music']) {
        const parent=path.join(dataRoot,folder);if(!fs.existsSync(parent)) continue;
        if(fs.realpathSync(parent)!==parent) throw fail('備份來源不能是目錄連結。');
        for(const name of fs.readdirSync(parent)) if(allowed(`${folder}/${name}`)) sources.set(`${folder}/${name}`,regularFile(dataRoot,`${folder}/${name}`));
      }
      if(sources.size>MAX_FILES) throw fail('完整備份最多 50,000 個檔案。');
      for(const [name,file] of sources) {
        if(closed) throw fail('服務已關閉。',503);
        const measured=await measure(file,maxFile(name));total+=measured.size;
        if(total>MAX_TOTAL) throw fail('完整備份最多 64 GB。');
        if(name.startsWith('photos/') && !name.startsWith(`photos/${measured.sha256}.`)) throw fail('照片檔案校驗失敗，尚未建立備份。');
        files.push({name,...measured});
      }
      const storage=photoStorage.status(),manifest={format:'PhotoCreate-backup',version:1,createdAt:new Date(now()).toISOString(),unavailableOriginals:storage.missing,files};
      const metadata=Buffer.from(JSON.stringify(manifest,null,2));if(metadata.length>MAX_MANIFEST) throw fail('備份清單過大。');
      const zipPath=path.join(directory,'backup.zip'),zip=new yazl.ZipFile();
      const writing=pipeline(zip.outputStream,fs.createWriteStream(zipPath,{flags:'wx'}));zip.on('error',error=>zip.outputStream.destroy(error));
      zip.addBuffer(metadata,'backup.json');for(const [name,file] of sources) zip.addFile(file,name,{compress:name.endsWith('.sqlite') || name.endsWith('.json')});
      zip.end({forceZip64Format:true});await writing;
      const token=randomUUID(),name=`PhotoCreate-backup-${new Date(now()).toISOString().replace(/[:.]/g,'-')}.zip`,size=fs.statSync(zipPath).size;
      archives.set(token,{directory,path:zipPath,name,size,expiresAt:now()+30*60000,downloading:false});
      return {token,name,size,files:files.length,photos:storage.files,unavailableOriginals:storage.missing};
    } catch(error) {if(directory) removeTemporary(root,directory);throw error;}
    finally {resume?.();busy=false;}
  }
  return {exportZip,isBusy:()=>busy,
    download(token) {
      const value=archives.get(token);if(!value || value.downloading || now()>value.expiresAt) throw fail('備份下載已過期，請重新備份。',410);
      value.downloading=true;return {...value,cleanup:()=>discard(token)};
    },
    close() {closed=true;clearInterval(expiry);for(const token of archives.keys()) discard(token);},
  };
}

// Restore is intentionally offline. The current data directory is kept intact
// beside the restored one so a failed restore never destroys the existing data.
export async function restoreBackup({archive,dataDir,assertOffline=async()=>{}}) {
  await assertOffline();
  const destination=path.resolve(dataDir),parent=fs.realpathSync(path.dirname(destination));
  if(path.dirname(destination)!==parent || destination===path.parse(destination).root || fs.existsSync(destination) && fs.realpathSync(destination)!==destination) throw fail('還原目錄無效或是目錄連結。');
  const staging=fs.mkdtempSync(path.join(parent,'PhotoCreate-backup-')),extracted=new Map();let zip,manifest,total=0,kept;
  try {
    if(fs.statSync(archive).size>MAX_TOTAL+MAX_MANIFEST) throw fail('完整備份 ZIP 最多 64 GB。');
    zip=await yauzl.openPromise(archive,{lazyEntries:true,strictFileNames:true,validateEntrySizes:true});
    for await(const entry of zip.eachEntry()) {
      const name=entry.fileName,type=(entry.externalFileAttributes>>>16)&0xf000;
      if(extracted.has(name) || extracted.size>=MAX_FILES+1 || entry.generalPurposeBitFlag&1 || type && type!==0x8000 || name!=='backup.json' && !allowed(name)) throw fail('備份 ZIP 內含重複、加密、特殊檔案或不安全路徑。');
      const max=name==='backup.json' ? MAX_MANIFEST : maxFile(name);
      if(!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize>max || (total+=entry.uncompressedSize)>MAX_TOTAL+MAX_MANIFEST) throw fail('備份解壓大小超出範圍。');
      const target=name==='backup.json' ? path.join(staging,name) : targetFile(staging,name);fs.mkdirSync(path.dirname(target),{recursive:true});
      const result=await measure(await zip.openReadStreamPromise(entry),max,target);extracted.set(name,result);
      if(name==='backup.json') {try {manifest=JSON.parse(fs.readFileSync(target,'utf8'));} catch {throw fail('完整備份清單無效。');}}
    }
    zip.close();zip=null;
    if(manifest?.format!=='PhotoCreate-backup' || manifest.version!==1 || !Array.isArray(manifest.files) || manifest.files.length!==extracted.size-1) throw fail('請選擇 PhotoCreate 的完整備份 ZIP。');
    const declared=new Set();
    for(const row of manifest.files) {
      const value=extracted.get(row.name);
      if(!allowed(row.name) || declared.has(row.name) || !value || value.sha256!==row.sha256 || value.size!==row.size) throw fail('備份檔案遺失或校驗失敗，保留原資料。');
      declared.add(row.name);
    }
    for(const name of ['studio.sqlite','accounts.sqlite','photos.sqlite']) {
      if(!declared.has(name)) throw fail('備份缺少必要的資料庫。');
      const db=new DatabaseSync(regularFile(staging,name),{readOnly:true});
      try {
        if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok') throw fail('備份資料庫損壞，保留原資料。');
        if(name==='studio.sqlite') {for(const row of db.prepare('SELECT data FROM jobs UNION ALL SELECT data FROM assets UNION ALL SELECT data FROM meta').all()) JSON.parse(row.data);}
        if(name==='accounts.sqlite' && !db.prepare("SELECT id FROM accounts WHERE role='admin'").get()) throw fail('備份缺少管理員帳號。');
        if(name==='photos.sqlite') for(const row of db.prepare('SELECT file_name,sha256,size FROM photos').all()) {
          const image=extracted.get(`photos/${row.file_name}`);if(!image || image.sha256!==row.sha256 || image.size!==row.size) throw fail('備份缺少已登記的成果照片。');
        }
      } finally {db.close();}
    }
    await assertOffline();
    if(fs.existsSync(destination)) {
      kept=path.join(parent,`${path.basename(destination)}-before-restore-${randomUUID()}`);
      if(path.dirname(kept)!==parent || fs.existsSync(kept)) throw fail('原資料保留目錄無效。');
      fs.renameSync(destination,kept);
    }
    try {fs.renameSync(staging,destination);} catch(error) {if(kept) fs.renameSync(kept,destination);throw error;}
    return {dataDir:destination,previousDataDir:kept,files:manifest.files.length,unavailableOriginals:manifest.unavailableOriginals || 0};
  } finally {zip?.close();if(fs.existsSync(staging)) removeTemporary(parent,staging);}
}
