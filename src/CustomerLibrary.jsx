import {useRef,useState} from 'react';
import {Check,ChevronLeft,ChevronRight,ImagePlus,Pencil,Save,Trash2} from 'lucide-react';
import {imagePreview} from './image-preview.js';
import './customer-library.css';

export function CustomerPromptLibrary({field,label,value,onUse,library,disabled=false}) {
  const [selectedId,setSelectedId]=useState(''),[editing,setEditing]=useState(false),[name,setName]=useState(''),[removing,setRemoving]=useState(false),[notice,setNotice]=useState('');
  const rows=(library.prompts || []).filter(row=>row.field===field),selected=rows.find(row=>row.id===selectedId),busy=disabled || !library.supported;
  const choose=id=>{
    const row=rows.find(row=>row.id===id);
    setSelectedId(id);setName(row?.name || '');setEditing(false);setRemoving(false);setNotice('');
    if(row) onUse(row.prompt);
  };
  const save=async(asNew=false)=>{
    const row=await library.savePrompt({field,name:name.trim(),prompt:value},!asNew && selected?.id);
    if(row) {setSelectedId(row.id);setName(row.name);setEditing(false);setNotice('已保存，下次登入也能選用。');}
  };
  const remove=async()=>{
    if(await library.deletePrompt(selected.id)) {setSelectedId('');setName('');setRemoving(false);setEditing(false);setNotice('已移除收藏，目前輸入的提詞仍可使用。');}
  };
  return <div className="customer-prompt-library" role="group" aria-label={`我的${label}提詞`}>
    <div className="customer-prompt-actions"><label>我的提詞<select aria-label={`我的${label}提詞`} disabled={busy || !rows.length} value={selected?.id || ''} onChange={event=>choose(event.target.value)}><option value="">{rows.length ? '選擇已保存的提詞' : '尚未保存提詞'}</option>{rows.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label><button type="button" disabled={busy || !value.trim()} onClick={()=>{setEditing(true);setRemoving(false);setName(selected?.name || '');setNotice('');}}><Save size={14}/>{selected ? '保存變更' : '保存到我的提詞'}</button>{selected && <button type="button" className="customer-library-icon" aria-label={`移除${label}提詞 ${selected.name}`} disabled={busy} onClick={()=>{setRemoving(true);setEditing(false);setNotice('');}}><Trash2 size={15}/></button>}</div>
    {editing && <div className="customer-prompt-editor"><label>提詞名稱<input autoFocus aria-label={`${label}提詞名稱`} maxLength={80} disabled={busy} value={name} onChange={event=>setName(event.target.value)} onKeyDown={event=>{if(event.key==='Enter') {event.preventDefault();if(name.trim() && value.trim() && !busy) save();}}} placeholder="例如：我喜歡的搭配"/></label><div className="customer-library-buttons"><button type="button" disabled={busy} onClick={()=>setEditing(false)}>取消</button>{selected && <button type="button" disabled={busy || !name.trim() || !value.trim()} onClick={()=>save(true)}>另存新提詞</button>}<button type="button" className="customer-library-save" disabled={busy || !name.trim() || !value.trim()} onClick={()=>save()}><Check size={14}/>{selected ? '保存變更' : '保存提詞'}</button></div></div>}
    {removing && selected && <div className="customer-library-confirm"><p>移除「{selected.name}」的收藏？</p><div className="customer-library-buttons"><button type="button" disabled={busy} onClick={()=>setRemoving(false)}>取消</button><button type="button" disabled={busy} onClick={remove}>確定移除提詞</button></div></div>}
    <p className="customer-library-note" role={notice ? 'status' : undefined}>{notice || '收藏保存在你的帳號，重新登入後可再次選用。'}</p>
  </div>;
}

const PAGE_SIZE=12;
export function CustomerWardrobe({rows,selectedId,onSelect,library,disabled=false}) {
  const input=useRef(null);
  const [page,setPage]=useState(0),[error,setError]=useState(''),[editingId,setEditingId]=useState(''),[name,setName]=useState(''),[removingId,setRemovingId]=useState('');
  const busy=disabled || !library.supported,pages=Math.max(1,Math.ceil(rows.length/PAGE_SIZE)),currentPage=Math.min(page,pages-1),visible=rows.slice(currentPage*PAGE_SIZE,(currentPage+1)*PAGE_SIZE);
  const removing=rows.find(row=>row.id===removingId),editing=rows.find(row=>row.id===editingId);
  const upload=async event=>{
    const file=event.target.files[0];event.target.value='';setError('');
    if(!file || busy) return;
    if(file.size>25*1024*1024) {setError('服裝圖片最多 25 MB，請選擇較小的圖片。');return;}
    const garment=await library.uploadGarment(file);
    if(garment) {setPage(0);onSelect(garment.id);}
  };
  const rename=async()=>{if(await library.renameGarment(editing.id,name.trim())) setEditingId('');};
  const remove=async()=>{if(await library.deleteGarment(removing.id)) {setRemovingId('');if(selectedId===removing.id) onSelect('');}};
  return <div className="customer-wardrobe" role="group" aria-label="我的服裝收藏">
    <div className="customer-wardrobe-heading"><span>我的服裝 · {rows.length} 套</span><button type="button" disabled={busy} onClick={()=>input.current.click()}><ImagePlus size={16}/>上傳服裝圖片</button><input ref={input} hidden type="file" aria-label="上傳我的服裝圖片" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={upload}/></div>
    <p className="customer-library-note">PNG、JPG、WebP，最多 25 MB。圖片會保存在你的帳號。</p>
    {error && <p className="customer-library-error" role="alert">{error}</p>}
    {rows.length ? <div className="customer-wardrobe-grid">{visible.map(row=><article key={row.id} className="customer-wardrobe-item"><button type="button" className="customer-wardrobe-select" aria-label={`選擇我的服裝 ${row.name}`} aria-pressed={selectedId===row.id} disabled={busy} onClick={()=>onSelect(row.id)}><img decoding="async" loading="lazy" src={imagePreview(row.image)} alt={row.name}/><span>{row.name}{selectedId===row.id && <Check size={14}/>}</span></button><div className="customer-wardrobe-tools"><button type="button" aria-label={`重新命名服裝 ${row.name}`} disabled={busy} onClick={()=>{setEditingId(row.id);setName(row.name);setRemovingId('');}}><Pencil size={12}/>改名</button><button type="button" aria-label={`移除我的服裝 ${row.name}`} disabled={busy} onClick={()=>{setRemovingId(row.id);setEditingId('');}}><Trash2 size={12}/>移除</button></div></article>)}</div> : <div className="customer-wardrobe-empty"><ImagePlus size={26}/><p>上傳喜歡的服裝，下次拍攝也能直接選用。</p></div>}
    {pages>1 && <nav className="customer-wardrobe-pages" aria-label="我的服裝分頁"><button type="button" aria-label="我的服裝上一頁" disabled={busy || currentPage===0} onClick={()=>setPage(currentPage-1)}><ChevronLeft size={14}/></button><span>{currentPage+1} / {pages}</span><button type="button" aria-label="我的服裝下一頁" disabled={busy || currentPage===pages-1} onClick={()=>setPage(currentPage+1)}><ChevronRight size={14}/></button></nav>}
    {editing && <div className="customer-prompt-editor"><label>服裝名稱<input autoFocus aria-label="我的服裝名稱" maxLength={200} value={name} disabled={busy} onChange={event=>setName(event.target.value)}/></label><div className="customer-library-buttons"><button type="button" disabled={busy} onClick={()=>setEditingId('')}>取消</button><button type="button" className="customer-library-save" disabled={busy || !name.trim()} onClick={rename}>保存名稱</button></div></div>}
    {removing && <div className="customer-library-confirm"><p>從我的服裝移除「{removing.name}」？已拍攝的照片會保留。</p><div className="customer-library-buttons"><button type="button" disabled={busy} onClick={()=>setRemovingId('')}>取消</button><button type="button" disabled={busy} onClick={remove}>確定移除服裝</button></div></div>}
  </div>;
}
