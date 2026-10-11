import {useEffect,useRef,useState} from 'react';
import {Folder,FolderOpen,FolderPlus,FolderInput,Pencil,Trash2,X} from 'lucide-react';
import './photo-folders.css';

export function usePhotoDrag(onMove,disabled=false,scope='') {
  const gesture=useRef(null),options=useRef({onMove,disabled,scope}),suppressClick=useRef(false),highlight=useRef(null);
  const [preview,setPreview]=useState(null);
  options.current={onMove,disabled,scope};
  useEffect(()=>{
    const targetAt=event=>{
      const target=document.elementFromPoint(event.clientX,event.clientY)?.closest('[data-photo-folder-id]:not(:disabled)');
      return options.current.scope && target?.closest('[data-photo-folder-scope]')?.getAttribute('data-photo-folder-scope')!==options.current.scope ? null : target;
    };
    const clear=()=>{
      const current=gesture.current;gesture.current=null;highlight.current?.classList.remove('drop-target');highlight.current=null;
      if(current?.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
      document.body.classList.remove('photocreate-dragging');setPreview(null);
    };
    const move=event=>{
      const current=gesture.current;
      if(!current || event.pointerId!==current.pointerId) return;
      if(!current.dragging && Math.hypot(event.clientX-current.x,event.clientY-current.y)<8) return;
      if(!current.dragging) {current.dragging=true;current.element.setPointerCapture(event.pointerId);}
      event.preventDefault();document.body.classList.add('photocreate-dragging');
      const target=targetAt(event);if(target!==highlight.current) {highlight.current?.classList.remove('drop-target');target?.classList.add('drop-target');highlight.current=target;}
      setPreview({x:event.clientX,y:event.clientY,count:current.ids.length});
    };
    const finish=event=>{
      const current=gesture.current;if(!current || event.pointerId!==current.pointerId) return;
      const folderId=current.dragging ? targetAt(event)?.getAttribute('data-photo-folder-id') : null;
      suppressClick.current=current.dragging;clear();
      if(current.dragging) setTimeout(()=>{suppressClick.current=false;},0);
      if(folderId!=null && !options.current.disabled) options.current.onMove?.(current.ids,folderId);
    };
    document.addEventListener('pointermove',move,{passive:false});document.addEventListener('pointerup',finish);document.addEventListener('pointercancel',clear);window.addEventListener('blur',clear);
    return ()=>{document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',finish);document.removeEventListener('pointercancel',clear);window.removeEventListener('blur',clear);clear();};
  },[]);
  return {
    cardProps:ids=>({draggable:false,onDragStart:event=>event.preventDefault(),onPointerDown:event=>{
      suppressClick.current=false;
      if(event.button!==0 || event.pointerType==='touch' || options.current.disabled || !options.current.onMove || !ids.length || event.target.closest('input,label,a,select,textarea,.gallery-card-actions')) return;
      gesture.current={ids:[...new Set(ids)],x:event.clientX,y:event.clientY,pointerId:event.pointerId,element:event.currentTarget,dragging:false};
    },onClickCapture:event=>{if(suppressClick.current) {event.preventDefault();event.stopPropagation();suppressClick.current=false;}}}),
    preview:preview && <div className="photo-drag-preview" aria-hidden="true" style={{left:preview.x+14,top:preview.y+14}}><FolderInput size={17}/>{preview.count} 張照片</div>,
  };
}

function FolderNameForm({initialName='',busy,onSave,onClose}) {
  const [name,setName]=useState(initialName),[error,setError]=useState('');
  const submit=async event=>{
    event.preventDefault();setError('');
    try {if(await onSave(name)) onClose();} catch(cause) {setError(cause.message);}
  };
  return <form className="photo-folder-form" onSubmit={submit}><input autoFocus aria-label="資料夾名稱" maxLength={60} placeholder="例如：旅行寫真" value={name} onChange={event=>setName(event.target.value)}/><button type="submit" disabled={busy || !name.trim()}>儲存資料夾</button><button type="button" disabled={busy} onClick={onClose} aria-label="取消資料夾編輯"><X size={16}/></button>{error && <p role="alert">{error}</p>}</form>;
}

export function FolderDestination({folders=[],value='',onChange,onCreate,busy}) {
  const [creating,setCreating]=useState(false);
  const valid=folders.some(folder=>folder.id===value) ? value : '';
  return <div className="photo-folder-destination"><div><label>照片存放位置<select aria-label="產圖資料夾" disabled={busy} value={valid} onChange={event=>onChange(event.target.value)}><option value="">未分類</option>{folders.map(folder=><option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>{onCreate && <button disabled={busy} aria-label="新增產圖資料夾" onClick={()=>setCreating(!creating)}><FolderPlus size={16}/>新增</button>}</div>{creating && <FolderNameForm busy={busy} onClose={()=>setCreating(false)} onSave={async name=>{const folder=await onCreate(name);if(folder?.id) onChange(folder.id);return folder;}}/>}</div>;
}

export default function PhotoFolders({folders=[],photos=[],value='all',onChange,onCreate,onRename,onDelete,deleteWithPhotos=false,collapsible=false,onMove,selectedIds=[],onClearSelection,selectionActions,busy=false,dragScope=''}) {
  const [editing,setEditing]=useState(null),[confirmDelete,setConfirmDelete]=useState(false),[destination,setDestination]=useState('choose');
  const section=useRef(null),[stickyTop,setStickyTop]=useState(0);
  useEffect(()=>{
    const header=section.current.closest('.pc-studio')?.querySelector('.pc-header');
    if(!header) return;
    const observer=new ResizeObserver(()=>setStickyTop(header.getBoundingClientRect().height));
    setStickyTop(header.getBoundingClientRect().height);observer.observe(header);
    return ()=>observer.disconnect();
  },[]);
  const selectedFolder=folders.find(folder=>folder.id===value);
  const count=id=>photos.filter(photo=>(photo.folderId || '')===id).length;
  const change=id=>{setEditing(null);setConfirmDelete(false);onChange(id);};
  const folderButton=(id,name,total,Icon)=> <button key={id} className={`photo-folder-tab ${value===id ? 'selected' : ''}`} data-photo-folder-id={id==='all' ? undefined : id} aria-label={`資料夾 ${name}`} aria-pressed={value===id} disabled={busy} onClick={()=>change(id)}><Icon size={15}/><span>{name}</span><small>{total}</small></button>;
  return <section ref={section} className="photo-folders" data-photo-folder-scope={dragScope} style={{'--photo-folder-top':`${stickyTop}px`}} aria-label="照片資料夾"><div className="photo-folder-tabs">
    {folderButton('all','全部照片',photos.length,value==='all' ? FolderOpen : Folder)}{folderButton('','未分類',count(''),Folder)}{folders.map(folder=>folderButton(folder.id,folder.name,count(folder.id),Folder))}
    {onCreate && <button className="photo-folder-new" disabled={busy} onClick={()=>{setEditing(editing===true ? null : true);setConfirmDelete(false);}}><FolderPlus size={15}/>新增資料夾</button>}
    {collapsible && value!==null && <button className="photo-folder-new" disabled={busy} aria-label="收起照片" onClick={()=>change(null)}><X size={15}/>收起照片</button>}
  </div>{editing!==null && <FolderNameForm key={editing?.id || 'new'} initialName={editing?.name || ''} busy={busy} onClose={()=>setEditing(null)} onSave={async name=>{const folder=editing===true ? await onCreate(name) : await onRename(editing.id,name);if(folder?.id) onChange(folder.id);return folder;}}/>}
    {(!collapsible || value!==null) && <div className="photo-folder-actions"><span>{onMove ? '拖曳照片到資料夾，或勾選後批次移動。' : '勾選照片後，可批次永久刪除。'}</span>{selectedFolder && onRename && <button disabled={busy} onClick={()=>{setEditing(selectedFolder);setConfirmDelete(false);}}><Pencil size={12}/>重新命名</button>}{selectedFolder && onDelete && <button className="photo-folder-delete" disabled={busy} onClick={async()=>{if(deleteWithPhotos) {await onDelete(selectedFolder.id);return;}if(!confirmDelete) {setConfirmDelete(true);return;}if(await onDelete(selectedFolder.id)) {setConfirmDelete(false);onChange(collapsible ? null : 'all');}}}><Trash2 size={12}/>{confirmDelete ? '確認刪除資料夾（照片保留）' : '刪除資料夾'}</button>}{confirmDelete && <button disabled={busy} onClick={()=>setConfirmDelete(false)}>取消</button>}</div>}
    {selectedIds.length>0 && (onMove || selectionActions) && <div className="photo-folder-move"><strong>已選 {selectedIds.length} 張</strong>{onMove && <><select aria-label="移動所選照片至" disabled={busy} value={destination} onChange={event=>setDestination(event.target.value)}><option value="choose" disabled>選擇目的地</option><option value="">未分類</option>{folders.map(folder=><option key={folder.id} value={folder.id}>{folder.name}</option>)}</select><button disabled={busy || destination==='choose'} onClick={async()=>{if(await onMove(selectedIds,destination)) {onClearSelection?.();setDestination('choose');}}}><FolderInput size={14}/>移動照片</button></>}{selectionActions}<button disabled={busy} onClick={onClearSelection}>取消勾選</button></div>}
  </section>;
}
