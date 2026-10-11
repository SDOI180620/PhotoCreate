import {useEffect,useId,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Loader2,Upload,X} from 'lucide-react';
import {CUP_SIZES,characterProfile} from '../shared/character-profile.js';
import './character-upload.css';

export function CharacterProfileFields({value,onChange,disabled=false}) {
  return <div className="character-profile-fields">
    <label>胸部尺寸<select aria-label="胸部尺寸" disabled={disabled} value={value.cupSize || ''} onChange={event=>onChange({...value,cupSize:event.target.value})}><option value="">未填寫（選填）</option>{CUP_SIZES.map(cup=><option value={cup} key={cup}>{cup} Cup</option>)}</select></label>
    <label>身高（公分）<input aria-label="身高（公分）" type="number" min="0.1" max="1000" step="0.1" placeholder="例如 168" disabled={disabled} value={value.heightCm ?? ''} onChange={event=>onChange({...value,heightCm:event.target.value})}/></label>
  </div>;
}

export default function CharacterUploadDialog({files,onSubmit,onClose}) {
  const titleId=useId(),dialog=useRef(null),[profiles,setProfiles]=useState(()=>files.map(()=>({cupSize:'',heightCm:''}))),[previews,setPreviews]=useState([]),[pending,setPending]=useState(false),[error,setError]=useState('');
  useEffect(()=>{const urls=files.map(file=>URL.createObjectURL(file));setPreviews(urls);return ()=>urls.forEach(url=>URL.revokeObjectURL(url));},[files]);
  useEffect(()=>{dialog.current.showModal();},[]);
  const submit=async event=>{
    event.preventDefault();if(pending) return;
    setError('');setPending(true);
    try {const values=profiles.map(characterProfile);if(await onSubmit(values)) onClose();else setError('上傳未完成，請確認資料後再試。');}
    catch(cause) {setError(cause.message);}
    finally {setPending(false);}
  };
  return createPortal(<dialog ref={dialog} className="character-upload-dialog" aria-labelledby={titleId} onCancel={event=>{event.preventDefault();if(!pending) onClose();}} onMouseDown={event=>{if(event.target!==event.currentTarget || pending) return;const box=event.currentTarget.getBoundingClientRect();if(event.clientX<box.left || event.clientX>box.right || event.clientY<box.top || event.clientY>box.bottom) onClose();}}>
    <form onSubmit={submit}><header><div><h2 id={titleId}>上傳角色</h2><p>尺寸與身高會帶入拍攝提詞，未填寫的項目不會加入。</p></div><button type="button" disabled={pending} onClick={onClose} aria-label="關閉角色上傳視窗"><X size={20}/></button></header>
      <div className="character-upload-body">{files.map((file,index)=><section key={index} className="character-upload-row" aria-label={`角色資料 ${index+1}`}><img src={previews[index]} alt={file.name}/><div><strong title={file.name}>{file.name}</strong><CharacterProfileFields value={profiles[index]} disabled={pending} onChange={value=>setProfiles(current=>current.map((row,i)=>i===index ? value : row))}/></div></section>)}{error && <p className="character-upload-error" role="alert">{error}</p>}</div>
      <footer><button type="button" disabled={pending} onClick={onClose}>取消</button><button type="submit" className="character-upload-submit" disabled={pending}>{pending ? <Loader2 size={16} className="spin"/> : <Upload size={16}/>}{pending ? '上傳中…' : `上傳 ${files.length} 個角色`}</button></footer>
    </form>
  </dialog>,document.body);
}
