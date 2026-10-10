import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Check,Copy,Loader2,ArrowUpRight} from 'lucide-react';
import ImageViewer from './ImageViewer.jsx';
import PhotoSettings from './PhotoSettings.jsx';

const selectionLabels={character:'角色',garment:'服裝',pose:'動作',expression:'表情',clothingState:'服裝狀態',interaction:'場景互動',camera:'鏡位',lighting:'光線',color:'色彩',quality:'畫質'};
const parameterLabels={seed:'Seed',steps:'步數',cfg:'CFG',denoise:'修正強度',sampler_name:'採樣器',scheduler:'排程'};
async function copyText(text) {
  if(navigator.clipboard?.writeText) {await navigator.clipboard.writeText(text);return;}
  const field=document.createElement('textarea'),focus=document.activeElement;
  field.value=text;field.style.cssText='position:fixed;left:-9999px;top:0';document.body.append(field);field.select();
  try {if(!document.execCommand('copy')) throw new Error('請選取提詞文字後複製。');} finally {field.remove();focus?.focus();}
}

export default function PhotoPrompts({job,api}) {
  const [data,setData]=useState(null),[error,setError]=useState(''),[stageId,setStageId]=useState('base'),[copied,setCopied]=useState(false),[retry,setRetry]=useState(0);
  const [viewer,setViewer]=useState(null),[reservedHeight,setReservedHeight]=useState(0);
  const panel=useRef(null);
  useEffect(()=>{
    let current=true;setError('');
    api(`/jobs/${job.id}/prompts`).then(value=>{if(current) setData(value);}).catch(cause=>{if(current) setError(cause.message);});
    return ()=>{current=false;};
  },[job.id,job.status,job.stage,job.pipelineStage,api,retry]);
  useEffect(()=>{setCopied(false);},[job.id,stageId]);
  const details=data?.id===job.id ? data : null,stage=details?.stages.find(row=>row.id===stageId) || details?.stages[0];
  // Reserve the previous panel while another version's prompts are being fetched.
  useLayoutEffect(()=>{if(details) setReservedHeight(panel.current.getBoundingClientRect().height);},[details,stage]);
  const copy=async()=>{try {await copyText(`${stage.label}\n\n正面提詞\n${stage.positive ?? '未保存文字'}\n\n負面提詞\n${stage.negative ?? '未保存文字'}\n\n參數\n${Object.entries(stage.settings).map(([key,value])=>`${parameterLabels[key]}: ${value}`).join('\n')}${stage.angle ? `\n水平: ${stage.angle.horizontalAngle}°\n俯仰: ${stage.angle.verticalAngle}°\nZoom: ${stage.angle.zoom}` : ''}`);setCopied(true);} catch(cause) {setError(cause.message);}};
  return <section ref={panel} className="pc-prompt-panel" aria-label="這張照片的提詞" style={{minHeight:!details && reservedHeight ? reservedHeight : undefined}}><div className="pc-prompt-heading"><h3>這張照片的提詞</h3><button className="pc-text-button" disabled={!stage} onClick={copy}>{copied ? <Check size={13}/> : <Copy size={13}/>} {copied ? '已複製' : '複製本階段提詞'}</button></div>
    {error && <div className="pc-error" role="alert">{error}<button onClick={()=>setRetry(value=>value+1)}>重新讀取</button></div>}
    {!details && !error && <p className="pc-small-note" role="status"><Loader2 size={13} className="spin"/>讀取實際提詞…</p>}
    {details && stage && <><div className="pc-prompt-stages" role="group" aria-label="製作階段">{details.stages.map(row=><button key={row.id} aria-pressed={stage.id===row.id} onClick={()=>setStageId(row.id)}>{row.label}</button>)}</div>
      {stage.id==='base' && <PhotoSettings settings={details.settings || Object.entries(details.selections).map(([key,value])=>({key,label:selectionLabels[key],value}))}/>}
      <p className="pc-small-note">{stage.source==='snapshot' ? '實際送出的提詞與參數' : stage.source==='record' ? '依拍攝記錄顯示；此階段未保存完整送出內容。' : '此階段尚未送出，先顯示預定提詞。'}</p>
      {stage.image && <button className="pc-stage-image" onClick={()=>setViewer({src:stage.image,alt:`${stage.label}階段成果`})}><img src={stage.image} alt={`${stage.label}階段成果`}/><span>放大{stage.label}階段成果<ArrowUpRight size={13}/></span></button>}
      <div className="pc-prompt-references">{stage.references.map(row=><span key={row.label}>{row.label}：{row.name}</span>)}</div>
      <label className="pc-prompt-label">正面提詞</label><pre className="pc-prompt-text" tabIndex={0}>{stage.positive ?? '此階段未保存可讀的提詞文字。'}</pre>
      <details className="pc-negative-prompt"><summary>負面提詞</summary><pre className="pc-prompt-text" tabIndex={0}>{stage.negative===null ? '此階段未保存可讀的負面提詞。' : stage.negative || '（無）'}</pre></details>
      <div className="pc-prompt-parameters">{Object.entries(stage.settings).map(([key,value])=><span key={key}>{parameterLabels[key]} <strong>{value}</strong></span>)}{stage.angle && <span>鏡頭 <strong>{stage.angle.horizontalAngle}° / {stage.angle.verticalAngle}° / Zoom {stage.angle.zoom}</strong></span>}{details.width && details.height && <span>輸出 <strong>{details.width} × {details.height}</strong></span>}</div>
      {stage.id==='base' && <details className="pc-prompt-selections"><summary>本張隨機搭配</summary><dl>{Object.entries(details.selections).map(([key,value])=><div key={key}><dt>{selectionLabels[key]}</dt><dd>{value}</dd></div>)}</dl></details>}
    </>}
    {viewer && <ImageViewer {...viewer} onClose={()=>setViewer(null)}/>}
  </section>;
}
