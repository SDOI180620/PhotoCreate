import {imagePreview} from './image-preview.js';
import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronLeft, ChevronRight, Download, FileJson, FolderOpen, Layers3, Loader2, MapPin, Pause, RefreshCw, Settings2, Shirt, Square, Trash2, UserRound, WandSparkles } from 'lucide-react';
import { ACTIVE_STATUSES, BATCH_STATUS_LABELS, JOB_STATUS_LABELS, RETRYABLE_STATUSES, STOPPABLE_STATUSES, collectShootBatches, matchesBatchFilter } from '../shared/batches.js';
import { Empty, SearchBox } from './ui.jsx';
import ResultGallery from './ResultGallery.jsx';
import ShotOptions from './ShotOptions.jsx';
import {GarmentVisual} from './Garments.jsx';
import {productionPreview,productionProgress,productionStatus} from '../shared/production.js';

const BATCH_PAGE_SIZE = 12;
const SHOT_PAGE_SIZE = 24;
const BATCH_FILTERS = [['all','全部拍攝組'],['draft','有草稿'],['active','進行中'],['stopped','已停止'],['completed','已完成'],['issues','需要處理']];
const SHOT_FILTERS = [['all','全部'],['draft','草稿'],['queued','排隊中'],['running','生成中'],['stopping','停止中'],['stopped','已停止'],['completed','已完成'],['failed','失敗'],['uncertain','待確認']];
const toggle = (values,id) => values.includes(id) ? values.filter(value => value !== id) : [...values,id];
const clampOffset = (offset,total,size) => Math.min(offset,Math.max(0,(Math.ceil(total / size) - 1) * size));

function Pagination({offset,total,size,onChange,noun}) {
  if(total <= size) return null;
  return <div className="pagination" aria-label={`${noun}分頁`}><button className="button secondary" disabled={offset === 0} onClick={() => onChange(Math.max(0,offset - size))}><ChevronLeft size={16}/>上一頁</button><span>{offset + 1}–{Math.min(offset + size,total)} / {total} {noun}</span><button className="button secondary" disabled={offset + size >= total} onClick={() => onChange(offset + size)}>下一頁<ChevronRight size={16}/></button></div>;
}

function BatchProgress({batch}) {
  const progress = productionProgress(batch.jobs),fraction = progress?.fraction ?? batch.completed / batch.total;
  return <div className="batch-progress"><div><span>{progress ? progress.label : '已完成'} <strong>{progress?.completed ?? batch.completed}</strong> / {progress?.total ?? batch.total} 張</span><span>{Math.round(fraction * 100)}%</span></div><div className="batch-progress-track" role="progressbar" aria-label={`${batch.name} 完成進度`} aria-valuemin={0} aria-valuemax={batch.total} aria-valuenow={Math.round(fraction * batch.total * 100) / 100}><span style={{width:`${fraction * 100}%`}}/></div>{progress?.completed === progress?.total && progress && <small className="stage-transition-note">正在準備下一階段，中間圖已保存。</small>}</div>;
}

