import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Download, FileText, Images, Loader2, LockKeyhole, RefreshCw, RotateCcw, Rotate3d, Trash2, X } from 'lucide-react';
import { PENDING_REMAKE_STATUSES, collectGalleryItems, pendingRemakeRoots, rootJobId } from '../shared/remakes.js';
import { Empty, SearchBox } from './ui.jsx';
import ShotOptions from './ShotOptions.jsx';
import ImageViewer from './ImageViewer.jsx';
import PhotoFolders,{usePhotoDrag} from './PhotoFolders.jsx';

const PAGE_SIZE = 24;
const toggle = (ids,id) => ids.includes(id) ? ids.filter(value => value !== id) : [...ids,id];
const REMAKE_LABELS = {draft:'重製待送出',submitting:'重製送出中',queued:'重製排隊中',running:'正在重製',stopping:'重製停止中',uncertain:'重製待確認',failed:'重製失敗 · 可重試',stopped:'重製已停止 · 可重試'};

function RemakeNotice({job}) {
  if (!job || job.status === 'completed') return null;
  const pending = PENDING_REMAKE_STATUSES.includes(job.status);
  const message = job.status === 'uncertain' ? '請至拍攝清單確認狀態，暫時鎖定勾選。'
    : job.status === 'draft' ? '已加入重製清單，等待送出。'
    : pending ? '已送出重製，勾選已鎖定；完成後自動更新。'
    : job.status === 'failed' ? '重製失敗，原圖已保留，可重新勾選重試。'
    : '重製已停止，原圖已保留，可重新勾選。';
  return <p className={`gallery-remake-note ${pending ? 'is-pending' : job.status === 'failed' ? 'is-failed' : 'is-stopped'}`}>{pending && <LockKeyhole size={12}/>}<span>{message}</span></p>;
}

function GalleryLightbox({item,position,total,navigation,onClose,onMove,onInspect,onAngle,onCustom,customReady,angleReady,selected,onSelect,selectable,remakeJob,onDelete,busy}) {
  const ref = useRef(null);
  const [viewer,setViewer]=useState(false);
  useEffect(() => {
    const previous = document.activeElement;
    ref.current.focus();
    return () => previous?.focus();
  },[]);
  useEffect(() => {
    const listener = event => {
      if(event.key === 'Escape') onClose();
      if(event.key === 'ArrowLeft') {event.preventDefault();onMove(-1);}
      if(event.key === 'ArrowRight') {event.preventDefault();onMove(1);}
      if(event.key === 'Tab') {
        const controls = [...ref.current.querySelectorAll('button:not([disabled]),input:not([disabled]),a[href]')];
        const first = controls[0],last = controls.at(-1);
        if(event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) {event.preventDefault();last?.focus();}
        else if(!event.shiftKey && document.activeElement === last) {event.preventDefault();first?.focus();}
      }
    };
    document.addEventListener('keydown',listener);
    return () => document.removeEventListener('keydown',listener);
  },[onClose,onMove]);
  return <div className="gallery-lightbox-backdrop" onMouseDown={event => {if(event.target === event.currentTarget) onClose();}}>
    <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label="成果放大檢視" className="gallery-lightbox">
      <div className="gallery-lightbox-heading"><div><strong>{item.job.garment.name}</strong><span>{item.job.pose.name} · {item.batchName}</span></div><span>{position + 1} / {total}</span><button aria-label="關閉成果檢視" onClick={onClose}><X size={22}/></button></div>
      <div className="gallery-lightbox-image"><button aria-label="上一張成果" disabled={position === 0} onClick={() => onMove(-1)}><ChevronLeft size={26}/></button><button className="gallery-expand" aria-label="放大這張成果" onClick={()=>setViewer(true)}><img src={`/api/jobs/${item.job.id}/image/${item.index}`} alt={item.job.name}/></button><button aria-label="下一張成果" disabled={position + 1 === total} onClick={() => onMove(1)}><ChevronRight size={26}/></button></div>
      <div className="gallery-lightbox-options"><ShotOptions job={item.job}/><RemakeNotice job={remakeJob}/></div>
      {onCustom && <button className="button action-view gallery-custom" disabled={busy || !customReady || !selectable} onClick={()=>{onClose();onCustom(item.job,item.index);}}>自訂拍攝</button>}
      <div className="gallery-lightbox-footer"><label><input type="checkbox" checked={selected} disabled={!selectable} onChange={onSelect}/>{remakeJob && PENDING_REMAKE_STATUSES.includes(remakeJob.status) ? '已送出重製 · 勾選已鎖定' : '勾選這張成果'}</label><span>{remakeJob && REMAKE_LABELS[remakeJob.status] || (item.job.remakeVersion ? `重製 ${item.job.remakeVersion}` : '原始成果')}</span><button className="button action-view" onClick={() => {onClose();onInspect(item.job);}}><FileText size={14}/>詳細</button>{onAngle && <button className="button action-view gallery-angle" title="不同角度拍攝" aria-label={`不同角度拍攝 ${item.job.name}`} disabled={!angleReady || !selectable} onClick={() => {onClose();onAngle(item.job,item.index);}}><Rotate3d size={14}/>不同角度拍攝</button>}<div className="gallery-download-actions"><a className="button action-export" href={`/api/jobs/${item.job.id}/image/${item.index}?download=1`} download><Download size={15}/>下載原圖</a><button className="button action-delete" disabled={busy || !selectable} onClick={onDelete} title="刪除這次拍攝的成果"><Trash2 size={15}/>刪除照片</button></div></div>
    </div>{viewer && <ImageViewer src={`/api/jobs/${item.job.id}/image/${item.index}`} alt={item.job.name} navigation={navigation} onClose={()=>setViewer(false)}/>}
  </div>;
}

