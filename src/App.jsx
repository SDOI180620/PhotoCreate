import { useEffect, useMemo, useRef, useState } from 'react';
import { Aperture, ArrowDownToLine, ArrowRight, Camera, Check, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Circle, Clipboard, Clock3, Database, Download, FileJson, Film, FolderOpen, ImagePlus, Images, Layers3, Loader2, MoreHorizontal, Plus, RefreshCw, Search, Settings2, Shirt, SlidersHorizontal, Sparkles, Square, Sun, Trash2, Upload, UserRound, WandSparkles, X } from 'lucide-react';
import { CATEGORIES, OPTIONAL_PRESET_FIELDS, OUTPUT_RATIOS, PRESET_POOL_FIELDS, selectedPresetIds, getShotRecipe, getOutputSize, composePrompt } from '../shared/domain.js';
import { JOB_STATUS_LABELS as STATUS } from '../shared/batches.js';
import { Empty, SearchBox } from './ui.jsx';
import JobLibrary from './JobLibrary.jsx';
import PresetPoolPicker, { PresetPoolField } from './PresetPools.jsx';
import ResultGallery from './ResultGallery.jsx';
import ShotOptions from './ShotOptions.jsx';
import CameraControl from './CameraControl.jsx';
import EnvironmentSetup from './EnvironmentSetup.jsx';
import DataTransfer from './DataTransfer.jsx';
import {DEFAULT_DRAFT} from '../shared/draft.js';
import {productionPreview,productionStatus} from '../shared/production.js';
import { DEFAULT_CAMERA_ANGLE, cameraPreset, cameraPrompt, cameraAngleLabel, REFINE_PROMPT } from '../shared/camera.js';
import { resolveCameraSource } from '../shared/camera-source.js';
import { RETRYABLE_STATUSES, STOPPABLE_STATUSES } from '../shared/batches.js';

const ASSET_LABELS = {garments:{name:'服裝',title:'服裝圖庫',subtitle:'每一套服裝，都是下一組寫真的起點。',icon:Shirt},characters:{name:'角色',title:'角色參考',subtitle:'保存角色的外貌與辨識特徵。',icon:UserRound}};
const PAGES = [{id:'studio',label:'拍攝工作檯',icon:SlidersHorizontal},{id:'garments',label:'服裝圖庫',icon:Shirt},{id:'references',label:'角色參考',icon:UserRound},{id:'presets',label:'提詞資料庫',icon:FileJson},{id:'jobs',label:'拍攝清單',icon:Layers3},{id:'gallery',label:'成果畫廊',icon:Images}];

