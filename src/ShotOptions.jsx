import { cameraAngleLabel } from '../shared/camera.js';
import { OUTPUT_RATIOS } from '../shared/domain.js';
import PresetReview from './PresetReview.jsx';

export default function ShotOptions({job,presets = [],onOpenPreset,detailed = false}) {
  const interaction = [job.interaction?.name,job.sceneInteraction?.trim()].filter(Boolean).join(' · ');
  const options = [
    ['character','角色',job.character?.name],
    ['garment','服裝',job.garment?.name],
    ['pose','動作',job.pose?.name],
    ['expression','表情',job.expression?.name],
    ['clothing-state','服裝狀態',job.clothingState?.name],
    ['interaction','場景',interaction],
    ['camera','攝影角度',job.camera?.name],
    ['lighting','光線',job.lighting?.name],
    ['color','色彩',job.color?.name],
    ['quality','畫質',job.quality?.name],
    ...(job.scene ? [['scene','場景參考',job.scene.name]] : []),
  ];
  const presetFor=kind=>{
    const key=kind==='clothing-state' ? 'clothingState' : kind;
    const category=kind==='clothing-state' ? 'clothing_state' : kind;
    return presets.find(row=>row.id===job[key]?.id && row.category===category);
  };
  const option=(kind,label,value,className)=>{
    const preset=presetFor(kind);
    return preset && onOpenPreset ? <button type="button" className={className} aria-label={`開啟${label}提詞 ${value}`} aria-haspopup="dialog" title={`開啟${label}提詞`} onClick={event=>{event.stopPropagation();onOpenPreset(preset);}}>{value}<PresetReview reviewed={preset.reviewed}/></button> : value;
  };
  if(!detailed) return <div className="shot-tags" aria-label="拍攝標籤">
    {options.filter(([kind,,value]) => !['character','garment','scene'].includes(kind) && value).map(([kind,label,value]) => {
      const text=kind==='interaction' ? job.interaction?.name || '自訂互動' : value;
      const content=option(kind,label,text,`shot-tag tag-${kind} shot-tag-link`);
      return <span key={kind} className={typeof content==='string' ? `shot-tag tag-${kind}` : undefined} title={label}>{content}</span>;
    })}
  </div>;
  const ratio = OUTPUT_RATIOS[job.aspectRatio || 'reference']?.label || job.aspectRatio;
  const dimensions = job.outputWidth && job.outputHeight ? `${job.outputWidth} × ${job.outputHeight} px` : `${job.resolution} px 等效`;
  return <div className="shot-option-summary">
    <dl className="shot-options" aria-label="拍攝選項">{options.map(([kind,label,value]) => <div key={label} className={`shot-option option-${kind}`}><dt>{label}</dt><dd>{value ? option(kind,label,value,'shot-option-link') : (['expression','clothing-state','interaction'].includes(kind) ? '無' : '未記錄')}</dd></div>)}</dl>
    {job.cameraMode === 'multiangle' && <div className="shot-camera-details"><p>{cameraAngleLabel(job.camera.angle)}</p><p>換角度 {job.angleSteps} 步 · 高清修正強度 {job.refineDenoise}</p></div>}
    <dl className="shot-settings" aria-label="生成設定"><div><dt>步數</dt><dd>{job.steps} 步</dd></div><div><dt>比例</dt><dd>{ratio}</dd></div><div><dt>解析度</dt><dd>{dimensions}</dd></div><div className="shot-seed"><dt>Seed</dt><dd>{job.seed}</dd></div></dl>
  </div>;
}
