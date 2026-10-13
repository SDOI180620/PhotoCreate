import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Check,ChevronDown,ChevronRight,FileText,Plus,Save,Shirt,SlidersHorizontal,Sparkles,X} from 'lucide-react';
import {PHOTO_CHANGE_FIELDS,PHOTO_PRESET_CATEGORIES,PHOTO_CHANGE_MAX_LENGTH} from '../shared/photo-customization.js';
import {PHOTO_PRESET_GROUPS,photoPresetGroupIds} from '../shared/photo-preset-groups.js';
import {CUSTOMER_MAX_SHOOT_CANDIDATES} from '../shared/customer-recipe.js';
import {imagePreview} from './image-preview.js';
import {randomId} from './ids.js';
import {SearchBox} from './ui.jsx';
import './customer-shoot.css';

const choiceKey=row=>`${row.source}:${row.id}`;
const sourceLabel={official:'官方選項',saved:'我的提詞',wardrobe:'我的服裝',temporary:'本次加入'};
const choiceValue=({source,id,name,prompt})=>({source,id,...(source==='temporary' ? {name,prompt} : {})});
const clothingVersion=row=>row.source==='saved' || row.source==='temporary' || row.sourceType==='prompt' ? 'prompt' : 'image';
const primaryFields=['clothing','clothingState','pose','scene'];
const detailFields=['expression','gaze','lighting','color','quality'];