async function api(endpoint,options = {}) {
  const isForm = options.body instanceof FormData;
  const response = await fetch(`/api${endpoint}`,{...options,headers:{...(isForm ? {} : {'Content-Type':'application/json'}),...options.headers},body:options.body && !isForm ? JSON.stringify(options.body) : options.body});
  const result = await response.json();
  if(!response.ok) throw new Error(result.error || '操作未完成，請再試一次。');
  return result;
}
function downloadJson(data,name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
  const anchor = document.createElement('a');anchor.href = url;anchor.download = name;anchor.click();
  setTimeout(() => URL.revokeObjectURL(url),1000);
}
function toggle(values,id) {return values.includes(id) ? values.filter(value => value !== id) : [...values,id];}
function Tags({tags = []}) {return <div className="tags">{tags.map(tag => <span key={tag}>{tag}</span>)}</div>;}
function SectionTitle({number,title,description,children}) {return <div className="section-title"><div className="section-title-main">{number && <span className="section-number">{number}</span>}<div><h2>{title}</h2>{description && <p>{description}</p>}</div></div>{children}</div>;}
function Modal({title,children,onClose,wide = false,className = ''}) {
  const ref = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    const focusable = () => [...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href],[tabindex="0"]')];
    focusable()[0]?.focus();
    const listener = e => {
      if(e.key === 'Escape') onClose();
      if(e.key === 'Tab') {
        const items = focusable(),first = items[0],last = items.at(-1);
        if(e.shiftKey && document.activeElement === first) {e.preventDefault();last?.focus();}
        else if(!e.shiftKey && document.activeElement === last) {e.preventDefault();first?.focus();}
      }
    };
    document.addEventListener('keydown',listener);
    return () => {document.removeEventListener('keydown',listener);previous?.focus();};
  },[]);
  return <div className="modal-backdrop" onMouseDown={e => {if(e.target === e.currentTarget) onClose();}}><div ref={ref} role="dialog" aria-modal="true" aria-label={title} className={`modal ${wide ? 'wide' : ''} ${className}`}><div className="modal-header"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="關閉視窗"><X size={20}/></button></div>{children}</div></div>;
}
function ReferenceCard({number,kind,asset,count,onPick,onUpload,busy}) {
  const input = useRef(null);
  const [dragging,setDragging] = useState(false);
  const Icon = ASSET_LABELS[kind].icon;
  return <div className={`reference-card ${asset ? 'filled' : ''} ${dragging ? 'dragging' : ''}`} onDragOver={e => {e.preventDefault();setDragging(true);}} onDragLeave={() => setDragging(false)} onDrop={e => {e.preventDefault();setDragging(false);if(!busy) onUpload(kind,e.dataTransfer.files);}}>
    <div className="ref-label"><span>{`<image${number}>`}</span><span>{ASSET_LABELS[kind].name}</span></div>
    <button className="ref-image" onClick={onPick} aria-label={`選擇${ASSET_LABELS[kind].name}參考圖`}>{asset ? <img src={asset.image} alt={asset.name}/> : <><Icon size={30} strokeWidth={1.25}/><span>選擇{ASSET_LABELS[kind].name}圖</span></>}{count > 1 && <span className="image-count">+{count - 1}</span>}</button>
    <div className="ref-name">{asset ? asset.name : '拖入圖片，或從圖庫選擇'}</div>
    <div className="ref-actions"><button onClick={onPick}><FolderOpen size={13}/>圖庫</button><button disabled={busy} onClick={() => input.current.click()}><Upload size={13}/>上傳</button></div>
    <input ref={input} hidden type="file" accept="image/png,image/jpeg,image/webp" multiple={kind === 'garments'} onChange={e => {onUpload(kind,e.target.files);e.target.value = '';}}/>
  </div>;
}
function AssetPicker({kind,state,draft,onSelect,onClose,onUpload,busy}) {
  const [query,setQuery] = useState('');
  const multi = kind === 'garments';
  const selected = multi ? draft.garmentIds : [draft.characterId];
  const [values,setValues] = useState(selected);
  const rows = state[kind].filter(row => `${row.name} ${row.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  const uploadRef = useRef(null);
  return <Modal title={`選擇${ASSET_LABELS[kind].name}參考圖${multi ? ' · 可多選' : ''}`} onClose={onClose} wide>
    <div className="modal-body"><div className="toolbar"><SearchBox value={query} onChange={setQuery} placeholder="搜尋名稱或標籤…"/><button className="button secondary" disabled={busy} onClick={() => uploadRef.current.click()}><Upload size={16}/>上傳圖片</button><input ref={uploadRef} hidden type="file" accept="image/png,image/jpeg,image/webp" multiple={multi} onChange={async e => {const files = Array.from(e.target.files); e.target.value=''; await onUpload(kind,files);onClose();}}/></div>
      {rows.length ? <div className="picker-grid">{rows.map(row => <button key={row.id} className={`picker-card ${values.includes(row.id) ? 'selected' : ''}`} onClick={() => setValues(multi ? toggle(values,row.id) : [row.id])}><img src={row.image} alt={row.name}/><span className="selection-mark">{values.includes(row.id) && <Check size={13}/>}</span><span>{row.name}</span></button>)}</div> : <Empty title="還沒有符合的圖片" description="上傳一張參考圖，就可以開始搭配。"/>}
    </div><div className="modal-footer"><span className="muted">{multi ? `已選 ${values.filter(Boolean).length} 套服裝` : '選擇一張參考圖'}</span><button className="button primary" disabled={!values.filter(Boolean).length} onClick={() => {onSelect(values);onClose();}}>使用所選圖片<ArrowRight size={16}/></button></div>
  </Modal>;
}
function AssetEditor({kind,asset,onClose,onSave,onDelete,busy}) {
  const [form,setForm] = useState({...asset,tags:asset.tags.join(', ')});
  const [remove,setRemove] = useState(false);
  return <Modal title={`編輯${ASSET_LABELS[kind].name}`} onClose={onClose}>
    <form onSubmit={e => {e.preventDefault();onSave({name:form.name,description:form.description,tags:form.tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean)});}}>
      <div className="modal-body asset-editor"><img className="edit-preview" src={asset.image} alt={asset.name}/><label>名稱<input required maxLength={200} value={form.name} onChange={e => setForm({...form,name:e.target.value})}/></label><p className="field-help">{kind === 'garments' ? '服裝名稱與提詞用於管理圖庫；提詞僅作備註，生成時使用 <image2> 的服裝參考圖。' : '名稱用於管理圖庫；生成時會帶入你填寫的角色提詞。'}</p><label>提詞<textarea aria-label="提詞" rows={4} value={form.description} onChange={e => setForm({...form,description:e.target.value})} placeholder={kind === 'garments' ? '記錄這套服裝的提詞、材質、款式或其他備註，不會加入生成提詞…' : '希望在生成圖片時保留的特徵與細節…'}/></label><label>標籤<input value={form.tags} onChange={e => setForm({...form,tags:e.target.value})} placeholder="例如：白色, 洋裝, 棚拍（用逗號分隔）"/></label>{remove && <p className="inline-error">確定將「{asset.name}」移出圖庫？已建立的拍攝清單會保留參考圖。</p>}</div>
      <div className="modal-footer"><button type="button" className="button danger-ghost" disabled={busy} onClick={() => remove ? onDelete() : setRemove(true)}><Trash2 size={15}/>{remove ? '確定移出圖庫' : '移出圖庫'}</button><button type="submit" className="button primary" disabled={busy || !form.name.trim()}><Check size={16}/>保存資料</button></div>
    </form>
  </Modal>;
}
function AssetLibrary({kind,rows,onUpload,onEdit,busy}) {
  const [query,setQuery] = useState('');
  const [tag,setTag] = useState('');
  const [dragging,setDragging] = useState(false);
  const input = useRef(null);
  const allTags = [...new Set(rows.flatMap(row => row.tags))];
  const filtered = rows.filter(row => `${row.name} ${row.description} ${row.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase()) && (!tag || row.tags.includes(tag)));
  const Icon = ASSET_LABELS[kind].icon;
  return <div className={`library ${dragging ? 'dragging' : ''}`} onDragOver={e => {e.preventDefault();setDragging(true);}} onDragLeave={e => {if(!e.currentTarget.contains(e.relatedTarget)) setDragging(false);}} onDrop={e => {e.preventDefault();setDragging(false);if(!busy) onUpload(kind,e.dataTransfer.files);}}>
    <div className="toolbar"><SearchBox value={query} onChange={setQuery} placeholder="搜尋名稱、提詞或標籤…"/><span className="item-count">{rows.length} 張參考圖</span><button className="button primary" disabled={busy} onClick={() => input.current.click()}>{busy ? <Loader2 className="spin" size={16}/> : <Plus size={16}/>}批次匯入{ASSET_LABELS[kind].name}</button><input ref={input} hidden type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={e => {onUpload(kind,e.target.files);e.target.value = '';}}/></div>
    {allTags.length > 0 && <div className="filter-tabs"><button className={!tag ? 'active' : ''} onClick={() => setTag('')}>全部</button>{allTags.map(value => <button key={value} className={tag === value ? 'active' : ''} onClick={() => setTag(value)}>{value}</button>)}</div>}
    {filtered.length > 0 ? <div className="asset-grid">{filtered.map(row => <article className="asset-card" key={row.id}><button className="asset-photo" onClick={() => onEdit(kind,row)}><img loading="lazy" src={row.image} alt={row.name}/><span className="edit-photo"><Settings2 size={15}/>編輯</span></button><div className="asset-details"><button onClick={() => onEdit(kind,row)} className="asset-title">{row.name}<MoreHorizontal size={17}/></button><p>{row.description || '加入提詞，讓生成結果更貼近你的想法。'}</p><Tags tags={row.tags}/></div></article>)}<button className="asset-add" onClick={() => input.current.click()} disabled={busy}><Plus size={28} strokeWidth={1.2}/><span>加入更多{ASSET_LABELS[kind].name}</span><small>PNG · JPG · WebP</small></button></div> : <div className="library-empty"><div className="empty-decor"><Icon size={78} strokeWidth={0.75}/><span className="decor-label">YOUR COLLECTION</span></div><Empty icon={ImagePlus} title={rows.length ? '沒有符合的圖片' : `建立你的${ASSET_LABELS[kind].name}圖庫`} description={rows.length ? '試試其他關鍵字或標籤。' : `拖曳圖片到這裡，或一次匯入多張圖片。\n檔名會自動成為名稱，之後可以自由修改。`}><button className="button primary" disabled={busy} onClick={() => input.current.click()}><Upload size={16}/>選擇圖片</button><small className="muted">每張最多 25 MB · 每批最多 50 張</small></Empty></div>}
  </div>;
}
function PresetEditor({preset,initialCategory,initialPrompt = '',onSave,onDelete,onClose,busy}) {
  const [form,setForm] = useState(preset ? {...preset,tags:preset.tags.join(', ')} : {id:`preset-${crypto.randomUUID()}`,name:'',category:initialCategory || 'pose',prompt:initialPrompt,tags:'',angle:DEFAULT_CAMERA_ANGLE});
  const [remove,setRemove] = useState(false);
  const camera = form.category === 'camera';
  return <Modal title={camera ? preset ? '編輯相機角度' : '新增相機角度' : preset ? '編輯提詞' : '新增提詞'} onClose={onClose} wide={camera} className={camera ? 'camera-editor' : ''}>
    <form onSubmit={e => {e.preventDefault();onSave({...form,...(camera ? {angle:form.angle || cameraPreset(form).angle,prompt:cameraPrompt(form.angle || cameraPreset(form).angle)} : {}),tags:form.tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean)});}}>
      <div className="modal-body form-stack"><div className="form-grid"><label>{camera ? '角度名稱' : '提詞名稱'}<input required maxLength={200} value={form.name} onChange={e => setForm({...form,name:e.target.value})} placeholder={camera ? '例如：右側平視半身' : '例如：海邊回眸'}/></label><label>分類<select value={form.category} onChange={e => setForm({...form,category:e.target.value})}>{Object.entries(CATEGORIES).map(([id,category]) => <option key={id} value={id}>{category.label}</option>)}</select></label></div>
        {camera ? <><CameraControl value={form.angle || cameraPreset(form).angle} onChange={angle => setForm({...form,angle,mappingNote:''})}/>{form.mappingNote && <p className="field-help camera-mapping-note">{form.mappingNote}</p>}</> : <label>提詞內容<textarea required rows={7} value={form.prompt} onChange={e => setForm({...form,prompt:e.target.value})} placeholder="描述動作、表情、服裝狀態、場景互動或攝影風格。支援中文與英文。"/></label>}
        <label>標籤<input value={form.tags} onChange={e => setForm({...form,tags:e.target.value})} placeholder="例如：側面, 平視, 半身"/></label>{remove && <p className="inline-error">確定移除這個設定？拍攝清單仍會保留已使用的內容。</p>}
      </div><div className="modal-footer">{preset ? <button type="button" disabled={busy} className="button danger-ghost" onClick={() => remove ? onDelete() : setRemove(true)}><Trash2 size={15}/>{remove ? '確定移除' : camera ? '移除角度' : '移除提詞'}</button> : <span/>}<button className="button primary" disabled={busy || !form.name.trim() || !camera && !form.prompt.trim()}><Check size={16}/>{camera ? '保存角度' : '保存提詞'}</button></div>
    </form>
  </Modal>;
}

