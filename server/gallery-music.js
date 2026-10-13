import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DEFAULT_PIANO_CAPTION,DEFAULT_PIANO_DURATION_CAP,MUSIC_KINDS,musicWorkflow} from '../shared/gallery-music.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE=['submitting','queued','running','uncertain'];
const MAX_AUDIO=80*1024*1024;
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const validId=id=>{if(typeof id!=='string' || !UUID.test(id)) throw fail('音樂識別碼無效。');return id.toLowerCase();};
function audioType(buffer) {
  if(!Buffer.isBuffer(buffer) || !buffer.length || buffer.length>MAX_AUDIO) throw fail('請選擇 80 MB 以下的 MP3、WAV 或 FLAC 音樂。');
  if(buffer.length>=12 && buffer.toString('ascii',0,4)==='RIFF' && buffer.toString('ascii',8,12)==='WAVE') return '.wav';
  if(buffer.length>=4 && buffer.toString('ascii',0,4)==='fLaC') return '.flac';
  if(buffer.length>=3 && (buffer.toString('ascii',0,3)==='ID3' || buffer[0]===255 && (buffer[1]&224)===224)) return '.mp3';
  throw fail('只支援 MP3、WAV 或 FLAC 音樂。');
}

// Music has its own journal and UUID files; photo jobs and their snapshots are
// never repurposed as audio records. A lost queue receipt is checked, not resent.
export function createGalleryMusic({dataDir,comfyJson,comfyAt,comfyUrl,isBusy=()=>false,pollMs=2500}) {
  const directory=path.join(dataDir,'gallery-music'),journal=path.join(dataDir,'gallery-music.json');
  fs.mkdirSync(directory,{recursive:true});
  if(fs.lstatSync(directory).isSymbolicLink() || path.dirname(fs.realpathSync(directory))!==fs.realpathSync(dataDir)) throw fail('音樂目錄含有連結，無法安全存取。');
  const saved=fs.existsSync(journal) ? JSON.parse(fs.readFileSync(journal,'utf8')) : {version:1,tracks:[]};
  let tracks=saved.tracks;
  if(saved.version!==1 || !Array.isArray(tracks) || tracks.some(row=>!UUID.test(row.id))) throw fail('音樂資料庫無效。');
  let closed=false,polling=false,starting=false;
  const persist=()=>{if(closed) return;fs.writeFileSync(journal+'.tmp',JSON.stringify({version:1,tracks},null,2));fs.renameSync(journal+'.tmp',journal);};
  const fileFor=track=>{
    if(!track || !new RegExp(`^${track.id}\\.(mp3|wav|flac)$`,'i').test(track.fileName || '')) throw fail('找不到音樂。',404);
    const file=path.join(directory,track.fileName),stat=fs.lstatSync(file,{throwIfNoEntry:false});
    if(!stat || !stat.isFile() || stat.isSymbolicLink() || path.dirname(fs.realpathSync(file))!==fs.realpathSync(directory)) throw fail('找不到音樂檔案。',404);
    return file;
  };
  const publicTrack=(track,customer=false)=>customer ? {id:track.id,name:track.name,kind:track.kind,audio:`/api/studio/music/${track.id}/audio`} : {...track,audio:track.status==='completed' ? `/api/music/${track.id}/audio` : null};
  const list=(customer=false)=>tracks.filter(row=>!customer || row.status==='completed' && row.enabled && (()=>{try {fileFor(row);return true;} catch {return false;}})()).map(row=>publicTrack(row,customer));
  const fields=input=>{
    if(typeof input?.name!=='string') throw fail('請輸入音樂名稱。');
    const name=input.name.trim(),kind=input.kind || 'piano';
    if(!name || name.length>100 || !Object.hasOwn(MUSIC_KINDS,kind)) throw fail('請輸入 100 字以內的音樂名稱與有效分類。');
    return {name,kind};
  };
  async function availability() {
    try {
      const nodes=await comfyJson('/object_info',{},comfyUrl());
      return {ready:Boolean(nodes.MiniMaxMusic3Generate && nodes.SaveAudioMP3),error:nodes.MiniMaxMusic3Generate && nodes.SaveAudioMP3 ? '' : 'ComfyUI 尚未安裝 MiniMax Music3 產生與 MP3 儲存節點。'};
    } catch(error) {return {ready:false,error:error.message};}
  }
  async function generate(id,input) {
    id=validId(id);const values=fields(input),caption=input.caption ?? DEFAULT_PIANO_CAPTION,durationCap=Number(input.durationCap ?? DEFAULT_PIANO_DURATION_CAP);
    if(typeof caption!=='string' || !caption.trim() || caption.length>16000 || !Number.isInteger(durationCap) || durationCap<10 || durationCap>360) throw fail('請輸入音樂提詞，生成上限須為 10–360 秒。');
    const existing=tracks.find(row=>row.id===id);
    if(existing) {if(existing.name!==values.name || existing.kind!==values.kind || existing.caption!==caption || existing.durationCap!==durationCap) throw fail('這個請求已用於另一首音樂。',409);return publicTrack(existing);}
    if(closed || starting || tracks.some(row=>ACTIVE.includes(row.status)) || isBusy()) throw fail('請先等目前拍攝、轉圖或音樂製作完成，再產生音樂。',409);
    if(values.kind==='rain') throw fail('雨聲請使用匯入音效；Music3 用於鋼琴、小提琴等音樂。');
    starting=true;
    try {
      const base=comfyUrl(),[available,queue]=await Promise.all([availability(),comfyJson('/queue',{},base)]);
      if(!available.ready) throw fail(available.error,503);
      if((queue.queue_running || []).length || (queue.queue_pending || []).length || isBusy()) throw fail('攝影棚目前正在製作，請完成後再產生音樂。',409);
      const track={id,...values,caption,durationCap,seed:Math.floor(Math.random()*2**40),status:'submitting',enabled:false,createdAt:new Date().toISOString(),comfyUrl:base};
      track.prompt=musicWorkflow(id,track);tracks.unshift(track);persist();
      try {
        const receipt=await comfyJson('/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt_id:id,client_id:'PhotoCreate-gallery-music',prompt:track.prompt})},base);
        if(receipt.prompt_id!==id) throw fail('音樂送出回應待確認。');
        track.status='queued';track.error='';
      } catch(error) {track.status='uncertain';track.error=error.message;}
      persist();return publicTrack(track);
    } finally {starting=false;}
  }
  async function audioBytes(response) {
    if(Number(response.headers.get('content-length'))>MAX_AUDIO) throw fail('音樂超過 80 MB。');
    const reader=response.body.getReader(),chunks=[];let size=0;
    try {while(true) {const {done,value}=await reader.read();if(done) break;size+=value.length;if(size>MAX_AUDIO) {await reader.cancel();throw fail('音樂超過 80 MB。');}chunks.push(Buffer.from(value));}} finally {reader.releaseLock();}
    return Buffer.concat(chunks,size);
  }
  async function sync() {
    if(closed || polling) return;polling=true;
    try {for(const track of tracks.filter(row=>ACTIVE.includes(row.status))) {
      try {
        const history=(await comfyJson(`/history/${track.id}`,{},track.comfyUrl))[track.id];
        if(!ACTIVE.includes(track.status)) continue;
        if(history?.status?.status_str==='error') {track.status='failed';track.error=JSON.stringify(history.status.messages || []).slice(0,1800);persist();continue;}
        if(history?.status?.completed) {
          const audio=Object.values(history.outputs || {}).flatMap(row=>row.audio || []).find(row=>row.type==='output');
          const folder=typeof audio?.subfolder==='string' ? audio.subfolder.replaceAll('\\','/') : '';
          if(!audio || typeof audio.filename!=='string' || /[\\/:\0]/.test(audio.filename) || folder!==`PhotoCreate/_gallery_music/${track.id}`) throw fail('音樂輸出位置無效。');
          const query=new URLSearchParams({filename:audio.filename,subfolder:folder,type:'output'}),bytes=await audioBytes(await comfyAt(track.comfyUrl,`/view?${query}`)),ext=audioType(bytes);
          if(!ACTIVE.includes(track.status)) continue;
          const fileName=track.id+ext;fs.writeFileSync(path.join(directory,fileName+'.tmp'),bytes);fs.renameSync(path.join(directory,fileName+'.tmp'),path.join(directory,fileName));
          Object.assign(track,{status:'completed',fileName,completedAt:new Date().toISOString(),error:''});persist();continue;
        }
        const queue=await comfyJson('/queue',{},track.comfyUrl);
        if(!ACTIVE.includes(track.status)) continue;
        if((queue.queue_running || []).some(row=>row[1]===track.id)) {track.status='running';track.error='';persist();}
        else if((queue.queue_pending || []).some(row=>row[1]===track.id)) {track.status='queued';track.error='';persist();}
        else if(Date.now()-Date.parse(track.createdAt)>120000 && track.status!=='uncertain') {track.status='uncertain';track.error='正在確認音樂製作狀態；此任務不會自動重送。';persist();}
      } catch(error) {track.error=error.message;persist();}
    }} finally {polling=false;}
  }
  function upload(file,input) {
    const values=fields(input),ext=audioType(file?.buffer),id=randomUUID(),fileName=id+ext;
    const track={id,...values,fileName,status:'completed',enabled:true,source:'uploaded',createdAt:new Date().toISOString()};
    fs.writeFileSync(path.join(directory,fileName),file.buffer);tracks.unshift(track);persist();return publicTrack(track);
  }
  function update(id,input) {
    const track=tracks.find(row=>row.id===validId(id));if(!track) throw fail('找不到音樂。',404);
    if(typeof input?.enabled!=='boolean') throw fail('請設定是否開放給顧客。');track.enabled=input.enabled;persist();return publicTrack(track);
  }
  function remove(id) {
    const track=tracks.find(row=>row.id===validId(id));if(!track) throw fail('找不到音樂。',404);
    if(ACTIVE.includes(track.status)) throw fail('音樂仍在製作或確認中，請稍候。',409);
    if(track.fileName) fs.unlinkSync(fileFor(track));tracks=tracks.filter(row=>row.id!==track.id);persist();return {ok:true};
  }
  function audio(id,customer=false) {
    const track=tracks.find(row=>row.id===validId(id) && row.status==='completed' && (!customer || row.enabled));return fileFor(track);
  }
  async function cancel(id) {
    const track=tracks.find(row=>row.id===validId(id));if(!track) throw fail('找不到音樂。',404);
    if(!ACTIVE.includes(track.status)) return publicTrack(track);
    const receipt=await comfyJson(`/api/jobs/${track.id}/cancel`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'},track.comfyUrl);
    if(typeof receipt.cancelled!=='boolean') throw fail('正在確認音樂已停止，請稍後再試。',502);
    const queue=await comfyJson('/queue',{},track.comfyUrl);
    if([...queue.queue_running || [],...queue.queue_pending || []].some(row=>row[1]===track.id)) throw fail('正在確認音樂已停止，請稍後再試。',409);
    if(track.status!=='completed') {track.status='stopped';track.error='';persist();}return publicTrack(track);
  }
  const timer=setInterval(()=>sync().catch(()=>{}),pollMs);timer.unref();
  return {list,generate,availability,sync,upload,update,remove,cancel,audio,hasWork:()=>starting || tracks.some(row=>ACTIVE.includes(row.status)),close:()=>{closed=true;clearInterval(timer);}};
}
