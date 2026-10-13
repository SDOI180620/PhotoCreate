import {useEffect,useRef,useState} from 'react';
import {Check,KeyRound,Loader2,Plus,UserRound,Users,X} from 'lucide-react';
import {authApi} from './auth-api.js';

function ConfigChoice({configs,value,onChange,disabled}) {
  return <label>顧客參數設定檔<select aria-label="顧客參數設定檔" value={value || ''} onChange={event=>onChange(event.target.value)} disabled={disabled}>{configs.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label>;
}

export default function Accounts({api}) {
  const [accounts,setAccounts]=useState([]),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
  const [configs,setConfigs]=useState([]),[defaultId,setDefaultId]=useState('');
  const [form,setForm]=useState({username:'',name:'',password:'',customerConfigId:''}),[editing,setEditing]=useState(null);
  const [error,setError]=useState(''),[notice,setNotice]=useState('');
  const editDialog=useRef(null),editingOpen=Boolean(editing);
  useEffect(()=>{
    if(!editingOpen) return;
    const dialog=editDialog.current,previous=document.activeElement,overflow=document.body.style.overflow;
    document.body.style.overflow='hidden';dialog.showModal();
    return ()=>{dialog.close();document.body.style.overflow=overflow;previous?.focus();};
  },[editingOpen]);
  const [passwords,setPasswords]=useState({currentPassword:'',password:'',confirm:''});
  const reload=async()=>{const data=await api('/accounts');setAccounts(data.accounts);};
  useEffect(()=>{let current=true;Promise.all([api('/accounts'),api('/customer-configs')]).then(([data,parameters])=>{if(current) {setAccounts(data.accounts);setConfigs(parameters.configs);setDefaultId(parameters.defaultId);setForm(value=>({...value,customerConfigId:parameters.defaultId}));}}).catch(error=>{if(current) setError(error.message);}).finally(()=>{if(current) setLoading(false);});return ()=>{current=false;};},[api]);
  const run=async(work,message)=>{setBusy(true);setError('');setNotice('');try {await work();await reload();setNotice(message);return true;} catch(error) {setError(error.message);return false;} finally {setBusy(false);}};
  const create=async event=>{event.preventDefault();if(await run(()=>api('/accounts',{method:'POST',body:form}),'顧客帳號已建立。')) setForm({username:'',name:'',password:'',customerConfigId:defaultId});};
  const save=async event=>{event.preventDefault();if(await run(()=>api(`/accounts/${editing.id}`,{method:'PATCH',body:{name:editing.name,customerConfigId:editing.customerConfigId,...(editing.password ? {password:editing.password} : {})}}),'顧客設定已保存；重設密碼後，顧客需要重新登入。')) setEditing(null);};
  const changePassword=async event=>{
    event.preventDefault();if(passwords.password!==passwords.confirm) {setError('兩次輸入的新密碼不同。');return;}
    if(await run(()=>authApi('/password',{currentPassword:passwords.currentPassword,password:passwords.password}),'管理員密碼已更新。')) setPasswords({currentPassword:'',password:'',confirm:''});
  };
  return <div className="account-management">
      {error && !editing && <p className="account-message error" role="alert">{error}</p>}{notice && <p className="account-message" role="status"><Check size={16}/>{notice}</p>}
      <div className="account-layout"><section className="panel account-create"><h2><Plus size={20}/>新增顧客帳號</h2><p className="muted">建立後，把帳號與密碼交給顧客，從同一個網址登入。</p><form onSubmit={create}><label>顧客名稱<input maxLength={80} autoComplete="off" value={form.name} onChange={event=>setForm({...form,name:event.target.value})} placeholder="例如：小林" disabled={busy}/></label><label>顧客帳號<input required minLength={3} maxLength={40} autoComplete="off" autoCapitalize="none" spellCheck={false} pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]{2,39}" value={form.username} onChange={event=>setForm({...form,username:event.target.value})} placeholder="英文字母、數字、底線、點或短橫線" disabled={busy}/></label><label>初始密碼<input required minLength={6} maxLength={128} type="password" autoComplete="new-password" value={form.password} onChange={event=>setForm({...form,password:event.target.value})} placeholder="至少 6 個字元" disabled={busy}/></label><ConfigChoice configs={configs} value={form.customerConfigId} onChange={customerConfigId=>setForm({...form,customerConfigId})} disabled={busy || loading}/><button className="button primary" disabled={busy || loading || !configs.length}>{busy ? <Loader2 size={16} className="spin"/> : <Plus size={16}/>}建立顧客帳號</button></form></section>
        <section className="panel account-list"><div className="account-list-heading"><h2><Users size={20}/>顧客帳號</h2><span>{accounts.length} 位</span></div><p className="muted">每個帳號依指定設定檔取得官方選項，各自保存角色與照片。停用會登出顧客，已保存的圖片會保留。</p>{loading ? <p className="muted"><Loader2 size={16} className="spin"/>正在讀取帳號…</p> : accounts.length ? <div className="account-rows">{accounts.map(account=><article className="account-row" key={account.id}><span className="account-avatar"><UserRound size={20}/></span><div className="account-identity"><strong>{account.name}</strong><small>{account.username}</small><small>設定檔：{configs.find(row=>row.id===account.customerConfigId)?.name || '未指定'}</small><span>{account.lastLoginAt ? `上次登入 ${new Date(account.lastLoginAt).toLocaleString('zh-TW')}` : '尚未登入'}</span></div><span className={`account-status ${account.enabled ? 'enabled' : ''}`}>{account.enabled ? '可登入' : '已停用'}</span><div className="account-row-actions"><button className="button secondary" disabled={busy} aria-label={`修改 ${account.username} 帳號`} onClick={()=>setEditing({...account,password:''})}><KeyRound size={14}/>修改</button><button className="button secondary" disabled={busy} aria-label={`${account.enabled ? '停用' : '啟用'} ${account.username} 帳號`} onClick={()=>run(()=>api(`/accounts/${account.id}`,{method:'PATCH',body:{enabled:!account.enabled}}),account.enabled ? '帳號已停用，顧客圖片已保留。' : '帳號已啟用。')}>{account.enabled ? '停用' : '啟用'}</button></div></article>)}</div> : <div className="account-empty"><Users size={32} strokeWidth={1}/><p>還沒有顧客帳號。</p><small>建立第一位顧客後，就能登入自己的攝影棚。</small></div>}</section>
    </div>
      {editing && <dialog ref={editDialog} className="account-edit-dialog" aria-label={`修改 ${editing.username} 帳號`} onCancel={event=>{event.preventDefault();if(!busy) setEditing(null);}}>
        <header className="account-edit-heading"><h2>修改 {editing.username}</h2><button type="button" className="icon-button" aria-label="關閉修改帳號視窗" disabled={busy} onClick={()=>setEditing(null)}><X size={20}/></button></header>
        <form onSubmit={save}>
          <div className="account-edit-body">{error && <p className="account-message error" role="alert">{error}</p>}<label>修改顧客名稱<input autoFocus maxLength={80} value={editing.name} onChange={event=>setEditing({...editing,name:event.target.value})} disabled={busy}/></label><label>重設顧客密碼<input type="password" minLength={6} maxLength={128} autoComplete="new-password" value={editing.password} onChange={event=>setEditing({...editing,password:event.target.value})} placeholder="留空就保留目前密碼" disabled={busy}/></label><ConfigChoice configs={configs} value={editing.customerConfigId} onChange={customerConfigId=>setEditing({...editing,customerConfigId})} disabled={busy}/></div>
          <footer className="account-edit-footer"><button type="button" className="button secondary" aria-label="取消修改帳號" disabled={busy} onClick={()=>setEditing(null)}>取消</button><button className="button primary" disabled={busy}>{busy ? <Loader2 size={16} className="spin"/> : <Check size={16}/>}保存顧客設定</button></footer>
        </form>
      </dialog>}
    <details className="panel account-password"><summary><KeyRound size={18}/>修改管理員密碼</summary><form onSubmit={changePassword}><label>目前密碼<input required type="password" autoComplete="current-password" maxLength={128} value={passwords.currentPassword} onChange={event=>setPasswords({...passwords,currentPassword:event.target.value})} disabled={busy}/></label><label>新密碼<input required type="password" autoComplete="new-password" minLength={6} maxLength={128} value={passwords.password} onChange={event=>setPasswords({...passwords,password:event.target.value})} disabled={busy}/></label><label>再次輸入新密碼<input required type="password" autoComplete="new-password" minLength={6} maxLength={128} value={passwords.confirm} onChange={event=>setPasswords({...passwords,confirm:event.target.value})} disabled={busy}/></label><button className="button primary" disabled={busy}><Check size={16}/>更新管理員密碼</button></form></details>
  </div>;
}
