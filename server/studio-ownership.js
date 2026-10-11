// An unmarked record belongs to the operator's original studio. Customer
// records keep their stable account owner, even when the operator is logged in.
export const belongsToStudio=(row,ownerId='admin')=>ownerId==='admin' ? !row.visitorId : row.visitorId===ownerId;

// The workbench lists status, prompts and image descriptors. Execution graphs
// remain in the database and are read only when exporting a shot or batch.
export function jobSummary(job) {
  const {workflowSnapshot,cameraWorkflowSnapshot,apiPrompt,stageResults,...view}=job;
  return {...view,...(stageResults ? {stageResults:Object.fromEntries(Object.entries(stageResults).map(([stage,result])=>{
    const {apiPrompt,...summary}=result;return [stage,summary];
  }))} : {})};
}

export function operatorState(state) {
  const own={...state};
  for(const kind of ['characters','garments','scenes','jobs']) own[kind]=state[kind].filter(row=>belongsToStudio(row));
  const batches=new Set(own.jobs.map(job=>job.batchId));
  own.batches=state.batches.filter(row=>belongsToStudio(row) && batches.has(row.id));
  // These metadata collections contain private customer records, not operator UI settings.
  delete own.galleryEntries;delete own.galleryFolders;
  return own;
}
