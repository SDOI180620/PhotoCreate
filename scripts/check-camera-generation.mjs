// Manual visual check of the production camera stage. This reads an existing
// job as a source, creates separate ComfyUI outputs, and never changes its data.
// Usage: node scripts/check-camera-generation.mjs <angle-job-id> <h> <v> <zoom>
// Add --suite for five distances, 7/8 and 9/10 pairs, and three other views;
// --close-suite checks five other viewpoints at the closest level;
// --low-suite compares front and side views at -70°, Zoom 8 and 9;
// --zoom-suite <h> <v> checks each distance once at the same viewpoint;
// --enqueue joins the end of the existing ComfyUI queue without interrupting it;
// --refine also checks the final HD stage; --wait-for-idle waits
// for user work to finish before submitting each diagnostic.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {buildCameraStage,buildCameraPipeline} from '../server/camera-workflow.js';
import {normalizeCameraAngle,cameraZoomLevel,CAMERA_FRAMING_VERSION} from '../shared/camera.js';

const [jobId,...args]=process.argv.slice(2);
const numbers=args.filter(arg=>!arg.startsWith('--'));
if(!jobId || (args.includes('--zoom-suite') ? numbers.length!==2 : ![0,3].includes(numbers.length))) throw new Error('Provide a source angle job and optional horizontal/vertical/zoom numbers; --zoom-suite needs horizontal/vertical only.');
if(['--suite','--close-suite','--low-suite','--zoom-suite'].filter(flag=>args.includes(flag)).length>1) throw new Error('Select one visual-check suite.');
const db=new DatabaseSync(path.resolve('data/studio.sqlite'),{readOnly:true});
const row=db.prepare('SELECT data FROM jobs WHERE id=?').get(jobId);db.close();
if(!row) throw new Error('Unknown source job.');
const job=JSON.parse(row.data),sourceImage=job.stageResults?.angle?.apiPrompt?.source?.inputs.image;
if(!sourceImage || !job.workflowSnapshot || !job.cameraWorkflowSnapshot) throw new Error('The angle job must have its source and workflow snapshots saved.');
const comfyUrl=job.comfyUrl || job.cameraSource?.comfyUrl || 'http://127.0.0.1:8188';
if(!['127.0.0.1','localhost','[::1]'].includes(new URL(comfyUrl).hostname)) throw new Error('This diagnostic only targets local ComfyUI.');
const suite=args.includes('--zoom-suite')
  ? [1,3,5,8,9].map(zoom=>[Number(numbers[0]),Number(numbers[1]),zoom])
  : args.includes('--low-suite')
  ? [[0,-70,8],[90,-70,8],[0,-70,9],[90,-70,9]]
  : args.includes('--close-suite')
  ? [[90,0,9],[180,30,9],[270,60,9],[0,-30,9],[0,60,9]]
  : args.includes('--suite') ? [[0,0,1],[0,0,3],[0,0,5],[0,0,7],[0,0,8],[0,0,9],[0,0,10],[90,-30,7],[180,30,7],[270,60,5]] : null;
const angles=suite
  ? suite.map(([horizontalAngle,verticalAngle,zoom])=>({horizontalAngle,verticalAngle,zoom}))
  : [numbers.length ? {horizontalAngle:Number(numbers[0]),verticalAngle:Number(numbers[1]),zoom:Number(numbers[2])} : job.camera.angle];
const runId=randomUUID(),report={runId,createdAt:new Date().toISOString(),cameraFramingVersion:CAMERA_FRAMING_VERSION,sourceJobId:jobId,sourceImage,seed:job.seed,views:[]};
const reportFile=path.resolve(`test-results/camera-generation/${runId}.json`);
fs.mkdirSync(path.dirname(reportFile),{recursive:true});
const saveReport=()=>fs.writeFileSync(reportFile,JSON.stringify(report,null,2));
for(const selected of angles) {
  const angle=normalizeCameraAngle(selected),idleDeadline=Date.now()+6*60*1000;
  while(true) {
    const queue=await (await fetch(comfyUrl+'/queue')).json();
    if(args.includes('--enqueue') || !queue.queue_running.length && !queue.queue_pending.length) break;
    if(!args.includes('--wait-for-idle') || Date.now()>idleDeadline) throw new Error('ComfyUI has user work in progress; inspect the saved report before retrying.');
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
  const shot={...job,camera:{...job.camera,angle}};
  const graph=args.includes('--refine')
    ? buildCameraPipeline(job.workflowSnapshot,job.cameraWorkflowSnapshot,shot,{source:sourceImage})
    : buildCameraStage(job.workflowSnapshot,job.cameraWorkflowSnapshot,shot,'angle',{source:sourceImage});
  const name=`h${angle.horizontalAngle}-v${angle.verticalAngle}-z${angle.zoom}`;
  Object.values(graph).find(node=>node.class_type==='SaveImage').inputs.filename_prefix=`PhotoCreate/_checks/camera-levels-${runId}/${name}${args.includes('--refine') ? '-hd' : ''}`;
  const response=await fetch(comfyUrl+'/prompt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:graph,prompt_id:randomUUID(),client_id:'PhotoCreate-camera-verification'})});
  const submitted=await response.json();
  if(!response.ok || Object.keys(submitted.node_errors || {}).length) throw new Error(JSON.stringify(submitted));
  const view={angle,framing:cameraZoomLevel(angle).label,seed:job.seed+1,promptId:submitted.prompt_id,prompt:Object.values(graph).find(node=>node._meta?.cameraAngle).inputs.prompt,outputs:null};
  report.views.push(view);saveReport();console.log(JSON.stringify({name,promptId:view.promptId,status:'submitted',reportFile}));
  const deadline=Date.now()+12*60*1000;
  while(true) {
    const history=await (await fetch(comfyUrl+'/history/'+view.promptId)).json(),entry=history[view.promptId];
    if(entry) {
      if(entry.status.status_str!=='success') throw new Error(JSON.stringify(entry.status));
      view.outputs=entry.outputs;saveReport();console.log(JSON.stringify({name,promptId:view.promptId,status:'success',outputs:view.outputs}));break;
    }
    if(Date.now()>deadline) throw new Error('Timed out; inspect the saved prompt ID before retrying.');
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
}
console.log(JSON.stringify({status:'complete',reportFile}));
