import {useEffect,useMemo,useState} from 'react';
import {ArrowDownToLine,ArrowUpRight,Check,CheckCheck,ChevronLeft,ChevronRight,Images,Maximize2,RefreshCw,X} from 'lucide-react';
import PhotoFolders,{usePhotoDrag} from './PhotoFolders.jsx';
import ImageViewer from './ImageViewer.jsx';
import './featured-gallery.css';

const PAGE_SIZE=24;
const versionLabel=entry=>entry.version ? `版本 ${entry.version+1}` : '原圖';

export default function FeaturedGallery({entries=[],folders=[],busy,error,onCreateFolder,onRenameFolder,onDeleteFolder,onMove,onRemove,onInspect,onRefresh}) {
  const [folderId,setFolderId]=useState('all'),[selected,setSelected]=useState([]),[page,setPage]=useState(0),[viewerId,setViewerId]=useState('');
  const filtered=useMemo(()=>entries.filter(row=>folderId==='all' || (row.folderId || '')===folderId),[entries,folderId]);
  const pages=Math.max(1,Math.ceil(filtered.length/PAGE_SIZE)),currentPage=Math.min(page,pages-1),visible=filtered.slice(currentPage*PAGE_SIZE,(currentPage+1)*PAGE_SIZE);
  const viewer=entries.find(row=>row.id===viewerId),viewerIndex=filtered.findIndex(row=>row.id===viewerId);
  const move=async(ids,destination)=>{const result=await onMove(ids,destination);if(result) setSelected([]);return result;};
  const drag=usePhotoDrag(move,Boolean(busy),'featured');
  useEffect(()=>{setSelected([]);setPage(0);},[folderId]);
  useEffect(()=>{setSelected(current=>current.filter(id=>entries.some(row=>row.id===id)));},[entries]);
  useEffect(()=>{if(folderId!=='all' && folderId && !folders.some(row=>row.id===folderId)) setFolderId('all');},[folders,folderId]);
  const toggle=id=>setSelected(current=>current.includes(id) ? current.filter(value=>value!==id) : [...current,id]);
  const allSelected=filtered.length>0 && filtered.every(row=>selected.includes(row.id));
  return <section className="pc-featured-gallery" id="gallery" aria-labelledby="pc-featured-title">
    <div className="pc-section-heading"><div><span className="pc-gallery-eyebrow">YOUR SELECTS</span><h2 id="pc-featured-title">精選畫廊 <small>{entries.length}</small></h2><p>把喜歡的版本收進來，整理成只屬於你的精選輯。</p></div><button className="pc-gallery-refresh" disabled={busy} onClick={onRefresh}><RefreshCw size={14}/>更新畫廊</button></div>
    {error && <p className="pc-error" role="alert">{error}</p>}
    <PhotoFolders folders={folders} photos={entries} value={folderId} onChange={setFolderId} onCreate={onCreateFolder} onRename={onRenameFolder} onDelete={onDeleteFolder} onMove={move} selectedIds={selected} onClearSelection={()=>setSelected([])} selectionActions={<button disabled={busy} onClick={async()=>{if(await onRemove(selected)) setSelected([]);}}><X size={14}/>移出畫廊</button>} busy={busy} dragScope="featured"/>
    <div className="pc-featured-toolbar" role="group" aria-label="精選照片選取"><span>{filtered.length} 張精選</span><button aria-label={allSelected ? '取消全選精選照片' : '全選精選照片'} aria-pressed={allSelected} disabled={busy || !filtered.length} onClick={()=>setSelected(allSelected ? [] : filtered.map(row=>row.id))}><CheckCheck size={14}/>{allSelected ? '取消全選' : '全選'}</button></div>
    {visible.length ? <div className="pc-featured-grid">{visible.map(entry=><article key={entry.id} className={`pc-featured-card ${selected.includes(entry.id) ? 'selected' : ''}`}>
      <button className="pc-featured-image" aria-label={`放大精選 ${entry.garment || '寫真'} ${versionLabel(entry)}`} {...drag.cardProps(selected.includes(entry.id) ? selected : [entry.id])} onClick={()=>setViewerId(entry.id)}><img src={entry.image} alt={`${entry.garment} · ${entry.pose} · ${versionLabel(entry)}`} draggable={false} loading="lazy"/><span className="pc-featured-version">{versionLabel(entry)}</span><span className="pc-featured-expand"><Maximize2 size={16}/></span></button>
      <label className="pc-featured-check"><input type="checkbox" aria-label={`勾選精選 ${entry.garment || '寫真'} ${versionLabel(entry)}`} checked={selected.includes(entry.id)} disabled={busy} onChange={()=>toggle(entry.id)}/><Check size={14}/></label>
      <div className="pc-featured-caption"><strong>{entry.garment || '你的寫真'}</strong><small>{entry.pose || '你的鏡頭'}</small><div><button disabled={busy} onClick={()=>onInspect(entry)}>查看照片<ArrowUpRight size={13}/></button><a href={`${entry.image}?download=1`} download aria-label={`下載精選 ${entry.garment || '寫真'} ${versionLabel(entry)}`}><ArrowDownToLine size={14}/></a><button disabled={busy} onClick={()=>onRemove([entry.id])} aria-label={`移出畫廊 ${entry.garment || '寫真'} ${versionLabel(entry)}`} title="移出畫廊，保留原照片"><X size={14}/></button></div></div>
    </article>)}</div> : <div className="pc-featured-empty"><Images size={32} strokeWidth={1.25}/><h3>{entries.length ? '這裡還沒有符合的精選。' : '留下你最喜歡的那一張。'}</h3><p>{entries.length ? '換個分類，看看其他精選。' : '打開「我的照片」，選好版本，再按「放入畫廊」。'}</p>{!entries.length && <a href="#photos">挑選我的照片<ArrowUpRight size={15}/></a>}</div>}
    {pages>1 && <div className="pc-featured-pagination"><button aria-label="上一頁精選" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}><ChevronLeft size={17}/></button><span>{currentPage+1} / {pages}</span><button aria-label="下一頁精選" disabled={currentPage+1>=pages} onClick={()=>setPage(currentPage+1)}><ChevronRight size={17}/></button></div>}
    <p className="pc-featured-note">移出畫廊會保留原照片。照片移到回收區時，精選會暫時隱藏，還原後會回來。</p>
    {drag.preview}{viewer && <ImageViewer src={viewer.image} alt={`精選 · ${viewer.garment} · ${versionLabel(viewer)}`} onClose={()=>setViewerId('')} navigation={viewerIndex>=0 ? {index:viewerIndex,total:filtered.length,onMove:delta=>{const next=filtered[viewerIndex+delta];if(next) setViewerId(next.id);}} : undefined}/>}
  </section>;
}
