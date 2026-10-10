// Read-only PhotoCreate data; separate native ComfyUI generation outputs.
// Usage: node scripts/check-photo-customization.mjs <source-job-id> <published-garment-id> [--enqueue] [--maid-check]
// Test descriptions use a neutral, fully worn outfit state to inspect clothing,
// pose, expression and scene independently of the source's optional state.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {buildComfyPrompt,referenceKinds} from '../server/workflow.js';
import {customPhotoPrompt,normalizePhotoCustomization,PHOTO_CUSTOMIZATION_VERSION,clothingDescription} from '../shared/photo-customization.js';
import {composePrompt} from '../shared/domain.js';

const [sourceId,garmentId,...flags]=process.argv.slice(2);
if(!sourceId || !garmentId || flags.some(flag=>!['--enqueue','--maid-check'].includes(flag) && !flag.startsWith('--clothing='))) throw new Error('Provide a source job and a published garment ID, with optional --enqueue, --maid-check or --clothing=<description>.');
const db=new DatabaseSync(path.resolve('data/studio.sqlite'),{readOnly:true});
const row=db.prepare('SELECT data FROM jobs WHERE id=?').get(sourceId),recipeRow=db.prepare('SELECT data FROM meta WHERE key=?').get('customerRecipe');db.close();
if(!row || !recipeRow) throw new Error('Unknown source job or missing published recipe.');
const source=JSON.parse(row.data),garment=JSON.parse(recipeRow.data).pools.garment.find(row=>row.id===garmentId);
if(!garment?.fileName || !source.character?.fileName || !source.workflowSnapshot) throw new Error('The test needs a character, a published garment image and a workflow snapshot.');
const comfyUrl=source.comfyUrl || 'http://127.0.0.1:8188';
if(!['127.0.0.1','localhost','[::1]'].includes(new URL(comfyUrl).hostname)) throw new Error('Only local ComfyUI is supported.');
const runId=randomUUID(),report={runId,createdAt:new Date().toISOString(),photoCustomizationVersion:PHOTO_CUSTOMIZATION_VERSION,sourceJobId:sourceId,neutralClothingState:true,views:[]};
const reportFile=path.resolve(`test-results/photo-customization/${runId}.json`);
fs.mkdirSync(path.dirname(reportFile),{recursive:true});
const saveReport=()=>fs.writeFileSync(reportFile,JSON.stringify(report,null,2)),uploaded=new Map();
async function upload(asset) {
  if(uploaded.has(asset.fileName)) return uploaded.get(asset.fileName);
  const name=`custom-check-${runId}-${asset.fileName}`,form=new FormData();
  form.append('image',new Blob([fs.readFileSync(path.resolve('data/uploads',asset.fileName))],{type:asset.mime || 'image/png'}),name);form.append('subfolder','PhotoCreate');form.append('overwrite','false');
  const response=await fetch(comfyUrl+'/upload/image',{method:'POST',body:form}),data=await response.json();
  if(!response.ok) throw new Error('Reference upload failed.');
  const input=[data.subfolder,data.name].filter(Boolean).join('/');uploaded.set(asset.fileName,input);return input;
}
const clothingOverride=flags.find(flag=>flag.startsWith('--clothing='))?.slice('--clothing='.length);
const cases=clothingOverride ? [{name:'custom-text',mode:'text',clothing:clothingOverride}] : flags.includes('--maid-check') ? [
  {name:'maid-short',mode:'text',clothing:'穿一件女僕裝'},
  {name:'maid-detailed',mode:'text',clothing:'一套黑色長袖、及膝的女僕洋裝，白色圍裙、白色蕾絲領口、白色袖口、黑色平底鞋，衣料不透光'},
] : [{name:'text',mode:'text',clothing:'an opaque red long-sleeve, knee-length dress, a white waist belt, and white sneakers'},{name:'reference',mode:'reference',clothing:''}];
for(const {name,mode,clothing} of cases) {
  const queue=await (await fetch(comfyUrl+'/queue')).json();
  if(!flags.includes('--enqueue') && (queue.queue_running.length || queue.queue_pending.length)) throw new Error('ComfyUI has user work. Use --enqueue to append without interrupting it.');
  const customization=normalizePhotoCustomization({useOriginal:{pose:false,clothing:false,clothingState:false,scene:false,expression:false},clothingMode:mode,garmentId,changes:{
    pose:'Standing upright, both hands resting on her hips, facing the camera. Her entire body from head to shoes is visible.',
    clothing,
    clothingState:'The outfit is fully worn and neatly arranged, with the skirt hanging naturally and both hands resting at the waist.',
    scene:'An outdoor seaside terrace at sunset, ocean waves and a warm orange sky behind her.',
    expression:'A gentle natural smile, looking toward the camera.',
  }});
  const shot={...structuredClone(source),id:`${runId}-${name}`,jobKind:'photo-edit',cameraEnabled:false,photoCustomization:customization,clothingState:null,seed:source.seed+123,
    garment:mode==='reference' ? garment : {id:'check-text-clothing',description:clothingDescription(customization.changes.clothing)}};
  shot.prompt=composePrompt({...source,clothingState:null,cameraMode:'multiangle'});
  shot.prompt=customPhotoPrompt(customization,shot);
  const references={};for(const kind of referenceKinds(shot)) references[kind]=await upload(shot[kind]);
  const graph=buildComfyPrompt(source.workflowSnapshot,shot,references);
  Object.values(graph).find(node=>node.class_type==='SaveImage').inputs.filename_prefix=`PhotoCreate/_checks/custom-photo-${runId}/${name}`;
  const response=await fetch(comfyUrl+'/prompt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:graph,prompt_id:randomUUID(),client_id:'PhotoCreate-custom-verification'})}),submitted=await response.json();
  if(!response.ok || Object.keys(submitted.node_errors || {}).length) throw new Error(JSON.stringify(submitted));
  const view={name,mode,customization,...(mode==='text' ? {resolvedClothing:shot.garment.description} : {}),references,seed:shot.seed,prompt:shot.prompt,promptId:submitted.prompt_id,outputs:null};report.views.push(view);saveReport();
  console.log(JSON.stringify({mode,status:'submitted',promptId:view.promptId,reportFile}));
  const deadline=Date.now()+12*60*1000;
  while(true) {
    const history=await (await fetch(comfyUrl+'/history/'+view.promptId)).json(),entry=history[view.promptId];
    if(entry) {
      if(entry.status.status_str!=='success') throw new Error(JSON.stringify(entry.status));
      view.outputs=entry.outputs;saveReport();console.log(JSON.stringify({mode,status:'success',outputs:view.outputs}));break;
    }
    if(Date.now()>deadline) throw new Error('Generation timed out; inspect the saved prompt ID before retrying.');
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
}
console.log(JSON.stringify({status:'complete',reportFile}));
