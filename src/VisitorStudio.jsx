import {useEffect,useMemo,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {ArrowDownToLine,ArrowLeft,ArrowUpRight,Camera,Check,CheckCheck,ChevronRight,ImagePlus,Loader2,Maximize2,Plus,RefreshCw,Scan,ShieldCheck,SlidersHorizontal,Square,Sparkles,Trash2,Undo2,X} from 'lucide-react';
import CameraControl from './CameraControl.jsx';
import PhotoPrompts from './PhotoPrompts.jsx';
import ImageViewer from './ImageViewer.jsx';
import PhotoFolders,{FolderDestination,usePhotoDrag} from './PhotoFolders.jsx';
import {checkAuthentication} from './auth-api.js';
import {DEFAULT_CAMERA_ANGLE} from '../shared/camera.js';
import './visitor-studio.css';

const requestKey=()=>crypto.randomUUID ? crypto.randomUUID() : [...crypto.getRandomValues(new Uint8Array(16))].map(value=>value.toString(16).padStart(2,'0')).join('');
async function studioApi(route,options={}) {
  const form=options.body instanceof FormData;
  const response=await fetch('/api/studio'+route,{...options,headers:{...(form ? {} : {'Content-Type':'application/json'})},...(options.body ? {body:form ? options.body : JSON.stringify(options.body)} : {})});
  const result=await response.json();
  checkAuthentication(response);
  if(!response.ok) throw new Error(result.error || '操作未完成，請稍後再試。');
  return result;
}
function savedPreferences(userId) {try {return JSON.parse(localStorage.getItem(`photocreate-studio-preferences:${userId}`) || '{}');} catch {return {};}}
const statusLabel=job=>job.status==='completed' ? '拍攝完成' : job.status==='failed' ? '拍攝未完成' : job.status==='stopped' ? '已暫停' : job.status==='stopping' ? '正在停止拍攝' : job.status==='uncertain' ? '確認拍攝中' : job.status==='submitting' ? '正在安排拍攝' : job.status==='queued' || job.status==='draft' ? '等候攝影棚' : job.stage==='refine' ? '正在修復細節' : job.stage==='angle' ? '正在拍攝不同角度' : '正在產圖';
function statusTone(job,arranging=false) {
  if(arranging || !job || ['draft','submitting','queued'].includes(job.status)) return 'waiting';
  if(['completed','failed','stopped','stopping','uncertain'].includes(job.status)) return job.status;
  return job.stage==='angle' ? 'angle' : job.stage==='refine' ? 'refine' : 'base';
}
function photoItems(jobs) {
  const groups=new Map();
  for(const job of jobs) {if(!groups.has(job.rootId)) groups.set(job.rootId,[]);groups.get(job.rootId).push(job);}
  return [...groups.entries()].map(([rootId,versions])=>{
    versions.sort((a,b)=>b.version-a.version);
    const job=versions[0],completed=versions.find(row=>row.status==='completed' && row.images.length);
    return {rootId,job,completed,versions:versions.filter(row=>row.status==='completed' && row.images.length),image:job.images[0] || job.preview || completed?.images[0],pending:job.active};
  }).sort((a,b)=>Date.parse(b.job.createdAt)-Date.parse(a.job.createdAt));
}
function Brand({small=false}) {
  return <a className={`pc-brand ${small ? 'small' : ''}`} href="#shoot" aria-label="PhotoCreate 攝影棚"><img src="/photocreate-mark.svg" alt=""/><span>PhotoCreate<small>你的私人攝影棚</small></span></a>;
}
function StudioSet({character,wardrobeCount}) {
  return <div className="pc-set" aria-label="攝影棚預覽"><div className="pc-set-wall"/><div className="pc-set-light left"><i/><span/></div><div className="pc-set-light right"><i/><span/></div><div className="pc-set-frame"><div className="pc-frame-corner top-left"/><div className="pc-frame-corner bottom-right"/>{character ? <img src={character.image} alt={`目前主角：${character.name}`}/> : <div className="pc-subject"><svg viewBox="0 0 180 240" aria-hidden="true"><path d="M54 70C48 22 135 16 130 70L134 131H49Z" fill="#4e3c70"/><ellipse cx="91" cy="66" rx="28" ry="35" fill="#efd1be"/><path d="M78 92H104V119H78Z" fill="#e3bba6"/><path d="M50 109Q92 88 134 110L153 211H28Z" fill="#302441"/><path d="M78 105L91 129L104 105" fill="#f7f4fb"/><path d="M50 118L38 232M134 118L146 232" stroke="#302441" strokeWidth="23" strokeLinecap="round"/><path d="M63 208L57 247M118 208L125 247" stroke="#615279" strokeWidth="25"/></svg><span>下一位主角，就是你。</span></div>}<span className="pc-frame-caption">{character ? character.name : 'PhotoCreate Studio'}</span></div><div className="pc-set-sticker"><Scan size={23}/><span>角色、服裝、鏡頭。<br/>每一張都有新可能。</span></div><div className="pc-set-note"><span className="pc-status-dot"/>{character ? '主角已就位' : '等你入鏡'}<small>{wardrobeCount || 0} 套服裝等你試穿</small></div></div>;
}
function PhotoDialog({item,cameras,ready,cameraReady,pending,error,onClose,onAction,onDelete}) {
  const dialog=useRef(null),previousFocus=useRef(null),close=useRef(onClose);
  const [mode,setMode]=useState('photo'),[angle,setAngle]=useState(DEFAULT_CAMERA_ANGLE),[versionId,setVersionId]=useState(null),[viewer,setViewer]=useState(null);
  const operationKey=useRef(requestKey()),photo=item.versions.find(row=>row.id===versionId) || item.completed;
  const image=photo?.images[0] || item.image;
  const sourceImage=photo ? `/api/studio/jobs/${photo.id}/angle-source` : null,displayImage=mode==='angle' ? sourceImage : image;
  const versionLabel=photo?.version ? `版本 ${photo.version+1}` : '原圖';
  const selectVersion=id=>{setVersionId(id);operationKey.current=requestKey();};
  const versionIndex=item.versions.findIndex(row=>row.id===photo?.id);
  const viewerNavigation=versionIndex>=0 ? {index:versionIndex,total:item.versions.length,onMove:delta=>{const next=item.versions[versionIndex+delta];if(next) selectVersion(next.id);}} : undefined;
  close.current=onClose;
  useEffect(()=>{
    previousFocus.current=document.activeElement;
    const previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';
    const focusable=()=>[...dialog.current.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),[tabindex="0"]')];
    focusable()[0]?.focus();
    const keydown=event=>{if(event.key==='Escape') close.current();if(event.key==='Tab') {const elements=focusable(),first=elements[0],last=elements.at(-1);if(event.shiftKey && document.activeElement===first) {event.preventDefault();last?.focus();} else if(!event.shiftKey && document.activeElement===last) {event.preventDefault();first?.focus();}}};
    document.addEventListener('keydown',keydown);
    return ()=>{document.body.style.overflow=previousOverflow;document.removeEventListener('keydown',keydown);previousFocus.current?.focus();};
  },[]);
  const act=async action=>{
    const id=['retry','stop'].includes(action) ? item.job.id : photo?.id || item.job.id;
    const ok=await onAction(id,action,{requestId:operationKey.current,...(action==='angle' ? {angle} : {})});
    if(ok) {operationKey.current=requestKey();setVersionId(null);setMode('photo');}
  };
  const remove=async()=>{if(await onDelete(photo?.id || item.job.id)) {setVersionId(null);setViewer(null);operationKey.current=requestKey();}};
  const deleteButton=<button className="pc-delete-photo" disabled={pending || item.pending} onClick={remove} title="移到回收區，可還原"><Trash2 size={16}/>{item.versions.length>1 ? '刪除此版本' : '刪除照片'}</button>;
  return <div className="pc-dialog-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget) onClose();}}>
    <section ref={dialog} className={`pc-dialog ${mode==='angle' ? 'angle-mode' : ''}`} role="dialog" aria-modal="true" aria-label={mode==='angle' ? '不同角度拍攝' : '我的照片'}>
      <button className="pc-dialog-close pc-icon-button" onClick={onClose} aria-label="關閉照片"><X size={23}/></button>
      <div className="pc-dialog-image">
        {displayImage ? <button className="pc-photo-expand" aria-label={mode==='angle' ? '放大拍攝來源照片' : '放大這張照片'} onClick={()=>setViewer(true)}><img src={displayImage} alt={mode==='angle' ? '拍攝來源照片' : '我的拍攝成果'}/><span><Maximize2 size={15}/>點圖放大</span></button> : <div className="pc-photo-waiting"><Camera size={48}/><p>{statusLabel(item.job)}</p></div>}
        {mode==='angle' && <span className="pc-angle-source-label">拍攝來源：{versionLabel}</span>}
        {item.pending && <span className={`pc-photo-status tone-${statusTone(item.job)}`}><Loader2 size={14} className="spin"/>{statusLabel(item.job)}</span>}
      </div>
      <div className="pc-dialog-content">
        <div className="pc-dialog-heading">{mode==='angle' && <button className="pc-text-button" onClick={()=>setMode('photo')}><ArrowLeft size={14}/>返回照片</button>}<h2>{mode==='angle' ? '不同角度拍攝' : '這一張，你喜歡嗎？'}</h2><p>{mode==='angle' ? `以你選取的${versionLabel}為來源，轉動鏡頭、調整俯仰與遠近。` : '保留喜歡的，讓下一張更接近你的想像。'}</p></div>
        {error && <p className="pc-error" role="alert">{error}</p>}
        {mode==='photo' && item.versions.length>1 && <div className="pc-version-picker" role="group" aria-label="照片版本"><span>保留的版本</span><div>{item.versions.map(row=><button key={row.id} aria-pressed={photo?.id===row.id} onClick={()=>selectVersion(row.id)}>{row.version ? `版本 ${row.version+1}` : '原圖'}</button>)}</div></div>}
        {mode==='angle' && photo ? <>
          <div className="pc-angle-presets">{cameras.filter(row=>row.angle).slice(0,5).map(row=><button key={row.id} onClick={()=>setAngle(row.angle)}>{row.name}</button>)}</div>
          <CameraControl value={angle} onChange={setAngle} image={sourceImage}/>
          <p className="pc-small-note">從左側這張照片拍攝不同角度，可點圖放大核對。鏡頭預設 0／0／0，細節修復 20 步；完成後保留先前版本。</p>
          <button className="pc-primary" disabled={pending || item.pending || !ready || !cameraReady} onClick={()=>act('angle')}>{pending ? <Loader2 size={17} className="spin"/> : <Camera size={17}/>}拍攝這個角度</button>
        </> : <>
          <div className="pc-photo-details"><span>{(photo || item.job).garment}</span><span>{(photo || item.job).pose}</span>{photo?.version>0 && <span>第 {photo.version+1} 個版本</span>}</div>
          {item.job.error && <p className="pc-error" role="status">{item.job.error}</p>}
          {item.job.canStop && <div className={`pc-task-status tone-${statusTone(item.job)}`} role="status"><Loader2 size={16} className="spin"/>{statusLabel(item.job)}<button disabled={pending || item.job.status==='stopping'} onClick={()=>act('stop')}><Square size={13}/>{item.job.status==='uncertain' ? '再次確認停止' : '停止拍攝'}</button></div>}
          {photo && <>
            <div className="pc-download-actions"><a className="pc-primary pc-download" href={`${photo.images[0]}?download=1`} download><ArrowDownToLine size={18}/>下載照片</a>{deleteButton}</div>
            <div className="pc-photo-actions"><button disabled={pending || item.pending || !ready || !cameraReady} onClick={()=>{setAngle(DEFAULT_CAMERA_ANGLE);operationKey.current=requestKey();setMode('angle');}}><SlidersHorizontal size={20}/><span>不同角度拍攝<small>用目前這張照片，換一個鏡位</small></span><ChevronRight size={18}/></button><button disabled={pending || item.pending || !ready} onClick={()=>act('remake')}><RefreshCw size={20}/><span>重新拍一張<small>同一組搭配，全新的照片</small></span><ChevronRight size={18}/></button></div>
            <p className="pc-small-note">重新拍攝會保留原本的照片。刪除會移到回收區，可還原。</p>
          </>}
          {item.job.canRetry && <button className="pc-primary" disabled={pending || !ready} onClick={()=>act('retry')}><RefreshCw size={17}/>繼續拍攝這張照片</button>}
          {!photo && !item.job.canRetry && <p className="pc-small-note">拍攝完成後，就可以下載、拍攝不同角度或重新拍攝。</p>}
        </>}
        {mode==='photo' && <><PhotoPrompts job={photo || item.job} api={studioApi}/>{!photo && deleteButton}</>}
      </div>
    </section>{viewer && displayImage && <ImageViewer src={displayImage} alt={mode==='angle' ? `拍攝來源：${versionLabel}` : `我的拍攝成果 · ${versionLabel}`} navigation={viewerNavigation} onClose={()=>setViewer(null)}/>}
  </div>;
}

function PurgeDialog({count,pending,error,onClose,onConfirm}) {
  const dialog=useRef(null);
  useEffect(()=>{const element=dialog.current;element.showModal();return ()=>element.close();},[]);
  return createPortal(<dialog ref={dialog} className="pc-purge-dialog" aria-labelledby="pc-purge-title" aria-describedby="pc-purge-description" onCancel={event=>{event.preventDefault();if(!pending) onClose();}}>
    <Trash2 size={27}/><h2 id="pc-purge-title">永久刪除 {count} 張照片？</h2>
    <p id="pc-purge-description">這些照片在回收區的所有版本都會刪除，之後無法還原。</p>
    {error && <p className="pc-error" role="alert">{error}</p>}
    <div><button autoFocus disabled={pending} onClick={onClose}>取消</button><button className="pc-permanent-delete" disabled={pending} onClick={onConfirm}>{pending ? <Loader2 size={15} className="spin"/> : <Trash2 size={15}/>}確認永久刪除</button></div>
  </dialog>,document.body);
}

export default function VisitorStudio({user,accountMenu}) {
  const preferences=useMemo(()=>savedPreferences(user.id),[user.id]);
  const [data,setData]=useState(null),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [selectedId,setSelectedId]=useState(preferences.characterId || ''),[count,setCount]=useState(preferences.count || 6),[ratio,setRatio]=useState(['9:16','1:1','16:9'].includes(preferences.ratio) ? preferences.ratio : '9:16');
  const [cameraEnabled,setCameraEnabled]=useState(preferences.cameraEnabled===true);
  const [needsCharacter,setNeedsCharacter]=useState(false);
  const [folderId,setFolderId]=useState(preferences.folderId || ''),[galleryFolder,setGalleryFolder]=useState('all'),[selectedPhotos,setSelectedPhotos]=useState([]);
  const [purgeSelection,setPurgeSelection]=useState(null);
  const [source,setSource]=useState('studio'),[filter,setFilter]=useState('all'),[selectedRoot,setSelectedRoot]=useState(null),[pending,setPending]=useState(''),[dragging,setDragging]=useState(false);
  const input=useRef(null),photos=useRef(null),characterSection=useRef(null),mutation=useRef(false),shootKey=useRef(requestKey());
  const reload=async onReload=>{const state=await studioApi('/state');if(typeof onReload==='function') onReload(state);setData(state);return state;};
  useEffect(()=>{document.body.classList.add('public-studio-page');let current=true;studioApi('/state').then(state=>{if(current) {setData(state);const savedCharacter=state.characters.find(row=>row.id===preferences.characterId);if(!savedCharacter) setSelectedId('');else if(savedCharacter.owned) setSource('mine');}}).catch(cause=>{if(current) setError(cause.message);});return ()=>{current=false;document.body.classList.remove('public-studio-page');};},[]);
  const active=Boolean(data?.jobs.some(job=>job.active));
  useEffect(()=>{if(!data || !active && data.ready && typeof data.cameraReady==='boolean') return;let current=true,running=false;const refresh=async()=>{if(running) return;running=true;try {const state=await studioApi('/state');if(current) setData(state);} catch { /* Keep the existing pictures during a connection outage. */ } finally {running=false;}};const timer=setInterval(refresh,1500);window.addEventListener('focus',refresh);return ()=>{current=false;clearInterval(timer);window.removeEventListener('focus',refresh);};},[active,data?.ready,data?.cameraReady]);
  useEffect(()=>{shootKey.current=requestKey();try {localStorage.setItem(`photocreate-studio-preferences:${user.id}`,JSON.stringify({characterId:selectedId,count,ratio,cameraEnabled,folderId}));} catch { /* Preferences are optional. */ }},[selectedId,count,ratio,cameraEnabled,folderId]);
  useEffect(()=>{if(!data) return;if(folderId && !(data.folders || []).some(folder=>folder.id===folderId)) setFolderId('');if(galleryFolder && galleryFolder!=='all' && !(data.folders || []).some(folder=>folder.id===galleryFolder)) setGalleryFolder('all');},[data?.folders,folderId,galleryFolder]);
  useEffect(()=>{setSelectedPhotos([]);},[galleryFolder,filter]);
  useEffect(()=>{if(!notice) return;const timer=setTimeout(()=>setNotice(''),6000);return ()=>clearTimeout(timer);},[notice]);
  const character=data?.characters.find(row=>row.id===selectedId),characters=(data?.characters || []).filter(row=>source==='mine' ? row.owned : !row.owned);
  useEffect(()=>{if(!needsCharacter) return;(characterSection.current?.querySelector('.pc-character-card') || characterSection.current?.querySelector('.pc-upload-card'))?.focus({preventScroll:true});},[needsCharacter,source]);
  const chooseCharacter=()=>{
    setNeedsCharacter(true);
    if(!characters.length && data?.characters.length) setSource(data.characters[0].owned ? 'mine' : 'studio');
    characterSection.current?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',block:'start'});
  };
  const selectCharacter=id=>{setSelectedId(id);setNeedsCharacter(false);};
  const items=useMemo(()=>photoItems(data?.jobs || []),[data?.jobs]),trash=useMemo(()=>photoItems(data?.trash || []),[data?.trash]);
  const currentPhoto=items.find(item=>item.job.status==='running') || items.find(item=>item.pending) || items[0];
  const currentBatch=currentPhoto ? items.filter(item=>item.job.batchId===currentPhoto.job.batchId) : [];
  const completedCount=currentBatch.filter(item=>item.job.status==='completed').length;
  const arranging=pending==='shoot' || pending==='photo';
  const productionLabel=arranging ? '正在安排拍攝' : active ? statusLabel(currentPhoto.job) : currentBatch.some(item=>item.job.status==='failed') ? '拍攝未完成' : currentBatch.some(item=>item.job.status==='stopped') ? '拍攝已暫停' : '拍攝完成';
  const folderPhotos=filter==='trash' ? trash : items;
  const visible=folderPhotos.filter(item=>(filter==='done' ? item.job.status==='completed' : filter==='working' ? item.job.status!=='completed' : true) && (galleryFolder==='all' || (item.job.folderId || '')===galleryFolder)),selectedItem=items.find(item=>item.rootId===selectedRoot);
  const selectedPhotoIds=visible.filter(item=>selectedPhotos.includes(item.rootId)).map(item=>item.job.id);
  const selectedActive=(data?.jobs || []).some(job=>job.active && selectedPhotos.includes(job.rootId));
  const updateRequired=Boolean(data && typeof data.cameraReady!=='boolean');
  const queueUpdateRequired=Boolean(active && data?.canQueueShoots!==true);
  const countValid=Number.isInteger(Number(count)) && Number(count)>=1 && Number(count)<=(data?.maxCount || 24);
  const run=async(key,action,message,onReload)=>{if(mutation.current) return false;mutation.current=true;setPending(key);setError('');setNotice('');try {const result=await action();await reload(onReload);if(message) setNotice(message);return result ?? true;} catch(cause) {setError(cause.message);return false;} finally {mutation.current=false;setPending('');}};
  const upload=async file=>{if(!file || !data || mutation.current) return;if(file.size>25*1024*1024) {setError('角色圖片最多 25 MB，請選擇較小的圖片。');return;}await run('upload',async()=>{const body=new FormData();body.append('image',file);const row=await studioApi('/characters',{method:'POST',body});selectCharacter(row.id);setSource('mine');},'角色已就位，可以開始拍攝。');};
  const shoot=async()=>{if(!character || !countValid) return;const ok=await run('shoot',()=>studioApi('/shoots',{method:'POST',body:{characterId:character.id,count:Number(count),aspectRatio:ratio,cameraEnabled,folderId,requestId:shootKey.current}}),active ? `已排入 ${count} 張照片，會依序拍攝。` : `已開始拍攝 ${count} 張照片。`);if(ok) {shootKey.current=requestKey();setFilter('all');setGalleryFolder(folderId || 'all');photos.current?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',block:'start'});}};
  const createFolder=name=>run('folder',()=>studioApi('/folders',{method:'POST',body:{name}}),'資料夾已建立。');
  const renameFolder=(id,name)=>run('folder',()=>studioApi(`/folders/${id}`,{method:'PATCH',body:{name}}),'資料夾名稱已更新。');
  const deleteFolder=id=>run('folder',()=>studioApi(`/folders/${id}`,{method:'DELETE'}),'資料夾已刪除，照片已回到未分類。');
  const movePhotos=async(ids,destination)=>{const result=await run('folder',()=>studioApi('/photos/move',{method:'POST',body:{ids,folderId:destination}}),'照片與所有版本已移動。');if(result) setSelectedPhotos([]);return result;};
  const photoDrag=usePhotoDrag(movePhotos,Boolean(pending));
  const photoAction=(id,action,body)=>run('photo',()=>studioApi(`/jobs/${id}/${action}`,{method:'POST',body}),action==='stop' ? '已送出停止要求，確認停止後可以繼續拍攝。' : action==='angle' ? '已安排不同角度拍攝，先前版本會保留。' : '已安排重新拍攝。');
  const preservePhotoDialog=state=>{
    if(!selectedRoot) return;
    const remaining=photoItems(state.jobs);
    if(remaining.some(item=>item.rootId===selectedRoot)) return;
    const matching=remaining.filter(item=>(filter==='done' ? item.job.status==='completed' : filter==='working' ? item.job.status!=='completed' : true) && (galleryFolder==='all' || (item.job.folderId || '')===galleryFolder));
    const index=Math.max(0,visible.findIndex(item=>item.rootId===selectedRoot)),next=matching[Math.min(index,matching.length-1)] || remaining[0];
    setSelectedRoot(next?.rootId || null);
  };
  const deletePhoto=(id,allVersions=false)=>run('delete',()=>studioApi(`/jobs/${id}`,{method:'DELETE',body:{allVersions}}),'照片已移到回收區，可隨時還原。',preservePhotoDialog);
  const deleteSelected=()=>run('delete',()=>studioApi('/photos/delete',{method:'POST',body:{ids:selectedPhotoIds}}),'所選照片與所有版本已移到回收區，可隨時還原。',state=>{setSelectedPhotos([]);preservePhotoDialog(state);});
  const confirmPurge=ids=>{setError('');setPurgeSelection(ids);};
  const purgePhotos=()=>run('purge',()=>studioApi('/photos/purge',{method:'POST',body:{ids:purgeSelection}}),'照片已永久刪除。',()=>{setSelectedPhotos([]);setPurgeSelection(null);});
  const deleteCharacter=id=>run('character-delete',()=>studioApi(`/characters/${id}`,{method:'DELETE'}),'角色已移除，既有照片仍會保留。',()=>{setSelectedId(current=>current===id ? '' : current);});
  const stoppableJobs=(data?.jobs || []).filter(job=>job.canStop),retryableJobs=(data?.jobs || []).filter(job=>job.canRetry);
  const stopPhotos=()=>run('stop',()=>studioApi('/jobs/stop',{method:'POST',body:{ids:stoppableJobs.map(job=>job.id)}}),'已送出停止要求，確認停止後可以繼續拍攝。');
  const retryPhotos=()=>run('retry',()=>studioApi('/jobs/retry',{method:'POST',body:{ids:retryableJobs.map(job=>job.id)}}),'已安排繼續未完成的拍攝。');
  const restorePhoto=id=>run('restore',()=>studioApi(`/jobs/${id}/restore`,{method:'POST',body:{allVersions:true}}),'照片已還原。');
  return <div className="pc-studio"><header className="pc-header"><Brand/><nav aria-label="攝影棚導覽"><a href="#shoot">開始拍攝</a><a href="#photos">我的照片{items.length>0 && <span>{items.length}</span>}</a></nav>{arranging || currentPhoto ? <a href="#photos" className={`pc-production-status ${active || arranging ? 'working' : 'finished'} tone-${statusTone(currentPhoto?.job,arranging)}`} aria-label="攝影棚拍攝狀態"><span role="status" aria-live="polite" aria-atomic="true">{active || arranging ? <Loader2 size={17} className="spin"/> : completedCount===currentBatch.length ? <CheckCheck size={17}/> : <Camera size={17}/>}<span><strong>{productionLabel}</strong><small>{currentBatch.length ? `已完成 ${completedCount} / ${currentBatch.length} 張` : '照片正在安排中'}</small></span></span><ChevronRight size={14}/></a> : <span className="pc-private"><ShieldCheck size={16}/>只屬於你的攝影棚</span>}{accountMenu}</header><main>
    <section className="pc-hero" id="shoot"><div className="pc-hero-copy"><div className="pc-opening-note"><span className="pc-status-dot"/>攝影棚，現在為你開放。</div><h1>今天，<br/>換個樣子<br/>入鏡。</h1><p>選一個角色，剩下的交給我們。<br/>服裝與動作隨機搭配，鏡頭由你決定。</p><a className="pc-hero-link" href="#character">選擇你的主角<ArrowUpRight size={19}/></a><div className="pc-hero-signature"><span>PhotoCreate</span><small>每張照片，都是一次新的可能。</small></div></div><StudioSet character={character} wardrobeCount={data?.wardrobeCount}/></section>
    <section className="pc-shooting" aria-label="開始一組拍攝"><div ref={characterSection} className={`pc-character-section ${needsCharacter ? 'needs-selection' : ''}`} id="character"><div className="pc-section-heading"><div><h2>先選你的主角</h2><p>用自己的角色，或選一位攝影棚角色。</p></div><div className="pc-segments" role="group" aria-label="角色來源"><button aria-pressed={source==='studio'} onClick={()=>setSource('studio')}>攝影棚角色</button><button aria-pressed={source==='mine'} onClick={()=>setSource('mine')}>我的角色{data?.characters.some(row=>row.owned) && <span>{data.characters.filter(row=>row.owned).length}</span>}</button></div></div><div className="pc-character-strip"><button className={`pc-upload-card ${dragging ? 'dragging' : ''} ${pending==='upload' ? 'uploading' : ''}`} disabled={!data || Boolean(pending)} onClick={()=>input.current.click()} onDragOver={event=>{event.preventDefault();setDragging(true);}} onDragLeave={()=>setDragging(false)} onDrop={event=>{event.preventDefault();setDragging(false);upload(event.dataTransfer.files[0]);}}>{pending==='upload' ? <Loader2 size={29} className="spin"/> : <ImagePlus size={29} strokeWidth={1.5}/>}<strong>{pending==='upload' ? '角色準備中' : '上傳你的角色'}</strong><small>拖入圖片，也可以點選</small><span>PNG / JPG / WebP</span></button>{!data && !error && <div className="pc-character-loading" role="status"><Loader2 size={20} className="spin"/>開啟你的攝影棚…</div>}{characters.map(row=><div key={row.id} className="pc-character-shell"><button className={`pc-character-card ${row.id===selectedId ? 'selected' : ''}`} aria-pressed={row.id===selectedId} aria-label={`選擇角色 ${row.name}`} onClick={()=>selectCharacter(row.id)}><div><img src={row.image} alt={row.name} loading="lazy"/><span className="pc-character-check">{row.id===selectedId ? <Check size={15}/> : <Plus size={15}/>}</span></div><strong>{row.name}</strong><small>{row.owned ? '你的角色' : '攝影棚角色'}</small></button>{row.owned && <button className="pc-character-delete pc-icon-button" disabled={Boolean(pending)} onClick={()=>deleteCharacter(row.id)} aria-label={`刪除角色 ${row.name}`} title="刪除角色，保留既有照片"><Trash2 size={15}/></button>}</div>)}{data && !characters.length && <p className="pc-character-empty">{source==='mine' ? '上傳第一張角色圖片，開啟你的私人攝影棚。' : '先上傳你的角色，就能開始拍攝。'}</p>}</div><input ref={input} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={event=>{upload(event.target.files[0]);event.target.value='';}}/></div>
    <div className="pc-shoot-settings"><div className="pc-settings-top"><span className="pc-step-tag"><Camera size={17}/>鏡頭準備好了</span><h2>這次，拍幾張？</h2><p>每張都會換一組搭配。</p></div><div className="pc-count-options" role="group" aria-label="拍攝張數">{[1,4,6,9,12].map(value=><button key={value} aria-pressed={Number(count)===value} aria-label={`拍攝 ${value} 張`} onClick={()=>setCount(value)}>{value}<small>張</small></button>)}</div><label className="pc-custom-count">自訂張數<input aria-label="自訂拍攝張數" type="number" min={1} max={data?.maxCount || 24} step={1} value={count} onChange={event=>setCount(event.target.value)}/><span>最多 24 張</span></label><div className="pc-ratio-options" role="group" aria-label="照片比例">{[['9:16','直式'],['1:1','方形'],['16:9','橫式']].map(([value,label])=><button key={value} aria-pressed={ratio===value} onClick={()=>setRatio(value)}><span className={`pc-ratio-icon ratio-${label}`}/>{label}</button>)}</div><FolderDestination folders={data?.folders || []} value={folderId} onChange={setFolderId} onCreate={createFolder} busy={!data || Boolean(pending)}/><label className="pc-camera-toggle"><input aria-label="套用鏡頭角度" type="checkbox" checked={cameraEnabled} disabled={!data || Boolean(pending) || (!data.cameraReady && !cameraEnabled)} onChange={event=>setCameraEnabled(event.target.checked)}/><span><strong>套用鏡頭角度</strong><small>{data && !data.cameraReady ? '鏡頭流程尚未就緒，可以先取消勾選、拍攝原圖。' : cameraEnabled ? '會依攝影棚鏡頭候選換角度，拍攝時間較長。' : '只產原圖，完成後仍可打開照片調鏡頭。'}</small></span></label><button className={`pc-primary pc-shoot-button ${!character && data ? 'needs-character' : ''}`} aria-describedby="pc-shoot-hint" disabled={!data || Boolean(pending) || Boolean(character && (!countValid || updateRequired || queueUpdateRequired || !data.ready || cameraEnabled && !data.cameraReady))} onClick={character ? shoot : chooseCharacter}>{pending==='shoot' ? <Loader2 size={20} className="spin"/> : <Sparkles size={20}/>} {pending==='shoot' ? '正在安排拍攝' : !character && data ? '先選主角再拍攝' : (countValid ? `${active ? '排隊拍攝' : '開始拍攝'} ${count} 張` : '開始拍攝')}<ArrowUpRight size={20}/></button><p id="pc-shoot-hint" className={`pc-shoot-hint ${!countValid ? 'invalid' : !character && data ? 'needs-character' : ''}`} role="status">{!data ? '正在載入攝影棚…' : pending ? pending==='shoot' ? '正在安排這次拍攝，請稍候。' : pending==='upload' ? '角色上傳中，完成後就能拍攝。' : '正在處理上一個操作，請稍候。' : !character ? '尚未選定主角。點「先選主角再拍攝」，選擇或上傳角色圖片。' : !countValid ? '請輸入 1–24 的整數張數。' : updateRequired ? '更新已準備好，請重新啟動 PhotoCreate，套用新的鏡頭流程。' : queueUpdateRequired ? '請重新啟動 PhotoCreate 服務，啟用拍攝中加入下一組；目前照片會繼續拍攝。': !data.ready ? '攝影棚搭配尚未就緒，請稍候或聯絡管理員確認服裝與動作設定。' : cameraEnabled && !data.cameraReady ? '鏡頭流程尚未就緒，取消「套用鏡頭角度」即可先拍攝原圖。' : active ? <><CheckCheck size={14}/>已選 {character.name}。前一組仍在拍攝，這一組會依序排隊。</> : <><CheckCheck size={14}/>已選 {character.name}，服裝與動作由攝影棚搭配。</>}</p></div></section>
    {error && <div className="pc-message error" role="alert"><span>{error}</span>{!data && <button onClick={()=>run('reload',reload)}>重新連線</button>}<button className="pc-icon-button" onClick={()=>setError('')} aria-label="關閉錯誤訊息"><X size={18}/></button></div>}{notice && <div className="pc-message" role="status"><Check size={18}/><span>{notice}</span><button className="pc-icon-button" onClick={()=>setNotice('')} aria-label="關閉通知"><X size={18}/></button></div>}
    <section ref={photos} className="pc-photos" id="photos">
      <div className="pc-section-heading"><div><h2>我的照片{items.length>0 && <span className="pc-photo-count">{items.length}</span>}</h2><p>{filter==='trash' ? '照片可以還原，也能勾選後永久刪除；永久刪除後無法還原。' : '打開照片，查看提詞、拍攝不同角度，或重新拍一張。'}</p></div>
        <div className="pc-photo-toolbar"><div className="pc-segments" role="group" aria-label="照片篩選">{[['all','全部'],['done','已完成'],['working','拍攝中'],['trash','回收區']].map(([value,label])=><button key={value} aria-label={label} aria-pressed={filter===value} onClick={()=>setFilter(value)}>{label}{value==='trash' && trash.length>0 && <span>{trash.length}</span>}</button>)}</div><button className="pc-icon-button" aria-label="重新整理我的照片" disabled={Boolean(pending)} onClick={()=>run('refresh',reload)}><RefreshCw size={18} className={pending==='refresh' ? 'spin' : ''}/></button></div>
      </div>
      {filter!=='trash' && (stoppableJobs.length>0 || retryableJobs.length>0) && <div className="pc-job-controls">{stoppableJobs.length>0 && <button className="pc-stop-task" disabled={Boolean(pending) || stoppableJobs.every(job=>job.status==='stopping')} onClick={stopPhotos}><Square size={14}/>停止我的拍攝 ({stoppableJobs.length})</button>}{retryableJobs.length>0 && <button className="pc-retry-task" disabled={Boolean(pending) || !data?.ready} onClick={retryPhotos}><RefreshCw size={14}/>繼續未完成 ({retryableJobs.length})</button>}<span>已完成的照片會保留。</span></div>}
      <PhotoFolders folders={data?.folders || []} photos={folderPhotos.map(item=>({id:item.job.id,folderId:item.job.folderId}))} value={galleryFolder} onChange={setGalleryFolder} onCreate={createFolder} onRename={renameFolder} onDelete={deleteFolder} onMove={filter==='trash' ? undefined : movePhotos} selectedIds={selectedPhotoIds} selectionActions={<button className="pc-selection-delete" disabled={Boolean(pending) || selectedActive} title={selectedActive ? '請先停止拍攝，確認停止後才能刪除' : undefined} onClick={filter==='trash' ? ()=>confirmPurge(selectedPhotoIds) : deleteSelected}><Trash2 size={14}/>{filter==='trash' ? '永久刪除所選' : '刪除所選'}</button>} onClearSelection={()=>setSelectedPhotos([])} busy={!data || Boolean(pending)}/>
      {visible.length ? <div className="pc-photo-grid">{visible.map((item,index)=>filter==='trash' ? <div className={`pc-trash-card pc-photo-card-shell ${selectedPhotos.includes(item.rootId) ? 'selected' : ''}`} key={item.rootId}><div className="pc-photo-image">{item.image && <img src={item.image} alt={`回收區第 ${index+1} 張照片`} loading="lazy"/>}</div><div className="pc-photo-card-caption"><strong>{item.job.garment || '你的寫真'}</strong></div><button className="pc-restore-photo" disabled={Boolean(pending)} onClick={()=>restorePhoto(item.job.id)}><Undo2 size={15}/>還原照片{item.versions.length>1 && <small>含 {item.versions.length} 個版本</small>}</button><button className="pc-trash-purge" disabled={Boolean(pending)} onClick={()=>confirmPurge([item.job.id])} aria-label={`永久刪除回收區第 ${index+1} 張照片`}><Trash2 size={14}/>永久刪除</button><label className="pc-card-select"><input type="checkbox" aria-label={`勾選回收區第 ${index+1} 張照片`} disabled={Boolean(pending)} checked={selectedPhotos.includes(item.rootId)} onChange={()=>setSelectedPhotos(current=>current.includes(item.rootId) ? current.filter(id=>id!==item.rootId) : [...current,item.rootId])}/><Check size={14}/></label></div> : <div className={`pc-photo-card-shell ${selectedPhotos.includes(item.rootId) ? 'selected' : ''}`} key={item.rootId}>
        <button className={`pc-photo-card ${item.pending ? 'in-progress' : ''} tone-${statusTone(item.job)}`} {...photoDrag.cardProps(item.image ? selectedPhotoIds.includes(item.job.id) ? selectedPhotoIds : [item.job.id] : [])} onClick={()=>setSelectedRoot(item.rootId)} aria-label={`打開第 ${index+1} 張照片`}><div className="pc-photo-image">{item.image ? <img draggable={false} src={item.image} alt={`第 ${index+1} 張拍攝成果`} loading="lazy"/> : <div className="pc-photo-waiting">{item.pending ? <Loader2 size={30} strokeWidth={1.2} className="spin"/> : <Camera size={30} strokeWidth={1.2}/>}<span>{statusLabel(item.job)}</span><small>好照片，需要一點時間。</small></div>}<span className="pc-photo-zoom"><Maximize2 size={16}/></span><span className={`pc-photo-status tone-${statusTone(item.job)}`} role="status" aria-live="polite">{item.pending ? <Loader2 size={12} className="spin"/> : item.job.status==='completed' ? <CheckCheck size={12}/> : <Camera size={12}/>}<span>{statusLabel(item.job)}</span></span></div><div className="pc-photo-card-caption"><strong>{item.job.garment || '你的寫真'}</strong><span>{item.job.version ? `新版本 ${item.job.version+1}` : '打開照片'}<ArrowUpRight size={14}/></span></div></button>
        {(item.job.canStop || item.job.canRetry) && <div className="pc-card-task-actions">{item.job.canStop ? <button className="pc-stop-task" disabled={Boolean(pending) || item.job.status==='stopping'} onClick={()=>photoAction(item.job.id,'stop',{})}><Square size={12}/>{item.job.status==='stopping' ? '確認停止中' : item.job.status==='uncertain' ? '再次確認停止' : '停止拍攝'}</button> : <button className="pc-retry-task" disabled={Boolean(pending) || !data?.ready} onClick={()=>photoAction(item.job.id,'retry',{})}><RefreshCw size={12}/>繼續拍攝</button>}</div>}
        <button className="pc-card-delete pc-icon-button" disabled={Boolean(pending) || item.pending} onClick={()=>deletePhoto(item.job.id,true)} aria-label={`刪除第 ${index+1} 張照片與所有版本`} title={item.pending ? '拍攝完成後才能刪除' : '刪除照片與所有版本'}><Trash2 size={15}/></button>
        <label className="pc-card-select"><input type="checkbox" aria-label={`勾選第 ${index+1} 張照片`} disabled={Boolean(pending)} checked={selectedPhotos.includes(item.rootId)} onChange={()=>setSelectedPhotos(current=>current.includes(item.rootId) ? current.filter(id=>id!==item.rootId) : [...current,item.rootId])}/><Check size={14}/></label>
      </div>)}</div> : <div className="pc-empty-gallery"><div className="pc-empty-print left"><Scan size={30}/></div><div className="pc-empty-print middle"><Camera size={34}/></div><div className="pc-empty-print right"><Sparkles size={27}/></div><div><h3>{filter==='trash' ? '回收區目前是空的。' : items.length ? '這裡還沒有符合的照片。' : '留個位置，給新的你。'}</h3><p>{filter==='trash' ? '刪除的照片會出現在這裡。' : items.length ? '換個篩選，看看其他照片。' : '第一組照片完成後，會出現在這裡。'}</p>{filter!=='trash' && !items.length && <a href="#character">選好角色，開始拍攝<ArrowUpRight size={16}/></a>}</div></div>}
    </section>
    {photoDrag.preview}
    </main><footer className="pc-footer"><Brand small/><p>你的角色，你的鏡頭，你的可能。<small>角色與照片保存在你的帳號；換個裝置，登入後就能繼續拍攝。</small></p><span>Made for your next look.</span></footer>{selectedItem && <PhotoDialog key={selectedRoot} item={selectedItem} cameras={data.cameras} ready={data.ready && !updateRequired} cameraReady={data.cameraReady} pending={Boolean(pending)} error={error} onClose={()=>setSelectedRoot(null)} onAction={photoAction} onDelete={deletePhoto}/>} {purgeSelection && <PurgeDialog count={purgeSelection.length} pending={Boolean(pending)} error={error} onClose={()=>setPurgeSelection(null)} onConfirm={purgePhotos}/>}</div>;
}
