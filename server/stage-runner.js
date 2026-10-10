import {randomUUID} from 'node:crypto';
import {buildCameraStage} from './camera-workflow.js';
import {jobUpdateFromComfy} from './job-status.js';
import {PRODUCTION_STAGES,productionStages,nextProductionStage} from '../shared/production.js';
import {referenceKinds} from './workflow.js';

const now = () => new Date().toISOString();
const imagePath = image => {
  if(!image?.filename || /[\\/:\0]/.test(image.filename) || !['output','input','temp'].includes(image.type || 'output')) throw new Error('中間圖資料無效。');
  const folder = String(image.subfolder || '').replaceAll('\\','/');
  if(folder.split('/').some(part => part === '..' || part === '.' || /[:\0]/.test(part))) throw new Error('中間圖路徑無效。');
  return `${folder ? folder+'/' : ''}${image.filename} [${image.type || 'output'}]`;
};

// Persist both stage outputs and stable prompt IDs. Every model change has a
// cohort barrier; no later stage is queued while an earlier prompt is unconfirmed.
export function createStageRunner({store,comfyJson,comfyAt,uploadReference,uploadAngleSource,onCompleted,onStop}) {
  let busy = false,closed = false,current = null,timer = null;
  const jobsFor = run => store.read().jobs.filter(job => run.jobIds.includes(job.id) && job.stageRunId === run.id);
  const eligible = job => ['queued','submitting','running','stopping','uncertain'].includes(job.status);
  const mutateJob = (id,callback) => {if(!closed) store.mutate(state => {const job = state.jobs.find(row => row.id === id);if(job) callback(job);});};
  const mutateRun = (id,callback) => {if(!closed) store.mutate(state => {const run = state.pipelineRuns?.find(row => row.id === id);if(run) callback(run);});};
  const stopped = id => closed || Boolean(store.read().jobs.find(job => job.id === id)?.stopRequestedAt);
  const waiting = id => {
    const job = store.read().jobs.find(job => job.id === id);
    return job?.executionMode === 'staged' && (job.stageWaiting || current?.id === id && current.phase === 'uploading');
  };
  const sending = id => current?.id === id && current.phase === 'sending';
  const memorySnapshot = async base => {
    try {
      const stats = await comfyJson('/system_stats',{},base);
      const devices = (stats.devices || []).filter(device => Number.isFinite(device.vram_total) && Number.isFinite(device.vram_free)).map(device => ({name:device.name,vramTotal:device.vram_total,vramFree:device.vram_free,torchReserved:device.torch_vram_total}));
      return devices.length ? {at:now(),ramFree:stats.system?.ram_free,devices} : null;
    } catch {return null;}
  };

  function reconcile(job,queue,history) {
    const update = jobUpdateFromComfy(job,queue,history);
    if(update.status === job.status && update.error === job.error && !update.images && !update.finishedAt) return;
    mutateJob(job.id,current => {
      if(current.promptId !== job.promptId || current.stageWaiting || ['completed','stopped'].includes(current.status)) return;
      if(current.stopRequestedAt && !job.stopRequestedAt) return;
      const stage = current.pipelineStage;
      const finalStage = productionStages(current).at(-1);
      const images = update.images || [];
      if(update.status === 'completed' && !images.length) Object.assign(update,{status:'failed',error:'此階段沒有產生圖片，請重試。'});
      if(update.status === 'completed') {
        current.stageResults ||= {};
        current.stageResults[stage] = {completed:true,images,promptId:current.promptId,comfyUrl:current.comfyUrl,finishedAt:update.finishedAt,apiPrompt:current.apiPrompt};
        if(stage !== finalStage) Object.assign(update,{status:current.stopRequestedAt ? 'stopped' : 'queued',images:[],finishedAt:undefined});
        current.stageWaiting = stage !== finalStage;
      } else if(stage !== finalStage) update.images = [];
      Object.assign(current,update);
      if(update.finishedAt === undefined) delete current.finishedAt;
    });
  }

  async function previousImage(job,stage,base) {
    const previous = job.stageResults?.[stage === 'angle' || !productionStages(job).includes('angle') ? 'base' : 'angle'];
    const image = previous?.images?.[0];
    if(!image) throw new Error('找不到已完成階段的中間圖。');
    if(previous.comfyUrl === base) return imagePath(image);
    const cached = job.stageInputs?.[stage];
    if(cached?.comfyUrl === base) return cached.image;
    const response = await comfyAt(previous.comfyUrl,`/view?${new URLSearchParams({filename:image.filename,subfolder:image.subfolder || '',type:image.type || 'output'})}`);
    const form = new FormData();
    form.append('image',new Blob([await response.arrayBuffer()],{type:response.headers.get('content-type') || 'image/png'}),`stage-${stage}-${job.id}.png`);
    form.append('type','input');form.append('subfolder','PhotoCreate');
    const result = await comfyJson('/upload/image',{method:'POST',body:form},base);
    if(!result.name) throw new Error('中間圖上傳失敗。');
    const input = result.subfolder ? `${result.subfolder}/${result.name}` : result.name;
    mutateJob(job.id,current => {current.stageInputs ||= {};current.stageInputs[stage] = {image:input,comfyUrl:base};});
    return input;
  }

  async function submitJob(run,original,stage,uploaded) {
    let attempted = false;
    current = {id:original.id,phase:'uploading'};
    mutateJob(original.id,job => {
      job.pipelineStage = stage;job.stageWaiting = false;job.status = 'submitting';job.error = null;
      delete job.promptId;delete job.finishedAt;
    });
    try {
      const job = store.read().jobs.find(row => row.id === original.id),images = {};
      if(stage === 'base') {
        for(const kind of referenceKinds(job)) {
          const asset = job[kind];
          if(!uploaded.has(asset.id)) uploaded.set(asset.id,await uploadReference(asset,run.comfyUrl));
          images[kind] = uploaded.get(asset.id);
          if(stopped(job.id)) break;
        }
      } else images.source = stage === 'angle' && job.jobKind === 'angle-edit' ? await uploadAngleSource(job,run.comfyUrl) : await previousImage(job,stage,run.comfyUrl);
      if(stopped(job.id)) {mutateJob(job.id,row => {row.status = 'stopped';row.stageWaiting = true;});return;}
      const prompt = buildCameraStage(job.workflowSnapshot,job.cameraWorkflowSnapshot,job,stage,images),promptId = randomUUID();
      mutateJob(job.id,row => Object.assign(row,{promptId,apiPrompt:prompt,comfyUrl:run.comfyUrl,stageWaiting:false}));
      attempted = true;current.phase = 'sending';
      const result = await comfyJson('/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt,prompt_id:promptId,client_id:'photocreate-studio'})},run.comfyUrl);
      if(!result.prompt_id) throw new Error('ComfyUI 回應缺少 prompt_id。');
      mutateJob(job.id,row => Object.assign(row,{promptId:result.prompt_id,status:row.stopRequestedAt ? 'stopping' : 'queued',submittedAt:now()}));
      if(stopped(job.id) && !closed) await onStop(store.read().jobs.find(row => row.id === job.id));
    } catch(error) {
      const ambiguous = attempted && !/^ComfyUI 4\d\d:/.test(error.message);
      mutateJob(original.id,job => Object.assign(job,{status:job.stopRequestedAt && !attempted ? 'stopped' : ambiguous ? 'uncertain' : 'failed',error:error.message,stageWaiting:!attempted}));
    } finally {current = null;}
  }

  async function releaseModels(run,nextStage,queue) {
    let release = run.release;
    if(!release) {
      // Never unload a model in the middle of a foreign/shared ComfyUI job.
      if(queue.queue_running?.length || queue.queue_pending?.length) return false;
      const job = jobsFor(run).find(job => eligible(job) && !job.stopRequestedAt && nextProductionStage(job) === nextStage);
      if(!job) return false;
      const image = nextStage === 'angle' && job.jobKind === 'angle-edit' ? await uploadAngleSource(job,run.comfyUrl) : await previousImage(job,nextStage,run.comfyUrl);
      release = {nextStage,image,state:'requesting'};
      mutateRun(run.id,row => {row.release = release;});
    }
    if(release.state === 'requesting') {
      if(queue.queue_running?.length || queue.queue_pending?.length) return false;
      const memoryBefore = await memorySnapshot(run.comfyUrl);
      const idle = await comfyJson('/queue',{},run.comfyUrl);
      if(idle.queue_running?.length || idle.queue_pending?.length) return false;
      await comfyAt(run.comfyUrl,'/free',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({unload_models:true,free_memory:true})});
      const promptId = randomUUID();
      // /free sets asynchronous flags. A model-free image checkpoint guarantees
      // those flags are consumed before the next model-bearing prompt executes.
      const prompt = {source:{class_type:'LoadImage',inputs:{image:release.image}},checkpoint:{class_type:'PreviewImage',inputs:{images:['source',0]}}};
      release = {...release,promptId,state:'uncertain',requestedAt:now(),memoryBefore};
      mutateRun(run.id,row => {row.release = release;});
      try {
        const result = await comfyJson('/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt,prompt_id:promptId,client_id:'photocreate-studio'})},run.comfyUrl);
        if(!result.prompt_id) throw new Error('階段切換回應缺少 ID。');
        release = {...release,promptId:result.prompt_id,state:'queued'};
        mutateRun(run.id,row => {row.release = release;});
      } catch(error) {
        if(/^ComfyUI 4\d\d:/.test(error.message)) mutateRun(run.id,row => {delete row.release;});
        throw error;
      }
    }
    const history = await comfyJson(`/history/${encodeURIComponent(release.promptId)}`,{},run.comfyUrl);
    const item = history[release.promptId];
    if(!item) return false;
    if(item.status?.status_str === 'error') {
      mutateRun(run.id,row => {delete row.release;});
      throw new Error('階段切換未完成，將保留中間圖並重試。');
    }
    const memoryAfter = await memorySnapshot(run.comfyUrl);
    mutateRun(run.id,row => {
      row.modelReleases ||= [];
      row.modelReleases.push({fromStage:row.stage,toStage:nextStage,requestedAt:release.requestedAt,checkpointPromptId:release.promptId,checkpointConfirmedAt:now(),memoryBefore:release.memoryBefore,memoryAfter});
      row.stage = nextStage;delete row.release;delete row.error;delete row.needsInitialRelease;
    });
    return true;
  }

  async function advance() {
    if(closed || busy) return;
    busy = true;
    try {
      let run;
      for(const candidate of store.read().pipelineRuns || []) {
        if(!['active','queued'].includes(candidate.status)) continue;
        const members = jobsFor(candidate);
        if(members.some(eligible)) {run = candidate;break;}
        mutateRun(candidate.id,row => {row.status = members.every(job => job.status === 'completed') ? 'completed' : 'paused';row.finishedAt = now();});
      }
      if(!run) return;
      if(run.status !== 'active') mutateRun(run.id,row => {row.status = 'active';});
      let jobs = jobsFor(run);
      if(!jobs.some(eligible)) {mutateRun(run.id,row => {row.status = jobs.every(job => job.status === 'completed') ? 'completed' : 'paused';row.finishedAt = now();});return;}
      const queue = await comfyJson('/queue',{},run.comfyUrl);
      const queued = new Set([...(queue.queue_pending || []),...(queue.queue_running || [])].map(row => row[1]));
      for(const job of jobs.filter(job => eligible(job) && job.promptId && !job.stageWaiting)) {
        if(sending(job.id)) continue;
        if(job.stopRequestedAt) {await onStop(job);continue;}
        const history = queued.has(job.promptId) ? {} : await comfyJson(`/history/${encodeURIComponent(job.promptId)}`,{},run.comfyUrl);
        reconcile(job,queue,history);
      }
      jobs = jobsFor(run);
      onCompleted();
      if(jobs.some(job => eligible(job) && !job.stageWaiting)) return;
      const ready = jobs.filter(job => eligible(job) && !job.stopRequestedAt && nextProductionStage(job));
      if(!ready.length) {mutateRun(run.id,row => {row.status = jobs.every(job => job.status === 'completed') ? 'completed' : 'paused';row.finishedAt = now();});onCompleted();return;}
      const stage = PRODUCTION_STAGES.find(stage => ready.some(job => nextProductionStage(job) === stage));
      if((run.needsInitialRelease || run.stage && run.stage !== stage) && !await releaseModels(run,stage,queue)) return;
      mutateRun(run.id,row => {row.stage = stage;delete row.error;});
      const uploaded = new Map();
      for(const job of ready.filter(job => nextProductionStage(job) === stage)) {
        if(stopped(job.id)) continue;
        await submitJob(run,job,stage,uploaded);
        if(closed) return;
      }
      onCompleted();
    } catch(error) {
      if(!closed) {
        const run = store.read().pipelineRuns?.find(row => row.status === 'active');
        if(run) {
          mutateRun(run.id,row => {row.error = error.message;});
          for(const job of jobsFor(run).filter(job => eligible(job))) mutateJob(job.id,row => {row.error = `階段處理中：${error.message}`;});
        }
      }
    } finally {busy = false;}
  }
  async function start(ids,snapshot) {
    const id = randomUUID();
    store.mutate(state => {
      state.pipelineRuns ||= [];
      const firstStage = PRODUCTION_STAGES.find(stage => state.jobs.some(job => ids.includes(job.id) && nextProductionStage(job) === stage));
      state.pipelineRuns.push({id,jobIds:ids,comfyUrl:snapshot.settings.comfyUrl,status:'queued',createdAt:now(),stage:null,needsInitialRelease:firstStage !== 'base'});
      for(const job of state.jobs.filter(job => ids.includes(job.id))) {
        Object.assign(job,{executionMode:'staged',stageRunId:id,pipelineStage:nextProductionStage(job),stageWaiting:true,status:'queued',images:[],error:null,
          workflowSnapshot:job.workflowSnapshot || structuredClone(snapshot.workflow),cameraWorkflowSnapshot:job.cameraWorkflowSnapshot || structuredClone(snapshot.cameraWorkflow)});
        delete job.stopRequestedAt;delete job.stopDispatchedAt;delete job.promptId;delete job.finishedAt;
      }
    });
    await advance();
    return {results:ids.map(id => {const job = store.read().jobs.find(job => job.id === id);return {id,ok:!['failed','uncertain','stopped'].includes(job.status),...(job.status === 'stopped' ? {stopped:true} : {}),...(job.error ? {error:job.error} : {})};})};
  }
  timer = setInterval(() => {advance().catch(() => {});},1500);timer.unref();
  const close = store.close;
  store.close = () => {closed = true;clearInterval(timer);close();};
  return {start,tick:advance,reconcile,waiting,sending,hasWork:() => store.read().pipelineRuns?.some(run => ['active','queued'].includes(run.status)) || false};
}
