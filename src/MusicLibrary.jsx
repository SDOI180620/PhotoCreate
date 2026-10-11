import {useEffect,useRef,useState} from 'react';
import {Loader2,Music2,RefreshCw,Sparkles,Square,Trash2,Upload} from 'lucide-react';
import {DEFAULT_PIANO_CAPTION,MUSIC_KINDS} from '../shared/gallery-music.js';
import './music-library.css';

const active=row=>['queued','submitting','running','uncertain'].includes(row.status);
const status=row=>row.status==='completed' ? '可播放' : row.status==='stopped' ? '已取消' : row.status==='failed' ? '未完成' : row.status==='running' ? '正在產生音樂' : row.status==='uncertain' ? '正在確認製作狀態' : '等候音樂製作';
export default function MusicLibrary({api}) {
  const [tracks,setTracks]=useState([]),[available,setAvailable]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [name,setName]=useState('森林微光 · 鋼琴'),[caption,setCaption]=useState(DEFAULT_PIANO_CAPTION),[durationCap,setDurationCap]=useState(90),[uploadKind,setUploadKind]=useState('piano'),[removeId,setRemoveId]=useState('');
  const picker=useRef(null),requestId=useRef(crypto.randomUUID()),mounted=useRef(true);
  const load=async()=>{const rows=await api('/music');if(mounted.current) setTracks(rows);};
  useEffect(()=>{mounted.current=true;load().catch(e=>setError(e.message));api('/music/availability').then(value=>mounted.current && setAvailable(value)).catch(e=>mounted.current && setError(e.message));return ()=>{mounted.current=false;};},[]);
  const producing=tracks.some(active);
  useEffect(()=>{if(!producing) return;let loading=false;const timer=setInterval(()=>{if(loading) return;loading=true;load().catch(e=>mounted.current && setError(e.message)).finally(()=>{loading=false;});},2500);return ()=>clearInterval(timer);},[producing]);
  async function run(action) {if(busy) return;setBusy(true);setError('');try {await action();await load();return true;} catch(e) {if(mounted.current) setError(e.message);return false;} finally {if(mounted.current) setBusy(false);}}
  async function publish(row,enabled) {
    if(busy) return;
    setTracks(current=>current.map(track=>track.id===row.id ? {...track,enabled} : track));
    if(!await run(()=>api(`/music/${row.id}`,{method:'PATCH',body:{enabled}}))) setTracks(current=>current.map(track=>track.id===row.id ? {...track,enabled:row.enabled} : track));
  }
  const generate=async event=>{event.preventDefault();if(await run(()=>api(`/music/${requestId.current}`,{method:'PUT',body:{name,kind:'piano',caption,durationCap}}))) requestId.current=crypto.randomUUID();};
  const upload=event=>{const file=event.target.files[0];event.target.value='';if(!file) return;const form=new FormData();form.append('audio',file);form.append('name',file.name.replace(/\.[^.]+$/,'').slice(0,100));form.append('kind',uploadKind);run(()=>api('/music/upload',{method:'POST',body:form}));};
  return <section className="music-library">
    <div className="music-library-note"><Music2 size={21}/><div><strong>讓精選寫真，有自己的配樂。</strong><p>開放的音樂會出現在顧客的精選播放器；顧客可選擇曲目、音量或無音樂。</p></div><button className="button secondary" disabled={busy} onClick={()=>run(load)}><RefreshCw size={14}/>更新</button></div>
    {error && <p className="music-library-error" role="alert">{error}</p>}
    <div className="music-library-layout"><form className="music-generator" onSubmit={generate}><span className="eyebrow">MINIMAX MUSIC3</span><h2>產生鋼琴音樂</h2><p>柔和、無人聲的鋼琴曲，適合森林、公園與日常寫真輪播。</p><label>音樂名稱<input aria-label="音樂名稱" maxLength={100} required value={name} onChange={e=>setName(e.target.value)}/></label><label>生成時間上限<select aria-label="音樂生成時間上限" value={durationCap} onChange={e=>setDurationCap(Number(e.target.value))}>{[30,60,90,120,180].map(value=><option key={value} value={value}>{value} 秒</option>)}</select></label><label>音樂提詞<textarea aria-label="音樂提詞" value={caption} onChange={e=>setCaption(e.target.value)} rows={13} maxLength={16000} required/></label><p className="music-generator-hint">實際長度依生成結果而定。音樂製作與拍攝共用攝影棚，完成後可繼續拍攝。</p>{available && !available.ready && <p className="music-library-error">{available.error}</p>}<button className="button primary" disabled={busy || producing || !available?.ready}>{busy || producing ? <Loader2 size={15} className="spin"/> : <Sparkles size={15}/>} {producing ? '音樂製作中' : '產生鋼琴曲'}</button></form>
      <div className="music-tracks"><div className="music-tracks-heading"><h2>播放音樂 <small>{tracks.filter(row=>row.status==='completed').length}</small></h2><div><select aria-label="匯入音樂分類" value={uploadKind} onChange={e=>setUploadKind(e.target.value)}>{Object.entries(MUSIC_KINDS).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select><button className="button secondary" disabled={busy} onClick={()=>picker.current.click()}><Upload size={14}/>匯入音樂</button><input ref={picker} type="file" accept="audio/mpeg,audio/wav,audio/flac,.mp3,.wav,.flac" hidden onChange={upload}/></div></div><p className="music-track-hint">可匯入小提琴、雨聲等 MP3、WAV 或 FLAC，最多 80 MB。</p>
        {!tracks.length && <div className="music-tracks-empty"><Music2 size={28}/><p>先產生一首鋼琴曲，或匯入喜歡的音樂。</p></div>}
        {tracks.map(row=><article className="music-track" key={row.id}><div className="music-track-title"><span className="music-track-icon"><Music2 size={19}/></span><div><h3>{row.name}</h3><p>{MUSIC_KINDS[row.kind]} · {status(row)}{row.durationCap ? ` · 上限 ${row.durationCap} 秒` : ''}</p></div>{!active(row) && <button className="button icon" aria-label={`刪除音樂 ${row.name}`} disabled={busy} onClick={()=>setRemoveId(row.id)}><Trash2 size={15}/></button>}</div>{active(row) && <button className="button secondary" disabled={busy} onClick={()=>run(()=>api(`/music/${row.id}/stop`,{method:'POST'}))}><Square size={13}/>取消音樂製作</button>}{row.status==='completed' && <><audio controls preload="metadata" src={row.audio}/><label className="music-track-enabled"><input type="checkbox" checked={row.enabled} disabled={busy} onChange={e=>publish(row,e.target.checked)}/>開放給顧客選擇</label></>}{active(row) && <p className="music-track-progress"><Loader2 size={14} className="spin"/>完成後可試聽，再開放給顧客選取。</p>}{row.error && <p className="music-library-error">{row.error}</p>}{removeId===row.id && <div className="music-track-confirm"><p>刪除後，顧客的音樂選單也會移除這首曲目。</p><button className="button secondary" disabled={busy} onClick={()=>setRemoveId('')}>保留</button><button className="button danger-ghost" disabled={busy} onClick={async()=>{if(await run(()=>api(`/music/${row.id}`,{method:'DELETE'}))) setRemoveId('');}}>確定刪除音樂</button></div>}</article>)}
      </div>
    </div>
  </section>;
}