function AngleEditDialog({job,imageIndex = 0,sourceState,presets,onClose,onGenerate,busy,ready}) {
  const [angle,setAngle] = useState(cameraPreset(job.camera || {}).angle);
  const [name,setName] = useState(job.camera?.name || '自訂角度');
  const [angleSteps,setAngleSteps] = useState(job.angleSteps || 20);
  const [refineDenoise,setRefineDenoise] = useState(job.refineDenoise || 0.2);
  const [deleteSourceOnComplete,setDeleteSourceOnComplete] = useState(true);
  const requestId = useRef(crypto.randomUUID());
  const cameras = presets.filter(row => row.category === 'camera');
  const sourceError = useMemo(() => {try {resolveCameraSource(sourceState,job,imageIndex);return '';} catch(error) {return error.message;}},[sourceState,job,imageIndex]);
  return <Modal title="調整角度並重繪" onClose={onClose} wide className="camera-editor"><form onSubmit={event => {event.preventDefault();onGenerate({requestId:requestId.current,angle,name,angleSteps,refineDenoise,deleteSourceOnComplete,imageIndex});}}>
    <div className="modal-body form-stack"><div className="form-grid"><label>角度名稱<input required maxLength={200} value={name} onChange={event => setName(event.target.value)}/></label><label>套用已存角度<select aria-label="套用已存角度" defaultValue="" onChange={event => {const preset = cameras.find(row => row.id === event.target.value);if(preset) {setAngle(cameraPreset(preset).angle);setName(preset.name);}}}><option value="">自訂角度</option>{cameras.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label></div>
      {sourceError ? <p className="inline-error" role="alert">{sourceError}</p> : <p className="field-help">換角度基準：首次生成的原圖。</p>}
      <CameraControl value={angle} onChange={setAngle} image={sourceError ? undefined : `/api/jobs/${job.id}/angle-source?index=${imageIndex}`}/>
      <div className="camera-edit-settings"><label>換角度步數<input type="number" min="1" max="100" required value={angleSteps} onChange={event => setAngleSteps(Number(event.target.value))}/></label><label>高清修正強度<input type="number" min="0.05" max="0.4" step="0.05" required value={refineDenoise} onChange={event => setRefineDenoise(Number(event.target.value))}/></label></div>
      <p className="field-help">每次從原圖重新換角度，再修正清晰度與細節，沿用原解析度。完成後可刪除被替換的成果，原圖仍保留。</p><label className="camera-delete-source"><input type="checkbox" checked={deleteSourceOnComplete} onChange={event => setDeleteSourceOnComplete(event.target.checked)}/>完成後刪除被替換的舊成果</label>{!ready && <p className="inline-error">請先在工作流設定載入 3D 相機工作流。</p>}
    </div><div className="modal-footer"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={busy || !ready || Boolean(sourceError) || !name.trim() || !Number.isInteger(angleSteps) || angleSteps < 1 || angleSteps > 100 || refineDenoise < 0.05 || refineDenoise > 0.4}><WandSparkles size={16}/>換角度並高清重繪</button></div>
  </form></Modal>;
}

function JsonImport({onClose,onImport,busy}) {
  const [value,setValue] = useState('');
  const [error,setError] = useState('');
  const example = {version:1,presets:[{id:'pose-beach-turn',category:'pose',name:'海邊回眸',prompt:'Standing near the shore, gently turning to look over one shoulder, relaxed hands and a natural expression.',tags:['海邊','回眸','站姿']}]};
  return <Modal title="批次匯入提詞 JSON" onClose={onClose} wide><div className="modal-body form-stack"><div className="notice"><FileJson size={19}/><div>貼上提詞陣列，或使用包含 <code>version</code> 與 <code>presets</code> 的 JSON。<small>相同 id 會更新原提詞；省略 id 會建立新提詞。支援 pose、expression（表情）、clothing_state（服裝狀態）、interaction（場景互動）、camera、lighting、color、quality。</small></div></div><textarea aria-label="提詞 JSON" className="code-input" rows={13} value={value} onChange={e => {setValue(e.target.value);setError('');}} placeholder={JSON.stringify(example,null,2)}/>{error && <p className="inline-error">{error}</p>}</div><div className="modal-footer"><button className="button secondary" onClick={() => setValue(JSON.stringify(example,null,2))}>填入格式範例</button><button className="button primary" disabled={busy || !value.trim()} onClick={async () => {try {const parsed = JSON.parse(value);await onImport(parsed);onClose();} catch(error) {setError(error.message);}}}><Upload size={16}/>匯入提詞</button></div></Modal>;
}

function PresetLibrary({state,onEdit,onImport,onJsonImport,busy}) {
  const [query,setQuery] = useState('');
  const [category,setCategory] = useState('');
  const [offset,setOffset] = useState(0);
  const [result,setResult] = useState({rows:[],total:0});
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState('');
  const input = useRef(null);
  useEffect(() => {setOffset(0);},[query,category]);
  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {setLoading(true);api(`/presets/search?${new URLSearchParams({q:query,category,offset,limit:24})}`).then(data => {if(current) {setResult(data);setError('');}}).catch(error => {if(current) setError(error.message);}).finally(() => {if(current) setLoading(false);});},150);
    return () => {current = false;clearTimeout(timer);};
  },[query,category,offset,state.presets]);
  return <div className="preset-library"><div className="toolbar"><SearchBox value={query} onChange={setQuery}/><button className="button secondary" onClick={() => downloadJson({version:1,presets:state.presets},'photocreate-presets.json')}><Download size={16}/>匯出</button><button className="button secondary" disabled={busy} onClick={onJsonImport}><FileJson size={16}/>貼上 JSON</button><button className="button secondary" disabled={busy} onClick={() => input.current.click()}><Upload size={16}/>匯入檔案</button><button className="button primary" onClick={() => onEdit(null,category)}><Plus size={16}/>新增提詞</button><input ref={input} hidden type="file" accept=".json,application/json" onChange={e => {const file = e.target.files[0];e.target.value = '';if(file) onImport(file);}}/></div><div className="filter-tabs"><button className={!category ? 'active' : ''} onClick={() => setCategory('')}>全部 <span>{state.presets.length}</span></button>{Object.entries(CATEGORIES).map(([id,item]) => <button key={id} className={category === id ? 'active' : ''} onClick={() => setCategory(id)}>{item.label}<span>{state.presets.filter(row => row.category === id).length}</span></button>)}</div>
    <div className="database-note"><Database size={14}/><span>SQLite 提詞庫</span><i/><span>名稱 · 內容 · 標籤搜尋</span><span className="search-results">{loading ? '搜尋中…' : `${result.total} 個結果`}</span></div>
    {error ? <p className="inline-error">{error}</p> : result.rows.length ? <div className="preset-grid">{result.rows.map(row => <button className="preset-card" onClick={() => onEdit(row)} key={row.id}><div className="preset-card-header"><span className={`category-badge ${row.category}`}>{CATEGORIES[row.category].label}</span><MoreHorizontal size={18}/></div><h3>{row.name}</h3><p>{row.category === 'camera' ? cameraAngleLabel(cameraPreset(row).angle) : row.prompt}</p><Tags tags={row.tags}/></button>)}</div> : !loading && <Empty icon={Search} title="沒有符合的提詞" description="換個關鍵字，或新增你想要的描述。"/>}
    {result.total > 24 && <div className="pagination"><button className="button secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0,offset - 24))}><ChevronLeft size={16}/>上一頁</button><span>{Math.floor(offset / 24) + 1} / {Math.ceil(result.total / 24)}</span><button className="button secondary" disabled={offset + 24 >= result.total} onClick={() => setOffset(offset + 24)}>下一頁<ChevronRight size={16}/></button></div>}
  </div>;
}

