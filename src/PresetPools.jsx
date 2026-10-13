import { cameraPreset, cameraAngleLabel } from '../shared/camera.js';
import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Plus, X } from 'lucide-react';
import { CATEGORIES } from '../shared/domain.js';
import { SearchBox } from './ui.jsx';
import PresetReview from './PresetReview.jsx';

const PAGE_SIZE = 8;
const REVIEW_FILTERS=[{id:'all',label:'全部'},{id:'reviewed',label:'已確認'},{id:'unreviewed',label:'未確認'}];

export function PresetPoolField({category,selected,optional = false,onOpen,onClear,onAdd,allCount,busy}) {
  const {label,plural} = CATEGORIES[category];
  const all = allCount !== undefined;
  const summary = all ? `全庫 ${allCount} 項候選` : selected.length
    ? `已選：${selected.slice(0,2).map(row => row.name).join('、')}${selected.length > 2 ? `，另 ${selected.length - 2} 項` : ''}`
    : category==='gaze' ? '未指定：自然配合動作' : optional ? '已選：無' : '尚未選擇';
  return <div role="group" aria-label={plural} className="preset-pool-field">
    <div className="pool-field-heading"><span>{label}<small>{optional ? '可複選 · 選填' : '可複選'}</small></span></div>
    <button className="pool-summary" aria-label={`選擇${label}提詞`} aria-haspopup="dialog" title={summary} onClick={onOpen}><span className="pool-open-copy"><strong>{all ? '瀏覽並限定候選' : selected.length ? '修改提詞選擇' : '選擇提詞'}</strong><small>{summary}</small></span><span className="pool-count">{all ? allCount : selected.length}</span><ChevronRight size={18} aria-hidden="true"/></button>
    <div className="pool-field-actions">{optional && selected.length > 0 && !all && <button aria-label={`清除${label}提詞`} onClick={onClear}><X size={12}/>清除</button>}<button disabled={busy} onClick={onAdd}><Plus size={12}/>{category === 'camera' ? '新增角度' : '新增提詞'}</button></div>
  </div>;
}

