import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Camera,ChevronLeft,ChevronRight,Images,Loader2,Maximize2,X} from 'lucide-react';
import {CATEGORIES,OUTPUT_RATIOS} from '../shared/domain.js';
import ImageViewer from './ImageViewer.jsx';
import {randomId} from './ids.js';
import './preset-photos.css';

const active = job => ['queued','running','submitting','stopping','uncertain'].includes(job.status);
const closeSession = id => fetch(`/api/preset-previews/${id}`,{method:'DELETE',keepalive:true}).catch(()=>{});

function PhotoTile({item,onClick}) {
  return <button type="button" className="preset-photo-tile" onClick={onClick} aria-label={`查看照片：${item.name}`}><img loading="lazy" src={item.src} alt={item.name}/><span className="preset-photo-enlarge"><Maximize2 size={14}/></span></button>;
}
function PhotoViewer({selection,onClose,onChange}) {
  const item=selection.items[selection.index];
  return <ImageViewer src={item.src} alt={item.name} onClose={onClose} navigation={{index:selection.index,total:selection.items.length,onMove:delta=>onChange({...selection,index:selection.index+delta})}}/>;
}
function PresetGallery({presetId,name,request,onClose}) {
  const dialog=useRef(null),close=useRef(onClose);
  const [offset,setOffset]=useState(0),[data,setData]=useState({items:[],total:0}),[loading,setLoading]=useState(true),[error,setError]=useState(''),[selection,setSelection]=useState(null);
  close.current=onClose;
  useEffect(()=>{
    const element=dialog.current,previous=document.activeElement,overflow=document.body.style.overflow;
    document.body.style.overflow='hidden';element.showModal();
    const keyboard=event=>{
      if(document.querySelector('.pc-image-viewer[open]')) return;
      if(event.key==='Escape') {event.preventDefault();event.stopPropagation();close.current();}
      else if(event.key==='Tab') event.stopPropagation();
    };
    document.addEventListener('keydown',keyboard,true);
    return ()=>{document.removeEventListener('keydown',keyboard,true);element.close();document.body.style.overflow=overflow;previous?.focus();};
  },[]);
  useEffect(()=>{
    const controller=new AbortController();let live=true;
    setLoading(true);setError('');
    request(`/presets/${encodeURIComponent(presetId)}/photos?limit=24&offset=${offset}`,{signal:controller.signal})
      .then(result=>{if(live) setData(result);}).catch(error=>{if(live) setError(error.message);}).finally(()=>{if(live) setLoading(false);});
    return ()=>{live=false;controller.abort();};
  },[presetId,offset,request]);
  return createPortal(<dialog ref={dialog} className="preset-photo-gallery" aria-label="提詞關聯成果" onCancel={event=>{event.preventDefault();event.stopPropagation();onClose();}} onMouseDown={event=>{if(event.target===event.currentTarget) {const rect=dialog.current.getBoundingClientRect();if(event.clientX<rect.left || event.clientX>rect.right || event.clientY<rect.top || event.clientY>rect.bottom) onClose();}}}>
    <header><div><span className="eyebrow">RELATED PHOTOGRAPHS</span><h2>{name || '提詞'} · 關聯成果</h2><p>共 {data.total} 張已完成的照片</p></div><button type="button" className="icon-button" aria-label="關閉關聯畫廊" onClick={onClose}><X size={20}/></button></header>
    <div className="preset-photo-gallery-body" aria-busy={loading}>{error ? <p className="inline-error" role="alert">{error}</p> : loading ? <p className="preset-photo-empty"><Loader2 size={18} className="spin"/>讀取照片…</p> : data.items.length ? <div className="preset-photo-gallery-grid">{data.items.map((item,index)=><figure key={item.id}><PhotoTile item={item} onClick={()=>setSelection({items:data.items,index})}/><figcaption>{item.name}</figcaption></figure>)}</div> : <p className="preset-photo-empty">目前沒有關聯成果。</p>}</div>
    {data.total>24 && <footer className="pagination"><button type="button" className="button secondary" disabled={loading || offset===0} onClick={()=>setOffset(Math.max(0,offset-24))}><ChevronLeft size={14}/>上一頁</button><span>{Math.floor(offset/24)+1} / {Math.ceil(data.total/24)}</span><button type="button" className="button secondary" disabled={loading || offset+24>=data.total} onClick={()=>setOffset(offset+24)}>下一頁<ChevronRight size={14}/></button></footer>}
    {selection && <PhotoViewer selection={selection} onClose={()=>setSelection(null)} onChange={setSelection}/>}
  </dialog>,document.body);
}