function Studio({state,draft,setDraft,onPick,onUpload,onCreate,onExport,onSettings,onChoosePreset,onAddOptionalPreset,busy,saved,notify,connected}) {
  const [previewTab,setPreviewTab] = useState('prompt');
  const [advanced,setAdvanced] = useState(false);
  const random = draft.mode === 'random';
  const all = random && draft.randomPoolMode === 'all';
  const allGarments = all && !draft.garmentIds.length;
  const outputSize = getOutputSize(draft.aspectRatio || 'reference',Number(draft.resolution));
  const character = state.characters.find(row => row.id === draft.characterId);
  const garments = state.garments.filter(row => draft.garmentIds.includes(row.id));
  let recipe,error = '';
  try {recipe = getShotRecipe(state,draft);} catch(cause) {error = cause.message;}
  const pools = recipe?.pools || {};
  const sample = Object.fromEntries(Object.entries(pools).map(([key,rows]) => [key,rows[0]]));
  const prompt = composePrompt({character,...sample,sceneInteraction:draft.sceneInteraction,extra:draft.extra,cameraMode:draft.cameraMode});
  const count = recipe?.count || 0;
  const copies = Number(draft.copies);
  const stepsValid = Number.isInteger(Number(draft.steps)) && Number(draft.steps) >= 1 && Number(draft.steps) <= 100;
  const missing = Object.entries(pools).find(([,rows]) => !rows.length)?.[0];
  const missingLabels = {garment:'服裝',pose:'動作',camera:'攝影角度',lighting:'光線',color:'色彩',quality:'畫質',expression:'表情',clothingState:'服裝狀態',interaction:'場景互動'};
  const cameraSettingsValid = Number.isInteger(Number(draft.angleSteps)) && Number(draft.angleSteps) >= 1 && Number(draft.angleSteps) <= 100 && Number(draft.refineDenoise) >= 0.05 && Number(draft.refineDenoise) <= 0.4;
  const valid = Boolean(cameraSettingsValid && (draft.cameraMode !== 'multiangle' || state.cameraWorkflow?.ready) && character && recipe && stepsValid && !missing && Number.isInteger(count) && count > 0 && count <= 100 && (random || Number.isInteger(copies) && copies >= 1 && copies <= 10));
  const selectedFor = category => {
    const ids = PRESET_POOL_FIELDS[category] ? selectedPresetIds(draft,category) : draft[OPTIONAL_PRESET_FIELDS[category]] ? [draft[OPTIONAL_PRESET_FIELDS[category]]] : [];
    return ids.map(id => state.presets.find(row => row.id === id && row.category === category)).filter(Boolean);
  };
  const poolField = (category,optional = false) => <PresetPoolField key={category} category={category} selected={selectedFor(category)} optional={optional}
    allCount={all ? state.presets.filter(row => row.category === category).length : undefined}
    randomEnabled={draft.randomOptional?.[category] || false}
    onRandomToggle={random && optional ? enabled => setDraft(current => ({...current,randomOptional:{...current.randomOptional,[category]:enabled}})) : undefined}
    onOpen={() => onChoosePreset(category)} onClear={() => setDraft(current => ({...current,[OPTIONAL_PRESET_FIELDS[category]]:''}))}
    onAdd={() => onAddOptionalPreset(category,'')} busy={busy}/>;
  const combinations = [];
  if (!random && recipe && !missing) {
    const entries = Object.entries(pools);
    for(let index = 0; index < Math.min(Number(recipe.combinationCount),20); index++) {
      let rest = index;const row = {};
      for(let i = entries.length - 1; i >= 0; i--) {const [key,items] = entries[i];row[key] = items[rest % items.length];rest = Math.floor(rest / items.length);}
      combinations.push(row);
    }
  }
  return <div className="studio-layout"><div className="studio-controls">
    <div className="panel shooting-mode-panel">
      <div className="shooting-mode-tabs" role="group" aria-label="拍攝模式">
        <button aria-pressed={!random} className={!random ? 'active' : ''} onClick={() => setDraft(current => ({...current,mode:'combinations'}))}><Layers3 size={16}/>候選組合</button>
        <button aria-pressed={random} className={random ? 'active' : ''} onClick={() => setDraft(current => ({...current,mode:'random'}))}><WandSparkles size={16}/>隨機寫真</button>
      </div>
      {random ? <><p className="field-help">選角色與張數，自動搭配服裝、動作、攝影角度、光線、色彩與畫質。每張各取一項候選。</p><div className="random-mode-settings"><label>隨機張數<input aria-label="隨機張數" type="number" min={1} max={100} value={draft.randomCount} onChange={e => setDraft(current => ({...current,randomCount:e.target.value}))}/></label><label>候選範圍<select aria-label="隨機候選範圍" value={draft.randomPoolMode} onChange={e => setDraft(current => ({...current,randomPoolMode:e.target.value}))}><option value="all">全部提詞庫</option><option value="selected">僅已選候選</option></select></label></div><p className="field-help">預設 30 張。表情、服裝狀態、場景互動預設無，可各別啟用。比例與生成設定沿用下方設定。</p></> : <p className="field-help">所選候選會逐一組合；每張照片各使用一個角度、光線、色彩與畫質。組合太多時可改用隨機寫真。</p>}
      <div className="basic-generation-settings">
      <div className="output-ratio-field"><label>輸出比例<select aria-label="輸出比例" value={draft.aspectRatio || 'reference'} onChange={e => setDraft(current => ({...current,aspectRatio:e.target.value}))}>{Object.entries(OUTPUT_RATIOS).map(([id,option]) => <option key={id} value={id}>{option.label}</option>)}</select></label><p className="field-help">{outputSize ? `預計輸出 ${outputSize.width} × ${outputSize.height} px` : '輸出尺寸跟隨人物參考圖的比例。'}</p></div>
        <div className="sampling-steps-field"><label>採樣步數<input aria-label="採樣步數" type="number" inputMode="numeric" min={1} max={100} step={1} value={draft.steps} onChange={e => setDraft(current => ({...current,steps:e.target.value}))}/></label><div className="step-shortcuts" role="group" aria-label="常用步數">{[20,30,40,60].map(value => <button key={value} aria-label={`設為 ${value} 步`} aria-pressed={Number(draft.steps) === value} onClick={() => setDraft(current => ({...current,steps:value}))}>{value} 步</button>)}</div><p className="field-help">可設 1–100 步，套用到本次所有圖片。</p>{!stepsValid && <p className="inline-error">請輸入 1–100 的整數步數。</p>}</div>
      </div>
    </div>
    <div className="panel reference-panel">
      <SectionTitle number="01" title="搭配參考圖" description={random ? `服裝從${allGarments ? '全部圖庫' : '已選服裝'}的 ${allGarments ? state.garments.length : garments.length} 套候選隨機挑選。` : '角色與服裝，組成這次拍攝的基礎。'}><span className="tiny-label">兩張參考圖</span></SectionTitle>
      <div className="reference-grid"><ReferenceCard number="1" kind="characters" asset={character} onPick={() => onPick('characters')} onUpload={onUpload} busy={busy}/><ReferenceCard number="2" kind="garments" asset={allGarments ? state.garments[0] : garments[0]} count={allGarments ? state.garments.length : garments.length} onPick={() => onPick('garments')} onUpload={onUpload} busy={busy}/></div>
      {random && <div className="garment-pool-source"><span>{allGarments ? '服裝池：全部圖庫' : `服裝池：已選 ${garments.length} 套`}</span>{!allGarments && <button onClick={() => setDraft(current => ({...current,garmentIds:[],randomPoolMode:'all'}))}>使用全部服裝</button>}</div>}
      {!allGarments && garments.length > 1 && <div className="selected-garments">{garments.slice(0,3).map(row => <button key={row.id} onClick={() => setDraft({...draft,garmentIds:toggle(draft.garmentIds,row.id)})}><Shirt size={12}/>{row.name}<X size={12}/></button>)}{garments.length > 3 && <button onClick={() => onPick('garments')}>另 {garments.length - 3} 套</button>}</div>}
    </div>
    <div className="panel"><SectionTitle number="02" title="動作與細節" description="按「選擇提詞」或「修改提詞選擇」，搜尋與調整候選。"/><div className="prompt-pool-grid">{poolField('pose')}{Object.keys(OPTIONAL_PRESET_FIELDS).map(category => poolField(category,true))}</div>
      <label className="extra-field">場景互動補充 <span>選填</span><textarea aria-label="場景互動" rows={2} maxLength={20000} value={draft.sceneInteraction || ''} onChange={e => setDraft({...draft,sceneInteraction:e.target.value})} placeholder="也可以自由輸入，或補充已選提詞的細節…"/></label><button className="save-interaction-prompt" disabled={busy || !draft.sceneInteraction?.trim()} onClick={() => onAddOptionalPreset('interaction',draft.sceneInteraction)}><Plus size={13}/>存為互動提詞</button>
    </div>
    <div className="panel"><SectionTitle number="03" title="攝影風格" description="可複選各類候選；每張照片會使用一組攝影設定。"/>
      <div className="prompt-pool-grid">{['camera','lighting','color','quality'].map(category => poolField(category))}</div>
      <label className="extra-field">補充拍攝提詞 <span>選填</span><textarea rows={3} value={draft.extra} onChange={e => setDraft({...draft,extra:e.target.value})} placeholder="例如：微風吹動髮絲，表情放鬆，服裝的刺繡細節要清晰…"/></label>
      <button className="advanced-toggle" onClick={() => setAdvanced(!advanced)}><Settings2 size={14}/>進階生成設定<ChevronDown size={14} className={advanced ? 'rotated' : ''}/></button>
      {advanced && <div className="advanced-settings"><div className="form-grid"><label>參考解析度<select value={draft.resolution} onChange={e => setDraft({...draft,resolution:Number(e.target.value)})}>{[1024,1536,2048].map(value => <option key={value} value={value}>{value} × {value} 等效面積</option>)}</select></label><label>Seed<input type="number" min={-1} max={281474976710555} value={draft.seed} onChange={e => setDraft({...draft,seed:e.target.value})}/></label>{!random && <label>每組張數<input type="number" min={1} max={10} value={draft.copies} onChange={e => setDraft({...draft,copies:e.target.value})}/></label>}</div><p className="field-help">Seed -1 為隨機。輸出尺寸依上方比例設定，參考圖會保留原比例。</p><label>負面提詞<textarea rows={3} value={draft.negative} onChange={e => setDraft({...draft,negative:e.target.value})}/></label></div>}
    </div>
  </div><aside className="shoot-preview">
    <div className="preview-heading"><div><span className="eyebrow">SHOOTING BRIEF</span><h2>{random ? '這次的隨機寫真' : '這次的拍攝企劃'}</h2></div><Aperture size={25} strokeWidth={1.3}/></div>
    <div className="contact-sheet"><div className="sheet-large">{character ? <img src={character.image} alt={character.name}/> : <div className="sheet-placeholder"><UserRound size={40} strokeWidth={1}/><span>YOUR CHARACTER</span></div>}<span className="sheet-caption">01 / 角色</span></div><div className="sheet-small">{sample.garment ? <img src={sample.garment.image} alt={sample.garment.name}/> : <div className="sheet-placeholder"><Shirt size={25} strokeWidth={1}/></div>}<span className="sheet-caption">02 / {random ? '服裝候選範例' : '服裝'}</span></div><div className="contact-label">PHOTO / CREATE</div></div>
    <div className="brief-details">{random ? <span>每張隨機搭配 · 盡量使用不同組合</span> : ['camera','lighting','color'].map(key => <span key={key}>{pools[key]?.length || 0} 項{CATEGORIES[key].label}</span>)}</div>
    <div className="preview-tabs"><button className={previewTab === 'prompt' ? 'active' : ''} onClick={() => setPreviewTab('prompt')}>{random ? '提詞範例' : '提詞預覽'}</button><button className={previewTab === 'shots' ? 'active' : ''} onClick={() => setPreviewTab('shots')}>{random ? '候選範圍' : '拍攝組合'} <span>{count || 0}</span></button><button className="copy-button" title="複製完整提詞" aria-label="複製完整提詞" onClick={async () => {try {await navigator.clipboard.writeText(prompt);notify('已複製完整提詞。');} catch {notify('無法存取剪貼簿，請直接選取提詞複製。','error');}}}><Clipboard size={15}/></button></div>
    {previewTab === 'prompt' ? <div className="prompt-preview">{random && <small className="random-preview-note">這是候選提詞範例；各張隨機結果會保存於拍攝清單。</small>}<p>{prompt}</p></div> : <div className="shot-combinations">{random ? Object.entries(pools).map(([key,rows]) => <div className="pool-scope-row" key={key}><span>{missingLabels[key]}</span><strong>{rows.length === 1 && rows[0] === null ? '無' : `${rows.length} 項候選`}</strong></div>) : combinations.map((row,index) => <div className="combination" key={index}><img src={row.garment.image} alt=""/><div><strong>{row.garment.name}</strong><span>{[row.pose.name,row.camera.name,row.lighting.name,row.color.name,row.quality.name].join(' · ')}</span></div><small>× {copies}</small></div>)}{!random && recipe && Number(recipe.combinationCount) > 20 && <p className="muted">僅預覽前 20 組，全部會包含在拍攝清單。</p>}</div>}
    <div className="preview-footer"><label className="batch-name-field">拍攝組名稱 <span>選填</span><input aria-label="拍攝組名稱" maxLength={200} value={draft.batchName || ''} onChange={e => setDraft({...draft,batchName:e.target.value})} placeholder="例如：海邊夏日寫真"/></label>
      <div className="shoot-total"><div><span>{random ? '指定生成' : '預計建立'}</span><strong>{count || '—'}<small>張寫真</small></strong></div><div className="total-formula">{random ? '按指定張數抽取候選組合' : `${recipe ? Number(recipe.combinationCount).toLocaleString('zh-TW') : 0} 種組合 × ${copies} 張`}</div></div>
      <div className="readiness"><span className={character ? 'done' : ''}>{character ? <CheckCircle2 size={13}/> : <Circle size={13}/>} 角色</span><span className={pools.garment?.length ? 'done' : ''}>{pools.garment?.length ? <CheckCircle2 size={13}/> : <Circle size={13}/>} 服裝池</span></div>
      {error && <p className="inline-error">{error}</p>}{missing && <p className="inline-error">請選擇{missingLabels[missing]}候選{all ? '，可先上傳圖片或新增提詞' : ''}。</p>}
      {count > 100 && <p className="inline-error">每批最多 100 張。可減少候選，或改用隨機寫真指定張數。</p>}
      {random && (!Number.isInteger(count) || count < 1) && <p className="inline-error">請輸入 1–100 張。</p>}
      <details className="camera-pipeline-settings"><summary>相機製作設定</summary><div className="camera-edit-settings"><label>換角度步數<input type="number" min="1" max="100" value={draft.angleSteps} onChange={event => setDraft(current => ({...current,angleSteps:Number(event.target.value)}))}/></label><label>高清修正強度<input type="number" min="0.05" max="0.4" step="0.05" value={draft.refineDenoise} onChange={event => setDraft(current => ({...current,refineDenoise:Number(event.target.value)}))}/></label></div><p className="field-help">先生成原圖，再用相機参数換角度，最後只修正清晰度。</p></details>
      <button className="button primary create-shots" disabled={busy || !valid || random && (!connected || !state.workflow.ready)} onClick={onCreate}>{busy ? <Loader2 size={17} className="spin"/> : random ? <WandSparkles size={17}/> : <Layers3 size={17}/>} {random ? '隨機組合並生成' : '建立拍攝清單'}<ArrowRight size={17}/></button>
      <button className="button export-shots" disabled={busy || !valid} onClick={onExport}><ArrowDownToLine size={15}/>匯出拍攝 JSON</button><p className="preview-note">{random ? connected && state.workflow.ready ? '只送出這次新建的拍攝組；每張的組合與提詞都會保存。' : '連接 ComfyUI 並載入工作流後，即可一鍵生成。' : '同一次建立會收成一組，再到組內查看或生成。'}</p>
    </div><div className="save-status"><Database size={12}/>{saved === 'saving' ? '保存中…' : saved === 'error' ? '保存失敗，請重試' : '已保存至本機 SQLite'}<button onClick={onSettings}>工作流設定<ArrowRight size={12}/></button></div>
  </aside></div>;
}