export default function ResultGallery({state,batchId:fixedBatchId = '',onRemake,onDeleteOutputs,onSubmit,onSync,onInspect,onAngle,onCustom,folderActions,busy,connected}) {
  const [batchId,setBatchId] = useState('');
  const [query,setQuery] = useState('');
  const [latestOnly,setLatestOnly] = useState(true);
  const [offset,setOffset] = useState(0);
  const [selected,setSelected] = useState([]);
  const [viewId,setViewId] = useState('');
  const lastViewPosition=useRef(0);
  const [deleteSourceOnComplete,setDeleteSourceOnComplete] = useState(true);
  const [folderId,setFolderId]=useState('all');
  const photoDrag=usePhotoDrag(folderActions ? async(ids,id)=>{const result=await folderActions.move(ids,id);if(result) setSelected([]);return result;} : undefined,busy);
  const effectiveBatchId = fixedBatchId || batchId;
  const allItems = useMemo(() => collectGalleryItems(state,{batchId:effectiveBatchId,query,latestOnly}),[state.jobs,state.batches,effectiveBatchId,query,latestOnly]);
  const items=allItems.filter(item=>folderId==='all' || (item.job.adminFolderId || '')===folderId);
  const folderPhotos=[...new Map(allItems.map(item=>[rootJobId(item.job),{id:item.job.id,folderId:item.job.adminFolderId}])).values()];
  const pending = useMemo(() => pendingRemakeRoots(state.jobs),[state.jobs]);
  const latestRemakes = useMemo(() => {
    const latest = new Map();
    for (const job of state.jobs.filter(row => row.sourceJobId)) {
      const root = rootJobId(job),previous = latest.get(root);
      if (!previous || (job.remakeVersion || 0) > (previous.remakeVersion || 0)) latest.set(root,job);
    }
    return latest;
  },[state.jobs]);
  const available = new Map(items.map(item => [item.job.id,item.job]));
  const selectedIds = selected.filter(id => available.has(id) && !pending.has(rootJobId(available.get(id))));
  const selectedRoots = new Map(selectedIds.map(id => [rootJobId(available.get(id)),id]));
  const selectable = job => !busy && !pending.has(rootJobId(job)) && (!selectedRoots.has(rootJobId(job)) || selectedRoots.get(rootJobId(job)) === job.id);
  const pageOffset = Math.min(offset,Math.max(0,(Math.ceil(items.length / PAGE_SIZE) - 1) * PAGE_SIZE));
  const visible = items.slice(pageOffset,pageOffset + PAGE_SIZE);
  const pageJobs = [...new Map(visible.map(item => [rootJobId(item.job),item.job])).values()].filter(selectable);
  const requestedPosition = items.findIndex(item => item.id === viewId);
  const viewPosition = requestedPosition>=0 ? requestedPosition : Math.min(lastViewPosition.current,items.length-1);
  const viewItem = viewId ? items[viewPosition] : null;
  const viewerGroup=items.filter(item=>item.job.batchId===viewItem?.job.batchId);
  const viewerPosition=viewerGroup.findIndex(item=>item.id===viewItem?.id);
  useEffect(()=>{if(viewItem) lastViewPosition.current=viewPosition;else if(viewId && !items.length) setViewId('');},[viewId,viewPosition,items.length]);
  const canRemake = connected && state.workflow.ready;
  const remakes = state.jobs.filter(job => job.sourceJobId && (!effectiveBatchId || job.batchId === effectiveBatchId));
  const activeCount = remakes.filter(job => ['submitting','queued','running','stopping'].includes(job.status)).length;
  const waiting = remakes.filter(job => job.status === 'draft');
  const problems = remakes.filter(job => ['failed','uncertain'].includes(job.status)).length;
  useEffect(() => {setOffset(0);setSelected([]);setViewId('');},[effectiveBatchId,query,latestOnly,folderId]);
  useEffect(()=>{if(folderId && folderId!=='all' && !(state.photoFolders || []).some(folder=>folder.id===folderId)) setFolderId('all');},[state.photoFolders,folderId]);
  const changePage = value => {setOffset(value);document.querySelector('.result-gallery')?.scrollIntoView({block:'start'});};
  const remake = async () => {const result = await onRemake(selectedIds,{deleteSourceOnComplete});if(result) setSelected([]);};
  const remove = async () => {const result = await onDeleteOutputs(selectedIds);if(result) setSelected([]);};
  const removeOne=async item=>{const result=await onDeleteOutputs([item.job.id]);if(result) setSelected(current=>current.filter(id=>id!==item.job.id));};
  return <div className="result-gallery">
    <PhotoFolders folders={state.photoFolders || []} photos={folderPhotos} value={folderId} onChange={setFolderId} onCreate={folderActions?.create} onRename={folderActions?.rename} onDelete={folderActions?.remove} onMove={folderActions ? async(ids,id)=>{const result=await folderActions.move(ids,id);if(result) setSelected([]);return result;} : undefined} selectedIds={selectedIds} onClearSelection={()=>setSelected([])} busy={busy}/>
    <div className="toolbar gallery-toolbar"><div className="gallery-count"><strong>{items.length}</strong> 張成果</div><SearchBox value={query} onChange={setQuery} placeholder="搜尋成果、服裝、動作或拍攝組…"/>{!fixedBatchId && <select aria-label="畫廊拍攝組" value={batchId} onChange={event => setBatchId(event.target.value)}><option value="">全部拍攝組</option>{(state.batches || []).map(batch => <option key={batch.id} value={batch.id}>{batch.name}</option>)}</select>}<button className="button secondary" disabled={busy} onClick={onSync}><RefreshCw size={15}/>更新成果</button></div>
    <div className="gallery-actions"><button className="button primary" disabled={busy || !canRemake || !selectedIds.length || selectedIds.length > 100} onClick={remake}>{busy ? <Loader2 size={16} className="spin"/> : <RotateCcw size={16}/>}重製所選 ({selectedIds.length})</button><button className="button action-delete gallery-delete" disabled={busy || !selectedIds.length || selectedIds.length > 100} onClick={remove}><Trash2 size={15}/>刪除所選 ({selectedIds.length})</button><label className="gallery-cleanup"><input type="checkbox" checked={deleteSourceOnComplete} onChange={event => setDeleteSourceOnComplete(event.target.checked)}/>重製完成後刪除舊成果</label><label className="gallery-latest"><input type="checkbox" checked={latestOnly} onChange={event => setLatestOnly(event.target.checked)}/>只看最新版本</label></div>
    <div className="gallery-state-legend" aria-label="成果狀態說明"><span className="legend-selected">已勾選 · 待送出 {selectedIds.length} 張</span><span className="legend-remaking">橘色框 · 重製中</span><span className="legend-failed">紅色框 · 重製失敗</span></div>
    {activeCount > 0 && <div className="gallery-progress-note is-remaking" role="status"><Loader2 size={14} className="spin"/>{activeCount} 張正在重製，已送出的勾選會保留並鎖定，完成後自動更新。</div>}
    {waiting.length > 0 && <div className="gallery-progress-note">有 {waiting.length} 張重製草稿尚未送出。<button disabled={busy || !canRemake} onClick={() => onSubmit(waiting.slice(0,100).map(job => job.id))}>送出重製草稿</button></div>}
    {problems > 0 && <p className="muted">有 {problems} 張重製任務失敗或待確認，可在拍攝清單查看。</p>}
    {remakes.some(job => job.sourceCleanupError) && <p className="inline-error">重製成果已完成，但有舊圖未刪除：{remakes.find(job => job.sourceCleanupError).sourceCleanupError}。可按「更新成果」再試。</p>}
    {selectedIds.length > 100 && <p className="inline-error">每次最多處理 100 張，請減少勾選的照片。</p>}
    <div className="gallery-selection-toolbar">{pageJobs.length > 0 && <label><input type="checkbox" checked={pageJobs.every(job => selectedIds.includes(job.id))} onChange={event => setSelected(event.target.checked ? [...new Set([...selected,...pageJobs.map(job => job.id)])] : selected.filter(id => !pageJobs.some(job => job.id === id)))}/>勾選本頁成果</label>}{selectedIds.length > 0 && <button onClick={() => setSelected([])}>清除勾選 ({selectedIds.length})</button>}<span>點照片可放大查看；重製會使用新的隨機 Seed。</span></div>
    {items.length ? <div className="gallery-grid">{visible.map(item => {
      const root = rootJobId(item.job),remakeJob = latestRemakes.get(root);
      const locked = pending.has(root),failed = remakeJob?.status === 'failed';
      const label = remakeJob && REMAKE_LABELS[remakeJob.status] || (item.job.remakeVersion ? `重製 ${item.job.remakeVersion}` : '原始成果');
      return <article key={item.id} data-job-id={item.job.id} {...photoDrag.cardProps(selectedIds.includes(item.job.id) ? selectedIds : [item.job.id])} className={`gallery-card ${selectedIds.includes(item.job.id) ? 'selected' : ''} ${locked ? 'remaking' : failed ? 'remake-failed' : ''}`}>
        <div className="gallery-photo"><button aria-label={`放大成果 ${item.job.name} 第 ${item.index + 1} 張`} onClick={() => setViewId(item.id)}><img draggable={false} loading="lazy" width={item.job.outputWidth || undefined} height={item.job.outputHeight || undefined} src={`/api/jobs/${item.job.id}/image/${item.index}`} alt={item.job.name}/></button><label className="gallery-check" title={locked ? '已加入重製，完成前勾選已鎖定。' : '勾選成果'}><input aria-label={`勾選成果 ${item.job.name} 第 ${item.index + 1} 張`} aria-describedby={`remake-status-${item.job.id}-${item.index}`} type="checkbox" checked={locked || selectedIds.includes(item.job.id)} disabled={!selectable(item.job)} onChange={() => setSelected(toggle(selected,item.job.id))}/><span><Check size={14}/></span></label><span id={`remake-status-${item.job.id}-${item.index}`} className={`gallery-version ${locked ? 'is-remaking' : failed ? 'is-failed' : ''}`}>{locked && <LockKeyhole size={11}/>} {label}</span></div>
        <div className="gallery-caption"><strong>{item.job.garment.name}</strong>{item.batchName !== item.job.garment.name && <small>拍攝組：{item.batchName}</small>}<ShotOptions job={item.job}/><RemakeNotice job={remakeJob}/><div className={`gallery-card-actions ${onAngle ? 'has-angle' : ''}`}><button className="button action-view" onClick={() => onInspect(item.job)}><FileText size={14}/>詳細</button>{onAngle && <button className="button action-view gallery-angle" title="不同角度拍攝" aria-label={`不同角度拍攝 ${item.job.name}`} disabled={busy || locked || !connected || !state.cameraWorkflow?.ready} onClick={() => onAngle(item.job,item.index)}><Rotate3d size={14}/>不同角度拍攝</button>}{onCustom && <button className="button action-view gallery-custom" aria-label={`自訂拍攝 ${item.job.name}`} disabled={busy || locked || !connected || !state.workflow?.ready} onClick={()=>onCustom(item.job,item.index)}>自訂拍攝</button>}<a className="button action-export" aria-label={`下載成果 ${item.job.name} 第 ${item.index + 1} 張`} href={`/api/jobs/${item.job.id}/image/${item.index}?download=1`} download><Download size={14}/>下載原圖</a></div></div>
      </article>;
    })}</div> : <Empty icon={Images} title={query ? '沒有符合的成果' : '生成完成的照片會出現在這裡'} description={query ? '試試其他名稱或拍攝組。' : '先在拍攝清單送出生成，完成後即可放大查看、勾選重製或刪除。'}/>}
    {items.length > PAGE_SIZE && <div className="pagination"><button className="button secondary" disabled={pageOffset === 0} onClick={() => changePage(Math.max(0,pageOffset - PAGE_SIZE))}><ChevronLeft size={16}/>上一頁</button><span>{pageOffset + 1}–{Math.min(pageOffset + PAGE_SIZE,items.length)} / {items.length} 張</span><button className="button secondary" disabled={pageOffset + PAGE_SIZE >= items.length} onClick={() => changePage(pageOffset + PAGE_SIZE)}>下一頁<ChevronRight size={16}/></button></div>}
    {photoDrag.preview}
    {viewItem && <GalleryLightbox item={viewItem} position={viewPosition} total={items.length} navigation={{index:viewerPosition,total:viewerGroup.length,onMove:delta=>{const next=viewerGroup[viewerPosition+delta];if(next) setViewId(next.id);}}} onClose={() => setViewId('')} onMove={delta => setViewId(items[Math.max(0,Math.min(items.length - 1,viewPosition + delta))].id)} onInspect={onInspect} onAngle={onAngle} onCustom={onCustom} customReady={connected && state.workflow?.ready} angleReady={connected && state.cameraWorkflow?.ready} selected={pending.has(rootJobId(viewItem.job)) || selectedIds.includes(viewItem.job.id)} onSelect={() => setSelected(toggle(selected,viewItem.job.id))} selectable={selectable(viewItem.job)} remakeJob={latestRemakes.get(rootJobId(viewItem.job))} busy={busy} onDelete={()=>removeOne(viewItem)}/>}
  </div>;
}