export default function PresetPoolPicker({category,presets,selectedIds,onApply,onClose,onAdd,api,busy,multi = true,optional = false,randomAll = false}) {
  const {label} = CATEGORIES[category];
  const [values,setValues] = useState(selectedIds);
  const [query,setQuery] = useState('');
  const [reviewFilter,setReviewFilter] = useState('all');
  const [offset,setOffset] = useState(0);
  const [remoteResult,setRemoteResult] = useState({rows:[],total:0});
  const [remoteLoading,setRemoteLoading] = useState(true);
  const [error,setError] = useState('');
  const [selectingAll,setSelectingAll] = useState(false);
  const categoryPresets=useMemo(()=>presets.filter(row=>row.category===category),[presets,category]);
  const reviewedCount=categoryPresets.filter(row=>row.reviewed===true).length;
  const reviewCounts={all:categoryPresets.length,reviewed:reviewedCount,unreviewed:categoryPresets.length-reviewedCount};
  // The state already contains the full library, so review filters work with
  // existing servers and include matches beyond the current search page.
  const filteredRows=useMemo(()=>{
    if(reviewFilter==='all') return [];
    const terms=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return categoryPresets.filter(row=>{
      if((row.reviewed===true)!==(reviewFilter==='reviewed')) return false;
      const text=[row.name,row.prompt,...(row.tags || [])].join(' ').toLocaleLowerCase();
      return terms.every(term=>text.includes(term));
    });
  },[categoryPresets,reviewFilter,query]);
  const pageOffset=reviewFilter==='all'?offset:Math.min(offset,Math.max(0,Math.floor((filteredRows.length-1)/PAGE_SIZE)*PAGE_SIZE));
  const result=reviewFilter==='all'?remoteResult:{rows:filteredRows.slice(pageOffset,pageOffset+PAGE_SIZE),total:filteredRows.length};
  const loading=reviewFilter==='all'&&remoteLoading;
  const validIds = new Set(categoryPresets.map(row => row.id));
  const validValues = values.filter(id => validIds.has(id));
  useEffect(() => {
    if(reviewFilter!=='all') return;
    let current = true;
    setRemoteLoading(true);
    const timer = setTimeout(async () => {
      try {
        const data = await api(`/presets/search?${new URLSearchParams({q:query,category,offset,limit:PAGE_SIZE})}`);
        if(current) {setRemoteResult(data);setError('');if(offset >= data.total && offset > 0) setOffset(Math.max(0,Math.floor((data.total - 1) / PAGE_SIZE) * PAGE_SIZE));}
      } catch(error) {if(current) setError(error.message);}
      finally {if(current) setRemoteLoading(false);}
    },150);
    return () => {current = false;clearTimeout(timer);};
  },[query,offset,presets,api,category,reviewFilter]);
  const toggle = id => setValues(current => current.includes(id) ? current.filter(value => value !== id) : multi ? [...current,id] : [id]);
  const allOnPage = result.rows.length > 0 && result.rows.every(row => values.includes(row.id));
  const selectAll=async()=>{
    setSelectingAll(true);setError('');
    try {
      if(reviewFilter!=='all') {
        if(filteredRows.length>10000) throw new Error('每類最多選擇 10,000 項，請縮小搜尋範圍。');
        setValues(current=>[...new Set([...current,...filteredRows.map(row=>row.id)])]);
        return;
      }
      const ids=[];
      for(let start=0;start<10000;) {
        const data=await api(`/presets/search?${new URLSearchParams({q:query,category,offset:start,limit:100})}`);
        if(data.total>10000) throw new Error('每類最多選擇 10,000 項，請縮小搜尋範圍。');
        ids.push(...data.rows.map(row=>row.id));start+=data.rows.length;
        if(start>=data.total || !data.rows.length) break;
      }
      setValues(current=>[...new Set([...current,...ids])]);
    } catch(cause) {setError(cause.message);} finally {setSelectingAll(false);}
  };
  return <>
    <div className="modal-body pool-picker-body">
      <p className="field-help">{category==='video' ? '勾選要開放給顧客的影片提詞。選擇會跨確認分類、搜尋與分頁保留；回首頁套用至顧客攝影棚後生效。' : multi ? '可複選候選；每張照片只會使用此類的一項提詞。選擇會跨確認分類、搜尋與分頁保留。' : '選擇一項提詞，或保持「無」。'}</p>
      {optional && <p className="field-help">{category==='video' ? '清空已選可關閉官方影片提詞，顧客仍可自行輸入。' : category==='gaze' ? '可固定一種視線，或複選讓每張照片隨機搭配；清空後視線自然配合動作與場景。' : '選了就加入搭配；清空已選後不使用這類提詞。'}</p>}
      {randomAll && <p className="field-help">目前隨機使用全部提詞庫；保存所選後會切換為「僅已選候選」，各類使用首頁保存的候選。</p>}
      <SearchBox disabled={selectingAll} value={query} onChange={value => {setQuery(value);setOffset(0);}} placeholder={`搜尋${label}名稱、標籤、提詞…`}/>
      <div className="filter-tabs pool-review-filters" role="group" aria-label="提詞確認分類">{REVIEW_FILTERS.map(item=><button key={item.id} type="button" aria-label={item.label} aria-pressed={reviewFilter===item.id} className={reviewFilter===item.id?'active':''} disabled={selectingAll} onClick={()=>{setReviewFilter(item.id);setOffset(0);setError('');}}>{item.label}<span aria-hidden="true">{reviewCounts[item.id]}</span></button>)}</div>
      <div className="pool-picker-toolbar"><span>已選 {validValues.length} 項 · {reviewFilter==='all'?'共':'符合'} {result.total} 項</span>{multi && <><button disabled={loading || selectingAll || !result.total} onClick={selectAll}><Check size={13}/>{selectingAll ? '選取中…' : query.trim() ? '全選搜尋結果' : reviewFilter==='reviewed'?'全選已確認':reviewFilter==='unreviewed'?'全選未確認':'全選'}</button><button disabled={loading || selectingAll || !result.rows.length} onClick={() => setValues(current => allOnPage ? current.filter(id => !result.rows.some(row => row.id === id)) : [...new Set([...current,...result.rows.map(row => row.id)])])}>{allOnPage ? '取消本頁' : '選取本頁'}</button></>}<button disabled={selectingAll} onClick={() => setValues([])}>{multi ? '清空已選' : '無'}</button><button disabled={busy || selectingAll} onClick={onAdd}><Plus size={13}/>{category === 'camera' ? '新增角度' : '新增提詞'}</button></div>
      <div className="pool-picker-results" aria-busy={loading}>{error ? <p className="inline-error">{error}</p> : <div className="pool-option-grid">{result.rows.map(row => <button key={row.id} aria-label={row.name} className={`pool-option ${values.includes(row.id) ? 'selected' : ''}`} aria-pressed={values.includes(row.id)} onClick={() => toggle(row.id)}><span className="check-square">{values.includes(row.id) && <Check size={11}/>}</span><span className="pool-option-copy"><strong className="pool-option-title"><span>{row.name}</span><PresetReview reviewed={row.reviewed}/></strong><small>{category === 'camera' ? cameraAngleLabel(cameraPreset(row).angle) : row.prompt}</small></span></button>)}</div>}{!loading && !error && !result.rows.length && <p className="muted">沒有符合的提詞，可以新增或換個搜尋詞。</p>}</div>
      {result.total > PAGE_SIZE && <div className="optional-pagination"><button aria-label={`${label}上一頁`} disabled={loading || pageOffset === 0} onClick={() => setOffset(Math.max(0,pageOffset - PAGE_SIZE))}><ChevronLeft size={14}/></button><span>{Math.floor(pageOffset / PAGE_SIZE) + 1} / {Math.ceil(result.total / PAGE_SIZE)}</span><button aria-label={`${label}下一頁`} disabled={loading || pageOffset + PAGE_SIZE >= result.total} onClick={() => setOffset(pageOffset + PAGE_SIZE)}><ChevronRight size={14}/></button></div>}
    </div>
    <div className="modal-footer"><button className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={selectingAll} onClick={() => onApply(validValues)}><Check size={16}/>使用所選提詞{validValues.length ? ` (${validValues.length})` : ''}</button></div>
  </>;
}