function PromptBlock({title,text,compact = false}) {
  const [copied,setCopied] = useState(false);
  const [error,setError] = useState('');
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current),[]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setError('');setCopied(true);clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false),2000);
    } catch {setCopied(false);setError('無法存取剪貼簿，請選取提詞手動複製。');}
  };
  return <section className="prompt-block" aria-label={title}><div className="prompt-block-heading"><h3>{title}</h3><button type="button" className="button secondary prompt-copy" aria-label={`複製${title}`} disabled={!text} onClick={copy}>{copied ? <Check size={14}/> : <Clipboard size={14}/>}<span aria-live="polite">{copied ? '已複製' : '複製'}</span></button></div><pre className={`inspect-prompt ${compact ? 'compact' : ''}`}>{text || '（無）'}</pre>{error && <p className="inline-error" role="status">{error}</p>}</section>;
}

function JobInspector({job,onClose,onExport}) {
  const preview = productionPreview(job);
  return <Modal title={job.name} onClose={onClose} wide>
    <div className="modal-body job-inspector">
      {job.images?.length ? <div className="result-images">{job.images.map((_,index) => <div key={index}><img src={`/api/jobs/${job.id}/image/${index}`} alt={`${job.name} ${index + 1}`}/><a className="button secondary" href={`/api/jobs/${job.id}/image/${index}?download=1`} download><Download size={15}/>下載原圖</a></div>)}</div> : preview ? <div className="result-images stage-image-preview"><div><img src={preview.src} alt={`${job.name} · ${preview.label}`}/><small className="muted">目前預覽：{preview.label}</small></div></div> : <div className="inspector-refs">{['character','garment','scene'].filter(kind => job[kind]).map((kind,index) => <div key={kind}><img src={job[kind].image} alt={job[kind].name}/><span>{`<image${index + 1}>`} · {job[kind].name}</span></div>)}</div>}
      <div className="job-detail-strip"><span className={`status-badge ${job.status}`}>{productionStatus(job) || STATUS[job.status]}</span>{job.remakeVersion && <span>重製 {job.remakeVersion}</span>}</div>
      {job.outputsDeletedAt && <p className="muted">{job.replacedByJobId ? '舊成果已由重製版本取代。' : '這次拍攝的成果圖片已刪除。'}</p>}
      {job.error && <p className="inline-error">{job.error}</p>}
      <ShotOptions job={job} detailed/>{job.executionMode === 'staged' && <p className="field-help">製作順序：{job.jobKind === 'angle-edit' ? '轉視角 → 高清修正' : '產原圖 → 轉視角 → 高清修正'}。各階段完成後保存中間圖，暫停後可接續。</p>}
      <PromptBlock title="完整提詞" text={job.prompt}/>
      <PromptBlock title="負面提詞" text={job.negative || ''} compact/>
      {job.cameraMode === 'multiangle' && <details className="camera-stage-prompts"><summary>換角度與高清修正提詞</summary><PromptBlock title="換角度提詞" text={cameraPrompt(job.camera.angle)}/><PromptBlock title="高清修正提詞" text={REFINE_PROMPT}/></details>}
      <small className="muted">建立時間：{new Date(job.createdAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})}{job.promptId && ` · ComfyUI ID: ${job.promptId}`}</small>
    </div>
    <div className="modal-footer"><span className="muted">參考圖與提詞已保存在此任務。</span><button className="button secondary" onClick={() => onExport(job)}><FileJson size={16}/>匯出 API JSON</button></div>
  </Modal>;
}

function BatchSettings({batch,onClose,onRename,onDelete,busy}) {
  return <Modal title="拍攝組設定" onClose={onClose}><div className="modal-body batch-settings-body"><p className="batch-settings-name">{batch.name}</p><button className="batch-setting-row" disabled={busy} onClick={() => onRename(batch)}><Settings2 size={18}/><span><strong>重新命名</strong><small>修改這組拍攝的名稱</small></span><ChevronRight size={16}/></button><button className="batch-setting-row danger-row" disabled={busy || batch.active} onClick={() => onDelete(batch)}><Trash2 size={18}/><span><strong>移除拍攝組</strong><small>{batch.active ? '完成或暫停製作後可移除' : '移除清單紀錄，保留已保存的成果圖片'}</small></span><ChevronRight size={16}/></button></div></Modal>;
}

function BatchRename({batch,onClose,onSave,busy}) {
  const [name,setName] = useState(batch.name);
  return <Modal title="重新命名拍攝組" onClose={onClose}><form onSubmit={e => {e.preventDefault();onSave(name);}}><div className="modal-body"><label>拍攝組名稱<input required maxLength={200} value={name} onChange={e => setName(e.target.value)}/></label></div><div className="modal-footer"><span className="muted">這組有 {batch.total} 張照片。</span><button className="button primary" disabled={busy || !name.trim()}><Check size={16}/>保存名稱</button></div></form></Modal>;
}