function BatchCard({batch,onOpen,onSubmit,onStop,onSettings,onExport,busy,canSubmit,canStop,stopping}) {
  const first = batch.jobs[0];
  const cover = batch.jobs.find(job => job.status === 'completed' && job.images?.length) || batch.jobs.find(job => productionPreview(job));
  const preview = cover && productionPreview(cover);
  const pending = batch.retryableIds.length;
  const date = new Date(batch.createdAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
  return <article className="batch-card">
    <button className="batch-cover" onClick={() => onOpen(batch.id)} aria-label={`開啟拍攝組 ${batch.name}`}>
      {preview ? <img decoding="async" loading="lazy" src={imagePreview(preview.src)} alt={batch.name}/> : <GarmentVisual garment={first.garment}/>}
      <span className={`status-badge ${batch.status}`}>{batch.active && <Loader2 size={12} className="spin"/>}{BATCH_STATUS_LABELS[batch.status]}</span>
      <span className="batch-shot-count"><Layers3 size={13}/>{batch.total} 張</span>
    </button>
    <div className="batch-details">
      <div className="batch-title-row"><button onClick={() => onOpen(batch.id)}><h2>{batch.name}</h2></button></div>
      <div className="batch-reference-names"><span><UserRound size={12}/>{first.character.name}</span>{first.scene && <span><MapPin size={12}/>{first.scene.name}</span>}</div>
      <p className="batch-recipe"><Shirt size={12}/>{first.generationMode === 'random' && '隨機寫真 · '}{batch.garments.length} 套服裝<span>·</span>{batch.poses.length} 個動作</p>
      <BatchProgress batch={batch}/>
      <div className="batch-counts"><span>{batch.counts.draft} 草稿</span>{batch.active && <span>{batch.counts.queued + batch.counts.running + batch.counts.submitting + batch.counts.stopping} 進行中</span>}{batch.counts.stopped > 0 && <span>{batch.counts.stopped} 已停止</span>}{batch.counts.failed + batch.counts.uncertain > 0 && <span className="batch-issue-count">{batch.counts.failed + batch.counts.uncertain} 需處理</span>}<time>{date}</time></div>
      <div className="batch-actions">
        <button className="button primary" disabled={busy || canStop || !canSubmit || !pending} onClick={() => onSubmit(batch.retryableIds)}><WandSparkles size={14}/>生成本組{pending > 0 && ` (${pending})`}</button>
        <button className="button secondary" disabled={stopping || !canStop} aria-label={`暫停拍攝組 ${batch.name}`} title="保留已完成照片；再次生成會接續未完成的階段。" onClick={() => onStop({batchId:batch.id})}><Pause size={14}/>暫停</button>
        <button className="icon-button batch-utility" title="匯出這組" aria-label={`匯出拍攝組 ${batch.name}`} onClick={() => onExport(batch)}><FileJson size={16}/></button>
        <button className="icon-button batch-utility" title="拍攝組設定" aria-label={`拍攝組設定 ${batch.name}`} disabled={busy} onClick={() => onSettings(batch)}><Settings2 size={16}/></button>
      </div>
    </div>
  </article>;
}

function ShotCard({job,presets,onOpenPreset,number,total,selected,onSelect,onInspect,onExport,onSubmit,onStop,onDelete,busy,canSubmit,canStop,stopping}) {
  const retryable = RETRYABLE_STATUSES.includes(job.status);
  const preview = productionPreview(job);
  return <article className="job-card"><div className="job-photo"><button className="job-inspect" onClick={() => onInspect(job)} aria-label={`檢視 ${job.name}`}>{preview ? <img decoding="async" loading="lazy" src={imagePreview(preview.src)} alt={job.name}/> : <GarmentVisual garment={job.garment}/>}</button><span className={`status-badge ${job.status}`}>{['running','submitting','stopping'].includes(job.status) && <Loader2 size={12} className="spin"/>}{productionStatus(job) || JOB_STATUS_LABELS[job.status]}</span><span className="shot-number">{String(number).padStart(2,'0')} / {total}</span>{retryable && <input aria-label={`選取 ${job.name}`} className="job-checkbox" type="checkbox" checked={selected} onChange={onSelect}/>}</div><div className="job-details"><h3>{job.garment.name}</h3><ShotOptions job={job} presets={presets} onOpenPreset={onOpenPreset}/>{job.error && <p className="job-error" title={job.error}>{job.error}</p>}<div className="job-actions"><button className="action-view" onClick={() => onInspect(job)}><FolderOpen size={14}/>詳細</button><button className="action-export" onClick={() => onExport(job)} title="匯出 API 請求"><FileJson size={14}/>JSON</button>{job.status === 'completed' && job.images?.length > 0 ? <a className="action-export" href={`/api/jobs/${job.id}/image/0?download=1`} download><Download size={14}/>下載</a> : retryable && <button className="action-generate" disabled={busy || !canSubmit} onClick={() => onSubmit([job.id])}><WandSparkles size={14}/>生成</button>}{canStop && <button className="action-stop" disabled={stopping} onClick={() => onStop({ids:[job.id]})} aria-label={`停止 ${job.name}`}><Square size={14}/>停止</button>}{!ACTIVE_STATUSES.includes(job.status) && <button className="action-delete" aria-label={`移除 ${job.name}`} disabled={busy} onClick={() => onDelete(job)}><Trash2 size={13}/>移除</button>}</div></div></article>;
}

export default function JobLibrary({state,onOpenPreset,onSubmit,onSync,onExport,onDelete,onInspect,onSettingsBatch,onExportBatch,onRemake,onAngle,onDeleteOutputs,folderActions,busy,connected,onStop,stopping = false,submittingIds = []}) {
  const [batchId,setBatchId] = useState('');
  const [view,setView] = useState('tasks');
  const openBatch = id => {setBatchId(id);setView(state.jobs.some(job => job.batchId === id && job.status === 'completed' && job.images?.length) ? 'gallery' : 'tasks');};
  const [query,setQuery] = useState('');
  const [batchFilter,setBatchFilter] = useState('all');
  const [batchOffset,setBatchOffset] = useState(0);
  const [shotFilter,setShotFilter] = useState('all');
  const [shotOffset,setShotOffset] = useState(0);
  const [selected,setSelected] = useState([]);
  const batches = useMemo(() => collectShootBatches(state),[state.batches,state.jobs]);
  const batch = batches.find(item => item.id === batchId);
  const canSubmit = connected && state.workflow.ready;
  const canStopJob = job => job.status !== 'completed' && (STOPPABLE_STATUSES.includes(job.status) || submittingIds.includes(job.id));
  const canStopBatch = item => item.jobs.some(canStopJob);
  const changeBatchPage = value => {setBatchOffset(value);document.querySelector('.batch-library')?.scrollIntoView({block:'start'});};
  const changeShotPage = value => {setShotOffset(value);document.querySelector('.batch-detail-toolbar')?.scrollIntoView({block:'start'});};
  useEffect(() => {setBatchOffset(0);},[query,batchFilter]);
  useEffect(() => {setShotFilter('all');setShotOffset(0);setSelected([]);},[batchId]);
  useEffect(() => {setShotOffset(0);},[shotFilter]);

  if(!batch) {
    const search = query.trim().toLowerCase();
    const filtered = batches.filter(item => matchesBatchFilter(item,batchFilter) && `${item.name} ${item.jobs[0].character.name} ${item.jobs[0].scene?.name || ''} ${item.garments.map(row => row.name).join(' ')}`.toLowerCase().includes(search));
    const offset = clampOffset(batchOffset,filtered.length,BATCH_PAGE_SIZE);
    return <div className="job-library batch-library"><div className="toolbar"><div className="jobs-overview"><strong>{batches.length}</strong> 組拍攝<span>共 {state.jobs.length} 張照片 · {state.jobs.filter(job => job.status === 'completed').length} 張已完成</span></div><SearchBox value={query} onChange={setQuery} placeholder="搜尋拍攝組、角色或服裝…"/><button className="button secondary" disabled={busy} onClick={onSync}><RefreshCw size={16}/>更新狀態</button></div><div className="filter-tabs">{BATCH_FILTERS.map(([id,label]) => <button key={id} className={batchFilter === id ? 'active' : ''} onClick={() => setBatchFilter(id)}>{label}<span>{batches.filter(item => matchesBatchFilter(item,id)).length}</span></button>)}</div><div className="batch-list-note"><Layers3 size={14}/><span>一次建立就是一組拍攝。照片收在組內，點進去再查看。</span><span>{filtered.length} 組</span></div>{filtered.length ? <><div className="batch-grid">{filtered.slice(offset,offset + BATCH_PAGE_SIZE).map(item => <BatchCard key={item.id} batch={item} onOpen={openBatch} onSubmit={onSubmit} onStop={onStop} stopping={stopping} canStop={canStopBatch(item)} onSettings={onSettingsBatch} onExport={onExportBatch} busy={busy} canSubmit={canSubmit}/>)}</div><Pagination offset={offset} total={filtered.length} size={BATCH_PAGE_SIZE} onChange={changeBatchPage} noun="組"/></> : <Empty icon={Layers3} title={batches.length ? '沒有符合的拍攝組' : '準備好你的第一組寫真'} description={batches.length ? '試試其他名稱或狀態。' : '在工作檯搭配素材與動作，建立一組拍攝。即使有 100 張，也只會顯示一張拍攝組卡片。'}/>}</div>;
  }

  const jobs = batch.jobs.filter(job => shotFilter === 'all' || job.status === shotFilter);
  const offset = clampOffset(shotOffset,jobs.length,SHOT_PAGE_SIZE);
  const visible = jobs.slice(offset,offset + SHOT_PAGE_SIZE);
  const retryable = new Set(batch.retryableIds);
  const selectedIds = selected.filter(id => retryable.has(id));
  const pageIds = visible.filter(job => retryable.has(job.id)).map(job => job.id);
  const numbers = new Map(batch.jobs.map((job,index) => [job.id,index + 1]));
  const first = batch.jobs[0];
  return <div className="job-library batch-detail">
    <button className="back-to-batches" onClick={() => setBatchId('')}><ChevronLeft size={16}/>返回拍攝組</button>
    <div className="batch-detail-heading"><div><span className="eyebrow">SHOOTING COLLECTION</span><div className="batch-detail-title"><h2>{batch.name}</h2></div><p>{batch.total} 張照片 · {batch.garments.length} 套服裝 · {batch.poses.length} 個動作</p></div><div className="batch-control"><span className={`status-badge ${batch.status}`}>{BATCH_STATUS_LABELS[batch.status]}</span><button className="icon-button batch-utility" title="匯出這組" aria-label={`匯出拍攝組 ${batch.name}`} onClick={() => onExportBatch(batch)}><FileJson size={16}/></button><button className="icon-button batch-utility" title="拍攝組設定" aria-label={`拍攝組設定 ${batch.name}`} disabled={busy} onClick={() => onSettingsBatch(batch)}><Settings2 size={16}/></button>{canStopBatch(batch) && <button className="button secondary" disabled={stopping} onClick={() => onStop({batchId:batch.id})}><Pause size={16}/>暫停</button>}</div></div>
    <div className="batch-detail-summary"><div className="batch-mini-refs">{[['角色',first.character],['服裝',first.garment],['場景',first.scene]].filter(([,asset]) => asset).map(([label,asset]) => <div key={label}>{label==='服裝' ? <GarmentVisual garment={asset} small/> : <img decoding="async" loading="lazy" src={imagePreview(asset.image,'small')} alt={asset.name}/>}<span><small>{label}</small>{label === '服裝' && batch.garments.length > 1 ? `${batch.garments.length} 套服裝` : asset.name}</span></div>)}</div><BatchProgress batch={batch}/></div>
    <div className="batch-view-tabs"><button className={view === 'tasks' ? 'active' : ''} onClick={() => setView('tasks')}>任務清單</button><button className={view === 'gallery' ? 'active' : ''} onClick={() => setView('gallery')}>本組成果 ({batch.jobs.reduce((sum,job) => sum + (job.images?.length || 0),0)})</button></div>
    {view === 'gallery' ? <ResultGallery folderActions={folderActions} onOpenPreset={onOpenPreset} state={state} batchId={batch.id} onRemake={onRemake} onAngle={onAngle} onDeleteOutputs={onDeleteOutputs} onSubmit={onSubmit} onSync={onSync} onInspect={onInspect} busy={busy} connected={connected}/> : <>
    <div className="toolbar batch-detail-toolbar"><button className="button primary" disabled={busy || !canSubmit || !batch.retryableIds.length} onClick={() => onSubmit(batch.retryableIds)}><WandSparkles size={16}/>生成本組 ({batch.retryableIds.length})</button><button className="button secondary" disabled={busy || !canSubmit || !selectedIds.length} onClick={() => onSubmit(selectedIds)}>送出所選 ({selectedIds.length})</button><button className="button secondary" disabled={busy} onClick={onSync}><RefreshCw size={16}/>更新狀態</button></div>
    <div className="filter-tabs">{SHOT_FILTERS.map(([id,label]) => <button key={id} className={shotFilter === id ? 'active' : ''} onClick={() => setShotFilter(id)}>{label}<span>{id === 'all' ? batch.total : batch.counts[id]}</span></button>)}</div>
    <div className="shot-selection-toolbar">{pageIds.length > 0 && <label className="select-all"><input type="checkbox" checked={pageIds.every(id => selectedIds.includes(id))} onChange={e => setSelected(e.target.checked ? [...new Set([...selected,...pageIds])] : selected.filter(id => !pageIds.includes(id)))}/>選取本頁可送出的照片</label>}{batch.retryableIds.length > 0 && <button onClick={() => setSelected([...batch.retryableIds])}>選取全組可送出的照片 ({batch.retryableIds.length})</button>}{selectedIds.length > 0 && <button onClick={() => setSelected([])}>清除選取 ({selectedIds.length})</button>}<span>{jobs.length ? `${offset + 1}–${Math.min(offset + SHOT_PAGE_SIZE,jobs.length)}` : '0'} / {jobs.length} 張</span></div>
    {visible.length ? <div className="job-grid">{visible.map(job => <ShotCard key={job.id} job={job} presets={state.presets} onOpenPreset={onOpenPreset} number={numbers.get(job.id)} total={batch.total} selected={selectedIds.includes(job.id)} onSelect={() => setSelected(toggle(selected,job.id))} onInspect={onInspect} onExport={onExport} onSubmit={onSubmit} onStop={onStop} stopping={stopping} canStop={canStopJob(job)} onDelete={onDelete} busy={busy} canSubmit={canSubmit}/>)}</div> : <Empty icon={CheckCircle2} title="這個分類還沒有照片" description="切換分類，可以查看這組其他照片。"/>}
    <Pagination offset={offset} total={jobs.length} size={SHOT_PAGE_SIZE} onChange={changeShotPage} noun="張"/>
    </>}
  </div>;
}
