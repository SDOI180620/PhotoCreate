import {useEffect,useMemo,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {ArrowRight,Check,FileText,ImagePlus,Plus,Settings2,Shirt,Trash2,Upload,X} from 'lucide-react';
import {GARMENT_SOURCES_VERSION,isPromptGarment} from '../shared/garments.js';
import {imagePreview} from './image-preview.js';
import {randomId} from './ids.js';
import {Empty,SearchBox} from './ui.jsx';
import PresetPhotos from './PresetPhotos.jsx';
import './garments.css';

const sourceLabel=garment=>isPromptGarment(garment) ? '提詞版' : '圖片版';
const matchesType=(row,type)=>type==='all' || (isPromptGarment(row) ? 'prompt' : 'image')===type;

export function GarmentVisual({garment,className='',small=false}) {
  if(!isPromptGarment(garment) && garment?.image) return <img className={className} decoding="async" loading="lazy" src={imagePreview(garment.image,small ? 'small' : 'card')} alt={garment.name}/>;
  return <div className={`garment-prompt-visual ${small ? 'compact' : ''} ${className}`} aria-label={`${garment?.name || '服裝'} · 提詞版`}><Shirt size={small ? 24 : 44} strokeWidth={1.1}/>{!small && <><span><FileText size={13}/>提詞版</span><small>以文字描述服裝</small></>}</div>;
}

function GarmentDialog({title,description,children,onClose,className='',busy=false}) {
  const ref=useRef(null),close=useRef(onClose);
  close.current=onClose;
  useEffect(()=>{
    const dialog=ref.current,previous=document.activeElement,overflow=document.body.style.overflow;
    document.body.style.overflow='hidden';dialog.showModal();
    return ()=>{dialog.close();document.body.style.overflow=overflow;previous?.focus();};
  },[]);
  return createPortal(<dialog ref={ref} className={`garment-dialog ${className}`} aria-label={title} onCancel={event=>{event.preventDefault();event.stopPropagation();if(!busy) close.current();}} onMouseDown={event=>{if(event.target!==event.currentTarget || busy) return;const rect=ref.current.getBoundingClientRect();if(event.clientX<rect.left || event.clientX>rect.right || event.clientY<rect.top || event.clientY>rect.bottom) onClose();}}>
    <header className="garment-dialog-header"><div><h2>{title}</h2><p>{description}</p></div><button type="button" className="icon-button" aria-label="關閉服裝視窗" disabled={busy} onClick={onClose}><X size={20}/></button></header>
    {children}
  </dialog>,document.body);
}

function SourceFilters({value,onChange,rows,disabled=false}) {
  const counts={all:rows.length,image:rows.filter(row=>!isPromptGarment(row)).length,prompt:rows.filter(isPromptGarment).length};
  return <div className="garment-source-filters" role="group" aria-label="服裝版本篩選">{[['all','全部服裝'],['image','圖片版'],['prompt','提詞版']].map(([id,label])=><button key={id} type="button" disabled={disabled} aria-pressed={value===id} onClick={()=>onChange(id)}>{id==='image' ? <ImagePlus size={14}/> : id==='prompt' ? <FileText size={14}/> : <Shirt size={14}/>}<span>{label}</span><small>{counts[id]}</small></button>)}</div>;
}

export function GarmentLibrary({rows,onUpload,onEdit,onCreate,busy,supported}) {
  const [query,setQuery]=useState(''),[type,setType]=useState('all'),[tag,setTag]=useState(''),[dragging,setDragging]=useState(false);
  const input=useRef(null),tags=[...new Set(rows.flatMap(row=>row.tags || []))];
  const filtered=rows.filter(row=>matchesType(row,type) && (!tag || row.tags?.includes(tag)) && `${row.name} ${row.prompt || ''} ${row.description || ''} ${(row.tags || []).join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  const upload=files=>onUpload('garments',files);
  return <div className={`garment-library ${dragging ? 'dragging' : ''}`} onDragOver={event=>{event.preventDefault();setDragging(true);}} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget)) setDragging(false);}} onDrop={event=>{event.preventDefault();setDragging(false);if(!busy) upload(event.dataTransfer.files);}}>
    <div className="toolbar"><SearchBox value={query} onChange={setQuery} placeholder="搜尋服裝名稱、提詞或標籤…"/><span className="item-count">{rows.length} 套服裝</span><button className="button secondary" disabled={busy} onClick={()=>input.current.click()}><Upload size={16}/>匯入服裝圖片</button><button className="button primary" disabled={busy || !supported} onClick={onCreate}><Plus size={16}/>新增提詞服裝</button><input ref={input} hidden type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={event=>{upload(event.target.files);event.target.value='';}}/></div>
    {!supported && <p className="field-help">重新啟動 PhotoCreate 後，即可新增服裝提詞與試拍。</p>}
    <SourceFilters value={type} onChange={setType} rows={rows}/>
    {tags.length>0 && <div className="filter-tabs garment-tags"><button className={!tag ? 'active' : ''} onClick={()=>setTag('')}>全部標籤</button>{tags.map(value=><button key={value} className={tag===value ? 'active' : ''} onClick={()=>setTag(value)}>{value}</button>)}</div>}
    {filtered.length ? <div className="asset-grid garment-grid">{filtered.map(row=><article key={row.id} className="asset-card garment-card"><button className="asset-photo" aria-label={`編輯服裝 ${row.name}`} onClick={()=>onEdit(row)}><GarmentVisual garment={row}/><span className="garment-source-badge">{sourceLabel(row)}</span><span className="edit-photo"><Settings2 size={15}/>編輯與試拍</span></button><div className="asset-details"><button className="asset-title" onClick={()=>onEdit(row)}>{row.name}<Settings2 size={15}/></button><p>{isPromptGarment(row) ? row.prompt : row.description || '使用參考圖的款式、材質與配色。'}</p>{row.tags?.length>0 && <div className="tags">{row.tags.map(tag=><span key={tag}>{tag}</span>)}</div>}</div></article>)}</div> : <Empty icon={Shirt} title={rows.length ? '沒有符合的服裝' : '建立你的服裝收藏'} description={rows.length ? '換個版本、名稱或標籤再試試。' : '匯入參考圖，或寫下服裝提詞，再直接試拍看看。'}><button className="button primary" disabled={busy || !supported} onClick={onCreate}><FileText size={16}/>新增提詞服裝</button></Empty>}
  </div>;
}

export function GarmentPicker({rows,selectedIds=[],multiple=true,onSelect,onClose,onUpload,busy=false}) {
  const [values,setValues]=useState(()=>[...selectedIds]),[type,setType]=useState('all');
  const input=useRef(null),filtered=useMemo(()=>rows.filter(row=>matchesType(row,type)),[rows,type]);
  const valid=values.filter(id=>rows.some(row=>row.id===id));
  const toggle=id=>setValues(current=>multiple ? current.includes(id) ? current.filter(value=>value!==id) : [...current,id] : [id]);
  return <GarmentDialog title="選擇服裝" description={multiple ? '搭配圖片版與提詞版服裝，可一次選擇多套。' : '選擇一套官方服裝，搭配原本的角色重新拍攝。'} onClose={onClose} className="garment-picker">
    <div className="garment-picker-body"><SourceFilters value={type} onChange={setType} rows={rows} disabled={busy}/><div className="garment-picker-tools"><span>{filtered.length} 套服裝</span>{multiple && <><button type="button" disabled={busy || !filtered.length} onClick={()=>setValues(current=>[...new Set([...current,...filtered.map(row=>row.id)])])}><Check size={13}/>全選{type!=='all' ? '此版本' : ''}</button><button type="button" disabled={busy || !values.length} onClick={()=>setValues([])}>清空已選</button></>}{onUpload && <button type="button" disabled={busy} onClick={()=>input.current.click()}><Upload size={13}/>匯入圖片</button>}</div>
      {onUpload && <input ref={input} hidden type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={async event=>{const files=Array.from(event.target.files);event.target.value='';if(await onUpload('garments',files)) onClose();}}/>}
      {filtered.length ? <div className="garment-picker-grid">{filtered.map(row=><button key={row.id} type="button" className="garment-picker-option" disabled={busy} aria-label={`選擇服裝 ${row.name}`} aria-pressed={values.includes(row.id)} onClick={()=>toggle(row.id)}><div className="garment-picker-photo"><GarmentVisual garment={row}/><span className="garment-selection-mark">{values.includes(row.id) && <Check size={14}/>}</span></div><span className="garment-picker-caption"><strong>{row.name}</strong><small>{sourceLabel(row)}</small></span></button>)}</div> : <Empty icon={Shirt} title="目前沒有這個版本的服裝" description="可選擇其他版本。"/>}
    </div><footer className="garment-dialog-footer"><p>{multiple ? `已選 ${valid.length} 套服裝` : rows.find(row=>row.id===valid[0])?.name || '請選擇一套服裝'}</p><button type="button" className="button primary" disabled={busy || !multiple && !valid.length} onClick={()=>{onSelect(valid);onClose();}}>使用所選服裝<ArrowRight size={16}/></button></footer>
  </GarmentDialog>;
}

export function GarmentEditor({asset,onClose,onSave,onDelete,busy,features,aspectRatio,request}) {
  const [form,setForm]=useState(()=>({...asset,id:asset?.id || randomId(),name:asset?.name || '',sourceType:asset?.sourceType || (asset ? 'image' : 'prompt'),prompt:asset?.prompt || '',description:asset?.description || '',tags:(asset?.tags || []).join(', ')}));
  const [remove,setRemove]=useState(false),promptMode=isPromptGarment(form),supported=features?.garmentSources===GARMENT_SOURCES_VERSION;
  const value={...form,tags:form.tags.split(/[,，]/).map(tag=>tag.trim()).filter(Boolean)};
  const valid=Boolean(form.name.trim() && (promptMode ? form.prompt.trim() : form.fileName));
  return <GarmentDialog title={asset ? '編輯服裝' : '新增提詞服裝'} description="編輯服裝內容，直接試拍，找到適合的搭配。" onClose={onClose} className="garment-editor" busy={busy}>
    <form onSubmit={event=>{event.preventDefault();if(valid) onSave(value);}}><div className="garment-editor-body"><div className="garment-editor-fields">
      <label>服裝名稱<input autoFocus required maxLength={200} disabled={busy} value={form.name} onChange={event=>setForm({...form,name:event.target.value})} placeholder="例如：奶油白針織套裝"/></label>
      <fieldset className="garment-source-choice"><legend>生成方式</legend><div role="group" aria-label="服裝生成版本">{[['image','圖片版','依照參考圖換裝',ImagePlus],['prompt','提詞版','依照文字描述換裝',FileText]].map(([id,label,help,Icon])=><button key={id} type="button" aria-pressed={form.sourceType===id} disabled={busy || id==='image' && !form.fileName || id==='prompt' && !supported} onClick={()=>setForm({...form,sourceType:id})}><Icon size={19}/><span><strong>{label}</strong><small>{help}</small></span>{form.sourceType===id && <Check size={15}/>}</button>)}</div>{!form.fileName && <p className="field-help">圖片版服裝可從圖庫匯入參考圖。</p>}</fieldset>
      {promptMode ? <label>服裝提詞<textarea required aria-label="服裝提詞" rows={8} maxLength={20000} disabled={busy} value={form.prompt} onChange={event=>setForm({...form,prompt:event.target.value})} placeholder="描述服裝款式、材質、顏色與配件。\n例如：奶油白短袖針織上衣、同色高腰長裙，細緻羅紋布料與簡約銀色腰扣。"/><span className="field-help">支援中文與英文。拍攝時會將這段描述用於換裝。</span></label> : <figure className="garment-reference-preview"><GarmentVisual garment={form}/><figcaption>服裝參考圖 · 保留款式、材質與配色</figcaption></figure>}
      <label>{promptMode ? '管理備註' : '圖片備註'}<textarea rows={2} maxLength={20000} disabled={busy} value={form.description} onChange={event=>setForm({...form,description:event.target.value})} placeholder="記錄這套服裝的用途或搭配建議…"/><span className="field-help">備註供圖庫管理使用。</span></label>
      <label>標籤<input disabled={busy} value={form.tags} onChange={event=>setForm({...form,tags:event.target.value})} placeholder="例如：白色, 針織, 日常（用逗號分隔）"/></label>
      {remove && <p className="inline-error" role="alert">確定將「{asset.name}」移出圖庫？已建立的拍攝仍會保留原本的服裝設定。</p>}
    </div><PresetPhotos kind="garment" garmentId={asset?.id} value={value} supported={supported && features?.presetPreviews===1} ratioSupported={features?.presetPreviewRatios===1} initialAspectRatio={aspectRatio} request={request} disabled={busy}/></div>
    <footer className="garment-dialog-footer">{asset && <button type="button" className="button danger-ghost" disabled={busy} onClick={()=>remove ? onDelete() : setRemove(true)}><Trash2 size={15}/>{remove ? '確定移出圖庫' : '移出圖庫'}</button>}<p>保存後，可在拍攝工作檯勾選並套用至顧客。</p><button type="submit" className="button primary" disabled={busy || !valid || !supported}><Check size={16}/>保存服裝</button></footer>
    </form>
  </GarmentDialog>;
}
