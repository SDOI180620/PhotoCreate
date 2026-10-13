import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createGalleryMusic} from '../server/gallery-music.js';
import {DEFAULT_PIANO_CAPTION,DEFAULT_PIANO_DURATION_CAP} from '../shared/gallery-music.js';

// Run with PhotoCreate stopped or before upgrading a server without music
// support. The journal must have exactly one writer, just like studio.sqlite.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const base=process.env.PHOTOCREATE_COMFY_URL || 'http://127.0.0.1:8188';
const comfyAt=async(url,route,options={})=>{const response=await fetch(url+route,{...options,signal:AbortSignal.timeout(30000)});if(!response.ok) throw new Error(`ComfyUI ${response.status}: ${await response.text()}`);return response;};
const music=createGalleryMusic({dataDir:process.env.PHOTOCREATE_DATA_DIR || path.join(root,'data'),comfyUrl:()=>base,comfyAt,comfyJson:async(route,options,url)=>(await comfyAt(url,route,options)).json()});
try {
  const existing=music.list().find(row=>row.kind==='piano' && row.status==='completed' && row.enabled);
  if(existing) {console.log(JSON.stringify({existing:true,id:existing.id,fileName:existing.fileName}));}
  else {
    const active=music.list().find(row=>['submitting','queued','running','uncertain'].includes(row.status));
    const track=active || await music.generate(randomUUID(),{name:'森林微光 · 鋼琴',kind:'piano',durationCap:DEFAULT_PIANO_DURATION_CAP,caption:DEFAULT_PIANO_CAPTION});
    console.log(JSON.stringify({id:track.id,status:track.status}));
    const end=Date.now()+45*60*1000;let previous='';
    while(Date.now()<end) {
      await music.sync();const current=music.list().find(row=>row.id===track.id);
      if(current.status!==previous) {previous=current.status;console.log(JSON.stringify({id:current.id,status:current.status,error:current.error || undefined}));}
      if(current.status==='completed') {console.log(JSON.stringify({fileName:current.fileName,promptId:current.id}));break;}
      if(current.status==='failed') throw new Error(current.error);
      await new Promise(resolve=>setTimeout(resolve,3000));
    }
    if(music.list().find(row=>row.id===track.id)?.status!=='completed') throw new Error('Music generation is still awaiting engine confirmation.');
  }
} finally {music.close();}
