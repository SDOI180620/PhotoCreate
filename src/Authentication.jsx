import {useCallback,useEffect,useRef,useState} from 'react';
import {Aperture,ArrowRight,Eye,EyeOff,Loader2,LogOut} from 'lucide-react';
import App from './App.jsx';
import VisitorStudio from './VisitorStudio.jsx';
import {authApi} from './auth-api.js';
import './authentication.css';

function Login({onLogin}) {
  const [username,setUsername]=useState(''),[password,setPassword]=useState('');
  const [visible,setVisible]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const submit=async event=>{
    event.preventDefault();setBusy(true);setError('');
    try {const result=await authApi('/login',{username,password});setPassword('');onLogin(result.user);}
    catch(error) {setError(error.message);} finally {setBusy(false);}
  };
  return <main className="pc-login"><a className="pc-login-brand" href="/login" aria-label="PhotoCreate 登入"><img src="/photocreate-mark.svg" alt=""/><span>PhotoCreate</span></a>
    <div className="pc-login-layout"><section className="pc-login-intro"><h1>你的角色。<br/>你的鏡頭。<br/>你的攝影棚。</h1><p>從一張參考圖開始，<br/>留下只有你的拍攝故事。</p><div className="pc-login-lens" aria-hidden="true"><Aperture strokeWidth={0.65}/><span>PhotoCreate</span></div></section>
      <section className="pc-login-form"><div><h2>登入攝影棚</h2><p>角色與照片會保存在你的帳號，<br/>換個裝置也能接著拍。</p></div><form onSubmit={submit}><label>帳號<input autoFocus autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={40} value={username} onChange={event=>setUsername(event.target.value)} placeholder="輸入你的帳號" disabled={busy}/></label><label>密碼<div className="pc-password-input"><input aria-label="密碼" type={visible ? 'text' : 'password'} autoComplete="current-password" required maxLength={128} value={password} onChange={event=>setPassword(event.target.value)} placeholder="輸入密碼" disabled={busy}/><button type="button" aria-label={visible ? '隱藏密碼' : '顯示密碼'} onClick={()=>setVisible(!visible)}>{visible ? <EyeOff size={18}/> : <Eye size={18}/>}</button></div></label>{error && <p className="pc-login-error" role="alert">{error}</p>}<button className="pc-login-submit" disabled={busy || !username.trim() || !password}>{busy ? <Loader2 size={18} className="spin"/> : <ArrowRight size={18}/>}<span>{busy ? '登入中…' : '登入'}</span></button></form><p className="pc-login-help">帳號由攝影棚管理員提供。<br/>忘記密碼時，請聯絡管理員重設。</p></section>
    </div><footer>每張照片，都是一次新的可能。</footer></main>;
}
export function AccountMenu({user,onLogout}) {
  return <div className="pc-account-menu"><span title={user.username}>{user.name || user.username}<small>{user.role==='admin' ? '管理員' : user.username}</small></span><button onClick={onLogout} aria-label="登出"><LogOut size={16}/><span>登出</span></button></div>;
}
const goHome=user=>{
  const path=user ? user.role==='admin' ? '/admin' : '/' : '/login';
  if(location.pathname!==path) history.replaceState(null,'',path);
};
export default function Authentication() {
  const [user,setUser]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const generation=useRef(0);
  const accept=useCallback(user=>{generation.current++;setUser(user);goHome(user);setLoading(false);setError('');},[]);
  const refresh=useCallback(async()=>{
    const current=generation.current;
    try {const result=await authApi('/session');if(current===generation.current) {setUser(result.user);goHome(result.user);setError('');}}
    catch(error) {if(current===generation.current) setError(error.message);}
    finally {if(current===generation.current) setLoading(false);}
  },[]);
  useEffect(()=>{
    refresh();const expired=()=>accept(null),timer=setInterval(refresh,60000);
    window.addEventListener('photocreate:auth-expired',expired);window.addEventListener('focus',refresh);
    return ()=>{clearInterval(timer);generation.current++;window.removeEventListener('photocreate:auth-expired',expired);window.removeEventListener('focus',refresh);};
  },[accept,refresh]);
  const logout=async()=>{try {await authApi('/logout',{});accept(null);} catch(error) {setError(error.message);}};
  if(loading || error) return <main className="pc-auth-loading"><Aperture size={44} strokeWidth={1}/><h1>PhotoCreate</h1>{error ? <><p role="alert">{error}</p><button className="button primary" onClick={()=>{setLoading(true);refresh();}}>重新連線</button></> : <p><Loader2 size={16} className="spin"/>正在開啟攝影棚…</p>}</main>;
  if(!user) return <Login onLogin={accept}/>;
  const accountMenu=<AccountMenu user={user} onLogout={logout}/>;
  return user.role==='admin' ? <App user={user} accountMenu={accountMenu}/> : <VisitorStudio key={user.id} user={user} accountMenu={accountMenu}/>;
}
