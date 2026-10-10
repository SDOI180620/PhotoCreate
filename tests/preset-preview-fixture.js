import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/index.js';
import {PNG,TEMPLATE,fixtureState} from './fixtures.js';
import {CAMERA_TEMPLATE} from './camera-fixtures.js';
import {adminFetch} from './auth-client.js';

export async function until(predicate,message='Condition did not become true') {
  const end=Date.now()+4000;
  while(Date.now()<end) {if(await predicate()) return;await new Promise(resolve=>setTimeout(resolve,10));}
  throw new Error(message);
}
export async function previewFixture({camera=true,presetPreviewOptions={},beforeStart}={}) {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-preset-preview-')),outputDir=path.join(dataDir,'output');
  fs.mkdirSync(outputDir);
  const pending=new Set(),submitted=[],cancelled=[],history=new Map(),calls=[];
  const control={uploadGate:null,promptGate:null,loseReply:false,cancelUnavailable:false,invalidReply:false};
  const fetchImpl=async(url,options={})=>{
    const route=new URL(url).pathname;calls.push(route);
    if(route==='/upload/image') {if(control.uploadGate) await control.uploadGate;return Response.json({name:options.body.get('image').name,subfolder:'PhotoCreate'});}
    if(route==='/queue') return Response.json({queue_running:[],queue_pending:[...pending].map(id=>[0,id])});
    if(route==='/prompt') {
      const body=JSON.parse(options.body);pending.add(body.prompt_id);submitted.push({id:body.prompt_id,prompt:body.prompt});
      if(control.promptGate) await control.promptGate;
      if(control.loseReply) {control.loseReply=false;throw new Error('Lost reply after accepting the prompt');}
      return Response.json({prompt_id:control.invalidReply ? 'invalid-upstream-id' : body.prompt_id});
    }
    if(route.startsWith('/history/')) {const id=route.split('/').at(-1);return Response.json(history.has(id) ? {[id]:history.get(id)} : {});}
    if(route.startsWith('/api/jobs/') && route.endsWith('/cancel')) {
      const id=route.split('/')[3];cancelled.push(id);
      if(control.cancelUnavailable) throw new Error('Engine is restarting');
      return Response.json({cancelled:pending.delete(id)});
    }
    if(route==='/view') return new Response(PNG,{headers:{'content-type':'image/png'}});
    if(route==='/userdata') return Response.json([]);
    if(route==='/system_stats') return Response.json({devices:[{name:'Test GPU',vram_total:32e9,vram_free:20e9}]});
    if(['/free','/interrupt'].includes(route)) throw new Error('Preview must not interrupt or unload a shared engine');
    return Response.json({});
  };
  beforeStart?.({dataDir,outputDir,pending,control});
  const app=createApp({dataDir,fetchImpl,comfyOutputDir:outputDir,presetPreviewOptions});
  const fixture=fixtureState();
  app.store.mutate(state=>Object.assign(state,fixture,{workflow:TEMPLATE,cameraWorkflow:camera ? CAMERA_TEMPLATE : null,settings:{...state.settings,comfyUrl:'http://127.0.0.1:8188',releaseGpuMemory:true},draft:{...state.draft,steps:30,resolution:1024,aspectRatio:'9:16',angleSteps:25,refineDenoise:0.15}}));
  for(const asset of [...fixture.characters,...fixture.garments]) fs.writeFileSync(path.join(dataDir,'uploads',asset.fileName),PNG);
  const server=app.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=async(route,body,method=body===undefined ? 'GET' : 'POST')=>{
    const response=await adminFetch(base+'/api'+route,{method,headers:{'content-type':'application/json'},...(body===undefined ? {} : {body:JSON.stringify(body)})});
    return {status:response.status,data:await response.json()};
  };
  const complete=id=>{
    const entry=submitted.find(row=>row.id===id);if(!entry) throw new Error('Prompt not submitted');
    const outputs={};
    for(const [nodeId,node] of Object.entries(entry.prompt)) if(node.class_type==='SaveImage') {
      const file=node.inputs.filename_prefix+'_00001_.png',absolute=path.resolve(outputDir,file);
      if(!path.relative(outputDir,absolute).startsWith('PhotoCreate'+path.sep)) throw new Error('Unsafe fixture output');
      fs.mkdirSync(path.dirname(absolute),{recursive:true});fs.writeFileSync(absolute,PNG);
      outputs[nodeId]={images:[{filename:path.basename(file),subfolder:path.dirname(file).replaceAll('\\','/'),type:'output'}]};
    }
    pending.delete(id);history.set(id,{status:{status_str:'success',completed:true},outputs});
    return outputs;
  };
  const open=async(presetId)=>{
    const id=randomUUID(),result=await request(`/preset-previews/${id}`,{presetId},'PUT');
    if(result.status!==200) throw new Error(JSON.stringify(result.data));
    return id;
  };
  const shoot=async(id,preset,requestId=randomUUID())=>request(`/preset-previews/${id}/shots`,{preset,requestId});
  const close=async()=>{
    await new Promise(resolve=>server.close(resolve));app.store.close();
    const resolved=path.resolve(dataDir),temporary=path.resolve(os.tmpdir());
    if(path.dirname(resolved)!==temporary || !path.basename(resolved).startsWith('PhotoCreate-preset-preview-')) throw new Error('Unsafe fixture cleanup');
    fs.rmSync(resolved,{recursive:true,force:true});
  };
  return {...app,base,request,open,shoot,complete,close,control,dataDir,outputDir,pending,submitted,cancelled,history,calls};
}
