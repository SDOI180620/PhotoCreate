// Disposable UI environment. ComfyUI responses are simulated; no GPU jobs are submitted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {createApp} from '../server/index.js';
import {DEFAULT_PRESETS} from '../shared/domain.js';
import {DEFAULT_DRAFT} from '../shared/draft.js';
import {fixtureState,TEMPLATE,PNG} from './fixtures.js';
import {CAMERA_TEMPLATE} from './camera-fixtures.js';

const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-visitor-ui-'));
const history=new Map();
// Slow image/prompt responses and mixed dimensions expose jumps during version switching.
const viewerSwitch=process.argv.includes('--viewer-switch');
let imageNumber=0;
const artwork=filename=>{
  const stage=filename?.includes('refine') ? 'DETAIL' : filename?.includes('angle') ? 'ANGLE' : 'ORIGINAL';
  const color=stage==='ORIGINAL' ? '#798cb5' : stage==='ANGLE' ? '#a47c99' : '#84a799';
  const number=Number(filename?.match(/^switch-(\d+)-/)?.[1] || 1);
  const [width,height]=viewerSwitch ? [[720,960],[1600,1000],[960,1920]][(number-1)%3] : [720,960];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 720 960"><rect width="720" height="960" fill="#e9e5ef"/><rect x="36" y="36" width="648" height="888" rx="10" fill="#f8f6fa"/><path d="M36 670L684 440V924H36Z" fill="${color}" opacity=".23"/><circle cx="360" cy="440" r="188" fill="${color}"/><circle cx="360" cy="440" r="120" fill="#f8f6fa"/><circle cx="360" cy="440" r="78" fill="${color}"/><path d="M145 735H575" stroke="${color}" stroke-width="3"/><text x="360" y="130" text-anchor="middle" font-family="sans-serif" font-size="33" fill="#514267">PhotoCreate</text><text x="360" y="794" text-anchor="middle" font-family="sans-serif" font-size="23" fill="#514267">${stage} / TEST FRAME ${viewerSwitch ? number : ''}</text><text x="360" y="840" text-anchor="middle" font-family="sans-serif" font-size="17" fill="#9587a5">Neutral artwork for interface verification</text></svg>`;
};
const holdStages=process.argv.includes('--progress'),held=new Set();
const fetchImpl=async(url,options={})=>{
  const route=new URL(url).pathname;
  if(route==='/system_stats') return Response.json({devices:[{name:'UI fixture'}]});
  if(route==='/queue') return Response.json({queue_running:[...held].slice(0,1).map(id=>[0,id]),queue_pending:[...held].slice(1).map(id=>[0,id])});
  if(route==='/upload/image') return Response.json({name:options.body.get('image').name,subfolder:'PhotoCreate'});
  if(route==='/view') return new Response(artwork(new URL(url).searchParams.get('filename')),{headers:{'content-type':'image/svg+xml'}});
  if(route==='/free') return new Response(null,{status:200});
  if(route.startsWith('/api/jobs/') && route.endsWith('/cancel')) {
    const id=route.split('/')[3],cancelled=held.delete(id);
    if(cancelled) history.set(id,{status:{status_str:'error',messages:[['execution_interrupted',{}]]},outputs:{}});
    return Response.json({cancelled});
  }
  if(route==='/prompt') {
    const {prompt,prompt_id}=JSON.parse(options.body),outputs={};
    for(const [id,node] of Object.entries(prompt)) if(node.class_type==='SaveImage') outputs[id]={images:[{filename:`${viewerSwitch ? `switch-${++imageNumber}-` : ''}${id}-${prompt_id}.png`,type:'output',subfolder:'PhotoCreate'}]};
    history.set(prompt_id,{status:{status_str:'success'},outputs});if(holdStages && Object.keys(outputs).length) held.add(prompt_id);return Response.json({prompt_id});
  }
  if(route.startsWith('/history/')) {const id=route.split('/').at(-1);return Response.json(history.has(id) && !held.has(id) ? {[id]:history.get(id)} : {});}
  return Response.json({});
};
const {app,store,authentication}=createApp({dataDir,fetchImpl});
await authentication.createCustomer({username:'gallery-demo',password:'gallery-test-2026',name:'畫廊測試顧客'});
store.mutate(state=>{
  Object.assign(state,fixtureState(),{workflow:TEMPLATE,cameraWorkflow:CAMERA_TEMPLATE,draft:structuredClone(DEFAULT_DRAFT)});
  state.characters=state.characters.map((row,index)=>({...row,name:`測試角色 ${index+1}`}));
  const garment=state.garments[0];state.garments=Array.from({length:30},(_,index)=>({...garment,id:`test-garment-${index+1}`,name:`測試服裝 ${index+1}`}));
  state.presets=[...structuredClone(DEFAULT_PRESETS),...Array.from({length:12},(_,index)=>({id:`test-pose-${index+1}`,category:'pose',name:`測試動作 ${index+1}`,prompt:'Standing for a photographic portrait.',tags:['測試']}))];
});
for(const asset of [...store.read().characters,...store.read().garments]) fs.writeFileSync(path.join(dataDir,'uploads',asset.fileName),PNG);
const uploadFile=path.join(dataDir,'test-character.png');fs.writeFileSync(uploadFile,PNG);
const server=createServer((req,res)=>{
  if(viewerSwitch && /^\/api\/(studio\/)?jobs\/[^/]+\/(prompts|image\/\d+)(\?|$)/.test(req.url)) setTimeout(()=>app(req,res),700);
  else app(req,res);
});
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}`,dataDir,uploadFile})));
app.post('/_fixture/release',(req,res)=>{const id=[...held][0];held.delete(id);res.json({released:Boolean(id)});});
app.post('/_fixture/close',(req,res)=>{
  res.json({ok:true});server.close(()=>{store.close();
    const target=fs.realpathSync(dataDir),temporaryRoot=fs.realpathSync(os.tmpdir());
    if(path.dirname(target)!==temporaryRoot || !path.basename(target).startsWith('PhotoCreate-visitor-ui-')) throw new Error('Unexpected fixture cleanup path');
    fs.rmSync(target,{recursive:true,force:true});
  });
});
