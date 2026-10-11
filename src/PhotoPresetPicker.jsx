import {useEffect,useId,useMemo,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Check,ChevronLeft,ChevronRight,X} from 'lucide-react';
import {PHOTO_PRESET_GROUPS,photoPresetGroupIds} from '../shared/photo-preset-groups.js';
import './photo-preset-picker.css';

const PAGE_SIZE=12;

export default function PhotoPresetPicker({category,label,presets,selectedId='',disabled=false,onSelect,onClose}) {
  const dialog=useRef(null),titleId=useId();
  const [selected,setSelected]=useState(selectedId),[group,setGroup]=useState('all'),[offset,setOffset]=useState(0);
  const groups=PHOTO_PRESET_GROUPS[category] || [];
  const entries=useMemo(()=>presets.filter(row=>row.category===category).map(row=>({row,groups:photoPresetGroupIds(row)})),[presets,category]);
  const availableGroups=groups.map(item=>({...item,count:entries.filter(entry=>entry.groups.includes(item.id)).length})).filter(item=>item.count);
  const currentGroup=group==='all'||availableGroups.some(item=>item.id===group)?group:'all';
  const filtered=useMemo(()=>entries.filter(entry=>currentGroup==='all'||entry.groups.includes(currentGroup)),[entries,currentGroup]);
  const pageOffset=Math.min(offset,Math.max(0,Math.floor((filtered.length-1)/PAGE_SIZE)*PAGE_SIZE));
  const rows=filtered.slice(pageOffset,pageOffset+PAGE_SIZE),chosen=entries.find(entry=>entry.row.id===selected)?.row;
  useEffect(()=>{
    const node=dialog.current,previous=document.activeElement;
    node.showModal();
    return ()=>{node.close();if(previous?.isConnected) previous.focus();};
  },[]);
  const chooseGroup=id=>{setGroup(id);setOffset(0);};
  return createPortal(<dialog ref={dialog} className="photo-preset-dialog" aria-labelledby={titleId} onCancel={event=>{event.preventDefault();onClose();}} onKeyDown={event=>{if(event.key==='Escape') event.stopPropagation();}} onMouseDown={event=>{
    if(event.target!==event.currentTarget) return;
    const box=event.currentTarget.getBoundingClientRect();
    if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom) onClose();
  }}>
    <header className="photo-preset-header"><div><h2 id={titleId}>選擇{label}</h2><p>{category==='pose'?'依姿勢、手勢或道具挑選一個動作，表情可另外設定。':'依地點類型挑選一個場景，搭配你選的動作。'}</p></div><button type="button" aria-label={`關閉${label}選擇`} onClick={onClose}><X size={20}/></button></header>
    <div className="photo-preset-controls">
      <div className="photo-preset-groups" role="group" aria-label={`${label}分類`}><button type="button" autoFocus aria-label="全部" aria-pressed={currentGroup==='all'} onClick={()=>chooseGroup('all')}>全部<span aria-hidden="true">{entries.length}</span></button>{availableGroups.map(item=><button key={item.id} type="button" aria-label={item.label} aria-pressed={currentGroup===item.id} onClick={()=>chooseGroup(item.id)}>{item.label}<span aria-hidden="true">{item.count}</span></button>)}</div>
    </div>
    <div className="photo-preset-body"><p className="photo-preset-result-count">{filtered.length?`${filtered.length} 個${label}可選`:'沒有符合的選項'}</p><div className="photo-preset-options" role="group" aria-label={`${label}選項`}>{rows.map(entry=><button key={entry.row.id} type="button" className="photo-preset-option" disabled={disabled} aria-label={entry.row.name} aria-pressed={selected===entry.row.id} onClick={()=>setSelected(entry.row.id)}><span className="photo-preset-radio">{selected===entry.row.id&&<Check size={12}/>}</span><span className="photo-preset-option-copy"><strong>{entry.row.name}</strong><small>{groups.filter(item=>item.id!=='other'&&entry.groups.includes(item.id)).slice(0,3).map(item=>item.label).join(' · ')||'自訂選項'}</small></span></button>)}</div>{!filtered.length&&<div className="photo-preset-empty"><p>{entries.length?'切換分類，再挑選喜歡的選項。':`目前沒有已開放的${label}，可返回使用自行輸入。`}</p></div>}</div>
    {filtered.length>PAGE_SIZE&&<nav className="photo-preset-pagination" aria-label={`${label}分頁`}><button type="button" aria-label={`${label}上一頁`} disabled={pageOffset===0} onClick={()=>setOffset(Math.max(0,pageOffset-PAGE_SIZE))}><ChevronLeft size={16}/></button><span>{Math.floor(pageOffset/PAGE_SIZE)+1} / {Math.ceil(filtered.length/PAGE_SIZE)}</span><button type="button" aria-label={`${label}下一頁`} disabled={pageOffset+PAGE_SIZE>=filtered.length} onClick={()=>setOffset(pageOffset+PAGE_SIZE)}><ChevronRight size={16}/></button></nav>}
    <footer className="photo-preset-footer"><p>{chosen?`已選：${chosen.name}`:'尚未選擇'}</p><div><button type="button" className="photo-preset-cancel" onClick={onClose}>取消</button><button type="button" className="photo-preset-use" disabled={disabled||!chosen} onClick={()=>onSelect(chosen.id)}><Check size={15}/>使用此{label}</button></div></footer>
  </dialog>,document.body);
}
