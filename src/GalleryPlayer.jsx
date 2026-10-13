import {imagePreview} from './image-preview.js';
import {useCallback,useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {ChevronLeft,ChevronRight,Expand,Images,Loader2,Maximize2,Music2,Pause,Play,Repeat,Shuffle,Volume2,VolumeX,X} from 'lucide-react';
import {MUSIC_KINDS} from '../shared/gallery-music.js';
import './gallery-player.css';

function preferences(key) {try {return JSON.parse(localStorage.getItem(key) || '{}');} catch {return {};}}
export default function GalleryPlayer({entries,music=[],title='我的精選',userId,onClose}) {
  const key=`photocreate-gallery-playback:${userId}`,saved=useRef(preferences(key)).current;
  const [playing,setPlaying]=useState(true),[random,setRandom]=useState(saved.random===true),[seconds,setSeconds]=useState([3,5,8,12].includes(saved.seconds) ? saved.seconds : 5);
  const [fill,setFill]=useState(saved.fill===true),[trackId,setTrackId]=useState(saved.trackId || ''),[volume,setVolume]=useState(Number.isFinite(saved.volume) ? Math.max(0,Math.min(1,saved.volume)) : .3);
  const [nav,setNav]=useState({id:entries[0]?.id,history:[entries[0]?.id],cursor:0,bag:entries.slice(1).map(row=>row.id)}),[ready,setReady]=useState(''),[failed,setFailed]=useState(''),[musicError,setMusicError]=useState(''),[full,setFull]=useState(false),[visible,setVisible]=useState(!document.hidden);
  const dialog=useRef(null),frame=useRef(null),audio=useRef(null),video=useRef(null),close=useRef(onClose),keyboard=useRef(null),didFullscreen=useRef(false);
  close.current=onClose;
  const ids=entries.map(row=>row.id),idList=ids.join(','),current=entries.find(row=>row.id===nav.id) || entries[0],index=entries.findIndex(row=>row.id===current?.id);
  const track=music.find(row=>row.id===trackId);
  const move=useCallback(delta=>setNav(old=>{
    if(!entries.length) return old;
    const active=ids.includes(old.id) ? old.id : ids[0];
    if(!random) {const id=ids[(ids.indexOf(active)+delta+ids.length)%ids.length];return {id,history:[id],cursor:0,bag:[]};}
    if(delta<0 && old.cursor>0) return {...old,cursor:old.cursor-1,id:old.history[old.cursor-1]};
    if(delta>0 && old.cursor<old.history.length-1) return {...old,cursor:old.cursor+1,id:old.history[old.cursor+1]};
    let bag=old.bag.filter(id=>ids.includes(id));if(!bag.length) bag=[...ids];
    const candidates=bag.filter(id=>id!==active),id=candidates[Math.floor(Math.random()*candidates.length)] || active,history=[...old.history.slice(0,old.cursor+1),id].slice(-200);
    return {id,history,cursor:history.length-1,bag:bag.filter(value=>value!==id)};
  }),[idList,random]);
  keyboard.current={move,toggle:()=>setPlaying(value=>!value)};
  const choose=id=>{setNav({id,history:[id],cursor:0,bag:ids.filter(value=>value!==id)});};
  useEffect(()=>{
    const element=dialog.current,previous=document.activeElement,overflow=document.body.style.overflow;
    document.body.style.overflow='hidden';element.showModal();element.querySelector('[aria-label="關閉精選播放"]')?.focus();
    const onKey=event=>{
      if(event.key==='Escape') {event.preventDefault();event.stopPropagation();close.current();}
      else if(!['SELECT','INPUT','TEXTAREA'].includes(event.target.tagName) && !(event.key===' ' && event.target.tagName==='BUTTON')) {
        if(['ArrowLeft','ArrowRight',' '].includes(event.key)) {event.preventDefault();event.stopPropagation();if(event.key===' ') keyboard.current.toggle();else keyboard.current.move(event.key==='ArrowLeft' ? -1 : 1);}
      }
    };
    const fullscreen=()=>{const active=document.fullscreenElement===frame.current;setFull(active);if(active) didFullscreen.current=true;else if(didFullscreen.current) close.current();};
    const visibility=()=>setVisible(!document.hidden);
    document.addEventListener('keydown',onKey,true);document.addEventListener('fullscreenchange',fullscreen);document.addEventListener('visibilitychange',visibility);
    frame.current.requestFullscreen?.().catch(()=>{});
    return ()=>{document.removeEventListener('keydown',onKey,true);document.removeEventListener('fullscreenchange',fullscreen);document.removeEventListener('visibilitychange',visibility);if(document.fullscreenElement===frame.current) document.exitFullscreen?.().catch(()=>{});element.close();document.body.style.overflow=overflow;previous?.focus();};
  },[]);
  useEffect(()=>{if(!entries.length) close.current();else if(!ids.includes(nav.id)) choose(ids[0]);},[idList]);
  useEffect(()=>{frame.current?.querySelector('.pc-player-thumbnails .active')?.scrollIntoView({block:'nearest',inline:'center'});},[current?.id]);
  useEffect(()=>{if(!playing || !visible || current?.video || entries.length<2 || ready!==current?.id) return;const timer=setTimeout(()=>move(1),seconds*1000);return ()=>clearTimeout(timer);},[playing,visible,seconds,current?.id,current?.video,ready,move]);
  useEffect(()=>{
    const player=video.current;if(!player) return;let cancelled=false;
    if(playing && visible) {if(player.ended) player.currentTime=0;player.play().catch(error=>{if(!cancelled && error.name!=='AbortError') setPlaying(false);});}
    else player.pause();
    return ()=>{cancelled=true;player.pause();};
  },[playing,visible,current?.id,current?.video,ready]);
  useEffect(()=>{try {localStorage.setItem(key,JSON.stringify({random,seconds,fill,trackId,volume}));} catch {/* Playback also works without persistent browser storage. */}},[key,random,seconds,fill,trackId,volume]);
  useEffect(()=>{if(trackId && !track) {setTrackId('');setMusicError('');}},[trackId,track]);
  useEffect(()=>{
    const player=audio.current;player.pause();setMusicError('');
    if(!track) {player.removeAttribute('src');player.load();return;}
    player.src=track.audio;player.loop=true;
    if(playing && visible) player.play().catch(()=>setMusicError('按音符按鈕開始音樂。'));
    return ()=>{player.pause();player.removeAttribute('src');player.load();};
  },[track?.id,track?.audio]);
  useEffect(()=>{const player=audio.current;player.volume=volume;if(!track) return;if(playing && visible) player.play().then(()=>setMusicError('')).catch(()=>setMusicError('按音符按鈕開始音樂。'));else player.pause();},[playing,visible,volume,track?.id]);
  const toggleMusic=()=>{if(!track) return;if(audio.current.paused) audio.current.play().then(()=>setMusicError('')).catch(()=>setMusicError('音樂暫時無法播放，請選擇另一首。'));else {audio.current.pause();setTrackId('');}};
  return createPortal(<dialog ref={dialog} className="pc-gallery-player" aria-label="精選全螢幕播放" onCancel={event=>{event.preventDefault();onClose();}}>
    <div ref={frame} className="pc-player-screen" tabIndex={-1}>
      {current && (current.video ? <video ref={video} key={`${current.id}:${current.video}`} className={`pc-player-photo ${fill ? 'fill' : ''}`} aria-label={`精選影片 ${current.garment || '寫真'}`} src={current.video} poster={current.image} muted playsInline preload="metadata" loop={entries.length===1} onLoadedData={()=>setReady(current.id)} onEnded={()=>{if(playing && visible && entries.length>1) move(1);}} onError={()=>{setFailed(current.id);setPlaying(false);}}/> : <img key={current.id} className={`pc-player-photo ${fill ? 'fill' : ''}`} src={current.image} alt={`${current.garment || '精選寫真'} · ${current.pose || ''}`} onLoad={()=>setReady(current.id)} onError={()=>{setFailed(current.id);setPlaying(false);}}/>)}
      {current && ready!==current.id && failed!==current.id && <div className="pc-player-loading" role="status"><Loader2 size={26} className="spin"/>{current.video ? '讀取影片…' : '讀取照片…'}</div>}
      {failed===current?.id && <div className="pc-player-loading" role="alert">這項精選無法讀取，請切換下一張。</div>}
      <header className="pc-player-header"><div><span>PhotoCreate / YOUR SELECTS</span><h2>{title}</h2></div><button aria-label="關閉精選播放" title="關閉 · Esc" onClick={onClose}><X size={22}/></button></header>
      <footer className="pc-player-bottom">
        <div className="pc-player-thumbnails" role="group" aria-label="精選播放縮圖">{entries.map((entry,i)=><button key={entry.id} className={current?.id===entry.id ? 'active' : ''} aria-label={`播放第 ${i+1} 張精選`} aria-pressed={current?.id===entry.id} onClick={()=>choose(entry.id)}><img decoding="async" src={imagePreview(entry.image,'small')} alt="" loading="lazy"/><span>{i+1}</span></button>)}</div>
        <div className="pc-player-controls">
          <div className="pc-player-transport" role="group" aria-label="照片輪播控制"><button aria-label="上一張精選" disabled={entries.length<2} onClick={()=>move(-1)}><ChevronLeft size={23}/></button><button className="pc-player-play" aria-label={playing ? '暫停精選輪播' : '播放精選輪播'} onClick={()=>setPlaying(value=>!value)}>{playing ? <Pause size={21}/> : <Play size={21}/>}</button><button aria-label="下一張精選" disabled={entries.length<2} onClick={()=>move(1)}><ChevronRight size={23}/></button><span className="pc-player-position" role="status" aria-label="目前播放照片">{index+1} / {entries.length}</span></div>
          <div className="pc-player-options"><button aria-label={random ? '改為固定順序' : '改為隨機順序'} aria-pressed={random} onClick={()=>{setRandom(value=>!value);choose(current.id);}}>{random ? <Shuffle size={17}/> : <Repeat size={17}/>}<span>{random ? '隨機' : '固定'}</span></button><label className="pc-player-time"><span>輪播秒數</span><select aria-label="輪播秒數" value={seconds} onChange={e=>setSeconds(Number(e.target.value))}>{[3,5,8,12].map(value=><option key={value} value={value}>{value} 秒</option>)}</select></label><button aria-label={fill ? '顯示完整照片' : '照片填滿畫面'} aria-pressed={fill} onClick={()=>setFill(value=>!value)}>{fill ? <Images size={17}/> : <Expand size={17}/>}<span>{fill ? '完整' : '填滿'}</span></button><button aria-label={full ? '結束全螢幕播放' : '進入全螢幕'} onClick={()=>{if(full) onClose();else frame.current.requestFullscreen?.().catch(()=>{});}}><Maximize2 size={17}/></button></div>
          <div className="pc-player-music"><button aria-label={musicError ? '開始播放音樂' : '播放音樂控制'} disabled={!track} onClick={toggleMusic}><Music2 size={18}/></button><select aria-label="播放音樂" value={track?.id || ''} onChange={e=>{setTrackId(e.target.value);setMusicError('');}}><option value="">無音樂</option>{music.map(row=><option key={row.id} value={row.id}>{MUSIC_KINDS[row.kind] || '音樂'} · {row.name}</option>)}</select><button aria-label={volume ? '靜音' : '開啟音量'} disabled={!track} onClick={()=>setVolume(volume ? 0 : .3)}>{volume ? <Volume2 size={17}/> : <VolumeX size={17}/>}</button><input aria-label="播放音量" type="range" min="0" max="1" step=".05" value={volume} disabled={!track} onChange={e=>setVolume(Number(e.target.value))}/></div>
        </div>
        {musicError && <p className="pc-player-music-error" role="status">{musicError}</p>}
      </footer>
      <audio ref={audio} preload="none" onError={()=>setMusicError('音樂暫時無法播放，請選擇另一首。')}/>
    </div>
  </dialog>,document.body);
}
