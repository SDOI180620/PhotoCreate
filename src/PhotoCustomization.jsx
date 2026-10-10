import {useEffect} from 'react';
import {OUTPUT_RATIOS,getOutputSize} from '../shared/domain.js';
import {PHOTO_CHANGE_FIELDS,PHOTO_PRESET_CATEGORIES,PHOTO_CHANGE_MAX_LENGTH,photoSettings,clothingDescription} from '../shared/photo-customization.js';
import PhotoSettings from './PhotoSettings.jsx';
import './photo-customization.css';

const placeholders={pose:'例如：雙手扶腰，身體微微側轉',clothingState:'例如：衣物整齊穿著，袖口捲起',scene:'例如：夕陽下的海邊，遠處有浪花',expression:'例如：輕輕微笑，看向鏡頭',lighting:'例如：柔和日落光，側面有暖色光線',color:'例如：自然膚色，低飽和暖色調',quality:'例如：清晰的布料細節、自然的皮膚質感'};

export default function PhotoCustomization({value,onChange,garments=[],presets=[],disabled=false,source={}}) {
  const settings=source.settings || photoSettings(source),byKey=Object.fromEntries(settings.map(row=>[row.key,row]));
  const resolvedClothing=clothingDescription(value.changes.clothing);
  const size=value.aspectRatio==='original' ? null : getOutputSize(value.aspectRatio,source.resolution || 1536);
  useEffect(()=>{
    const presetIds=Object.fromEntries(Object.entries(value.presetIds || {}).filter(([key,id])=>presets.some(row=>row.id===id && row.category===PHOTO_PRESET_CATEGORIES[key])));
    const garmentId=garments.some(row=>row.id===value.garmentId) ? value.garmentId : '';
    if(Object.keys(presetIds).length!==Object.keys(value.presetIds || {}).length || garmentId!==value.garmentId) onChange({...value,presetIds,garmentId});
  },[value,presets,garments,onChange]);
  const setChange=(key,text)=>onChange({...value,changes:{...value.changes,[key]:text}});
  const setMode=(key,mode)=>onChange({...value,fieldModes:{...value.fieldModes,[key]:mode}});
  const setOriginal=(key,checked)=>{
    const useOriginal={...value.useOriginal,[key]:checked};
    onChange({...value,useOriginal,preserveOriginal:Object.values(useOriginal).every(Boolean)});
  };
  return <div className="photo-customization">
    <p className="photo-customization-help">使用原本選取的角色，重新送出完整拍攝提詞。每項預設沿用上次設定；取消勾選後可選官方選項或自行輸入，文字留白也沿用原設定。</p>
    <section className="photo-ratio-choice" aria-label="照片比例"><div className="photo-option-heading"><span>照片比例</span><small>上一張：{OUTPUT_RATIOS[source.aspectRatio]?.label || '跟隨人物參考圖'}</small></div>
      <div className="photo-ratio-options" role="group" aria-label="自訂拍攝照片比例">{[['original','沿用上一張'],['9:16','直式 9:16'],['1:1','方形 1:1'],['16:9','橫式 16:9']].map(([ratio,label])=><button key={ratio} type="button" disabled={disabled} aria-pressed={value.aspectRatio===ratio} onClick={()=>onChange({...value,aspectRatio:ratio})}>{label}</button>)}</div>
      <p className="photo-customization-help">{size ? `拍攝尺寸 ${size.width} × ${size.height} px` : '沿用上一張的拍攝比例。'}</p>
    </section>
    <div className="photo-change-fields">
      {Object.entries(PHOTO_CHANGE_FIELDS).map(([key,label])=><section key={key} className="photo-change-option"><div className="photo-option-heading"><span>{label}</span><label className="photo-preserve-choice"><input type="checkbox" aria-label={`${label}沿用原設定`} checked={value.useOriginal[key]} disabled={disabled} onChange={event=>setOriginal(key,event.target.checked)}/>沿用原設定</label></div>
        <p className="photo-original-setting"><span>{value.useOriginal[key] ? '沿用：' : '原設定：'}</span>{byKey[key]?.value || '未指定'}{byKey[key]?.source==='custom' && <small>自訂</small>}{byKey[key]?.description && <small className="photo-clothing-description">拍攝描述：{byKey[key].description}</small>}</p>
        {!value.useOriginal[key] && (key==='clothing' ? <div className="photo-clothing-choice"><div className="photo-clothing-modes" role="group" aria-label="換裝方式">{[['text','輸入服裝描述'],['reference','選擇服裝圖']].map(([mode,name])=><button key={mode} type="button" disabled={disabled} aria-pressed={value.clothingMode===mode} onClick={()=>onChange({...value,clothingMode:mode})}>{name}</button>)}</div>
        {value.clothingMode==='text' && <label>服裝描述<textarea aria-label="自訂服裝" rows={2} maxLength={PHOTO_CHANGE_MAX_LENGTH} disabled={disabled} value={value.changes.clothing} onChange={event=>setChange('clothing',event.target.value)} placeholder="例如：黑色長袖女僕洋裝、白色圍裙與蕾絲領口"/><span className="photo-customization-help">描述款式、顏色與配件，較容易和角色參考圖的原服裝區分。</span></label>}
        {value.clothingMode==='text' && resolvedClothing!==value.changes.clothing.trim() && <div className="photo-resolved-clothing" role="status"><span>女僕裝短描述使用黑白款式；輸入顏色、款式可自行指定。拍攝時使用：</span><p>{resolvedClothing}</p><button type="button" disabled={disabled} onClick={()=>setChange('clothing',resolvedClothing)}>編輯這段服裝描述</button></div>}
        {value.clothingMode==='reference' && <><p className="photo-customization-help">從已開放的服裝中挑選，搭配原本的角色重新拍攝。</p><div className="photo-garment-picker" role="group" aria-label="服裝參考圖">{garments.map(row=><button key={row.id} type="button" disabled={disabled} aria-pressed={value.garmentId===row.id} aria-label={`選擇服裝 ${row.name}`} onClick={()=>onChange({...value,garmentId:row.id})}><img src={row.image} alt={row.name}/><span>{row.name}</span></button>)}</div>{!garments.length && <p className="photo-customization-help">目前沒有可選服裝，可改用文字描述。</p>}</>}
      </div> : <div className="photo-preset-choice"><div className="photo-clothing-modes" role="group" aria-label={`${label}設定方式`}>{[['preset','官方選項'],['text','自行輸入']].map(([mode,name])=><button key={mode} type="button" disabled={disabled} aria-pressed={(value.fieldModes[key] || 'text')===mode} onClick={()=>setMode(key,mode)}>{name}</button>)}</div>
        {value.fieldModes[key]==='preset' ? <label>{label}官方選項<select aria-label={`${label}官方選項`} disabled={disabled || !presets.some(row=>row.category===PHOTO_PRESET_CATEGORIES[key])} value={presets.some(row=>row.id===value.presetIds[key] && row.category===PHOTO_PRESET_CATEGORIES[key]) ? value.presetIds[key] : ''} onChange={event=>onChange({...value,presetIds:{...value.presetIds,[key]:event.target.value}})}><option value="">請選擇{label}</option>{presets.filter(row=>row.category===PHOTO_PRESET_CATEGORIES[key]).map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select>{!presets.some(row=>row.category===PHOTO_PRESET_CATEGORIES[key]) && <span className="photo-customization-help">目前沒有可選的官方{label}，可改用自行輸入。</span>}</label> : <textarea aria-label={`自訂${label}`} rows={2} maxLength={PHOTO_CHANGE_MAX_LENGTH} disabled={disabled} value={value.changes[key]} onChange={event=>setChange(key,event.target.value)} placeholder={placeholders[key]}/>}
      </div>)}
      </section>)}
    </div>
    <PhotoSettings title="其他沿用提詞" settings={settings.filter(row=>!Object.hasOwn(PHOTO_CHANGE_FIELDS,row.key))}/>
  </div>;
}