export default function PresetPhotos({presetId,value,supported,ratioSupported=false,initialAspectRatio='reference',request,disabled=false}) {
  const session=useRef(null),live=useRef(false);
  const [history,setHistory]=useState({items:[],total:0}),[historyLoading,setHistoryLoading]=useState(Boolean(presetId)),[historyError,setHistoryError]=useState('');
  const [ready,setReady]=useState(false),[jobs,setJobs]=useState([]),[pending,setPending]=useState(false),[error,setError]=useState('');
  const [gallery,setGallery]=useState(false),[selection,setSelection]=useState(null);
  const [aspectRatio,setAspectRatio]=useState(()=>Object.hasOwn(OUTPUT_RATIOS,initialAspectRatio) ? initialAspectRatio : 'reference');
  useEffect(()=>{
    if(!supported) {setHistoryLoading(false);return;}
    const id=randomId(),controller=new AbortController();let alive=true,timer;
    live.current=true;session.current=id;setReady(false);setJobs([]);setError('');
    if(presetId) {
      setHistoryLoading(true);
      request(`/presets/${encodeURIComponent(presetId)}/photos?sample=1&limit=5`,{signal:controller.signal}).then(result=>{if(alive) setHistory(result);})
        .catch(error=>{if(alive) setHistoryError(error.message);}).finally(()=>{if(alive) setHistoryLoading(false);});
    }
    const poll=async()=>{
      try {const result=await request(`/preset-previews/${id}`,{signal:controller.signal});if(alive) {setJobs(result.jobs);setError('');}}
      catch(error) {if(alive) {setError(error.message);if(error.message.includes('臨時試拍已結束')) {setReady(false);clearInterval(timer);}}}
    };
    request(`/preset-previews/${id}`,{method:'PUT',body:{presetId:presetId || null},signal:controller.signal}).then(result=>{
      if(alive) {setReady(true);setJobs(result.jobs);timer=setInterval(poll,1500);}
    }).catch(error=>{if(alive) setError(error.message);});
    const pagehide=()=>closeSession(id);
    window.addEventListener('pagehide',pagehide);
    return ()=>{alive=false;live.current=false;clearInterval(timer);controller.abort();window.removeEventListener('pagehide',pagehide);closeSession(id);};
  },[presetId,supported,request]);
  const shoot=async()=>{
    const id=session.current;
    if(!ready || pending || jobs.some(active)) return;
    setPending(true);setError('');
    try {
      const result=await request(`/preset-previews/${id}/shots`,{method:'POST',body:{preset:structuredClone(value),requestId:randomId(),...(ratioSupported ? {aspectRatio} : {})}});
      if(live.current && session.current===id) setJobs(result.jobs);
    } catch(error) {if(live.current && session.current===id) setError(error.message);}
    finally {if(live.current && session.current===id) setPending(false);}
  };
  const running=pending || jobs.some(active),valid=Boolean(value.name.trim() && (value.category==='camera' || value.prompt.trim()));
  return <aside className="preset-photos" aria-label="提詞成果與臨時試拍">
    <section className="preset-related"><div className="preset-photos-heading"><h3><Images size={16}/>關聯成果 <span>{history.total} 張</span></h3>{history.total>5 && <button type="button" className="preset-more" onClick={()=>setGallery(true)}>更多 <ChevronRight size={14}/></button>}</div>
      <p className="preset-photo-help">使用這項提詞拍攝的照片，隨機展示最多 5 張。</p>
      {!supported ? <p className="preset-photo-empty">重新啟動 PhotoCreate 後，即可查看關聯成果與臨時試拍。</p> : historyError ? <p className="inline-error" role="alert">{historyError}</p> : historyLoading ? <p className="preset-photo-empty"><Loader2 size={18} className="spin"/>讀取關聯成果…</p> : history.items.length ? <div className="preset-photo-sample">{history.items.map((item,index)=><PhotoTile key={item.id} item={item} onClick={()=>setSelection({items:history.items,index})}/>)}</div> : <p className="preset-photo-empty">{presetId ? '還沒有使用這項提詞的完成照片。' : '保存提詞後，這裡會記錄使用過它的拍攝成果。'}</p>}
    </section>
    <section className="preset-trials"><div className="preset-photos-heading"><h3><Camera size={16}/>臨時試拍</h3><span className="preset-temporary">不保存</span></div><p className="preset-photo-help">固定左側目前的提詞，其他搭配隨機選擇。只產一張原圖，完成即可查看。關閉視窗時會停止試拍並清除臨時照片。</p>
      <div className="preset-trial-controls">
        <label>試拍比例<select value={aspectRatio} onChange={event=>setAspectRatio(event.target.value)} disabled={disabled || !supported || !ratioSupported || running}>{Object.entries(OUTPUT_RATIOS).map(([id,ratio])=><option key={id} value={id}>{ratio.label}</option>)}</select></label>
        <button type="button" className="button primary preset-trial-button" onClick={shoot} disabled={disabled || !supported || !ready || !valid || running}>{running ? <Loader2 size={16} className="spin"/> : <Camera size={16}/>}<span>{running ? '試拍中…' : jobs.length ? '再試拍一張' : '試拍一張'}</span></button>
      </div>
      {supported && !ratioSupported && <p className="preset-photo-help">重新啟動 PhotoCreate 後，即可選擇試拍比例。</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="preset-trial-results" aria-live="polite">{[...jobs].reverse().map((job,index)=>{
        const items=job.images;
        return <article className="preset-trial" key={job.id}><div className="preset-trial-result">{items.length ? <PhotoTile item={items[0]} onClick={()=>setSelection({items,index:0})}/> : <div className="preset-trial-placeholder" style={job.outputWidth && job.outputHeight ? {aspectRatio:`${job.outputWidth} / ${job.outputHeight}`} : undefined}>{active(job) ? <Loader2 size={20} className="spin"/> : <Camera size={20}/>}<span>{job.status==='failed' ? '試拍未完成' : job.status==='stopped' ? '已停止' : job.progress || '準備拍攝…'}</span></div>}</div><div className="preset-trial-details"><strong>試拍 {jobs.length-index}</strong>{OUTPUT_RATIOS[job.aspectRatio] && <p className="preset-trial-size">{OUTPUT_RATIOS[job.aspectRatio].label}{job.outputWidth && job.outputHeight ? ` · ${job.outputWidth} × ${job.outputHeight}` : ''}</p>}<p>{job.character} · {job.garment}</p><dl>{job.presets.map(preset=><div key={`${preset.category}:${preset.id}`}><dt>{CATEGORIES[preset.category]?.label || '鏡頭'}</dt><dd>{preset.name}{preset.id===value.id && <span className="preset-bound">固定</span>}</dd></div>)}</dl>{job.error && <p className="inline-error">{job.error}</p>}</div></article>;
      })}</div>
    </section>
    {gallery && <PresetGallery presetId={presetId} name={value.name} request={request} onClose={()=>setGallery(false)}/>}
    {selection && <PhotoViewer selection={selection} onClose={()=>setSelection(null)} onChange={setSelection}/>}
  </aside>;
}
