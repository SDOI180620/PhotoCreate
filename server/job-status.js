// Translate ComfyUI state without treating an unconfirmed stop as retryable.
export function jobUpdateFromComfy(job, queue, history) {
  const item = history[job.promptId];
  if (item) {
    const messages = item.status?.messages || [];
    const interrupted = messages.some(([type]) => type === 'execution_interrupted');
    const detail = messages.find(([type]) => type === 'execution_error')?.[1];
    const images = Object.values(item.outputs || {}).flatMap(output => output.images || []);
    const finishedAt = new Date().toISOString();
    if (interrupted || detail?.exception_type?.endsWith('InterruptProcessingException')) return {status:'stopped',images,error:null,finishedAt};
    if (item.status?.status_str === 'error') return {status:'failed',images,error:detail?.exception_message || 'ComfyUI 執行失敗。',finishedAt};
    return {status:'completed',images,error:null,finishedAt};
  }
  const running = queue.queue_running?.some(row => row[1] === job.promptId);
  const pending = queue.queue_pending?.some(row => row[1] === job.promptId);
  if (running || pending) return {status:job.stopRequestedAt ? 'stopping' : running ? 'running' : 'queued',error:null};
  if (job.stopDispatchedAt) return {status:'stopped',error:null,finishedAt:new Date().toISOString()};
  return {status:'uncertain',error:job.stopRequestedAt ? '停止要求尚未確認，將繼續查詢 ComfyUI；確認停止後才能重新生成。' : 'ComfyUI 佇列與歷史中找不到此任務，請檢查 ComfyUI 後再處理。'};
}