function SettingsModal({state,status,onSave,onLoad,onImport,onClose,onActivate,onBound,onBeforeTransfer,onImported,busy}) {
  const [tab,setTab] = useState('environment');
  const [paths,setPaths] = useState([]);
  const [workflowPath,setWorkflowPath] = useState('Qwen Image 2.1/02 Qwen Image 2.1 Uncensored 5090 High Quality - 圖生圖.json');
  const [error,setError] = useState('');
  const input = useRef(null);
  useEffect(() => {api('/comfy/workflows').then(setPaths).catch(error => setError(error.message));},[state.settings.comfyUrl]);
  return <Modal title="工作室設定" onClose={onClose} wide>
    <div className="settings-tabs" role="tablist" aria-label="工作室設定分頁"><button role="tab" aria-selected={tab==='environment'} onClick={()=>setTab('environment')}>環境與工作流</button><button role="tab" aria-selected={tab==='transfer'} onClick={()=>setTab('transfer')}>資料搬移</button></div>
    <div className="modal-body form-stack">
      <div hidden={tab!=='transfer'}><DataTransfer state={state} api={api} onBeforeTransfer={onBeforeTransfer} onImported={onImported} busy={busy}/></div>
      <div className="form-stack" hidden={tab!=='environment'}>
        <EnvironmentSetup settings={state.settings} api={api} onSave={onSave} onActivate={onActivate} onBound={onBound} busy={busy}/>
        <div className={`connection-message ${status.connected ? 'online' : ''}`}><span className="status-dot"/>{status.connected ? `${status.device} · ${state.settings.comfyUrl}` : status.error || '尚未連線'}</div>
        <details className="environment-manual-workflow"><summary>手動載入與匯入工作流</summary><label>從 ComfyUI 讀取已保存的工作流<select value={workflowPath} onChange={e => setWorkflowPath(e.target.value)}>{!paths.includes(workflowPath) && <option value={workflowPath}>{workflowPath}</option>}{paths.map(value => <option key={value} value={value}>{value}</option>)}</select></label>{error && <p className="inline-error">{error}</p>}<div className="workflow-actions"><button className="button primary" disabled={busy || !status.connected} onClick={() => onLoad(workflowPath)}><RefreshCw size={16}/>載入工作流</button><button className="button secondary" disabled={busy} onClick={() => input.current.click()}><Upload size={16}/>匯入工作流 JSON</button><input ref={input} hidden type="file" accept=".json,application/json" onChange={e => {const file = e.target.files[0];e.target.value='';if(file) onImport(file);}}/></div><button className="button secondary" disabled={busy || !status.connected} onClick={() => onLoad(state.settings.cameraWorkflowPath && state.settings.cameraWorkflowPath!=='bundled' ? state.settings.cameraWorkflowPath : 'Qwen Multiangle/01 Qwen 2511 - 單圖 3D 相機換角度.json')}><RefreshCw size={15}/>載入相機工作流</button></details>
        <div className="workflow-summary"><div><Aperture size={22}/><strong>{state.workflow.ready ? '角色與服裝工作流已就緒' : '尚未載入工作流'}</strong></div><p>{state.workflow.name}</p>{state.workflow.ready && <><div className="workflow-stats"><span>{state.workflow.steps} steps</span><span>CFG {state.workflow.cfg}</span><span>{state.workflow.sampler} / {state.workflow.scheduler}</span></div><code>{state.workflow.model}</code></>}<p className="field-help">{'<image1>'} 角色 · {'<image2>'} 服裝</p></div>
        <div className="camera-workflow-summary"><strong>{state.cameraWorkflow?.ready ? '3D 相機工作流已就緒' : '3D 相機工作流尚未載入'}</strong><p className="field-help">{state.cameraWorkflow?.error || '換角度後使用 Qwen 2.1 低強度修正，保留內容。'}</p></div>
      </div>
    </div><div className="modal-footer"><span className="muted">PhotoCreate Studio · v1.0</span><button className="button secondary" onClick={onClose}>完成</button></div>
  </Modal>;
}

