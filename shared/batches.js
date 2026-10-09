export const JOB_STATUS_LABELS = {draft:'草稿',submitting:'傳送中',queued:'排隊中',running:'生成中',stopping:'停止中',stopped:'已停止',completed:'已完成',failed:'失敗',uncertain:'待確認'};
export const BATCH_STATUS_LABELS = {...JOB_STATUS_LABELS,partial:'部分完成',failed:'有失敗照片'};
export const RETRYABLE_STATUSES = ['draft','failed','stopped'];
export const ACTIVE_STATUSES = ['submitting','queued','running','stopping'];
export const STOPPABLE_STATUSES = [...ACTIVE_STATUSES,'uncertain'];

export function defaultBatchName(jobs) {
  const garments = new Set(jobs.map(job => job.garment?.id));
  const clothing = garments.size === 1 ? jobs[0]?.garment?.name : `${garments.size} 套服裝`;
  return [jobs[0]?.scene?.name,clothing].filter(Boolean).join(' · ').slice(0,200) || '寫真拍攝';
}

// Earlier versions had no creation-batch ID. Recover closely timed records
// with the same references/settings, then persist the ID once. New batches
// always get a UUID at creation and never depend on timestamps for grouping.
export function migrateShootBatches(state) {
  state.batches ||= [];
  const records = new Map(state.batches.map(batch => [batch.id,batch]));
  const candidates = new Map();
  for(const job of state.jobs) {
    if(!job.batchId) {
      const signature = JSON.stringify([job.character?.id,job.scene?.id,job.camera?.id,job.lighting?.id,job.color?.id,job.quality?.id,job.steps,job.resolution]);
      const time = Date.parse(job.createdAt);
      const candidate = candidates.get(signature);
      if(candidate && Number.isFinite(time) && Math.abs(time - candidate.time) <= 100) job.batchId = candidate.id;
      else {
        job.batchId = `legacy-${job.id}`;
        candidates.set(signature,{id:job.batchId,time});
      }
    }
    if(!records.has(job.batchId)) records.set(job.batchId,{id:job.batchId,name:'',createdAt:job.createdAt});
  }
  const grouped = new Map();
  for(const job of state.jobs) {
    if(!grouped.has(job.batchId)) grouped.set(job.batchId,[]);
    grouped.get(job.batchId).push(job);
  }
  state.batches = [...records.values()].filter(batch => grouped.has(batch.id)).map(batch => ({...batch,name:batch.name || defaultBatchName(grouped.get(batch.id))}));
  state.version = 2;
}

export function collectShootBatches(state) {
  const grouped = new Map();
  for(const job of state.jobs || []) {
    const id = job.batchId || `legacy-${job.id}`;
    if(!grouped.has(id)) grouped.set(id,[]);
    grouped.get(id).push(job);
  }
  const records = new Map((state.batches || []).map(batch => [batch.id,batch]));
  return [...grouped.entries()].map(([id,jobs]) => {
    const counts = Object.fromEntries(Object.keys(JOB_STATUS_LABELS).map(status => [status,0]));
    for(const job of jobs) counts[job.status] = (counts[job.status] || 0) + 1;
    const total = jobs.length;
    const status = counts.stopping ? 'stopping' : counts.running || counts.submitting ? 'running' : counts.queued ? 'queued' : counts.uncertain ? 'uncertain' : counts.failed ? 'failed' : counts.completed === total ? 'completed' : counts.stopped ? 'stopped' : counts.completed ? 'partial' : 'draft';
    return {
      ...records.get(id),id,name:records.get(id)?.name || defaultBatchName(jobs),createdAt:records.get(id)?.createdAt || jobs[0].createdAt,
      jobs,total,counts,status,completed:counts.completed,retryableIds:jobs.filter(job => RETRYABLE_STATUSES.includes(job.status)).map(job => job.id),
      active:jobs.some(job => ACTIVE_STATUSES.includes(job.status)),
      garments:[...new Map(jobs.map(job => [job.garment?.id,job.garment])).values()].filter(Boolean),
      poses:[...new Map(jobs.map(job => [job.pose?.id,job.pose])).values()].filter(Boolean),
    };
  });
}

export function matchesBatchFilter(batch,filter) {
  if(filter === 'draft') return batch.counts.draft > 0;
  if(filter === 'active') return batch.active;
  if(filter === 'stopped') return batch.counts.stopped > 0;
  if(filter === 'completed') return batch.completed === batch.total;
  if(filter === 'issues') return batch.counts.failed > 0 || batch.counts.uncertain > 0;
  return true;
}
