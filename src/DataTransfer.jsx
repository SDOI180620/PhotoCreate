import {useEffect,useRef,useState} from 'react';
import {ArrowDownToLine,Upload,Loader2,Check,FileArchive} from 'lucide-react';

const LABELS={characters:'角色',garments:'服裝',scenes:'舊場景',presets:'提詞與角度'};
const formatBytes=bytes=>bytes>=1024**2 ? `${(bytes/1024**2).toFixed(1)} MB` : `${(bytes/1024).toFixed(1)} KB`;

export default function DataTransfer({state,api,onBeforeTransfer,onImported,busy}) {
  const input=useRef(null),token=useRef(''),mounted=useRef(true);
  const [working,setWorking]=useState(''),[preview,setPreview]=useState(null),[applyDraft,setApplyDraft]=useState(true),[error,setError]=useState(''),[message,setMessage]=useState('');
  const [storage,setStorage]=useState(null);
  useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false;if(token.current) api(`/transfer/preview/${token.current}`,{method:'DELETE'}).catch(()=>{});};},[]);
  useEffect(()=>{
    if(!state.features?.fullBackups) return;
    let live=true;const refresh=()=>api('/photo-storage').then(value=>{if(live) setStorage(value);}).catch(()=>{});
    refresh();const timer=setInterval(refresh,5000);return ()=>{live=false;clearInterval(timer);};
  },[state.features?.fullBackups]);
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
    <div className="transfer-card transfer-export-card">
      <div className="transfer-card-heading"><FileArchive size={20}/><div><h3>完整備份（含照片）</h3><p className="field-help">保存所有顧客帳號、角色與服裝、成果原圖、拍攝紀錄、分類與精選、提詞設定及播放音樂。</p></div></div>
      {storage && <p className="field-help">已保存 {storage.files} 個照片檔案 · {formatBytes(storage.bytes)}{storage.archiving ? ' · 正在保存歷史照片…' : ''}{storage.missing>0 ? ` · 還有 ${storage.missing} 張成果待保存` : ''}</p>}
      <button className="button primary" disabled={locked || !state.features?.fullBackups} onClick={()=>action('正在保存照片並建立完整備份…',async()=>{
        await onBeforeTransfer();const result=await api('/backups/export',{method:'POST'});
        const anchor=document.createElement('a');anchor.href=`/api/backups/${result.token}`;anchor.download=result.name;document.body.append(anchor);anchor.click();anchor.remove();
        if(mounted.current) setMessage(`完整備份已開始下載（${formatBytes(result.size)}，${result.photos} 個照片檔案）。${result.unavailableOriginals ? `有 ${result.unavailableOriginals} 張歷史成果的來源未能取得，備份已包含其餘保存的照片與資料。` : ''}`);
      })}><ArrowDownToLine size={16}/>下載完整備份</button>
      <p className="field-help">還原時先關閉 PhotoCreate，將完整備份 ZIP 拖到 Restore-PhotoCreate.cmd，再啟動程式。還原前的資料會另外保留。</p>
    </div>
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
    <p className="field-help transfer-scope">素材搬移 ZIP 不包含成果照片與拍攝任務；要保存整個工作室，請下載完整備份。兩種 ZIP 都不包含模型；新電腦可在「環境與工作流」重新綁定 ComfyUI。</p>
    {working && <p className="transfer-status" role="status"><Loader2 size={16} className="spin"/>{working}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {message && <p className="transfer-status" role="status"><Check size={16}/>{message}</p>}
  </section>;
}