function CandidatePicker({field,rows,value,onApply,onClose,onSavePrompt,disabled}) {
  const ref=useRef(null),close=useRef(onClose);
  const [selected,setSelected]=useState(value),[search,setSearch]=useState('');
  const [group,setGroup]=useState('all');
  const [source,setSource]=useState('all');
  const [version,setVersion]=useState('all');
  const [temporary,setTemporary]=useState([]),[adding,setAdding]=useState(false),[name,setName]=useState(''),[prompt,setPrompt]=useState('');
  const [savedTemporary,setSavedTemporary]=useState([]),[message,setMessage]=useState(null);
  close.current=onClose;
  useEffect(()=>{
    const dialog=ref.current,previous=document.activeElement,overflow=document.body.style.overflow;
    document.body.style.overflow='hidden';dialog.showModal();
    return ()=>{dialog.close();document.body.style.overflow=overflow;previous?.focus({preventScroll:true});};
  },[]);
  const label=PHOTO_CHANGE_FIELDS[field],term=search.trim().toLocaleLowerCase();
  const selectedKeys=new Set(selected.map(choiceKey));
  const candidates=[...rows,...temporary].filter(row=>!savedTemporary.includes(choiceKey(row)));
  const category=PHOTO_PRESET_CATEGORIES[field],groups=PHOTO_PRESET_GROUPS[category] || [];
  const entries=candidates.map(row=>({row,groupIds:photoPresetGroupIds({...row,category})}));
  const availableGroups=groups.map(item=>({...item,count:entries.filter(entry=>entry.groupIds.includes(item.id)).length})).filter(item=>item.count);
  const currentGroup=group==='all' || availableGroups.some(item=>item.id===group) ? group : 'all';
  const sources=Object.entries(sourceLabel).map(([id,name])=>({id,name,count:candidates.filter(row=>row.source===id).length})).filter(item=>item.count);
  const currentSource=source==='all' || sources.some(item=>item.id===source) ? source : 'all';
  const versions=field==='clothing' ? [['image','圖片版'],['prompt','提詞版']].map(([id,name])=>({id,name,count:candidates.filter(row=>clothingVersion(row)===id).length})).filter(item=>item.count) : [];
  const currentVersion=version==='all' || versions.some(item=>item.id===version) ? version : 'all';
  const visible=entries.filter(entry=>(currentGroup==='all' || entry.groupIds.includes(currentGroup)) && (currentSource==='all' || entry.row.source===currentSource) && (currentVersion==='all' || clothingVersion(entry.row)===currentVersion) && (!term || `${entry.row.name} ${entry.row.prompt || ''}`.toLocaleLowerCase().includes(term))).map(entry=>entry.row);
  const toggle=(row,checked)=>setSelected(current=>checked ? [...current,choiceValue(row)] : current.filter(item=>choiceKey(item)!==choiceKey(row)));
  const selectAll=()=>{
    const choices=new Map([...selected,...visible.map(choiceValue)].map(item=>[choiceKey(item),item]));
    if(choices.size>CUSTOMER_MAX_SHOOT_CANDIDATES) {setMessage({error:true,text:`每個分類最多選擇 ${CUSTOMER_MAX_SHOOT_CANDIDATES} 個候選，請縮小分類或搜尋範圍。`});return;}
    setSelected([...choices.values()]);
  };
  const cancelVisible=()=>{
    const keys=new Set(visible.map(choiceKey));
    setSelected(current=>current.filter(item=>!keys.has(choiceKey(item))));
  };
  const add=event=>{
    event.preventDefault();if(disabled || !prompt.trim() || selected.length>=CUSTOMER_MAX_SHOOT_CANDIDATES) return;
    const row={source:'temporary',id:randomId(),name:name.trim() || prompt.trim().slice(0,32),prompt:prompt.trim()};
    setTemporary(current=>[...current,row]);setSelected(current=>[...current,row]);setSearch('');setGroup('all');setSource('all');setVersion('all');setAdding(false);setName('');setPrompt('');
  };
  const save=async row=>{
    setMessage(null);
    try {
      const saved=await onSavePrompt({field,name:row.name,prompt:row.prompt});
      if(!saved) {setMessage({error:true,text:'保存未完成，請稍後再試。'});return;}
      setSelected(current=>[...new Map(current.map(item=>{
        const choice=choiceKey(item)===choiceKey(row) ? {source:'saved',id:saved.id} : item;
        return [choiceKey(choice),choice];
      })).values()]);
      setSavedTemporary(current=>[...current,choiceKey(row)]);setTemporary(current=>current.filter(item=>choiceKey(item)!==choiceKey(row)));
      setMessage({text:'已保存到我的提詞，下次登入也能選用。'});
    } catch {setMessage({error:true,text:'保存未完成，請稍後再試。'});}
  };
  return createPortal(<dialog ref={ref} className="pc-candidate-dialog" aria-label={`選擇${label}候選`} onCancel={event=>{event.preventDefault();if(!disabled) close.current();}}>
    <header><div><span>這次的搭配</span><h2>選擇{label}</h2><p>官方選項與你的收藏都在這裡，可以一起勾選。</p></div><button type="button" aria-label="關閉候選視窗" disabled={disabled} onClick={onClose}><X size={20}/></button></header>
    <div className="pc-candidate-body">
      <SearchBox value={search} onChange={setSearch} placeholder={`搜尋${label}選項`} disabled={disabled}/>
      {sources.length>1 && <div className="pc-candidate-groups pc-candidate-sources" role="group" aria-label={`${label}來源`}><button type="button" aria-label="全部來源" aria-pressed={currentSource==='all'} disabled={disabled} onClick={()=>setSource('all')}>全部來源<span aria-hidden="true">{candidates.length}</span></button>{sources.map(item=><button type="button" key={item.id} aria-label={item.name} aria-pressed={currentSource===item.id} disabled={disabled} onClick={()=>setSource(item.id)}>{item.name}<span aria-hidden="true">{item.count}</span></button>)}</div>}
      {availableGroups.length>0 && <div className="pc-candidate-groups" role="group" aria-label={`${label}分類`}><button type="button" aria-label="全部分類" aria-pressed={currentGroup==='all'} disabled={disabled} onClick={()=>setGroup('all')}>全部分類<span aria-hidden="true">{candidates.length}</span></button>{availableGroups.map(item=><button type="button" key={item.id} aria-label={item.label} aria-pressed={currentGroup===item.id} disabled={disabled} onClick={()=>setGroup(item.id)}>{item.label}<span aria-hidden="true">{item.count}</span></button>)}</div>}
      {versions.length>1 && <div className="pc-candidate-groups" role="group" aria-label="服裝版本"><button type="button" aria-label="全部版本" aria-pressed={currentVersion==='all'} disabled={disabled} onClick={()=>setVersion('all')}>全部版本<span aria-hidden="true">{candidates.length}</span></button>{versions.map(item=><button type="button" key={item.id} aria-label={item.name} aria-pressed={currentVersion===item.id} disabled={disabled} onClick={()=>setVersion(item.id)}>{item.name}<span aria-hidden="true">{item.count}</span></button>)}</div>}
      <div className="pc-candidate-tools"><span>顯示 {visible.length}／共 {candidates.length} 個選項</span><button type="button" disabled={disabled} onClick={()=>setAdding(current=>!current)} aria-expanded={adding}><Plus size={15}/>加入臨時提詞</button></div>
      <div className="pc-candidate-bulk"><button type="button" disabled={disabled || !visible.length} onClick={selectAll}>全選</button><button type="button" disabled={disabled || !visible.some(row=>selectedKeys.has(choiceKey(row)))} onClick={cancelVisible}>全取消</button><small>只影響目前顯示的候選</small></div>
      {message && <p className={`pc-candidate-message ${message.error ? 'error' : ''}`} role={message.error ? 'alert' : 'status'}>{message.text}</p>}
      {adding && <form className="pc-temporary-editor" onSubmit={add}>
        <label>名稱 <small>選填</small><input autoFocus aria-label={`${label}臨時提詞名稱`} maxLength={80} value={name} disabled={disabled} onChange={event=>setName(event.target.value)} placeholder="方便辨識這個候選"/></label>
        <label>{label}提詞<textarea aria-label={`臨時${label}提詞`} maxLength={PHOTO_CHANGE_MAX_LENGTH} value={prompt} disabled={disabled} onChange={event=>setPrompt(event.target.value)} placeholder={`描述想要的${label}…`} rows={3}/></label>
        <p>只加入本次候選，重新整理後清除。{prompt.length} / {PHOTO_CHANGE_MAX_LENGTH}</p>
        <div><button type="button" disabled={disabled} onClick={()=>setAdding(false)}>取消輸入</button><button type="submit" disabled={disabled || !prompt.trim() || selected.length>=CUSTOMER_MAX_SHOOT_CANDIDATES}><Plus size={15}/>加入本次候選</button></div>
      </form>}
      <div className={`pc-candidate-list ${field==='clothing' ? 'with-images' : ''}`}>
        {visible.map(row=><article key={choiceKey(row)} className={`pc-candidate-option ${selectedKeys.has(choiceKey(row)) ? 'selected' : ''}`}><label className="pc-candidate-choice">
          <input type="checkbox" aria-label={row.name} disabled={disabled || selected.length>=CUSTOMER_MAX_SHOOT_CANDIDATES && !selectedKeys.has(choiceKey(row))} checked={selectedKeys.has(choiceKey(row))} onChange={event=>toggle(row,event.target.checked)}/>
          {field==='clothing' && <div className="pc-candidate-visual">{row.image ? <img decoding="async" loading="lazy" src={imagePreview(row.image)} alt={row.name}/> : <Shirt size={24} strokeWidth={1.3}/>}</div>}
          <div className="pc-candidate-copy"><small>{sourceLabel[row.source]}</small><strong>{row.name}</strong>{row.prompt && <p>{row.prompt}</p>}</div>
        </label>{row.source==='temporary' && onSavePrompt && <button type="button" className="pc-candidate-save" aria-label={`保存提詞 ${row.name}`} disabled={disabled} onClick={()=>save(row)}><Save size={12}/>保存到我的提詞</button>}</article>)}
      </div>
      {!visible.length && <div className="pc-candidate-empty"><FileText size={24}/><p>{term ? '沒有符合搜尋的選項。' : candidates.length ? '沒有符合目前篩選的選項。' : '這個分類尚未提供候選。'}</p></div>}
    </div>
    <footer><div><strong>已選 {selected.length} 個</strong><small>{selected.length ? '每張從勾選的候選搭配' : `不加入${label}提詞`}</small></div><button type="button" className="pc-candidate-reset" disabled={disabled} onClick={()=>setSelected([])}>清空此分類</button><button type="button" className="pc-candidate-apply" disabled={disabled} onClick={()=>onApply(selected,candidates.filter(row=>row.source==='temporary'))}><Check size={16}/>套用{label}候選</button></footer>
  </dialog>,document.body);
}

