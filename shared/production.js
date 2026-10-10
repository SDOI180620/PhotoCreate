export const PRODUCTION_STAGES = ['base','angle','refine'];
export const STAGE_LABELS = {base:'產原圖',angle:'轉視角',refine:'高清修正'};
export function productionStages(job) {
  if(job.jobKind === 'angle-edit') return ['angle','refine'];
  if(job.cameraMode !== 'multiangle' && job.executionMode !== 'staged') return ['base'];
  return job.cameraEnabled === false ? ['base'] : PRODUCTION_STAGES;
}
export function nextProductionStage(job) {
  return productionStages(job).find(stage => !job.stageResults?.[stage]?.completed);
}
export function productionStatus(job) {
  if(job.executionMode !== 'staged' || !job.pipelineStage || job.status === 'completed') return '';
  const label = STAGE_LABELS[job.pipelineStage];
  if(job.stageResults?.[job.pipelineStage]?.completed) return job.status === 'stopped' ? `已停止 · ${label}完成` : `${label}完成 · 等待下一階段`;
  return `${job.status === 'running' ? '' : job.status === 'stopped' ? '已停止 · ' : job.status === 'failed' ? '失敗 · ' : job.status === 'uncertain' ? '待確認 · ' : '排隊 · '}${label}`;
}
export function productionPreview(job) {
  if(job.outputsDeletedAt) return null;
  const src = `/api/jobs/${encodeURIComponent(job.id)}/image/0`;
  if(job.images?.length) return {src,stage:null,label:job.executionMode === 'staged' ? productionStages(job).includes('refine') ? '高清成果' : '原圖成果' : '成果'};
  if(job.status === 'completed') return null;
  for(const stage of ['angle','base']) {
    if(job.stageResults?.[stage]?.completed && job.stageResults[stage].images?.length) return {src:`${src}?stage=${stage}`,stage,label:stage === 'angle' ? '轉角圖' : '原圖'};
  }
  return null;
}
export function productionProgress(jobs) {
  const active = jobs.find(job => job.executionMode === 'staged' && ['queued','running','submitting','stopping','uncertain'].includes(job.status));
  if(!active) return null;
  const cohort = jobs.filter(job => job.stageRunId === active.stageRunId);
  const stage = active.pipelineStage;
  const completed = cohort.filter(job => job.stageResults?.[stage]?.completed).length;
  const fraction = cohort.reduce((sum,job) => {
    const stages = productionStages(job);
    return sum + stages.filter(stage => job.stageResults?.[stage]?.completed).length / stages.length;
  },0) / cohort.length;
  return {stage,label:STAGE_LABELS[stage],completed,total:cohort.length,fraction};
}
