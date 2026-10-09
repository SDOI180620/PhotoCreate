import {useEffect,useRef,useState} from 'react';
import {ArrowDownToLine,Upload,Loader2,Check,FileArchive} from 'lucide-react';

const LABELS={characters:'角色',garments:'服裝',scenes:'舊場景',presets:'提詞與角度'};
const formatBytes=bytes=>bytes>=1024**2 ? `${(bytes/1024**2).toFixed(1)} MB` : `${(bytes/1024).toFixed(1)} KB`;

export default function DataTransfer({state,api,onBeforeTransfer,onImported,busy}) {
  const input=useRef(null),token=useRef(''),mounted=useRef(true);
  const [working,setWorking]=useState(''),[preview,setPreview]=useState(null),[applyDraft,setApplyDraft]=useState(true),[error,setError]=useState(''),[message,setMessage]=useState('');
  useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false;if(token.current) api(`/transfer/preview/${token.current}`,{method:'DELETE'}).catch(()=>{});};},[]);
  const locked=busy || !!working;
  async function action(label,callback) {
    setWorking(label);setError('');setMessage('');
    try {await callback();} catch(error) {if(mounted.current) setError(error.message);}
    finally {if(mounted.current) setWorking('');}
  }
  function discard() {
    if(token.current) api(`/transfer/preview/${token.current}`,{method:'DELETE'}).catch(()=>{});
    token.current='';setPreview(null);setError('');setMessage('');
  }
  const stats=Object.entries(LABELS).filter(([kind])=>kind!=='scenes' || state.scenes.length);
  return <section className="data-transfer" aria-label="資料搬移">
    <div><h2>把工作室帶到新環境</h2><p className="field-help">角色、服裝原圖與保存的提詞，連同角度和拍攝設定，一次打包。</p></div>
    {!preview && <div className="transfer-card transfer-export-card">
      <div className="transfer-card-heading"><ArrowDownToLine size={20}/><div><h3>匯出資料 ZIP</h3><p className="field-help">下載後，可在另一台電腦的 PhotoCreate 匯入。</p></div></div>
      <div className="transfer-counts">{stats.map(([kind,label])=><span key={kind}><strong>{state[kind].length}</strong>{label}</span>)}</div>
      <button className="button primary" disabled={locked} onClick={()=>action('正在打包原圖與提詞…',async()=> {
        await onBeforeTransfer();const result=await api('/transfer/export',{method:'POST'});
        const anchor=document.createElement('a');anchor.href=`/api/transfer/export/${result.token}`;anchor.download=result.name;document.body.append(anchor);anchor.click();anchor.remove();
        if(mounted.current) setMessage(`資料 ZIP 已開始下載（${formatBytes(result.size)}）。`);
      })}><ArrowDownToLine size={16}/>匯出 ZIP</button>
    </div>}
    <div className="transfer-card">
      <div className="transfer-card-heading"><Upload size={20}/><div><h3>匯入資料 ZIP</h3><p className="field-help">保留這台電腦已有的資料，相同內容略過，不同內容另存。</p></div></div>
      <button className="button secondary" disabled={locked} onClick={()=>input.current.click()}><FileArchive size={16}/>{preview ? '選擇另一個 ZIP' : '選擇資料 ZIP'}</button>
      <input ref={input} aria-label="資料 ZIP" hidden type="file" accept=".zip,application/zip" onChange={event=> {
        const file=event.target.files[0];event.target.value='';if(!file) return;
        if(file.size>2*1024**3) {setError('資料 ZIP 最多 2 GB。');return;}
        action('正在檢查 ZIP 與圖片完整性…',async()=> {
          discard();const body=new FormData();body.append('archive',file);
          const result=await api('/transfer/preview',{method:'POST',body});
          if(!mounted.current) {api(`/transfer/preview/${result.token}`,{method:'DELETE'}).catch(()=>{});return;}
          token.current=result.token;setPreview(result);setApplyDraft(true);
        });
      }}/>
      {preview && <div className="transfer-preview">
        <div className="transfer-preview-heading"><strong>匯入預覽</strong><span>{formatBytes(preview.bytes)} · {new Date(preview.createdAt).toLocaleDateString('zh-TW')}</span></div>
        <table><thead><tr><th>資料</th><th>包內</th><th>將新增</th><th>重複略過</th></tr></thead><tbody>{Object.entries(LABELS).filter(([kind])=>kind!=='scenes' || preview.counts.scenes).map(([kind,label])=><tr key={kind}><th>{label}</th><td>{preview.counts[kind]}</td><td>{preview.added[kind]}</td><td>{preview.duplicates[kind]}</td></tr>)}</tbody></table>
        <label className="transfer-draft-choice"><input type="checkbox" checked={applyDraft} disabled={locked} onChange={event=>setApplyDraft(event.target.checked)}/>套用 ZIP 內的拍攝設定</label>
        <p className="field-help">{preview.draft.mode==='random' ? '隨機寫真' : '組合拍攝'} · {preview.draft.steps} 步 · {preview.draft.resolution} px · {preview.draft.aspectRatio==='reference' ? '沿用參考圖比例' : preview.draft.aspectRatio}<br/>換角度 {preview.draft.angleSteps} 步 · 高清修正 {preview.draft.refineDenoise}。取消勾選即可保留目前拍攝設定。</p>
        <div className="environment-actions"><button className="button primary" disabled={locked} onClick={()=>action('正在匯入資料…',async()=> {
          await onBeforeTransfer();const result=await api('/transfer/import',{method:'POST',body:{token:token.current,applyDraft}});
          token.current='';setPreview(null);await onImported(result);
          if(mounted.current) setMessage(`匯入完成：新增 ${result.added.characters} 個角色、${result.added.garments} 套服裝、${result.added.presets} 個提詞與角度${result.added.scenes ? `、${result.added.scenes} 個舊場景` : ''}。${result.draftApplied ? '拍攝設定已套用。' : '已保留目前拍攝設定。'}`);
        })}><Check size={16}/>匯入資料</button><button className="button secondary" disabled={locked} onClick={discard}>取消</button></div>
      </div>}
    </div>
    <p className="field-help transfer-scope">資料 ZIP 不包含成果照片、拍攝任務或模型。ComfyUI 目錄與網址沿用新環境的設定；模型與工作流請到「環境與工作流」安裝或綁定。</p>
    {working && <p className="transfer-status" role="status"><Loader2 size={16} className="spin"/>{working}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {message && <p className="transfer-status" role="status"><Check size={16}/>{message}</p>}
  </section>;
}