export default function App() {
  const [state,setState] = useState(null);
  const [draft,setDraft] = useState(DEFAULT_DRAFT);
  const [page,setPage] = useState('studio');
  const [modal,setModal] = useState(null);
  const [status,setStatus] = useState({connected:false,checking:true});
  const [busy,setBusy] = useState(false);
  const [stopping,setStopping] = useState(false);
  const [submittingIds,setSubmittingIds] = useState([]);
  const stopInFlight = useRef(false);
  const [saved,setSaved] = useState('saved');
  const [toast,setToast] = useState(null);
  const [loadError,setLoadError] = useState('');
  const initialized = useRef(false);
  const saveChain = useRef(Promise.resolve());
  const draftSaveTimer = useRef(null);
  const toastTimer = useRef(null);
  const notify = (message,type = 'success') => {setToast({message,type});clearTimeout(toastTimer.current);toastTimer.current = setTimeout(() => setToast(null),6000);};
  const reload = async () => {const data = await api('/state');setState(data);return data;};
  const checkConnection = async () => {setStatus(value => ({...value,checking:true}));const result = await api('/comfy/status');setStatus({...result,checking:false});return result;};
  useEffect(() => {
    Promise.all([api('/state'),api('/comfy/status')]).then(([data,connection]) => {const {sceneId:unusedScene,referencePrompts:unusedReferencePrompts,...savedDraft} = data.draft || {};setState(data);setDraft({...DEFAULT_DRAFT,...savedDraft,...Object.fromEntries(Object.entries(PRESET_POOL_FIELDS).map(([category,field]) => [field,savedDraft[field] ?? (savedDraft[`${category}Id`] ? [savedDraft[`${category}Id`]] : DEFAULT_DRAFT[field])])),aspectRatio:Object.hasOwn(OUTPUT_RATIOS,savedDraft.aspectRatio) ? savedDraft.aspectRatio : 'reference'});setStatus({...connection,checking:false});initialized.current = true;}).catch(error => setLoadError(error.message));
    const timer = setInterval(() => api('/comfy/status').then(result => setStatus({...result,checking:false})).catch(() => setStatus({connected:false})),20000);
    return () => {clearInterval(timer);clearTimeout(toastTimer.current);};
  },[]);
  useEffect(() => {
    if(!initialized.current) return;
    setSaved('saving');
    const timer = draftSaveTimer.current = setTimeout(() => {
      saveChain.current = saveChain.current.catch(() => {}).then(() => api('/draft',{method:'PUT',body:draft})).then(() => setSaved('saved')).catch(error => {setSaved('error');notify(error.message,'error');});
    },450);
    return () => clearTimeout(timer);
  },[draft]);
  const flushDraft = async () => {
    clearTimeout(draftSaveTimer.current);
    saveChain.current = saveChain.current.catch(()=>{}).then(()=>api('/draft',{method:'PUT',body:draft}));
    await saveChain.current;setSaved('saved');
  };
  const importedData = async result => {
    const data=await reload();
    if(result.draftApplied) {clearTimeout(draftSaveTimer.current);setDraft({...structuredClone(DEFAULT_DRAFT),...data.draft});}
  };
  const activeJobs = submittingIds.length > 0 || state?.jobs.some(job => STOPPABLE_STATUSES.includes(job.status));
  useEffect(() => {
    if(!activeJobs) return;
    let running = false;
    const timer = setInterval(async () => {if(running) return;running = true;try {const jobs = await api('/jobs/sync',{method:'POST'});setState(current => ({...current,jobs}));} catch { /* Connection badge reports outages. */ } finally {running = false;}},4500);
    return () => clearInterval(timer);
  },[activeJobs]);
  useEffect(() => {
    if(!state || state.workflow.ready) return;
    const timer = setTimeout(() => reload().catch(() => {}),2000);
    return () => clearTimeout(timer);
  },[state?.workflow.ready]);

  async function run(action,success) {
    if(busy || stopping) return;
    setBusy(true);
    try {const result = await action();await reload();if(success) notify(typeof success === 'function' ? success(result) : success);return result;}
    catch(error) {await reload().catch(() => {});notify(error.message,'error');throw error;}
    finally {setBusy(false);}
  }
  const safely = promise => promise?.catch(() => {});
  const onUpload = async (kind,fileList) => {
    const files = Array.from(fileList || []);
    if(!files.length) return;
    if(files.length > 50) {notify('每批最多 50 張圖片，請分批匯入。','error');return;}
    if(files.some(file => file.size > 25 * 1024 * 1024)) {notify('每張圖片最多 25 MB。','error');return;}
    const form = new FormData();for(const file of files) form.append('images',file);
    try {const rows = await run(() => api(`/assets/${kind}`,{method:'POST',body:form}),data => `已匯入 ${data.length} 張${ASSET_LABELS[kind].name}圖。`);if(!rows) return;setDraft(current => kind === 'garments' ? {...current,garmentIds:[...new Set([...current.garmentIds,...rows.map(row => row.id)])]} : {...current,characterId:rows[0].id});} catch { /* run shows error */ }
  };
  const importPresets = async input => {
    const parsed = input instanceof File ? JSON.parse(await input.text()) : input;
    return run(() => api('/presets/import',{method:'POST',body:parsed}),data => `已匯入／更新 ${data.count} 個提詞。`);
  };
  const sendJobs = async ids => {
    setSubmittingIds(ids);
    try {
      const request = api('/jobs/submit',{method:'POST',body:{ids}});
      reload().catch(() => {});
      return await request;
    } finally {setSubmittingIds([]);}
  };
  const stopJobs = target => safely((async () => {
    if(!state.features?.stopJobs) {notify('重新啟動 PhotoCreate 後即可使用停止功能。','error');return;}
    if(stopInFlight.current) return;
    stopInFlight.current = true;
    setStopping(true);
    try {
      const result = await api('/jobs/stop',{method:'POST',body:target});
      setState(current => ({...current,jobs:result.jobs}));
      const failed = result.results.filter(row => !row.ok);
      if(failed.length) notify(`${failed.length} 個停止要求尚未確認：${failed[0].error || '請更新狀態或再次停止。'}`,'error');
      else notify(result.results.length ? `已送出 ${result.results.length} 個任務的停止要求，保留已完成圖片。` : '目前沒有需要停止的製作。');
    } catch(error) {notify(error.message,'error');await reload().catch(() => {});}
    finally {stopInFlight.current = false;setStopping(false);}
  })());
  const submitJobs = ids => safely(run(async () => {
    const result = await sendJobs(ids);
    const failed = result.results.find(row => !row.ok && !row.stopped);
    if(failed) notify(`已送出 ${result.results.filter(row => row.ok).length} 項；${failed.error}`,'error');
    else if(result.results.some(row => row.stopped)) notify('製作已停止，已完成圖片已保留。');
    else notify(`已送出 ${result.results.length} 個任務至 ComfyUI。`);
    return result;
  }));
  const remakeJobs = (ids,options) => safely(run(async () => {
    const created = await api('/jobs/remake',{method:'POST',body:{ids,requestId:crypto.randomUUID(),...options}});
    const ready = created.jobs.filter(job => RETRYABLE_STATUSES.includes(job.status)).map(job => job.id);
    if(!ready.length) return created;
    const result = await sendJobs(ready);
    const failed = result.results.find(row => !row.ok && !row.stopped);
    if(failed) notify(`已送出 ${result.results.filter(row => row.ok).length} 張重製；${failed.error}`,'error');
    else if(result.results.some(row => row.stopped)) notify('重製已停止，原成果已保留。');
    else notify(`已送出 ${result.results.length} 張重製，完成後會更新畫廊。`);
    return {...created,results:result.results};
  }));
  const deleteOutputs = ids => safely(run(() => api('/jobs/outputs/delete',{method:'POST',body:{ids}}),'已刪除所選成果圖片。'));
  const syncResults = () => safely(run(() => api('/jobs/sync',{method:'POST'}),'成果已更新。'));
  const exportJob = job => safely(run(async () => {downloadJson(await api(`/jobs/${job.id}/prompt`),`${job.name}.api.json`);}));
  const closeModal = () => setModal(null);
  const currentInfo = page === 'studio' ? {title:'拍攝工作檯',subtitle:'把每一套服裝，變成一組有風格的寫真。',eyebrow:'CREATE YOUR NEXT SHOOT'} : page === 'garments' ? {...ASSET_LABELS.garments,eyebrow:'THE WARDROBE'} : page === 'references' ? {title:'角色參考',subtitle:'保存角色的外貌與辨識特徵。',eyebrow:'YOUR VISUAL REFERENCES'} : page === 'presets' ? {title:'提詞資料庫',subtitle:'收集好用的描述，讓每一次拍攝都更有方向。',eyebrow:'THE PROMPT COLLECTION'} : page === 'gallery' ? {title:'成果畫廊',subtitle:'挑選喜歡的照片，不滿意的勾選重製。',eyebrow:'REVIEW YOUR PHOTOGRAPHS'} : {title:'拍攝清單',subtitle:'每次拍攝收成一組，進入組內查看照片與生成進度。',eyebrow:'FROM BRIEF TO PHOTOGRAPH'};
  if(!state) return <div className="app-loading"><Aperture size={42} strokeWidth={1.1}/><h1>PhotoCreate</h1>{loadError ? <><p>{loadError}</p><button className="button primary" onClick={() => location.reload()}>重新連線</button></> : <p><Loader2 size={16} className="spin"/>正在開啟你的寫真工作檯…</p>}</div>;
  return <div className="app-shell"><aside className="sidebar"><a href="#" className="brand" onClick={e => {e.preventDefault();setPage('studio');}}><span className="brand-icon"><Aperture size={25} strokeWidth={1.3}/></span><span>PhotoCreate<small>YOUR PRIVATE PHOTO STUDIO</small></span></a><div className="workspace-label">WORKSPACE <span>本機工作室</span></div><nav>{PAGES.map(item => <button key={item.id} aria-label={item.label} className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => setPage(item.id)}><item.icon size={18} strokeWidth={1.6}/><span>{item.label}</span>{item.id === 'garments' && state.garments.length > 0 && <small>{state.garments.length}</small>}{item.id === 'jobs' && state.batches?.length > 0 && <small>{state.batches.length}</small>}</button>)}</nav><div className="sidebar-bottom"><div className="studio-note"><span className="note-line"/><span className="eyebrow">MADE FOR YOUR IDEAS</span><p>一張參考圖，<br/>一個新的拍攝故事。</p><Camera size={25} strokeWidth={1}/></div><button className="sidebar-settings" onClick={() => setModal({type:'settings'})}><Settings2 size={17}/>工作流與連線設定</button><div className="local-storage"><Database size={13}/><span>SQLite · 本機保存</span><span className="status-dot"/></div></div></aside>
    <main className="main-content"><header className="topbar"><div className="breadcrumb">工作室<ChevronRight size={13}/><span>{currentInfo.title}</span></div><div className="topbar-actions"><button className="button danger-ghost stop-all" aria-label="停止全部製作" title="停止目前製作並保留已完成圖片" disabled={stopping || !state.features?.stopJobs || !activeJobs} onClick={() => stopJobs({all:true})}>{stopping ? <Loader2 size={14} className="spin"/> : <Square size={14}/>}停止製作</button><span className="workflow-chip"><Aperture size={13}/>Qwen Image 2.1</span><button className={`connection-pill ${status.connected ? 'online' : ''}`} onClick={() => setModal({type:'settings'})}><span className="status-dot"/>{status.checking ? '連線檢查中' : status.connected ? 'ComfyUI 已連線' : 'ComfyUI 未連線'}</button></div></header><div className="page-content"><div className="page-heading"><div><span className="eyebrow">{currentInfo.eyebrow}</span><h1>{currentInfo.title}<span className="heading-dot">.</span></h1><p>{currentInfo.subtitle}</p></div>{page === 'studio' && <div className="page-number"><span>STUDIO</span><strong>01 /</strong></div>}</div>
      {!state.features?.stopJobs && <div className="workflow-warning"><Square size={18}/><span>停止功能已更新。重新啟動 PhotoCreate 後即可使用。</span></div>}
      {!state.workflow.ready && <div className="workflow-warning"><Aperture size={18}/><span>工作流尚未就緒。你可以先管理素材與建立拍攝清單。</span><button onClick={() => setModal({type:'settings'})}>載入工作流<ArrowRight size={14}/></button></div>}
      {page === 'studio' && <Studio state={state} draft={draft} setDraft={setDraft} onPick={kind => setModal({type:'picker',kind})} onUpload={onUpload} onCreate={() => safely(run(async () => {const shots = await api('/jobs',{method:'POST',body:draft});setPage('jobs');if(draft.mode === 'random') {const result = await sendJobs(shots.map(row => row.id));const failed = result.results.filter(row => !row.ok && !row.stopped);if(failed.length) throw new Error(`已建立 ${shots.length} 張隨機寫真；${failed.length} 張送出失敗，可在組內重試。`);shots.stoppedCount = result.results.filter(row => row.stopped).length;}return shots;},shots => shots.stoppedCount ? '隨機製作已停止，已完成圖片已保留。' : draft.mode === 'random' ? `已送出 ${shots.length} 張隨機寫真。` : `已建立一組拍攝，共 ${shots.length} 張照片。`))} onExport={() => safely(run(async () => {const shots = await api('/shots/preview',{method:'POST',body:draft});downloadJson({version:1,batchName:draft.batchName || undefined,workflow:state.workflow.name,shots},'photocreate-shooting-plan.json');}))} connected={status.connected} onChoosePreset={category => setModal({type:'promptPool',category})} onSettings={() => setModal({type:'settings'})} onAddOptionalPreset={(category,initialPrompt) => setModal({type:'preset',category,initialPrompt,fromStudio:true})} busy={busy} saved={saved} notify={notify}/>}
      {page === 'garments' && <AssetLibrary kind="garments" rows={state.garments} onUpload={onUpload} onEdit={(kind,asset) => setModal({type:'asset',kind,asset})} busy={busy}/>}
      {page === 'references' && <AssetLibrary kind="characters" rows={state.characters} onUpload={onUpload} onEdit={(kind,asset) => setModal({type:'asset',kind,asset})} busy={busy}/>}
      {page === 'presets' && <PresetLibrary state={state} onEdit={(preset,category) => setModal({type:'preset',preset,category})} onImport={file => importPresets(file).catch(error => notify(error.message,'error'))} onJsonImport={() => setModal({type:'json'})} busy={busy}/>}
      {page === 'jobs' && <JobLibrary state={state} onStop={stopJobs} stopping={stopping || !state.features?.stopJobs} submittingIds={submittingIds} onSubmit={submitJobs} onSync={() => safely(run(() => api('/jobs/sync',{method:'POST'}),'拍攝狀態已更新。'))} onExport={exportJob} onRemake={remakeJobs} onAngle={(job,imageIndex) => setModal({type:'angle-edit',job,imageIndex})} onDeleteOutputs={deleteOutputs} onDelete={job => setModal({type:'delete-job',job})} onInspect={job => setModal({type:'inspect',job})} onSettingsBatch={batch => setModal({type:'batch-settings',batch})} onExportBatch={batch => downloadJson({version:1,batch:{id:batch.id,name:batch.name,createdAt:batch.createdAt},shots:batch.jobs},`${batch.name}.json`)} busy={busy} connected={status.connected}/>}
      {page === 'gallery' && <ResultGallery state={state} onRemake={remakeJobs} onAngle={(job,imageIndex) => setModal({type:'angle-edit',job,imageIndex})} onDeleteOutputs={deleteOutputs} onSubmit={submitJobs} onSync={syncResults} onInspect={job => setModal({type:'inspect',job})} busy={busy} connected={status.connected}/>}
    </div><footer className="app-footer"><span>PhotoCreate Studio</span><span>每一個靈感，都值得一張好照片。</span><span>LOCAL / PRIVATE</span></footer></main>
    {modal?.type === 'picker' && <AssetPicker kind={modal.kind} state={state} draft={draft} onSelect={values => setDraft(current => modal.kind === 'garments' ? {...current,garmentIds:values} : {...current,characterId:values[0]})} onClose={closeModal} onUpload={onUpload} busy={busy}/>}
    {modal?.type === 'promptPool' && <Modal title={`選擇${CATEGORIES[modal.category].label}提詞`} onClose={closeModal} wide><PresetPoolPicker category={modal.category} presets={state.presets} selectedIds={PRESET_POOL_FIELDS[modal.category] ? selectedPresetIds(draft,modal.category) : draft[OPTIONAL_PRESET_FIELDS[modal.category]] ? [draft[OPTIONAL_PRESET_FIELDS[modal.category]]] : []} multi={!!PRESET_POOL_FIELDS[modal.category]} randomAll={draft.mode === 'random' && draft.randomPoolMode === 'all'} api={api} busy={busy} onClose={closeModal} onAdd={() => setModal({type:'preset',category:modal.category,fromStudio:true})} onApply={values => {setDraft(current => ({...current,...(current.mode === 'random' ? {randomPoolMode:'selected'} : {}),[PRESET_POOL_FIELDS[modal.category] || OPTIONAL_PRESET_FIELDS[modal.category]]:PRESET_POOL_FIELDS[modal.category] ? values : values[0] || ''}));closeModal();}}/></Modal>}
    {modal?.type === 'asset' && <AssetEditor kind={modal.kind} asset={modal.asset} onClose={closeModal} busy={busy} onSave={fields => safely(run(async () => {await api(`/assets/${modal.kind}/${modal.asset.id}`,{method:'PATCH',body:fields});closeModal();},'資料已保存。'))} onDelete={() => safely(run(async () => {await api(`/assets/${modal.kind}/${modal.asset.id}`,{method:'DELETE'});setDraft(current => ({...current,garmentIds:current.garmentIds.filter(id => id !== modal.asset.id),characterId:current.characterId === modal.asset.id ? '' : current.characterId}));closeModal();},'已移出圖庫。'))}/>}
    {modal?.type === 'preset' && <PresetEditor preset={modal.preset} initialCategory={modal.category} initialPrompt={modal.initialPrompt} onClose={closeModal} busy={busy} onSave={preset => safely(run(async () => {await api('/presets',{method:'POST',body:preset});if(modal.fromStudio) setDraft(current => ({...current,...(PRESET_POOL_FIELDS[preset.category] ? {[PRESET_POOL_FIELDS[preset.category]]:[...new Set([...selectedPresetIds(current,preset.category),preset.id])]} : {[OPTIONAL_PRESET_FIELDS[preset.category]]:preset.id}),...(preset.category === 'interaction' && modal.initialPrompt ? {sceneInteraction:''} : {})}));closeModal();},modal.category === 'camera' || modal.preset?.category === 'camera' ? '角度已保存。' : '提詞已保存。'))} onDelete={() => safely(run(async () => {await api(`/presets/${modal.preset.id}`,{method:'DELETE'});setDraft(current => ({...current,...Object.fromEntries(Object.values(OPTIONAL_PRESET_FIELDS).filter(field => current[field] === modal.preset.id).map(field => [field,''])),...Object.fromEntries(Object.entries(PRESET_POOL_FIELDS).map(([category,field]) => [field,selectedPresetIds(current,category).filter(id => id !== modal.preset.id)]))}));closeModal();},'提詞已移除。'))}/>}
    {modal?.type === 'json' && <JsonImport onClose={closeModal} onImport={importPresets} busy={busy}/>}
    {modal?.type === 'angle-edit' && <AngleEditDialog job={modal.job} imageIndex={modal.imageIndex} sourceState={state} presets={state.presets} onClose={closeModal} busy={busy} ready={status.connected && state.cameraWorkflow?.ready} onGenerate={options => safely(run(async () => {const created = await api(`/jobs/${modal.job.id}/angle`,{method:'POST',body:options});if(RETRYABLE_STATUSES.includes(created.job.status)) {const result = await sendJobs([created.job.id]);const failed = result.results.find(row => !row.ok && !row.stopped);if(failed) throw new Error(failed.error);}closeModal();return created;},'換角度已送出，完成後會更新畫廊。'))}/>}
    {modal?.type === 'inspect' && <JobInspector job={state.jobs.find(row => row.id === modal.job.id) || modal.job} onClose={closeModal} onExport={exportJob}/>}
    {modal?.type === 'batch-settings' && <BatchSettings batch={modal.batch} onClose={closeModal} busy={busy} onRename={batch => setModal({type:'rename-batch',batch})} onDelete={batch => setModal({type:'delete-batch',batch})}/> }
    {modal?.type === 'rename-batch' && <BatchRename batch={modal.batch} onClose={closeModal} busy={busy} onSave={name => safely(run(async () => {await api(`/batches/${modal.batch.id}`,{method:'PATCH',body:{name}});closeModal();},'拍攝組名稱已保存。'))}/>}
    {modal?.type === 'delete-batch' && <Modal title="移除整組拍攝" onClose={closeModal}><div className="modal-body"><p>確定移除「{modal.batch.name}」與組內 {modal.batch.total} 張照片的拍攝紀錄？</p><p className="muted">ComfyUI 已保存的輸出圖片會保留。</p></div><div className="modal-footer"><button className="button secondary" onClick={closeModal}>取消</button><button className="button danger" disabled={busy} onClick={() => safely(run(async () => {await api(`/batches/${modal.batch.id}`,{method:'DELETE'});closeModal();},'已移除這組拍攝。'))}><Trash2 size={16}/>移除整組</button></div></Modal>}
    {modal?.type === 'delete-job' && <Modal title="移除拍攝任務" onClose={closeModal}><div className="modal-body"><p>確定移除「{modal.job.name}」？</p><p className="muted">ComfyUI 已保存的輸出圖片會保留。</p></div><div className="modal-footer"><button className="button secondary" onClick={closeModal}>取消</button><button className="button danger" disabled={busy} onClick={() => safely(run(async () => {await api(`/jobs/${modal.job.id}`,{method:'DELETE'});closeModal();},'已移除拍攝任務。'))}><Trash2 size={16}/>移除任務</button></div></Modal>}
    {modal?.type === 'settings' && <SettingsModal state={state} status={status} busy={busy} onClose={closeModal} onBeforeTransfer={flushDraft} onImported={importedData} onSave={settings => run(async () => {await api('/environment/settings',{method:'PUT',body:settings});},'安裝設定已保存，通過檢查後才切換環境。')} onActivate={()=>run(async()=>{const result=await api('/environment/activate',{method:'POST'});await checkConnection();return result;},'環境與工作流已就緒。')} onBound={()=>run(async()=>{await checkConnection();},'已綁定此 ComfyUI。')} onLoad={workflowPath => safely(run(() => api(workflowPath.includes('3D 相機換角度') ? '/camera-workflow/load' : '/workflow/load',{method:'POST',body:{path:workflowPath}}),'角色與服裝的 Qwen 工作流已就緒。'))} onImport={file => safely(run(async () => {const workflow = JSON.parse(await file.text());return api('/workflow/import',{method:'POST',body:{workflow,name:file.name.replace(/\.json$/,'')}});},'工作流已匯入。'))}/>}
    {toast && <div className={`toast ${toast.type}`} role={toast.type === 'error' ? 'alert' : 'status'}>{toast.type === 'error' ? <Circle size={17}/> : <CheckCircle2 size={17}/>}<span>{toast.message}</span><button aria-label="關閉訊息" onClick={() => setToast(null)}><X size={16}/></button></div>}
  </div>;
}
