import {useEffect,useId,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Check,Image,Loader2,RefreshCw,Trash2,Upload,X} from 'lucide-react';
import {CUP_SIZES,characterProfile,cupSizeDescription} from '../shared/character-profile.js';
import {randomId} from './ids.js';
import {checkAuthentication} from './auth-api.js';
import './character-upload.css';

export function CharacterProfileFields({value,onChange,disabled=false}) {
  return <div className="character-profile-fields">
    <label>胸部尺寸<select aria-label="胸部尺寸" disabled={disabled} value={value.cupSize || ''} onChange={event=>onChange({...value,cupSize:event.target.value})}><option value="">未填寫（選填）</option>{CUP_SIZES.map(cup=><option value={cup} key={cup}>{cup} Cup · {cupSizeDescription(cup).label}</option>)}</select></label>
    <label>身高（公分）<input aria-label="身高（公分）" type="number" min="0.1" max="1000" step="0.1" placeholder="例如 168" disabled={disabled} value={value.heightCm ?? ''} onChange={event=>onChange({...value,heightCm:event.target.value})}/></label>
  </div>;
}

const CONVERTING=['starting','queued','submitting','running','uncertain','downloading','accepting'];

export default function CharacterUploadDialog({files:uploadedFiles,character,onSubmit,onDelete,onClose,error:externalError='',turnaroundApi,turnaroundSupported=false,turnaroundReady=false,characterPromptProfileId,customerConfigId}) {
  const editing=Boolean(character),files=uploadedFiles || [character];
  const titleId=useId(),dialog=useRef(null),sessions=useRef(new Set()),mounted=useRef(true),[profiles,setProfiles]=useState(()=>files.map(()=>editing ? characterProfile(character) : {cupSize:'',heightCm:''})),[previews,setPreviews]=useState(()=>editing ? [character.image] : []),[pending,setPending]=useState(false),[error,setError]=useState(''),[turnarounds,setTurnarounds]=useState(()=>files.map(()=>null));
  const [name,setName]=useState(character?.name || ''),[confirmDelete,setConfirmDelete]=useState(false);
  useEffect(()=>{if(editing) return;const urls=uploadedFiles.map(file=>URL.createObjectURL(file));setPreviews(urls);return ()=>urls.forEach(url=>URL.revokeObjectURL(url));},[uploadedFiles,editing]);
  useEffect(()=>{dialog.current.showModal();},[]);
  useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false;for(const id of sessions.current) turnaroundApi?.(`/character-turnarounds/${id}`,{method:'DELETE',keepalive:true}).catch(()=>{});sessions.current.clear();};},[turnaroundApi]);
  const update=(index,id,value)=>{if(mounted.current && sessions.current.has(id)) setTurnarounds(current=>current.map((row,i)=>i===index && row?.id===id ? {...row,...value} : row));};
  const discard=id=>{if(!id) return;sessions.current.delete(id);turnaroundApi?.(`/character-turnarounds/${id}`,{method:'DELETE',keepalive:true}).catch(()=>{});};
  useEffect(()=>{
    const active=turnarounds.map((row,index)=>({...row,index})).filter(row=>row.id && CONVERTING.includes(row.status) && !['starting','accepting'].includes(row.status));
    if(!active.length) return;
    let live=true;const timer=setTimeout(async()=>{
      await Promise.all(active.map(async row=>{try {const result=await turnaroundApi(`/character-turnarounds/${row.id}`);if(live) update(row.index,row.id,result);} catch(cause) {if(live) update(row.index,row.id,{status:'failed',error:cause.message});}}));
    },1200);
    return ()=>{live=false;clearTimeout(timer);};
  },[turnarounds,turnaroundApi]);
  const changeProfile=(index,value)=>{
    const row=turnarounds[index];
    if(row && row.status!=='stale') {let same=false;try {same=JSON.stringify(characterProfile(value))===JSON.stringify(row.profile);} catch { /* Invalid edited measurements invalidate the old result too. */ }if(!same) {discard(row.id);setTurnarounds(current=>current.map((entry,i)=>i===index ? {status:'stale',error:'尺寸已修改，請重新轉圖或選擇沿用原圖。'} : entry));}}
    setProfiles(current=>current.map((row,i)=>i===index ? value : row));setError('');
  };
  const convert=async index=>{
    let profile;try {profile=characterProfile(profiles[index]);} catch(cause) {setError(cause.message);return;}
    discard(turnarounds[index]?.id);const id=randomId(),body=new FormData();body.append('profile',JSON.stringify(profile));sessions.current.add(id);
    if(characterPromptProfileId) body.append('characterPromptProfileId',characterPromptProfileId);
    if(customerConfigId) body.append('customerConfigId',customerConfigId);
    setTurnarounds(current=>current.map((row,i)=>i===index ? {id,status:'starting',profile} : row));setError('');
    try {
      let file=files[index];
      if(editing) {const response=await fetch(character.image);checkAuthentication(response);if(!response.ok) throw new Error('無法取得角色原圖，請重新開啟角色設定。');const blob=await response.blob();file=new File([blob],character.name+'.png',{type:blob.type});}
      if(!mounted.current || !sessions.current.has(id)) return;
      body.append('image',file);update(index,id,await turnaroundApi(`/character-turnarounds/${id}`,{method:'PUT',body}));
    }
    catch(cause) {update(index,id,{status:'failed',error:cause.message});}
  };
  const accept=async index=>{
    const row=turnarounds[index];if(!row?.image) return;update(index,row.id,{status:'accepting',error:''});
    try {
      const response=await fetch(row.image);checkAuthentication(response);if(!response.ok) throw new Error('無法取得三視圖，請重新轉圖。');
      const blob=await response.blob(),ext=blob.type==='image/jpeg' ? '.jpg' : blob.type==='image/webp' ? '.webp' : '.png';
      const selectedFile=new File([blob],files[index].name.replace(/\.[^.]+$/,'')+'-three-view'+ext,{type:blob.type});
      update(index,row.id,{status:'completed',selectedFile});
    } catch(cause) {update(index,row.id,{status:'completed',error:cause.message});}
  };
  const useOriginal=index=>{discard(turnarounds[index]?.id);setTurnarounds(current=>current.map((row,i)=>i===index ? null : row));setError('');};
  const needsConfirmation=turnarounds.some(row=>row && !row.selectedFile);
  const submit=async event=>{
    event.preventDefault();if(pending || needsConfirmation) return;
    if(editing && (!name.trim() || name.trim().length>200)) {setError('角色名稱需為 1–200 個字。');return;}
    setError('');setPending(true);
    try {const values=profiles.map(characterProfile),chosenFiles=files.map((file,index)=>turnarounds[index]?.selectedFile || (editing ? null : file));if(await onSubmit(values,chosenFiles,name.trim())) onClose();else if(!editing) setError('上傳未完成，請確認資料後再試。');}
    catch(cause) {setError(cause.message);}
    finally {setPending(false);}
  };
  const remove=async()=>{if(pending) return;setError('');setPending(true);try {if(await onDelete(character.id)) onClose();} catch(cause) {setError(cause.message);} finally {setPending(false);}};
  return createPortal(<dialog ref={dialog} className={`character-upload-dialog ${turnarounds.some(Boolean) ? 'has-turnaround' : ''}`} aria-labelledby={titleId} onCancel={event=>{event.preventDefault();if(!pending) onClose();}} onMouseDown={event=>{if(event.target!==event.currentTarget || pending) return;const box=event.currentTarget.getBoundingClientRect();if(event.clientX<box.left || event.clientX>box.right || event.clientY<box.top || event.clientY>box.bottom) onClose();}}>
    <form onSubmit={submit}><header><div><h2 id={titleId}>{editing ? '編輯角色' : '上傳角色'}</h2><p>{editing ? '調整原本的角色設定，也能轉成三視圖；確認並儲存後套用於新的拍攝。' : '填寫 Cup 與身高，可直接匯入原圖，或先轉成三視圖並確認結果。'}</p></div><button type="button" disabled={pending} onClick={onClose} aria-label={editing ? '關閉角色編輯視窗' : '關閉角色上傳視窗'}><X size={20}/></button></header>
      <div className="character-upload-body">{files.map((file,index)=>{const row=turnarounds[index],converting=row && CONVERTING.includes(row.status);return <section key={index} className="character-upload-row" aria-label={`角色資料 ${index+1}`}><img src={previews[index]} alt={file.name}/><div>{editing ? <label className="character-edit-name">角色名稱<input aria-label="角色名稱" required maxLength={200} disabled={pending} value={name} onChange={event=>{setName(event.target.value);setError('');}}/></label> : <strong title={file.name}>{file.name}</strong>}<CharacterProfileFields value={profiles[index]} disabled={pending || converting} onChange={value=>changeProfile(index,value)}/><div className="character-turnaround-trigger"><button type="button" disabled={pending || converting || !turnaroundSupported || !turnaroundReady} onClick={()=>convert(index)}>{converting ? <Loader2 size={15} className="spin"/> : <RefreshCw size={15}/>} {row ? '重新轉圖' : '轉成三視圖'}</button><small>{turnaroundSupported ? turnaroundReady ? '最左大頭特寫，正面與側面不含頭部，背面保留頭部。' : '請先載入圖轉圖工作流。' : '重新啟動服務後可使用角色三視圖。'}</small></div></div>{row && <div className="character-turnaround-section"><div className="character-turnaround-comparison"><figure><figcaption>角色原圖</figcaption><img src={previews[index]} alt={`原圖 ${file.name}`}/></figure><figure><figcaption>{row.selectedFile ? '已確認的三視圖' : '三視圖預覽'}</figcaption>{row.image ? <a href={row.image} target="_blank" rel="noopener noreferrer" title="放大三視圖"><img src={row.image} alt={`三視圖 ${file.name}`}/></a> : <div className="character-turnaround-placeholder">{converting ? <><Loader2 size={26} className="spin"/><span>{row.status==='uncertain' ? '正在確認轉圖狀態…' : '三視圖轉圖中…'}</span></> : <><Image size={26}/><span>三視圖尚未完成</span></>}</div>}</figure></div>{row.error && <p className="character-upload-error" role="alert">{row.error}</p>}<div className="character-turnaround-actions">{row.selectedFile ? <span role="status"><Check size={16}/>{editing ? '已確認，儲存時使用三視圖' : '已確認，匯入時使用三視圖'}</span> : row.status==='completed' && <button type="button" className="character-use-turnaround" disabled={pending} onClick={()=>accept(index)}><Check size={15}/>使用這張三視圖</button>}<button type="button" disabled={pending || row.status==='accepting'} onClick={()=>useOriginal(index)}>沿用原圖</button></div></div>}</section>;})}{(error || externalError) && <p className="character-upload-error" role="alert">{error || externalError}</p>}{editing && onDelete && <div className="character-delete-section">{confirmDelete ? <><p>確定刪除「{character.name}」？角色會從你的清單移除，已拍攝的照片仍會保留。</p><div><button type="button" disabled={pending} onClick={()=>setConfirmDelete(false)}>保留角色</button><button type="button" className="character-delete-confirm" disabled={pending} onClick={remove}><Trash2 size={15}/>確定刪除角色</button></div></> : <button type="button" disabled={pending} onClick={()=>{setConfirmDelete(true);setError('');}}><Trash2 size={15}/>刪除角色</button>}</div>}</div>
      <footer>{needsConfirmation && <p>{editing ? '請確認三視圖或選擇沿用原圖，再儲存角色。' : '請確認三視圖或選擇沿用原圖，再匯入角色。'}</p>}<button type="button" disabled={pending} onClick={onClose}>取消</button><button type="submit" className="character-upload-submit" disabled={pending || needsConfirmation}>{pending ? <Loader2 size={16} className="spin"/> : <Upload size={16}/>}{pending ? editing ? '儲存中…' : '上傳中…' : editing ? '儲存角色設定' : `上傳 ${files.length} 個角色`}</button></footer>
    </form>
  </dialog>,document.body);
}
