import {useEffect,useId,useRef,useState} from 'react';
import {Check,CopyPlus,Loader2,RotateCcw,Save,Trash2} from 'lucide-react';
import {CHARACTER_HEIGHT_RANGES,CHARACTER_PROMPT_MAX_LENGTH,CUP_SIZES,characterHeightRange,characterProfilePrompt,cupSizeDescription,defaultCharacterPromptSettings,normalizeCharacterPromptSettings} from '../shared/character-profile.js';
import {CHARACTER_PROMPT_PROFILE_LIMIT,CHARACTER_PROMPT_PROFILE_NAME_LENGTH,initialCharacterPromptProfiles,normalizeCharacterPromptProfileName} from '../shared/character-prompt-profiles.js';
import {CharacterProfileFields} from './CharacterUpload.jsx';
import {characterTurnaroundPrompt,characterTurnaroundNegative} from '../shared/character-turnaround.js';
import {randomId} from './ids.js';
import './character-prompt-settings.css';

const profileDraft=row=>({name:row.name,settings:structuredClone(row.settings)});

export default function CharacterPromptSettings({settings,profiles,supported,profilesSupported,turnaroundNegativeSupported=false,busy,onSave,onProfilesChange,initialProfileId,customerConfigs=[]}) {
  const activeSettings={...defaultCharacterPromptSettings(),...settings},library=profiles || initialCharacterPromptProfiles(activeSettings);
  const rows=library.profiles.map(row=>({...row,settings:row.id===library.activeId ? activeSettings : {...defaultCharacterPromptSettings(),...row.settings}}));
  const [selectedId,setSelectedId]=useState(rows.some(row=>row.id===initialProfileId) ? initialProfileId : library.activeId),[drafts,setDrafts]=useState(()=>Object.fromEntries(rows.map(row=>[row.id,profileDraft(row)]))),[tab,setTab]=useState('height'),[profile,setProfile]=useState({heightCm:'165',cupSize:'B'}),[saving,setSaving]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false),[newProfile,setNewProfile]=useState(null),[deleting,setDeleting]=useState(null);
  const id=useId(),stored=JSON.stringify(Object.fromEntries(rows.map(row=>[row.id,profileDraft(row)]))),previousStored=useRef(stored);
  const selected=rows.find(row=>row.id===selectedId) || rows.find(row=>row.id===library.activeId),draft=drafts[selected.id] || profileDraft(selected),form=draft.settings,active=selected.id===library.activeId;
  useEffect(()=>{
    const previous=JSON.parse(previousStored.current),next=JSON.parse(stored);previousStored.current=stored;
    setDrafts(current=>Object.fromEntries(Object.entries(next).map(([key,value])=>[key,!current[key] || JSON.stringify(current[key])===JSON.stringify(previous[key]) ? value : current[key]])));
    setSelectedId(current=>Object.hasOwn(next,current) ? current : library.activeId);
  },[stored,library.activeId]);
  const dirtyFor=row=>drafts[row.id] && JSON.stringify(drafts[row.id])!==JSON.stringify(profileDraft(row));
  const dirty=Boolean(dirtyFor(selected)),disabled=busy || saving || !supported,manageDisabled=disabled || !profilesSupported;
  const bindings=customerConfigs.filter(row=>row.characterPromptProfileId===selected.id);
  const setForm=update=>setDrafts(current=>{const value=current[selected.id] || profileDraft(selected);return {...current,[selected.id]:{...value,settings:typeof update==='function' ? update(value.settings) : update}};});
  const editName=value=>{setDrafts(current=>({...current,[selected.id]:{...(current[selected.id] || profileDraft(selected)),name:value}}));setSaved(false);setError('');};
  let preview='',negativePreview='',previewError='';
  try {preview=tab==='turnaround' ? characterTurnaroundPrompt(profile,form) : characterProfilePrompt(profile,form);if(tab==='turnaround') negativePreview=characterTurnaroundNegative(form);} catch(cause) {previewError=cause.message;}
  const range=characterHeightRange(Number(profile.heightCm));
  const edit=(kind,key,value)=>{
    setForm(current=>({...current,[kind]:{...current[kind],[key]:value}}));setSaved(false);setError('');
    if(kind==='cupPrompts') setProfile(current=>({...current,cupSize:key}));
    else if(range?.id!==key) setProfile(current=>({...current,heightCm:String(CHARACTER_HEIGHT_RANGES.find(row=>row.id===key).min || 139)}));
  };
  const selectProfile=key=>{setSelectedId(key);setSaved(false);setError('');setDeleting(null);};
  const profileKey=event=>{
    if(disabled || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();const next=event.key==='Home' ? rows[0] : event.key==='End' ? rows.at(-1) : rows[(rows.findIndex(row=>row.id===selected.id)+(event.key==='ArrowRight' ? 1 : -1)+rows.length)%rows.length];
    selectProfile(next.id);event.currentTarget.parentElement.querySelector(`[data-profile="${next.id}"]`).focus();
  };
  const remember=result=>{const row=result.profiles.find(row=>row.id===result.selectedId);if(row) setDrafts(current=>({...current,[row.id]:profileDraft(row)}));setSelectedId(result.selectedId);};
  const save=async(event,activate=false)=>{
    event?.preventDefault();if(disabled || !dirty && !activate || activate && !profilesSupported) return;
    setSaving(true);setError('');
    try {
      const promptSettings=normalizeCharacterPromptSettings(form),name=normalizeCharacterPromptProfileName(draft.name);
      if(active && name===selected.name && !activate) {
        const result=await onSave(promptSettings);if(result) setDrafts(current=>({...current,[selected.id]:{name,settings:result}}));
      } else {
        const result=await onProfilesChange('update',{id:selected.id,body:{name,settings:promptSettings,...(activate ? {activate:true} : {})}});if(result) remember(result);
      }
      setSaved(true);
    } catch(cause) {setError(cause.message);}
    finally {setSaving(false);}
  };
  const create=async()=>{
    if(manageDisabled || !newProfile) return;setSaving(true);setError('');
    try {
      const result=await onProfilesChange('create',{body:{id:newProfile.id,name:normalizeCharacterPromptProfileName(newProfile.name),settings:normalizeCharacterPromptSettings(form)}});
      if(result) {remember(result);setNewProfile(null);setSaved(true);}
    } catch(cause) {setError(cause.message);}
    finally {setSaving(false);}
  };
  const remove=async()=>{
    if(manageDisabled || active || bindings.length) return;setSaving(true);setError('');
    try {const result=await onProfilesChange('remove',{id:selected.id});if(result) {setSelectedId(result.selectedId);setDeleting(null);setSaved(false);}}
    catch(cause) {setError(cause.message);}
    finally {setSaving(false);}
  };
  const tabKey=event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();const tabs=['height','cup','turnaround'],next=event.key==='Home' ? tabs[0] : event.key==='End' ? tabs.at(-1) : tabs[(tabs.indexOf(tab)+(event.key==='ArrowRight' ? 1 : -1)+tabs.length)%tabs.length];
    setTab(next);event.currentTarget.parentElement.querySelector(`[data-tab="${next}"]`).focus();
  };
  return <form className="character-prompts-shell" onSubmit={save} aria-label="角色提詞設定">
    <section className="character-profile-library panel" aria-label="角色提詞設定檔">
      <div className="character-profile-library-header"><div><h2>設定檔</h2><p>每份設定檔保存三視圖、Cup 與身高提詞。顧客使用參數設定檔綁定的角色提詞；使用中的是工作檯預設。</p></div><button type="button" className="button secondary" disabled={manageDisabled || rows.length>=CHARACTER_PROMPT_PROFILE_LIMIT || Boolean(newProfile)} onClick={()=>{setNewProfile({id:randomId(),name:''});setError('');}}><CopyPlus size={15}/>新增設定檔</button></div>
      <div className="character-profile-tabs" role="tablist" aria-label="設定檔分頁">{rows.map(row=><button type="button" role="tab" key={row.id} id={`${id}-profile-${row.id}`} aria-label={row.name} aria-selected={row.id===selected.id} aria-controls={`${id}-profile-panel`} tabIndex={row.id===selected.id ? 0 : -1} disabled={disabled} data-profile={row.id} title={row.name} onKeyDown={profileKey} onClick={()=>selectProfile(row.id)}><span>{row.name}</span>{dirtyFor(row) && <i aria-label="尚未保存"/>}{row.id===library.activeId && <small>使用中</small>}</button>)}</div>
      {newProfile && <div className="character-profile-create" role="group" aria-label="新增設定檔"><label>新設定檔名稱<input autoFocus aria-label="新設定檔名稱" maxLength={CHARACTER_PROMPT_PROFILE_NAME_LENGTH} disabled={manageDisabled} placeholder="例如：自然寫真、棚拍角色" value={newProfile.name} onChange={event=>setNewProfile(current=>({...current,name:event.target.value}))} onKeyDown={event=>{if(event.key==='Enter') {event.preventDefault();create();}}}/></label><button type="button" className="button primary" disabled={manageDisabled || !newProfile.name.trim()} onClick={create}>建立設定檔</button><button type="button" className="button secondary" disabled={manageDisabled} onClick={()=>setNewProfile(null)}>取消新增</button><p>複製目前分頁的提詞，建立後可分別修改。</p></div>}
      <div className="character-profile-toolbar"><label>設定檔名稱<input aria-label="設定檔名稱" maxLength={CHARACTER_PROMPT_PROFILE_NAME_LENGTH} value={draft.name} disabled={manageDisabled} onChange={event=>editName(event.target.value)}/></label><div>{active ? <span className="character-profile-active"><Check size={14}/>工作檯預設使用這份設定檔</span> : <button type="button" className="button primary" disabled={manageDisabled} onClick={event=>save(event,true)}><Check size={15}/>{dirty ? '保存並套用設定檔' : '套用設定檔'}</button>}<button type="button" className="button secondary" disabled={manageDisabled || active || Boolean(bindings.length)} title={bindings.length ? '請先到參數設定檔改綁，再刪除這份角色提詞設定檔。' : active ? '請先套用另一份設定檔，再刪除這份設定檔。' : '刪除此設定檔'} onClick={()=>setDeleting(selected.id)}><Trash2 size={14}/>刪除設定檔</button></div></div>
      {bindings.length>0 && <p className="field-help">綁定的參數設定檔：{bindings.map(row=>row.name).join('、')}。保存提詞後，這些帳號的新拍攝與角色轉圖會使用更新內容。</p>}
      {deleting===selected.id && <div className="character-profile-delete" role="group" aria-label="確認刪除設定檔"><p>刪除「{selected.name}」？這份設定檔與尚未保存的修改會一併移除。</p><button type="button" className="button secondary" disabled={manageDisabled} onClick={()=>setDeleting(null)}>保留設定檔</button><button type="button" className="button danger" disabled={manageDisabled} onClick={remove}>確定刪除</button></div>}
      {!profilesSupported && supported && <p className="inline-error">請重新啟動服務，啟用多份設定檔。</p>}
    </section>
    <div className="character-profile-content" role="tabpanel" id={`${id}-profile-panel`} aria-labelledby={`${id}-profile-${selected.id}`}>
      <div className="character-prompt-actions"><div><strong>{active ? '工作檯預設角色提詞' : '可綁定到參數設定檔'}</strong><p>{active ? '身高與 Cup 描述供寫真及角色轉圖使用。三視圖提詞套用到匯入時的圖轉圖。' : `工作檯預設使用「${rows.find(row=>row.id===library.activeId).name}」。保存這個分頁會更新綁定的顧客設定檔。`}</p></div><div className="character-prompt-save-controls"><span role="status" className={dirty ? 'unsaved' : ''}>{dirty ? '尚未保存變更' : saved ? <><Check size={14}/>設定已保存</> : '目前設定已保存'}</span><button type="submit" className="button primary" disabled={disabled || !dirty}>{saving ? <Loader2 size={16} className="spin"/> : <Save size={16}/>}保存設定</button></div></div>
      {!supported && <p className="inline-error character-prompt-notice" role="alert">請重新啟動 PhotoCreate 服務，啟用角色提詞設定。</p>}
      {error && <p className="inline-error character-prompt-notice" role="alert">{error}</p>}
      <section className="character-prompt-editor panel">
        <div className="character-prompt-tabs" role="tablist" aria-label="角色提詞分類">{[['height','身高提詞','5 個區間'],['cup','Cup 提詞','A–Z'],['turnaround','三視圖提詞','圖轉圖']].map(([key,label,count])=><button type="button" role="tab" key={key} id={`${id}-${key}-tab`} aria-selected={tab===key} aria-controls={`${id}-${key}-panel`} tabIndex={tab===key ? 0 : -1} data-tab={key} onKeyDown={tabKey} onClick={()=>setTab(key)}><span>{label}</span><small>{count}</small></button>)}</div>
        <p className="character-prompt-guide">{tab==='height' ? '區間下限包含、上限不包含；例如 150 cm 使用「150–160 cm」的提詞。' : tab==='cup' ? '每個 Cup 可分別設定描述；相同胸型可使用相同提詞。' : '轉圖時會合併這段提詞、所選 Cup 的描述與身高區間提詞；<image1> 是匯入的角色原圖。'}</p>
        <fieldset disabled={disabled} className="character-prompt-fields">
          <div role="tabpanel" id={`${id}-turnaround-panel`} aria-labelledby={`${id}-turnaround-tab`} hidden={tab!=='turnaround'} className="character-turnaround-rule"><label>轉成三視圖的提詞（正向）<textarea aria-label="轉成三視圖的提詞" rows={13} maxLength={CHARACTER_PROMPT_MAX_LENGTH} value={form.turnaroundPrompt} onChange={event=>{setForm(current=>({...current,turnaroundPrompt:event.target.value}));setSaved(false);setError('');}}/></label><p>預設版面：最左側大頭特寫 → 正面身體（不含頭部）→ 側面身體（不含頭部）→ 背面全身（保留頭部與頭髮）。可自行修改版面與外貌、服裝、比例要求。</p><label>三視圖負面提詞<textarea aria-label="三視圖負面提詞" rows={6} maxLength={CHARACTER_PROMPT_MAX_LENGTH} disabled={!turnaroundNegativeSupported} value={form.turnaroundNegative} onChange={event=>{setForm(current=>({...current,turnaroundNegative:event.target.value}));setSaved(false);setError('');}}/></label><p>{turnaroundNegativeSupported ? '負面提詞可自行修改或留白；保存後套用新的角色轉圖。轉圖完成後可先確認結果再匯入。' : '請重新啟動 PhotoCreate 服務，啟用負面提詞編輯與保存。'}</p></div>
          <div role="tabpanel" id={`${id}-height-panel`} aria-labelledby={`${id}-height-tab`} hidden={tab!=='height'} className="character-height-rules">{CHARACTER_HEIGHT_RANGES.map(row=><label className="character-height-rule" key={row.id}><span><strong>{row.label}</strong><small>{row.bounds}</small></span><textarea aria-label={`${row.label}提詞`} rows={3} maxLength={CHARACTER_PROMPT_MAX_LENGTH} value={form.heightPrompts[row.id]} onChange={event=>edit('heightPrompts',row.id,event.target.value)} placeholder="輸入這個身高區間的提詞；留白略過描述"/></label>)}</div>
          <div role="tabpanel" id={`${id}-cup-panel`} aria-labelledby={`${id}-cup-tab`} hidden={tab!=='cup'} className="character-cup-rules">{CUP_SIZES.map(cup=><label className="character-cup-rule" key={cup}><span><strong>{cup} Cup</strong><small>{cupSizeDescription(cup).label}</small></span><textarea aria-label={`${cup} Cup 提詞`} rows={2} maxLength={CHARACTER_PROMPT_MAX_LENGTH} value={form.cupPrompts[cup]} onChange={event=>edit('cupPrompts',cup,event.target.value)} placeholder="輸入這個 Cup 的提詞"/></label>)}</div>
        </fieldset>
        <div className="character-prompt-editor-footer"><p>{tab==='turnaround' ? '正向提詞須填寫，負面提詞可留白；Cup 與身高選填，未填的尺寸不加入轉圖提詞。' : '留白會略過該項描述；角色的公分數值與 Cup 字母仍會保留。未填寫的角色資料不加入提詞。'}</p><button type="button" className="button secondary" disabled={disabled} onClick={()=>{setForm(defaultCharacterPromptSettings());setSaved(false);setError('');}}><RotateCcw size={14}/>還原預設提詞</button></div>
      </section>
      <aside className="character-prompt-preview panel" aria-label="角色提詞預覽"><h2>提詞預覽</h2><p>輸入角色資料，查看目前分頁產生的提詞。</p><CharacterProfileFields value={profile} onChange={setProfile} disabled={saving}/><div className="character-prompt-matches">{range && <span>{range.label}</span>}{profile.cupSize && <span>{profile.cupSize} Cup</span>}</div>{tab==='turnaround' && <h3>正向提詞</h3>}{previewError ? <p className="inline-error" role="alert">{previewError}</p> : <pre aria-label="產生的角色提詞">{preview || '未填寫身高與 Cup，不加入角色尺寸提詞。'}</pre>}{tab==='turnaround' && <><h3>負面提詞</h3><pre aria-label="產生的三視圖負面提詞">{negativePreview || '未設定負面提詞。'}</pre></>}<small>預覽包含尚未保存的修改。保存後套用到綁定帳號的新拍攝與角色轉圖；「套用設定檔」調整工作檯預設。</small></aside>
    </div>
  </form>;
}