export default function CustomerShoot({mode,onModeChange,selections={},onSelectionsChange,garments=[],presets=[],prompts=[],onSavePrompt,disabled=false}) {
  const [field,setField]=useState(null),[details,setDetails]=useState(false);
  const [temporaryByField,setTemporaryByField]=useState({});
  const rowsFor=key=>[
    ...(key==='clothing' ? garments.map(row=>({...row,source:row.owned ? 'wardrobe' : 'official'})) : presets.filter(row=>row.category===PHOTO_PRESET_CATEGORIES[key]).map(row=>({...row,source:'official'}))),
    ...prompts.filter(row=>row.field===key).map(row=>({...row,source:'saved'})),
    ...(temporaryByField[key] || []),
  ];
  const summary=key=>{
    const selected=selections[key] || [],rows=rowsFor(key);
    return selected.length ? `已選 ${selected.length} 個 · ${selected.map(item=>rows.find(row=>choiceKey(row)===choiceKey(item))?.name || '選項已移除').join('、')}` : '未指定，不加入提詞';
  };
  return <>
    <div className="pc-shoot-modes" role="group" aria-label="拍攝模式">
      <button type="button" aria-pressed={mode==='random'} disabled={disabled} onClick={()=>onModeChange('random')}><Sparkles size={16}/>隨機</button>
      <button type="button" aria-pressed={mode==='custom'} disabled={disabled} onClick={()=>onModeChange('custom')}><SlidersHorizontal size={16}/>自定義</button>
    </div>
    {mode==='custom' && <div className="pc-custom-candidates" role="group" aria-label="自定義拍攝候選">
      <p>只使用勾選的候選，未指定的分類不加入提詞。</p>
      {[...primaryFields,...(details ? detailFields : [])].map(key=><button type="button" key={key} className="pc-candidate-summary" aria-label={`設定${PHOTO_CHANGE_FIELDS[key]}候選`} disabled={disabled} onClick={()=>setField(key)}><strong>{PHOTO_CHANGE_FIELDS[key]}</strong><span title={summary(key)}>{summary(key)}</span><ChevronRight size={16}/></button>)}
      <button type="button" className="pc-candidate-details" aria-label="更多設定" aria-expanded={details} disabled={disabled} onClick={()=>setDetails(current=>!current)}><SlidersHorizontal size={13}/>{details ? '收起更多設定' : '更多設定'}<small>表情、光線等</small><ChevronDown size={14}/></button>
    </div>}
    {field && <CandidatePicker field={field} rows={rowsFor(field)} value={selections[field] || []} disabled={disabled} onSavePrompt={onSavePrompt} onClose={()=>setField(null)} onApply={(items,temporaryRows)=>{setTemporaryByField(current=>({...current,[field]:temporaryRows}));onSelectionsChange({...selections,[field]:items});setField(null);}}/>}
  </>;
}
