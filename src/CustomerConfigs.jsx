import {useEffect,useState} from 'react';
import {Check,FileSliders,Loader2,Plus,Search,Shirt,UserRound} from 'lucide-react';
import {CATEGORIES,PRESET_SELECTION_FIELDS} from '../shared/domain.js';
import {customerConfigDraft} from '../shared/customer-configs.js';
import {imagePreview} from './image-preview.js';
import './customer-configs.css';

export default function CustomerConfigs({state,api,onSaved,onEditCharacterPrompts,initialEditorDraft,onDraftRestored}) {
  const [data,setData]=useState(null),[selectedId,setSelectedId]=useState(''),[name,setName]=useState(''),[draft,setDraft]=useState(null),[videoIds,setVideoIds]=useState([]);
  const [creating,setCreating]=useState(false),[newName,setNewName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [characterPromptProfileId,setCharacterPromptProfileId]=useState('');
  const [category,setCategory]=useState('characterIds'),[query,setQuery]=useState('');
  const select=row=>{setSelectedId(row.id);setName(row.name);setDraft(customerConfigDraft(row,state));setVideoIds(row.videoPromptIds || []);setCharacterPromptProfileId(row.characterPromptProfileId || state.settings.characterPromptProfiles.activeId);setQuery('');setNotice('');setError('');};
  useEffect(()=>{let current=true;api('/customer-configs').then(result=>{
    if(!current) return;
    const row=result.configs.find(row=>row.id===initialEditorDraft?.selectedId) || result.configs.find(row=>row.id===result.defaultId);
    setData(result);select(row);
    if(initialEditorDraft?.selectedId===row.id) {
      setName(initialEditorDraft.name);setDraft(structuredClone(initialEditorDraft.draft));setVideoIds([...initialEditorDraft.videoIds]);
      if(state.settings.characterPromptProfiles.profiles.some(profile=>profile.id===initialEditorDraft.characterPromptProfileId)) setCharacterPromptProfileId(initialEditorDraft.characterPromptProfileId);
      setCategory(initialEditorDraft.category);setQuery(initialEditorDraft.query);setCreating(initialEditorDraft.creating);setNewName(initialEditorDraft.newName);
    }
    onDraftRestored?.();
  }).catch(error=>{if(current) setError(error.message);});return()=>{current=false;};},[api]);
  const run=async(work,message)=>{
    setBusy(true);setError('');setNotice('');
    try {const row=await work(),result=await api('/customer-configs');setData(result);select(result.configs.find(value=>value.id===row.id));await onSaved();setNotice(message);return true;}
    catch(error) {setError(error.message);return false;} finally {setBusy(false);}
  };
  const create=async event=>{event.preventDefault();if(await run(()=>api('/customer-configs',{method:'POST',body:{name:newName}}),'設定檔已建立，可以開始調整可用選項。')) {setCreating(false);setNewName('');}};
  const save=async event=>{event.preventDefault();await run(()=>api(`/customer-configs/${selectedId}`,{method:'PATCH',body:{name,draft,videoPromptIds:videoIds,characterPromptProfileId}}),'設定檔已保存，指定此設定檔的顧客會使用這些選項。');};
  const groups=[{field:'characterIds',label:'角色',rows:state.characters},{field:'garmentIds',label:'服裝',rows:state.garments},
    ...Object.entries(PRESET_SELECTION_FIELDS).map(([key,field])=>({field,label:CATEGORIES[key].label,rows:state.presets.filter(row=>row.category===key)})),
    {field:'videoPromptIds',label:'動畫',rows:state.videoSettings.prompts}];
  const group=groups.find(row=>row.field===category),ids=category==='videoPromptIds' ? videoIds : draft?.[category] || [];
  const rows=group.rows.filter(row=>!query.trim() || [row.name,...row.tags || []].join(' ').toLowerCase().includes(query.trim().toLowerCase()));
  const change=next=>category==='videoPromptIds' ? setVideoIds(next) : setDraft(current=>({...current,[category]:next,...(category==='characterIds' ? {characterId:next[0] || ''} : {})}));
  return <div className="customer-configs">
    {error && <p className="account-message error" role="alert">{error}</p>}{notice && <p className="account-message" role="status"><Check size={16}/>{notice}</p>}
    {!data ? <p className="muted"><Loader2 size={16} className="spin"/>正在讀取設定檔…</p> : <>
      <section className="panel config-heading"><div><h2><FileSliders size={20}/>帳號使用的參數設定檔</h2><p className="muted">自由命名、勾選可用項目，再到「顧客帳號」指定給顧客。保存後即可生效。</p></div><div className="config-selector"><label>參數設定檔<select aria-label="參數設定檔" value={selectedId} disabled={busy} onChange={event=>select(data.configs.find(row=>row.id===event.target.value))}>{data.configs.map(row=><option key={row.id} value={row.id}>{row.name}{row.id===data.defaultId ? '（預設）' : ''}</option>)}</select></label><button className="button secondary" disabled={busy} onClick={()=>setCreating(value=>!value)}><Plus size={15}/>新增設定檔</button></div></section>
      {creating && <section className="panel config-create"><form onSubmit={create}><label>新設定檔名稱<input autoFocus aria-label="新設定檔名稱" required maxLength={80} value={newName} disabled={busy} onChange={event=>setNewName(event.target.value)} placeholder="例如：普通會員、朋友試玩"/></label><button className="button primary" disabled={busy || !newName.trim()}><Plus size={15}/>建立設定檔</button><button type="button" className="button secondary" disabled={busy} onClick={()=>setCreating(false)}>取消</button></form><p className="muted">新設定檔會先複製預設檔的選項，再依需求調整。</p></section>}
      <form onSubmit={save}>
        <section className="panel config-name"><label>設定檔名稱<input aria-label="設定檔名稱" required maxLength={80} value={name} disabled={busy} onChange={event=>setName(event.target.value)}/></label><div><span className="muted">{selectedId===data.defaultId ? '未指定設定檔的帳號使用這一份。名稱可以自由修改。' : '帳號指定這份設定檔後，會看到這裡勾選的官方選項。'}</span><button className="button primary" disabled={busy || !name.trim()}>{busy ? <Loader2 size={15} className="spin"/> : <Check size={15}/>}保存設定檔</button></div></section>
        <div className="config-editor"><nav className="panel config-categories" aria-label="參數分類">{groups.map(row=><button type="button" key={row.field} aria-label={`設定${row.label}候選`} aria-pressed={category===row.field} className={category===row.field ? 'active' : ''} onClick={()=>{setCategory(row.field);setQuery('');}}><span>{row.label}</span><small>{(row.field==='videoPromptIds' ? videoIds : draft?.[row.field] || []).length} / {row.rows.length}</small></button>)}</nav>
          <section className="panel config-candidates" aria-label={`${group.label}可用選項`}><div className="config-candidate-heading"><div><h2>{group.label}</h2><p className="muted">已選 {ids.length} 個，共 {group.rows.length} 個可用選項。</p></div><div className="config-selection-actions"><button type="button" className="button secondary" disabled={busy || !rows.length} onClick={()=>change([...new Set([...ids,...rows.map(row=>row.id)])])}>{query.trim() ? '全選搜尋結果' : '全選此分類'}</button><button type="button" className="button secondary" disabled={busy || !ids.length} onClick={()=>change([])}>清空此分類</button></div></div>
            <label className="config-search"><Search size={16}/><input type="search" aria-label="搜尋可用選項" value={query} onChange={event=>setQuery(event.target.value)} placeholder={`搜尋${group.label}名稱或標籤`}/></label>
            <div className="config-choice-grid">{rows.map(row=><label className={`config-choice ${ids.includes(row.id) ? 'selected' : ''}`} key={row.id}><input type="checkbox" aria-label={row.name} disabled={busy} checked={ids.includes(row.id)} onChange={()=>change(ids.includes(row.id) ? ids.filter(id=>id!==row.id) : [...ids,row.id])}/>{row.image ? <img src={imagePreview(row.image)} alt="" loading="lazy"/> : category==='characterIds' || category==='garmentIds' ? <span className="config-choice-icon">{category==='characterIds' ? <UserRound size={20}/> : <Shirt size={20}/>}</span> : null}<span><strong>{row.name}</strong>{row.tags?.length>0 && <small>{row.tags.slice(0,3).join('、')}</small>}</span></label>)}</div>
            {!rows.length && <p className="config-empty">{query ? '沒有符合搜尋的選項。' : '這個分類還沒有選項，請先到素材或提詞資料庫新增。'}</p>}
            <p className="config-guidance muted">角色、動畫及選填分類可清空。服裝、動作、光線、色彩與畫質至少保留一項，才能隨機拍攝。</p>
          </section></div>
        <section className="panel config-generation" aria-label="設定檔拍攝參數"><h2>拍攝參數</h2>
          <div className="config-character-prompts"><label>角色提詞設定檔<select aria-label="角色提詞設定檔" disabled={busy || !state.features?.customerCharacterPromptProfiles} value={characterPromptProfileId} onChange={event=>setCharacterPromptProfileId(event.target.value)}>{state.settings.characterPromptProfiles.profiles.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label>{onEditCharacterPrompts && <button type="button" className="button secondary" disabled={busy || !characterPromptProfileId} onClick={()=>onEditCharacterPrompts(characterPromptProfileId,{selectedId,name,draft,videoIds,characterPromptProfileId,category,query,creating,newName})}>編輯角色提詞</button>}</div>
          <p className="field-help">三視圖、Cup 與身高提詞依這份設定檔套用。保存綁定後，該帳號的新拍攝與角色轉圖會使用這組提詞。</p><div className="form-grid">
          <label>採樣步數<input aria-label="採樣步數" type="number" inputMode="numeric" min={1} max={100} step={1} required disabled={busy} value={draft.steps} onChange={event=>setDraft(current=>({...current,steps:event.target.value}))}/></label>
          <label>參考解析度<select aria-label="參考解析度" disabled={busy} value={draft.resolution} onChange={event=>setDraft(current=>({...current,resolution:Number(event.target.value)}))}>{[1024,1536,2048].map(value=><option key={value} value={value}>{value} × {value} 等效面積</option>)}</select></label>
        </div><p className="field-help">保存後，指定此設定檔的顧客會使用這些拍攝參數。角色、張數與照片比例由顧客自行選擇。</p>
          <details><summary>補充提詞與負面提詞</summary><div className="form-grid">
            <label>場景補充<textarea aria-label="場景補充" rows={3} maxLength={20000} disabled={busy} value={draft.sceneInteraction} onChange={event=>setDraft(current=>({...current,sceneInteraction:event.target.value}))}/></label>
            <label>補充拍攝提詞<textarea aria-label="補充拍攝提詞" rows={3} maxLength={20000} disabled={busy} value={draft.extra} onChange={event=>setDraft(current=>({...current,extra:event.target.value}))}/></label>
            <label className="config-negative">負面提詞<textarea aria-label="負面提詞" rows={3} maxLength={20000} disabled={busy} value={draft.negative} onChange={event=>setDraft(current=>({...current,negative:event.target.value}))}/></label>
          </div></details>
        </section>
      </form>
    </>}
  </div>;
}
