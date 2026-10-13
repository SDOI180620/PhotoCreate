import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Check,Download,Film,Images,Loader2,RefreshCw,Save,Trash2,X} from 'lucide-react';
import {defaultVideoSettings,VIDEO_DURATIONS,VIDEO_ASPECT_RATIOS,VIDEO_GENERATION_VERSIONS,videoIsActive,videoStatus} from '../shared/photo-video.js';
import {randomId} from './ids.js';
import {CustomerPromptLibrary} from './CustomerLibrary.jsx';
import './photo-video.css';

export function VideoResults({videos=[],image,busy,onStop,onRemove,gallery=[],galleryFolders=[],onAddToGallery}) {
  const [removeId,setRemoveId]=useState(''),[folderId,setFolderId]=useState('');
  return videos.length>0 && <div className="photo-video-results" aria-label="這張照片的影片">{videos.map(row=><article key={row.id} className="photo-video-result">
    <div className="photo-video-result-heading"><div><strong><Film size={17}/>{row.presetName || (row.mode==='custom' ? '自行輸入' : '官方提詞')}</strong><div className="photo-video-result-meta"><span>{row.duration} 秒</span><span>{VIDEO_ASPECT_RATIOS[row.aspectRatio || 'reference']}</span></div></div><div className="photo-video-result-status"><span className={'photo-video-status status-'+row.status} role="status">{videoIsActive(row) ? <Loader2 size={14} className="spin"/> : row.status==='completed' ? <Check size={14}/> : null}{videoIsActive(row) ? '影片製作中' : videoStatus(row)}</span>{videoIsActive(row) && onStop && <button type="button" className="photo-video-stop" aria-label="停止影片" disabled={busy} onClick={()=>onStop(row.id)}>{row.status==='stopping' || row.status==='uncertain' ? '確認停止' : '停止'}</button>}</div></div>
    {row.video && <video aria-label={`${row.duration} 秒影片`} src={row.video} poster={image} controls playsInline preload="metadata"/>}
    {row.error && <p className="photo-video-error" role="status">{row.error}</p>}

    <div className="photo-video-result-actions">{row.video && <a href={`${row.video}?download=1`} download><Download size={14}/>下載影片</a>}{!videoIsActive(row) && onRemove && <button type="button" className="photo-video-delete" disabled={busy} onClick={()=>setRemoveId(row.id)}><Trash2 size={16}/>刪除影片</button>}</div>
    <details><summary>影片提詞</summary><p className="photo-video-prompt-text">{row.prompt}</p></details>
    {row.video && onAddToGallery && <div className="photo-video-feature-actions">{gallery.some(entry=>entry.mediaType==='video' && entry.videoId===row.id) ? <span><Check size={14}/>這段影片已加入精選</span> : <><label>影片精選分類<select aria-label={`影片精選分類 ${row.id}`} value={galleryFolders.some(folder=>folder.id===folderId) ? folderId : ''} disabled={busy} onChange={event=>setFolderId(event.target.value)}><option value="">未分類</option>{galleryFolders.map(folder=><option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label><button type="button" disabled={busy} onClick={()=>onAddToGallery(row.jobId,row.imageIndex,folderId,{mediaType:'video',videoId:row.id})}><Images size={14}/>將這段影片加入精選</button></>}</div>}

  </article>)}{removeId && <VideoDeleteDialog busy={busy} onClose={()=>setRemoveId('')} onConfirm={()=>onRemove(removeId)}/>}</div>;
}

export function VideoCreator({jobId,imageIndex=0,image,settings=defaultVideoSettings(),api,onChange,personalLibrary,gallery,galleryFolders,onAddToGallery,disabled=false}) {
  const [mode,setMode]=useState(settings.prompts.length ? 'official' : 'custom'),[presetId,setPresetId]=useState(settings.prompts[0]?.id || ''),[prompt,setPrompt]=useState(''),[duration,setDuration]=useState(settings.defaultDuration);
  const aspectRatio='reference';
  const [videos,setVideos]=useState([]),[availability,setAvailability]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const mounted=useRef(true),requestId=useRef(randomId()),mutation=useRef(false),changed=useRef(onChange),signature=useRef('');changed.current=onChange;
  const preset=settings.prompts.find(row=>row.id===presetId) || settings.prompts[0],active=videos.some(videoIsActive);
  const load=async()=>{
    const rows=(await api(`/jobs/${jobId}/videos`)).filter(row=>row.imageIndex===imageIndex);
    if(!mounted.current) return;
    const value=rows.map(row=>`${row.id}:${row.status}`).join(',');
    if(signature.current && signature.current!==value) changed.current?.();
    signature.current=value;setVideos(rows);return rows;
  };
  const check=async()=>{const result=await api('/photo-videos/availability');if(mounted.current) setAvailability(result);};
  useEffect(()=>{mounted.current=true;Promise.all([load(),check()]).catch(cause=>mounted.current && setError(cause.message));return ()=>{mounted.current=false;};},[jobId,imageIndex]);
  useEffect(()=>{if(!active) return;let loading=false;const timer=setInterval(()=>{if(loading) return;loading=true;load().catch(cause=>mounted.current && setError(cause.message)).finally(()=>{loading=false;});},1500);return ()=>clearInterval(timer);},[active,jobId,imageIndex]);
  const edit=setter=>value=>{setter(value);requestId.current=randomId();setNotice('');};
  async function run(action) {
    if(mutation.current) return false;
    mutation.current=true;setBusy(true);setError('');
    try {const result=await action();await load();await changed.current?.();return result || true;}
    catch(cause) {if(mounted.current) setError(cause.message);return false;}
    finally {mutation.current=false;if(mounted.current) setBusy(false);}
  }
  async function generate(event) {
    event.preventDefault();
    if(await run(()=>api(`/jobs/${jobId}/video`,{method:'POST',body:{requestId:requestId.current,imageIndex,duration,aspectRatio,mode,...(mode==='official' ? {presetId:preset.id} : {prompt})}}))) {
      requestId.current=randomId();if(mounted.current) setNotice('影片已排入製作。你可以離開視窗，完成後再回來查看。');
    }
  }
  return <div className="photo-video-creator">
    <form onSubmit={generate}>
      <div className="photo-video-mode" role="group" aria-label="影片提詞方式"><button type="button" aria-pressed={mode==='official'} disabled={busy || disabled || !settings.prompts.length} onClick={()=>edit(setMode)('official')}>官方提詞</button><button type="button" aria-pressed={mode==='custom'} disabled={busy || disabled} onClick={()=>edit(setMode)('custom')}>自行輸入</button></div>
      {mode==='official' ? <><label>官方影片提詞<select aria-label="官方影片提詞" value={preset?.id || ''} disabled={busy || disabled} onChange={event=>edit(setPresetId)(event.target.value)}>{settings.prompts.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label><p className="photo-video-prompt-text">{preset?.prompt}</p></> : <label>影片提詞<textarea aria-label="影片提詞" value={prompt} rows={5} maxLength={16000} required disabled={busy || disabled} placeholder="描述這張照片接下來的動作、鏡頭或場景變化…" onChange={event=>edit(setPrompt)(event.target.value)}/></label>}
      {mode==='custom' && personalLibrary?.supported && <CustomerPromptLibrary field="video" label="影片" value={prompt} onUse={edit(setPrompt)} library={personalLibrary} disabled={busy || disabled}/>}
      <p className="photo-video-source-ratio"><Images size={16}/>影片比例沿用這張照片</p>
      <fieldset disabled={busy || disabled}><legend>影片秒數</legend><div className="photo-video-durations">{VIDEO_DURATIONS.map(value=><label key={value} className={duration===value ? 'selected' : ''}><input type="radio" name={`video-duration-${jobId}`} value={value} checked={duration===value} onChange={()=>edit(setDuration)(value)}/>{value} 秒</label>)}</div></fieldset>
      {error && <p className="photo-video-error" role="alert">{error}</p>}
      {availability && !availability.ready && <p className="photo-video-error" role="status">{availability.error}<button type="button" className="photo-video-recheck" disabled={busy} onClick={()=>run(check)}><RefreshCw size={13}/>重新檢查</button></p>}
      {notice && <p className="photo-video-notice" role="status">{notice}</p>}
      <div className="photo-video-submit-row"><button className="photo-video-generate" disabled={busy || disabled || active || !availability?.ready || (mode==='custom' ? !prompt.trim() : !preset)}>{busy || active || !availability ? <Loader2 size={17} className="spin"/> : <Film size={17}/>} {active ? '影片製作中' : !availability ? '檢查影片功能…' : '開始產影片'}</button>{active && <button type="button" className="photo-video-stop" aria-label="停止影片" disabled={busy || disabled} onClick={()=>run(()=>api(`/photo-videos/${videos.find(videoIsActive).id}/stop`,{method:'POST'}))}>停止</button>}</div>
      <p className="photo-video-hint">以目前這張照片演繹後續動畫，保留原照片。圖片與影片可各自加入精選畫廊。</p>
    </form>
    <VideoResults videos={videos} image={image} gallery={gallery} galleryFolders={galleryFolders} onAddToGallery={onAddToGallery} busy={busy || disabled} onStop={undefined} onRemove={id=>run(()=>api(`/photo-videos/${id}`,{method:'DELETE'}))}/>
  </div>;
}

export function VideoSettings({api,onSaved,onOpenEnvironment,onOpenLibrary}) {
  const [form,setForm]=useState(null),[parameters,setParameters]=useState(null),[availability,setAvailability]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[workflowError,setWorkflowError]=useState(''),[notice,setNotice]=useState('');
  const mounted=useRef(true),parameterRequest=useRef(0);
  const readParameters=async(version=form?.generationVersion)=>{const request=++parameterRequest.current;setParameters(null);setWorkflowError('');try {const result=await api('/photo-videos/parameters'+(version ? '?generationVersion='+encodeURIComponent(version) : ''));if(mounted.current && request===parameterRequest.current) setParameters(result);return result;} catch(cause) {if(mounted.current && request===parameterRequest.current) setWorkflowError(cause.message);throw cause;}};
  useEffect(()=>{mounted.current=true;api('/photo-videos/settings').then(config=>{if(mounted.current){setForm(config);readParameters(config.generationVersion).catch(()=>{});}}).catch(cause=>mounted.current && setError(cause.message));api('/photo-videos/availability').then(value=>mounted.current && setAvailability(value)).catch(cause=>mounted.current && setError(cause.message));return ()=>{mounted.current=false;parameterRequest.current++;};},[]);
  const update=(key,value)=>{setForm(current=>({...current,[key]:value}));setNotice('');};
  const updateParameter=(key,value)=>{setParameters(current=>({...current,[key]:value}));setNotice('');};
  async function save(event) {
    event.preventDefault();if(busy) return;setBusy(true);setError('');
    try {
      const body={defaultDuration:form.defaultDuration,defaultAspectRatio:form.defaultAspectRatio,generationVersion:form.generationVersion};
      if(parameters) {body.workflowParameters={sampler:parameters.sampler,scheduler:parameters.scheduler,steps:parameters.steps,megapixels:parameters.megapixels,...(parameters.generationVersion==='two-pass' ? {refineMegapixels:parameters.refineMegapixels} : {})};body.workflowRevision=parameters.revision;}
      const config=await api('/photo-videos/settings',{method:'PUT',body});setForm(config);if(parameters) await readParameters(config.generationVersion);setAvailability(await api('/photo-videos/availability'));await onSaved?.();setNotice('影片設定已保存，新影片會使用這些工作流參數。');
    } catch(cause) {setError(cause.message);} finally {if(mounted.current) setBusy(false);}
  }
  return <section className="photo-video-settings">
    {error && <p className="photo-video-error" role="alert">{error}</p>}
    {!form ? <p><Loader2 size={17} className="spin"/>讀取影片設定…</p> : <form onSubmit={save}>
      <div className="photo-video-settings-intro"><Film size={26}/><div><h2>讓照片接著動起來</h2><p>玩家產圖後可選官方影片提詞或自行輸入，影片固定提供 5、7、10 秒。</p></div></div>
      <label>提供給顧客的影片版本<select aria-label="影片生成版本" value={form.generationVersion || 'single'} disabled={busy} onChange={event=>{const version=event.target.value;update('generationVersion',version);setAvailability(null);readParameters(version).catch(()=>{});}}>{Object.entries(VIDEO_GENERATION_VERSIONS).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      <div className="form-grid"><label className="photo-video-default">預設影片秒數<select aria-label="預設影片秒數" value={form.defaultDuration} disabled={busy} onChange={event=>update('defaultDuration',Number(event.target.value))}>{VIDEO_DURATIONS.map(value=><option key={value} value={value}>{value} 秒</option>)}</select></label><p className="photo-video-source-ratio"><Images size={16}/>影片比例固定沿用來源照片</p></div>
      <fieldset className="video-workflow-parameters" disabled={busy || !parameters}><legend>影片生成參數</legend><div className="form-grid">
        <label>K 採樣器（KSamplerSelect）<select aria-label="影片 K 採樣器" value={parameters?.sampler || 'euler'} onChange={event=>updateParameter('sampler',event.target.value)}>{(parameters?.samplers || ['euler']).map(value=><option key={value} value={value}>{value}</option>)}</select></label>
        <label>排程器（BasicScheduler）<select aria-label="影片 BasicScheduler" value={parameters?.scheduler || 'simple'} onChange={event=>updateParameter('scheduler',event.target.value)}>{(parameters?.schedulers || ['simple']).map(value=><option key={value} value={value}>{value}</option>)}</select></label>
        <label>{form.generationVersion==='two-pass' ? '一採 Megapixels（Resolution Selector）' : 'Megapixels（Resolution Selector）'}<input aria-label="影片 Megapixels" type="number" min="0.1" max="16" step="0.1" required value={parameters?.megapixels ?? (form.generationVersion==='two-pass' ? 0.4 : 1)} onChange={event=>updateParameter('megapixels',Number(event.target.value))}/></label>
        <label>{form.generationVersion==='two-pass' ? '基礎排程步數' : '採樣步數'}<input aria-label="影片採樣步數" type="number" min={parameters?.firstPassSteps || 1} max="1000" step="1" required value={parameters?.steps ?? 8} onChange={event=>updateParameter('steps',Number(event.target.value))}/></label>
        {form.generationVersion==='two-pass' && <label>二採輸出 Megapixels<input aria-label="二採輸出 Megapixels" type="number" min="0.1" max="16" step="0.1" required value={parameters?.refineMegapixels ?? 1} onChange={event=>updateParameter('refineMegapixels',Number(event.target.value))}/></label>}
      </div></fieldset>
      <p className="field-help">{form.generationVersion==='two-pass' ? `二採使用 ${parameters?.steps || 8} 步基礎排程的前 ${parameters?.firstPassSteps || 4} 步，升頻後再細化 ${parameters?.refineSteps || 3} 步。預設 0.4 MP → 1 MP，需安裝 NVFP4 與 Latent 升頻模型。` : '一採預設 Euler／Simple／8 步／1 MP。'}保存會同步更新 ComfyUI 工作流，保留其他節點設定與連線。</p>
      {workflowError && <p role="alert" className="inline-error">{workflowError}</p>}<button type="button" className="button secondary" disabled={busy} onClick={()=>readParameters().catch(cause=>setWorkflowError(cause.message))}><RefreshCw size={14}/>重新讀取影片參數</button>
      <p className="field-help">官方影片提詞與其他提詞共用「提詞資料庫」，在首頁勾選後套用至顧客攝影棚。</p>{onOpenLibrary && <button type="button" className="button secondary" onClick={onOpenLibrary}>到提詞庫管理影片提詞</button>}
      <p className="field-help">H3 工作流、模型選擇與下載位於「工作室設定 → 環境與工作流」。</p>{onOpenEnvironment && <button type="button" className="button secondary" disabled={busy} onClick={onOpenEnvironment}><Download size={15}/>開啟 H3 環境與模型下載</button>}
      {availability && <div className={availability.ready ? 'photo-video-availability ready' : 'photo-video-availability'} role="status">{availability.ready ? 'H3 工作流與模型已就緒。' : availability.error}</div>}
      {notice && <p className="photo-video-notice" role="status">{notice}</p>}<button className="button primary" disabled={busy || !parameters}>{busy ? <Loader2 size={16} className="spin"/> : <Save size={16}/>}保存影片設定</button>
    </form>}
  </section>;
}

function VideoDeleteDialog({busy,onClose,onConfirm}) {
  const ref=useRef(null),[working,setWorking]=useState(false),[error,setError]=useState('');const locked=busy || working;
  useEffect(()=>{const previous=document.activeElement,dialog=ref.current;dialog.showModal();return ()=>{dialog.close();previous?.focus();};},[]);
  return createPortal(<dialog ref={ref} className="modal photo-video-delete-dialog" aria-label="確認刪除影片" onCancel={event=>{event.preventDefault();event.stopPropagation();if(!locked) onClose();}}><div className="modal-header"><h2>刪除這段影片？</h2><button type="button" className="icon-button" aria-label="關閉刪除影片確認" disabled={locked} onClick={onClose}><X size={18}/></button></div><div className="modal-body"><p>這段影片及其影片精選會一併移除。原照片與其他影片會保留。</p>{error && <p role="alert" className="inline-error">{error}</p>}</div><div className="modal-footer"><button type="button" autoFocus className="button secondary" disabled={locked} onClick={onClose}>取消</button><button type="button" className="button danger" disabled={locked} onClick={async()=>{setWorking(true);setError('');try {if(await onConfirm()===false) throw new Error('影片未能刪除，請重試。');onClose();} catch(cause) {setError(cause.message);setWorking(false);}}}><Trash2 size={15}/>確認刪除影片</button></div></dialog>,document.body);
}

export function VideoViewer({src,poster,onClose}) {
  const dialog=useRef(null),video=useRef(null);
  useEffect(()=>{const element=dialog.current,previous=document.activeElement;const player=video.current;element.showModal();return ()=>{player.pause();element.close();previous?.focus();};},[]);
  return createPortal(<dialog ref={dialog} className="photo-video-viewer" aria-label="播放影片" onCancel={event=>{event.preventDefault();onClose();}}><button onClick={onClose} aria-label="關閉影片"><X size={22}/></button><video ref={video} src={src} poster={poster} controls playsInline autoPlay preload="metadata"/><a href={`${src}?download=1`} download><Download size={16}/>下載影片</a></dialog>,document.body);
}
