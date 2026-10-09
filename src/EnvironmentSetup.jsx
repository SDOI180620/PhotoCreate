import {useEffect,useState} from 'react';
import {Check,Download,FolderOpen,Globe,Loader2,Pause,RefreshCw,Link} from 'lucide-react';

const bytes = value => value===null || value===undefined ? '未知' : value>=1e9 ? `${(value/1e9).toFixed(1)} GB` : value>=1e6 ? `${(value/1e6).toFixed(1)} MB` : `${Math.round(value/1000)} KB`;
const inProgress = job => ['installing','downloading','verifying'].includes(job?.status);
const labels = {installed:'已找到',different:'需更新',missing:'缺少'};

export default function EnvironmentSetup({settings,api,onSave,onActivate,onBound,busy}) {
  const [mode,setMode]=useState(settings.environmentDraft ? 'directory' : settings.connectionMode || (settings.comfyDirectory ? 'directory' : 'url'));
  const [url,setUrl]=useState(settings.environmentDraft?.comfyUrl || settings.comfyUrl),[directory,setDirectory]=useState(settings.environmentDraft?.comfyDirectory || settings.comfyDirectory || '');
  const [plan,setPlan]=useState(null),[job,setJob]=useState(null),[error,setError]=useState(''),[working,setWorking]=useState(false);
  const [includeModels,setIncludeModels]=useState(true),[tested,setTested]=useState(null),[paths,setPaths]=useState([]);
  const [workflowPath,setWorkflowPath]=useState(settings.workflowPath || 'bundled'),[cameraWorkflowPath,setCameraPath]=useState(settings.cameraWorkflowPath || 'bundled');
  const locked=working || busy,inFlight=inProgress(job);
  const connection = {comfyUrl:url,workflowPath,cameraWorkflowPath};
  const act = async action => {setWorking(true);setError('');try {return await action();} catch(error) {setError(error.message);} finally {setWorking(false);}};
  const inspect = async (selected=directory) => {
    const query=new URLSearchParams({url});if(selected) query.set('directory',selected);
    const result=await api('/environment/plan?'+query);
    setPlan(result);if(result.directory) setDirectory(result.directory);return result;
  };
  useEffect(()=> {
    let live=true;
    api('/environment/install').then(result=>{if(live) setJob(result.job);}).catch(()=>{});
    if(mode==='directory') act(()=>inspect());
    return ()=>{live=false;};
  },[mode]);
  useEffect(()=> {
    if(!inFlight) return;
    let pending=false,live=true;
    const timer=setInterval(async ()=>{if(pending) return;pending=true;try {const result=await api('/environment/install');if(live) {setJob(result.job);if(!inProgress(result.job)) await inspect(result.job.directory);}} catch(error) {if(live) setError(error.message);} finally {pending=false;}},1000);
    return ()=>{live=false;clearInterval(timer);};
  },[inFlight]);
  useEffect(()=>{setTested(null);setPaths([]);},[url]);
  useEffect(()=>{setTested(null);},[workflowPath,cameraWorkflowPath]);
  const models=plan?.resources?.filter(row=>row.kind==='model') || [];
  const files=plan?.resources?.filter(row=>row.kind!=='model') || [];
  const finished=job?.status==='verifying' ? job.verificationBytes || 0 : job?.currentBytes || 0;
  const percent=job?.currentTotal ? Math.min(100,finished/job.currentTotal*100) : 0;
  return <section className="environment-setup">
    <div className="environment-modes" role="group" aria-label="環境連接方式"><button type="button" disabled={locked} aria-pressed={mode==='directory'} onClick={()=>{setMode('directory');setError('');}}><FolderOpen size={17}/><span>本機目錄<small>安裝工作流、節點與模型</small></span></button><button type="button" disabled={locked} aria-pressed={mode==='url'} onClick={()=>{setMode('url');setError('');}}><Globe size={17}/><span>ComfyUI 網址<small>測試現有環境，再綁定使用</small></span></button></div>
    <label>ComfyUI 網址<input aria-label="ComfyUI 網址" disabled={locked || inFlight} value={url} onChange={event=>setUrl(event.target.value)} placeholder="http://127.0.0.1:8188 或對方主機網址"/></label>
    {mode==='directory' ? <>
      <label>ComfyUI 目錄<div className="environment-directory"><input aria-label="ComfyUI 目錄" disabled={locked || inFlight} value={directory} onChange={event=>{setDirectory(event.target.value);setPlan(null);}} placeholder="例如 D:\\ComfyUI_windows_portable\\ComfyUI"/><button type="button" className="button secondary" disabled={locked || inFlight} onClick={()=>act(async()=>{const result=await api('/environment/directory/pick',{method:'POST'});if(result.directory) {setDirectory(result.directory);await inspect(result.directory);}})}><FolderOpen size={16}/>選擇目錄</button></div></label>
      <p className="field-help">選擇此電腦上含 main.py 與 comfy 資料夾的目錄。模型、工作流和輸出位置會依此目錄設定。</p>
      <div className="environment-actions"><button type="button" className="button secondary" disabled={locked || inFlight || !directory.trim()} onClick={()=>act(async()=>{await onSave({comfyUrl:url,comfyDirectory:directory});await inspect();})}><Check size={16}/>保存安裝設定</button><button type="button" className="button secondary" disabled={locked || !directory.trim()} onClick={()=>act(()=>inspect())}><RefreshCw size={16}/>檢查環境</button></div>
      {plan?.resources?.length>0 && <div className="environment-plan">
        <div className="environment-summary"><span>工作流 {files.filter(row=>row.kind==='workflow').length} 組 · 相機加強節點 · 模型 {models.length} 個</span><span>需下載 {bytes(plan.missingModelBytes)} · 可用 {bytes(plan.freeBytes)}</span></div>
        <div className="environment-resource-row"><strong>角色、服裝與 3D 相機工作流</strong><span>{files.filter(row=>row.kind==='workflow').every(row=>row.status==='installed') ? '已安裝' : '待安裝'}</span></div>
        <div className="environment-resource-row"><strong>相機加強版（−90° / −60°、Zoom 9 / 10）</strong><span>{files.filter(row=>row.kind==='node').every(row=>row.status==='installed') ? '已安裝' : '待安裝'}</span></div>
        <details className="environment-models"><summary>模型清單與下載來源 <span>{plan.modelsReady ? '全部已找到' : '有缺少的模型'}</span></summary>{models.map(row=><div className="environment-model-row" key={row.id}><div><a href={row.sourceUrl} target="_blank" rel="noreferrer">{row.label}</a><small>{row.target} · {bytes(row.size)}{row.partialBytes>0 && row.status!=='installed' ? ` · 已下載 ${bytes(row.partialBytes)}` : ''}</small></div><span>{labels[row.status]}</span></div>)}</details>
        {!!plan.missingCoreNodes?.length && <p className="inline-error">此 ComfyUI 缺少 {plan.missingCoreNodes.join('、')}。請先更新 ComfyUI，再檢查環境。</p>}
        {plan.connectionError && <p className="field-help">尚未連接 ComfyUI；可先安裝檔案，啟動 ComfyUI 後再檢查並載入。</p>}
        {!plan.modelsReady && <label className="environment-download-choice"><input type="checkbox" checked={includeModels} onChange={event=>setIncludeModels(event.target.checked)} disabled={inFlight}/>同時下載缺少的模型（{bytes(plan.missingModelBytes)}）</label>}
        <p className="field-help">工作流安裝於 PhotoCreate 專用資料夾。更新同名節點或檔案前會保留備份，已有模型會略過。</p>
        <div className="environment-actions"><button type="button" className="button primary" disabled={locked || inFlight || !directory.trim() || includeModels && plan.freeBytes!==null && plan.missingModelBytes>plan.freeBytes} onClick={()=>act(async()=>{await onSave({comfyUrl:url,comfyDirectory:directory});const result=await api('/environment/install',{method:'POST',body:{directory:plan.directory,includeModels}});setJob(result.job);await inspect();})}><Download size={16}/>{job?.status==='paused' || job?.status==='failed' ? '繼續安裝' : '安裝環境'}</button><button type="button" className="button secondary" disabled={locked || inFlight || !plan.modelsReady || !plan.filesReady} onClick={()=>act(async()=>{await onActivate();await inspect();const result=await api('/environment/install');setJob(result.job);})}><Link size={16}/>檢查並載入</button></div>
      </div>}
      {job && plan && job.directory===plan.directory && <div className="environment-progress" role="status"><div><strong>{job.status==='verifying' ? '驗證模型' : inFlight ? '安裝中' : job.status==='paused' ? '已暫停' : job.status==='failed' ? '安裝未完成' : '安裝完成'}</strong>{inFlight && <button type="button" className="button secondary" onClick={()=>act(async()=>{const result=await api('/environment/pause',{method:'POST'});setJob(result.job);})}><Pause size={14}/>暫停下載</button>}</div>{inFlight && <><p>{job.currentName}</p><progress max="100" value={percent}/><small>{bytes(finished)} / {bytes(job.currentTotal)} · {Math.floor(percent)}%</small></>}<p>{job.message || job.error}</p></div>}
    </> : <>
      <p className="field-help">可連接本機或對方的 ComfyUI。測試會檢查原圖、換角度及高清修正所需的工作流、節點、模型和加強參數。</p>
      <details className="environment-workflow-selection"><summary>選擇對方已保存的工作流</summary><button type="button" className="button secondary" disabled={locked || !url.trim()} onClick={()=>act(async()=>setPaths(await api('/environment/connection/workflows?url='+encodeURIComponent(url))))}><RefreshCw size={15}/>讀取此主機的工作流</button><div className="form-grid"><label>原圖工作流<select aria-label="連線原圖工作流" disabled={locked || inFlight} value={workflowPath} onChange={event=>setWorkflowPath(event.target.value)}><option value="bundled">PhotoCreate 內建工作流</option>{workflowPath!=='bundled' && !paths.includes(workflowPath) && <option value={workflowPath}>{workflowPath}</option>}{paths.map(value=><option key={value} value={value}>{value}</option>)}</select></label><label>相機工作流<select aria-label="連線相機工作流" disabled={locked || inFlight} value={cameraWorkflowPath} onChange={event=>setCameraPath(event.target.value)}><option value="bundled">PhotoCreate 內建工作流</option>{cameraWorkflowPath!=='bundled' && !paths.includes(cameraWorkflowPath) && <option value={cameraWorkflowPath}>{cameraWorkflowPath}</option>}{paths.map(value=><option key={value} value={value}>{value}</option>)}</select></label></div></details>
      <div className="environment-actions"><button type="button" className="button secondary" disabled={locked || !url.trim()} onClick={()=>act(async()=>setTested(await api('/environment/connection/test',{method:'POST',body:connection})))}>{working ? <Loader2 size={16} className="spin"/> : <RefreshCw size={16}/>}測試工作流</button><button type="button" className="button primary" disabled={locked || inFlight || !tested?.ready} onClick={()=>act(async()=>{await api('/environment/connection/bind',{method:'POST',body:connection});await onBound();})}><Link size={16}/>綁定此 ComfyUI</button></div>
      {tested && <div className="environment-test" role="status"><strong>{tested.ready ? '三個階段均可用，可以綁定。' : '尚未通過工作流測試。'}</strong>{tested.device && <p>{tested.device}</p>}{tested.error && <p className="inline-error">{tested.error}</p>}{tested.stages.map(stage=><div className="environment-resource-row" key={stage.stage}><div><strong>{stage.name}</strong>{stage.errors.map(value=><small key={value}>{value}</small>)}</div><span>{stage.ready ? '就緒' : '需處理'}</span></div>)}{!tested.ready && <p className="field-help">請在此 ComfyUI 主機安裝缺少的節點或模型，再重新測試。可使用本機目錄模式安裝同一套環境。</p>}</div>}
    </>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
