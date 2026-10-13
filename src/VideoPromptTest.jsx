import {useEffect,useRef,useState} from 'react';
import {ChevronLeft,ChevronRight,Film,Loader2,Play,Upload} from 'lucide-react';
import {VIDEO_DURATIONS,videoIsActive} from '../shared/photo-video.js';
import {VideoResults,VideoViewer} from './PhotoVideo.jsx';
import {randomId} from './ids.js';

export default function VideoPromptTest({prompt,api,disabled}) {
  const session=useRef(randomId()),requestId=useRef(randomId()),input=useRef(null),mounted=useRef(true),mutation=useRef(false);
  const [photos,setPhotos]=useState({items:[],total:0}),[query,setQuery]=useState(''),[offset,setOffset]=useState(0),[source,setSource]=useState(null),[file,setFile]=useState(null),[preview,setPreview]=useState('');
  const [duration,setDuration]=useState(5),[availability,setAvailability]=useState(null),[videos,setVideos]=useState([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [playing,setPlaying]=useState(null);
  const aspectRatio='reference';
  const imageFor=row=>`/api/jobs/${row.jobId}/image/${row.imageIndex}`;
  const active=videos.some(videoIsActive),locked=disabled || busy || active;
  const load=async()=>{const rows=await api('/photo-videos/tests?sessionId='+session.current);if(mounted.current) setVideos(rows);};
  useEffect(()=>{mounted.current=true;Promise.all([api('/photo-videos/settings'),api('/photo-videos/availability')]).then(([settings,available])=>{if(mounted.current){setDuration(settings.defaultDuration);setAvailability(available);}}).catch(cause=>mounted.current && setError(cause.message));return ()=>{mounted.current=false;};},[]);
  useEffect(()=>{let live=true;const timer=setTimeout(()=>api('/photo-videos/test-images?'+new URLSearchParams({q:query,offset,limit:8})).then(result=>live && setPhotos(result)).catch(cause=>live && setError(cause.message)),150);return ()=>{live=false;clearTimeout(timer);};},[query,offset]);
  useEffect(()=>{if(!file){setPreview('');return;}const url=URL.createObjectURL(file);setPreview(url);return ()=>URL.revokeObjectURL(url);},[file]);
  useEffect(()=>{requestId.current=randomId();},[prompt,duration,aspectRatio,source,file]);
  useEffect(()=>{if(!active) return;const timer=setInterval(()=>load().catch(cause=>mounted.current && setError(cause.message)),1500);return ()=>clearInterval(timer);},[active]);
  async function act(action) {
    if(mutation.current) return false;mutation.current=true;setBusy(true);setError('');
    try {const result=await action();await load();return result;} catch(cause) {if(mounted.current) setError(cause.message);throw cause;} finally {mutation.current=false;if(mounted.current) setBusy(false);}
  }
  async function generate() {
    const values={requestId:requestId.current,sessionId:session.current,prompt,duration,aspectRatio,...(source && !file ? {jobId:source.jobId,imageIndex:source.imageIndex} : {})};
    const body=file ? new FormData() : values;
    if(file) {for(const [key,value] of Object.entries(values)) body.append(key,String(value));body.append('image',file);}
    try {await act(()=>api('/photo-videos/tests',{method:'POST',body}));requestId.current=randomId();} catch { /* Displayed in the test panel. */ }
  }
  return <aside className="video-prompt-test" aria-label="影片提詞測試">
    <h3><Film size={18}/>測試影片提詞</h3><p className="field-help">使用目前編輯的提詞測試，保存與開放給顧客仍由你決定。</p>
    <div className="video-test-upload"><button type="button" className="button secondary" disabled={locked} onClick={()=>input.current.click()}><Upload size={15}/>上傳臨時測試圖片</button><input ref={input} hidden type="file" aria-label="上傳影片測試圖片" accept="image/png,image/jpeg,image/webp" onChange={event=>{const picked=event.target.files[0];event.target.value='';if(picked){setFile(picked);setSource(null);}}}/><small>PNG、JPG、WebP · 最多 25 MB</small></div>
    {file ? <div className="video-test-source"><img src={preview} alt="臨時測試圖片"/><span>{file.name}</span><button type="button" disabled={locked} onClick={()=>setFile(null)}>改用已產出的照片</button></div> : <>
      <label>選擇後台已產出的照片<input aria-label="搜尋測試照片" placeholder="搜尋照片名稱…" value={query} disabled={locked} onChange={event=>{setQuery(event.target.value);setOffset(0);}}/></label>
      <div className="video-test-photos">{photos.items.map(item=>{
        const completed=videos.find(row=>row.jobId===item.jobId && row.imageIndex===item.imageIndex && row.video);
        return <div className="video-test-photo" key={item.jobId+':'+item.imageIndex}><button type="button" aria-label={`測試照片 ${item.name} ${item.imageIndex+1}`} aria-pressed={source?.jobId===item.jobId && source?.imageIndex===item.imageIndex} disabled={locked} onClick={()=>setSource(item)}><img src={item.image} alt={item.name} loading="lazy"/><span>{item.name} · {item.imageIndex+1}</span></button>{completed && <button type="button" className="video-test-play" aria-label={`播放影片 ${item.name} ${item.imageIndex+1}`} onClick={()=>setPlaying({src:completed.video,poster:item.image})}><Play size={14}/>播放影片<small>{completed.duration} 秒</small></button>}</div>;
      })}</div>
      {!photos.total && <p className="field-help">目前沒有可選的照片，可以上傳一張臨時測試圖片。</p>}
      {photos.total>8 && <div className="video-test-pagination"><button type="button" aria-label="測試照片上一頁" disabled={locked || !offset} onClick={()=>setOffset(Math.max(0,offset-8))}><ChevronLeft size={15}/></button><span>{Math.floor(offset/8)+1} / {Math.ceil(photos.total/8)}</span><button type="button" aria-label="測試照片下一頁" disabled={locked || offset+8>=photos.total} onClick={()=>setOffset(offset+8)}><ChevronRight size={15}/></button></div>}
    </>}
    <div className="form-grid"><label>測試秒數<select aria-label="影片測試秒數" value={duration} disabled={locked} onChange={event=>setDuration(Number(event.target.value))}>{VIDEO_DURATIONS.map(value=><option key={value} value={value}>{value} 秒</option>)}</select></label><p className="photo-video-source-ratio">影片比例沿用測試圖片</p></div>
    {availability && !availability.ready && <p className="inline-error">{availability.error}</p>}{error && <p role="alert" className="inline-error">{error}</p>}
    <button type="button" className="button primary" disabled={locked || !prompt.trim() || !availability?.ready || !file && !source} onClick={generate}>{busy || active ? <Loader2 size={16} className="spin"/> : <Film size={16}/>}測試產影片</button>
    <VideoResults videos={videos} image={imageFor} busy={busy || disabled} onPlay={row=>setPlaying({src:row.video,poster:imageFor(row)})} onStop={id=>act(()=>api('/photo-videos/'+id+'/stop',{method:'POST'})).catch(()=>{})} onRemove={id=>act(()=>api('/photo-videos/'+id,{method:'DELETE'}))}/>
    {playing && <VideoViewer src={playing.src} poster={playing.poster} onClose={()=>setPlaying(null)}/>}
  </aside>;
}
