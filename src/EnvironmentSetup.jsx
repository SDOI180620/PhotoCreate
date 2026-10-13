import {useEffect,useRef,useState} from 'react';
import {Download,FolderOpen,Globe,Loader2,Pause,RefreshCw,Link,Camera,Film} from 'lucide-react';
import {CAMERA_VERSIONS,DEFAULT_CAMERA_VERSION} from '../shared/camera-version.js';
import VideoEnvironmentSetup from './VideoEnvironmentSetup.jsx';

const bytes=value=>value==null ? '未知' : value>=1e9 ? `${(value/1e9).toFixed(1)} GB` : value>=1e6 ? `${(value/1e6).toFixed(1)} MB` : `${Math.round(value/1000)} KB`;
const inProgress=job=>['installing','downloading','verifying'].includes(job?.status);
const labels={installed:'已找到',different:'需補齊',missing:'缺少'};

export default function EnvironmentSetup({settings,api,onSave,onActivate,onBound,onCameraVersion,hasWorkflow,onWorkflowsChanged,busy,children}) {
  const [mode,setMode]=useState(settings.environmentDraft ? 'directory' : settings.connectionMode || (settings.comfyDirectory ? 'directory' : 'url'));
  const [url,setUrl]=useState(settings.environmentDraft?.comfyUrl || settings.comfyUrl),[directory,setDirectory]=useState(settings.environmentDraft?.comfyDirectory || settings.comfyDirectory || '');
  const [version,setVersion]=useState(settings.environmentDraft?.cameraVersion || settings.cameraVersion || DEFAULT_CAMERA_VERSION);
  const [models,setModels]=useState(null),[plan,setPlan]=useState(null),[job,setJob]=useState(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[working,setWorking]=useState(false);
  const [tested,setTested]=useState(null),[paths,setPaths]=useState([]),[workflowPath,setWorkflowPath]=useState(settings.workflowPath || 'bundled'),[cameraWorkflowPath,setCameraPath]=useState(settings.cameraWorkflowPath || 'bundled');
  const mounted=useRef(true),revision=useRef(0),completeJob=useRef('');
  const inFlight=inProgress(job),locked=working || busy || inFlight,versionReady=settings.cameraVersion!==undefined;
  const act=async action=>{setWorking(true);setError('');setNotice('');try {return await action();} catch(cause) {if(mounted.current) setError(cause.message);} finally {if(mounted.current) setWorking(false);}};
  const inspect=async(selected=directory,selection=models)=>{
    if(!selection) return;
    const request=++revision.current,query=new URLSearchParams({url,cameraVersion:version,purpose:'studio',videoModels:JSON.stringify(selection)});
    if(selected) query.set('directory',selected);
    let result;
    if(mode==='directory') result=await api('/environment/plan?'+query);
    else {const remote=await api('/environment/video/plan?'+new URLSearchParams({url,models:JSON.stringify(selection),local:'false'}));result={...remote,videoChoices:remote.choices,videoCatalog:remote.catalog,videoAvailability:remote.availability};}
    if(mounted.current && revision.current===request) setPlan(result);
    return result;
  };
  const readModels=async()=>{const config=await api('/photo-videos/settings');if(mounted.current) setModels(config.effectiveModels || config.models);return config;};
  useEffect(()=>{mounted.current=true;api('/environment/install').then(value=>mounted.current && setJob(value.job)).catch(cause=>mounted.current && setError(cause.message));readModels().catch(cause=>mounted.current && setError(cause.message));return ()=>{mounted.current=false;revision.current++;};},[]);
  useEffect(()=>{let live=true;if(models) inspect().catch(cause=>live && setError(cause.message));return ()=>{live=false;revision.current++;};},[mode,version,models]);
  useEffect(()=>setVersion(settings.environmentDraft?.cameraVersion || settings.cameraVersion || DEFAULT_CAMERA_VERSION),[settings.cameraVersion,settings.environmentDraft?.cameraVersion]);
  useEffect(()=>{setTested(null);setPaths([]);},[url]);
  useEffect(()=>setTested(null),[workflowPath,cameraWorkflowPath,version]);
  const finish=async result=>{
    await inspect(result.directory);
    if(result.status!=='completed' || completeJob.current!==result.id) return;
    completeJob.current='';setWorking(true);
    try {await onActivate();onWorkflowsChanged?.();await inspect(result.directory);if(mounted.current) setNotice('環境已安裝並載入，可以開始拍攝與產影片。');}
    catch(cause) {if(mounted.current){setNotice('缺少的檔案已補齊。請重新啟動 ComfyUI，再按「安裝環境」完成檢查。');setError(cause.message);}}
    finally {if(mounted.current) setWorking(false);}
  };
  useEffect(()=>{
    if(!inFlight) return;let pending=false,live=true;
    const timer=setInterval(async()=>{if(pending) return;pending=true;try {const result=await api('/environment/install');if(live){setJob(result.job);if(!inProgress(result.job)){await finish(result.job);onWorkflowsChanged?.();}}} catch(cause) {if(live) setError(cause.message);} finally {pending=false;}},1000);
    return ()=>{live=false;clearInterval(timer);};
  },[inFlight]);
  async function install() {
    await onSave({comfyUrl:url,comfyDirectory:directory,cameraVersion:version});
    await api('/photo-videos/models',{method:'PATCH',body:{models}});
    const result=await api('/environment/install',{method:'POST',body:{directory,purpose:'studio',includeModels:true,videoModels:models}});
    completeJob.current=result.job.id;setJob(result.job);
    if(!inProgress(result.job)) await finish(result.job);
  }
  const resources=plan?.resources || [],missing=resources.filter(row=>row.status!=='installed');
  const currentBytes=job?.status==='verifying' ? job.verificationBytes || 0 : job?.currentBytes || 0,percent=job?.currentTotal ? Math.min(100,currentBytes/job.currentTotal*100) : 0;
  const summary=section=>{const rows=resources.filter(row=>row.section===section),count=rows.filter(row=>row.status!=='installed').length;return !rows.length ? '等待檢查' : count ? `需補齊 ${count} 個檔案` : '檔案已齊全';};
  return <section className="environment-setup">
    <div className="environment-modes" role="group" aria-label="環境連接方式"><button type="button" disabled={locked} aria-pressed={mode==='directory'} onClick={()=>{setMode('directory');setError('');}}><FolderOpen size={17}/><span>本機目錄<small>自動安裝與補齊環境</small></span></button><button type="button" disabled={locked} aria-pressed={mode==='url'} onClick={()=>{setMode('url');setError('');}}><Globe size={17}/><span>ComfyUI 網址<small>使用另一台主機的環境</small></span></button></div>
    <div className="environment-location"><label>ComfyUI 網址<input aria-label="ComfyUI 網址" disabled={locked} value={url} onChange={event=>{setUrl(event.target.value);setPlan(null);revision.current++;}} placeholder="http://127.0.0.1:8188"/></label>{mode==='directory' && <label>ComfyUI 目錄<div className="environment-directory"><input aria-label="ComfyUI 目錄" disabled={locked} value={directory} onChange={event=>{setDirectory(event.target.value);setPlan(null);revision.current++;}} placeholder="例如 D:\\ComfyUI_windows_portable\\ComfyUI"/><button type="button" className="button secondary" disabled={locked} onClick={()=>act(async()=>{const result=await api('/environment/directory/pick',{method:'POST'});if(result.directory){setDirectory(result.directory);await inspect(result.directory);}})}><FolderOpen size={16}/>選擇目錄</button></div></label>}</div>
    {mode==='directory' ? <>
      <p className="field-help">選擇含 main.py 與 comfy 資料夾的目錄，按「安裝環境」即可。程式會檢查拍照與目前選用的影片版本，只補齊缺少的節點、工作流和模型。</p>
      <div className="environment-overview" aria-label="環境檢查結果"><div className="environment-overview-heading"><h3>環境檢查</h3><button type="button" className="button secondary" disabled={locked || !directory.trim() || !models} onClick={()=>act(()=>inspect())}><RefreshCw size={14}/>重新檢查</button></div><div className="environment-status-row"><Camera size={19}/><div><strong>拍照與換角度</strong><small>{CAMERA_VERSIONS.find(row=>row.id===version)?.label}</small></div><span>{summary('photo')}</span></div><div className="environment-status-row"><Film size={19}/><div><strong>照片產影片</strong><small>{models?.latentUpscaler ? '二採升頻版（5090 NVFP4）' : '一採版'}</small></div><span>{summary('video')}</span></div>
      {plan && <details className="environment-models"><summary>檔案明細 <span>{missing.length ? `${missing.length} 個待補齊` : '全部已找到'}</span></summary>{resources.map(row=><div className="environment-model-row" key={row.target}><div>{row.sourceUrl ? <a href={row.sourceUrl} target="_blank" rel="noreferrer">{row.label}</a> : <strong>{row.label}</strong>}<small>{row.target}{row.kind==='model' ? ` · ${bytes(row.size)}` : ''}{row.partialBytes>0 && row.status!=='installed' ? ` · 可續傳 ${bytes(row.partialBytes)}` : ''}</small></div><span>{row.customized ? '已找到・保留設定' : labels[row.status]}</span></div>)}</details>}
      {plan?.connectionError && <p className="field-help">ComfyUI 尚未連線，可先安裝檔案，啟動後再按「安裝環境」完成檢查。</p>}{!!plan?.missingCoreNodes?.length && <p className="inline-error">ComfyUI 需先更新：{plan.missingCoreNodes.join('、')}。</p>}{!!plan?.manualModels?.length && <p className="inline-error">{plan.manualModels.join('、')}沒有可下載的來源。請在進階設定選擇可下載模型，或放入模型後重新檢查。</p>}
      </div>
    </> : <>
      <p className="field-help">遠端主機需已有 ComfyUI。可測試與綁定，模型下載請在該主機使用本機目錄模式。</p>
      <details className="environment-workflow-selection"><summary>選擇已保存的工作流</summary><button type="button" className="button secondary" disabled={locked || !url.trim()} onClick={()=>act(async()=>setPaths(await api('/environment/connection/workflows?url='+encodeURIComponent(url))))}><RefreshCw size={15}/>讀取此主機的工作流</button><div className="form-grid"><label>原圖工作流<select aria-label="連線原圖工作流" disabled={locked} value={workflowPath} onChange={event=>setWorkflowPath(event.target.value)}><option value="bundled">PhotoCreate 內建工作流</option>{workflowPath!=='bundled' && !paths.includes(workflowPath) && <option value={workflowPath}>{workflowPath}</option>}{paths.map(value=><option key={value} value={value}>{value}</option>)}</select></label><label>相機工作流<select aria-label="連線相機工作流" disabled={locked} value={cameraWorkflowPath} onChange={event=>setCameraPath(event.target.value)}><option value="bundled">PhotoCreate 內建工作流</option>{cameraWorkflowPath!=='bundled' && !paths.includes(cameraWorkflowPath) && <option value={cameraWorkflowPath}>{cameraWorkflowPath}</option>}{paths.map(value=><option key={value} value={value}>{value}</option>)}</select></label></div></details>
      <div className="environment-actions"><button type="button" className="button secondary" disabled={locked || !url.trim()} onClick={()=>act(async()=>setTested(await api('/environment/connection/test',{method:'POST',body:{comfyUrl:url,workflowPath,cameraWorkflowPath,cameraVersion:version}})))}><RefreshCw size={16}/>測試工作流</button><button type="button" className="button primary" disabled={locked || !tested?.ready || !models} onClick={()=>act(async()=>{await api('/photo-videos/models',{method:'PATCH',body:{models}});await api('/environment/connection/bind',{method:'POST',body:{comfyUrl:url,workflowPath,cameraWorkflowPath,cameraVersion:version}});await onBound();})}><Link size={16}/>綁定此 ComfyUI</button></div>
      {tested && <div className="environment-test" role="status"><strong>{tested.ready ? '三個階段均可用，可以綁定。' : '尚未通過工作流測試。'}</strong>{tested.device && <p>{tested.device}</p>}{tested.error && <p className="inline-error">{tested.error}</p>}{tested.stages.map(stage=><div className="environment-resource-row" key={stage.stage}><div><strong>{stage.name}</strong>{stage.errors.map(value=><small key={value}>{value}</small>)}</div><span>{stage.ready ? '就緒' : '需處理'}</span></div>)}</div>}
    </>}
    <details className="environment-advanced"><summary>進階設定・版本、模型與工作流</summary><div className="environment-advanced-content"><label>視角拍攝版本<select aria-label="視角拍攝版本" disabled={locked || !versionReady} value={version} onChange={event=>{setVersion(event.target.value);setCameraPath('bundled');setPlan(null);}}>{CAMERA_VERSIONS.map(row=><option key={row.id} value={row.id}>{row.label}</option>)}</select></label><p className="field-help">本機安裝會套用此版本；已建立的拍攝保留原設定。</p>{mode==='url' && <button type="button" className="button secondary" disabled={locked || !versionReady || !hasWorkflow || url!==settings.comfyUrl || version===(settings.cameraVersion || DEFAULT_CAMERA_VERSION)} onClick={()=>act(async()=>{await onCameraVersion(version);onWorkflowsChanged?.();})}><RefreshCw size={14}/>套用拍攝版本</button>}<VideoEnvironmentSetup api={api} url={url} models={models} onModelsChange={setModels} plan={plan} busy={locked} installationStatus={job?.status} onWorkflowSaved={readModels}/>{children}</div></details>
    {mode==='directory' && job && job.directory===directory && <div className="environment-progress" role="status"><div><strong>{job.status==='verifying' ? '驗證模型' : inFlight ? '環境安裝中' : job.status==='paused' ? '下載已暫停・進度已保留' : job.status==='failed' ? '安裝未完成' : '檔案安裝完成'}</strong>{inFlight && <button type="button" className="button secondary" disabled={working} onClick={()=>act(async()=>{const result=await api('/environment/pause',{method:'POST',body:{jobId:job.id}});setJob(result.job);})}><Pause size={14}/>暫停下載</button>}</div>{inFlight && <><p>{job.currentName}</p><progress max="100" value={percent}/><small>{bytes(currentBytes)} / {bytes(job.currentTotal)}・{Math.floor(percent)}%</small></>}<p>{job.error || (job.status==='completed' ? '已安裝模型會略過，再次安裝只會檢查及補齊缺少的檔案。' : job.message)}</p></div>}
    {error && <p className="inline-error" role="alert">{error}</p>}{notice && <p className="environment-notice" role="status">{notice}</p>}
    {mode==='directory' && <div className="environment-install-bar"><div><strong>{inFlight ? '正在自動補齊環境' : plan ? missing.length ? `需補齊 ${missing.length} 個檔案` : '環境檔案已齊全' : '自動檢查與補齊環境'}</strong><small>{inFlight ? '可以關閉視窗，下載會繼續。' : `只下載缺少的模型${plan ? ` ${bytes(plan.missingModelBytes)}・可用 ${bytes(plan.freeBytes)}` : ''}`}</small></div><button type="button" className="button primary" disabled={locked || !directory.trim() || !models || !!plan?.manualModels?.length || plan?.freeBytes!=null && plan.missingModelBytes>plan.freeBytes} onClick={()=>act(install)}>{working || inFlight ? <Loader2 size={16} className="spin"/> : <Download size={16}/>}安裝環境</button></div>}
  </section>;
}
