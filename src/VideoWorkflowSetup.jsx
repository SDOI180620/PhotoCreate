import {useEffect,useState} from 'react';
import {Check,Download,RefreshCw} from 'lucide-react';

export default function VideoWorkflowSetup({api,url,busy,installationStatus,onSaved}) {
  const [version,setVersion]=useState('single');
  const [path,setPath]=useState(null),[paths,setPaths]=useState([]),[summary,setSummary]=useState(null),[working,setWorking]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  useEffect(()=>{let live=true;api('/photo-videos/settings').then(config=>{if(live){setVersion(config.generationVersion || 'single');setPath(config.workflowPath || 'bundled');}}).catch(cause=>live && setError(cause.message));return ()=>{live=false;};},[]);
  const read=async()=> {
    const query=new URLSearchParams({url,path:path || 'bundled',generationVersion:version});
    const result=await api('/photo-videos/workflow?'+query);setSummary(result);
    setPaths(await api('/photo-videos/workflows?url='+encodeURIComponent(url)));
  };
  useEffect(()=> {
    if(path===null) return;let live=true;setSummary(null);setError('');setNotice('');
    const query=new URLSearchParams({url,path,generationVersion:version});
    Promise.all([api('/photo-videos/workflow?'+query),api('/photo-videos/workflows?url='+encodeURIComponent(url))]).then(([result,files])=>{if(live){setSummary(result);setPaths(files);}}).catch(cause=>live && setError(cause.message));
    return ()=>{live=false;};
  },[path,url,version,installationStatus==='completed']);
  async function act(action) {setWorking(true);setError('');setNotice('');try {await action();} catch(cause) {setError(cause.message);} finally {setWorking(false);}}
  return <div className="environment-test" role="group" aria-label="H3 影片工作流">
    <label>影片工作流<select aria-label="影片工作流" value={path || 'bundled'} disabled={busy || working || path===null} onChange={event=>setPath(event.target.value)}><option value="bundled">PhotoCreate 預設 · 自動讀取此主機儲存的工作流</option>{path && path!=='bundled' && !paths.includes(path) && <option value={path}>{path}</option>}{paths.map(value=><option key={value} value={value}>{value}</option>)}</select></label>
    {summary && <p className="field-help" role="status">KSamplerSelect：{summary.sampler} · BasicScheduler：{summary.scheduler} · {summary.steps} 步 · Megapixels：{summary.megapixels}{summary.generationVersion==='two-pass' ? ` → ${summary.refineMegapixels} · 前 ${summary.firstPassSteps} 步＋細化 ${summary.refineSteps} 步` : ''}</p>}
    <p className="field-help">在 ComfyUI 開啟「{version==='two-pass' ? '02 FastH3 Trim－升頻二採（5090 NVFP4）' : '01 FastH3 Trim - 圖生影片'}」，修改採樣器、排程器或 Megapixels 後儲存。每次產新影片會讀取最新儲存內容；另存新檔後，請在這裡選擇並套用。</p>
    {summary?.source==='bundled' && <p className="field-help">目前使用內建工作流。按「安裝環境」後，ComfyUI 的工作流清單會出現可編輯檔案。</p>}
    <div className="environment-actions"><button type="button" className="button secondary" disabled={busy || working || !summary} onClick={()=>act(async()=>{const config=await api('/photo-videos/workflow',{method:'PATCH',body:{url,workflowPath:path}});setVersion(config.generationVersion);onSaved?.(config);setNotice('影片工作流已套用，新影片會讀取此工作流。');})}><Check size={15}/>套用影片工作流</button><button type="button" className="button secondary" disabled={busy || working || path===null} onClick={()=>act(read)}><RefreshCw size={15}/>重新讀取影片工作流</button><a className="button secondary" href={'/api/photo-videos/workflow/file?generationVersion='+version} download><Download size={15}/>匯出可編輯工作流</a></div>
    {notice && <p className="field-help" role="status">{notice}</p>}{error && <p className="inline-error" role="alert">{error}</p>}
  </div>;
}
