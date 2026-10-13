import {Loader2} from 'lucide-react';
import {VIDEO_MODEL_LABELS} from '../shared/photo-video.js';
import VideoWorkflowSetup from './VideoWorkflowSetup.jsx';

export default function VideoEnvironmentSetup({api,url,models,onModelsChange,plan,busy,installationStatus,onWorkflowSaved}) {
  const availability=plan?.videoAvailability,catalog=plan?.videoCatalog || [];
  return <section className="video-environment" aria-label="H3 影片環境"><h3>影片模型與工作流</h3><p className="field-help">一採／二採版本與生成參數在「影片設定」選擇。這裡的模型選擇會在按「安裝環境」時一併保存並補齊。</p>{!models ? <p><Loader2 size={16} className="spin"/>讀取影片設定…</p> : <><div className="form-grid">{Object.entries(VIDEO_MODEL_LABELS).filter(([role])=>models[role]!==undefined).map(([role,label])=><label key={role}>{label}<select aria-label={label} disabled={busy} value={models[role]} onChange={event=>onModelsChange({...models,[role]:event.target.value})}>{(plan?.videoChoices?.[role] || [models[role]]).map(name=><option key={name} value={name}>{name}{availability?.choices?.[role]?.includes(name) ? '（已找到）' : catalog.some(row=>row.role===role && row.fileName===name) ? '（可下載）' : '（需自行安裝）'}</option>)}</select></label>)}</div><VideoWorkflowSetup api={api} url={url} busy={busy} installationStatus={installationStatus} onSaved={onWorkflowSaved}/>{availability && !availability.ready && <p className="field-help">{availability.error}</p>}</>}</section>;
}
