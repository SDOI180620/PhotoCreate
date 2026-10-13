import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createApp} from '../server/index.js';
import {videoTemplate} from '../server/video-workflow.js';
import {DEFAULT_VIDEO_MODELS} from '../shared/photo-video.js';
import {PNG,TEMPLATE,DRAFT,fixtureState} from './fixtures.js';
import {buildShotPlans} from '../shared/domain.js';
import {adminFetch,login} from './auth-client.js';

export const MP4=fs.readFileSync(new URL('./video-fixture.mp4',import.meta.url));
export function videoObjectInfo() {
  return JSON.parse(fs.readFileSync(new URL('./video-object-info.json',import.meta.url),'utf8'));
}
export async function videoFixture() {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-video-')),outputDir=path.join(dataDir,'output');fs.mkdirSync(outputDir);
  const info=videoObjectInfo(),pending=new Set(),running=new Set(),history=new Map(),submitted=[],cancelled=[],calls=[],control={loseReply:false,archiveFails:false,uploadGate:null,workflows:new Map()};
  const fetchImpl=async(url,options={})=>{
    const parsed=new URL(url),route=parsed.pathname;calls.push({route,url,options});
    if(route==='/object_info') return Response.json(info);
    if(route==='/userdata') return Response.json([...control.workflows.keys()].map(value=>value.replace(/^workflows\//,'')));
    if(route.startsWith('/userdata/')) {const file=decodeURIComponent(route.slice('/userdata/'.length));if(options.method==='POST') {control.workflows.set(file,JSON.parse(options.body));return Response.json(file);}return control.workflows.has(file) ? Response.json(control.workflows.get(file)) : new Response('Not found',{status:404});}
    if(route==='/queue') return Response.json({queue_running:[...running].map(id=>[0,id]),queue_pending:[...pending].map(id=>[0,id])});
    if(route.startsWith('/history/')) {const id=route.split('/').at(-1);return Response.json(history.has(id) ? {[id]:history.get(id)} : {});}
    if(route==='/upload/image') {
      if(control.uploadGate) await control.uploadGate;
      const subfolder=options.body.get('subfolder'),image=options.body.get('image'),target=path.join(dataDir,'input',...subfolder.split('/'),image.name);
      fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,Buffer.from(await image.arrayBuffer()));
      return Response.json({name:image.name,subfolder});
    }
    if(route==='/prompt') {const body=JSON.parse(options.body);submitted.push(body);pending.add(body.prompt_id);if(control.loseReply) {control.loseReply=false;throw new Error('Lost reply after accepting the prompt');}return Response.json({prompt_id:body.prompt_id});}
    if(route.startsWith('/api/jobs/') && route.endsWith('/cancel')) {const id=route.split('/')[3];cancelled.push(id);return Response.json({cancelled:pending.delete(id) || running.delete(id)});}
    if(route==='/view') {if(parsed.searchParams.get('filename').endsWith('.mp4')) {if(control.archiveFails) return new Response('download unavailable',{status:503});return new Response(MP4,{headers:{'content-type':'video/mp4'}});}return new Response(control.sourcePng || PNG,{headers:{'content-type':'image/png'}});}
    if(['/interrupt','/free'].includes(route)) throw new Error('Video must never interrupt or unload shared jobs');
    return Response.json({});
  };
  let instance,server;
  const f={dataDir,outputDir,info,pending,running,history,submitted,cancelled,calls,control};
  async function start() {
    instance=createApp({dataDir,fetchImpl,comfyOutputDir:outputDir,photoVideoOptions:{intervalMs:0}});Object.assign(f,instance);
    server=instance.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));f.base=`http://127.0.0.1:${server.address().port}`;
  }
  await start();
  const assets=fixtureState();
  instance.store.mutate(state=>{
    const videoPresets=state.presets.filter(row=>row.category==='video');
    Object.assign(state,assets,{workflow:TEMPLATE});
    state.presets.push(...videoPresets);
    const [plan]=buildShotPlans(state,{...DRAFT,copies:1,garmentIds:['garment-a'],cameraEnabled:false});
    state.jobs=[{...plan,id:'original',status:'completed',createdAt:new Date().toISOString(),comfyUrl:state.settings.comfyUrl,comfyOutputDir:outputDir,images:[{filename:'first.png',subfolder:'PhotoCreate',type:'output'},{filename:'second.png',subfolder:'PhotoCreate',type:'output'}]}];
  });
  fs.mkdirSync(path.join(outputDir,'PhotoCreate'),{recursive:true});for(const name of ['first.png','second.png']) fs.writeFileSync(path.join(outputDir,'PhotoCreate',name),PNG);
  for(const asset of [...assets.characters,...assets.garments]) fs.writeFileSync(path.join(dataDir,'uploads',asset.fileName),PNG);
  f.request=async(route,body,method=body===undefined ? 'GET' : 'POST')=>{
    const response=await adminFetch(f.base+'/api'+route,{method,headers:{'content-type':'application/json'},...(body===undefined ? {} : {body:JSON.stringify(body)})});
    return {status:response.status,data:await response.json()};
  };
  f.customer=async(name)=>{
    const username=`video-${name}`,user=await f.authentication.createCustomer({username,password:'fixture-pass'});
    const db=new DatabaseSync(path.join(dataDir,'accounts.sqlite'),{readOnly:true}),ownerId=db.prepare('SELECT owner_id FROM accounts WHERE id=?').get(user.id).owner_id;db.close();
    const {cookie}=await login(f.base,username,'fixture-pass');
    return {ownerId,username,cookie,request:async(route,body,method=body===undefined ? 'GET' : 'POST')=>{
      const response=await fetch(f.base+'/api/studio'+route,{method,headers:{Cookie:cookie,'content-type':'application/json'},...(body===undefined ? {} : {body:JSON.stringify(body)})});return {status:response.status,data:await response.json()};
    }};
  };
  f.finish=async(id=submitted.at(-1)?.prompt_id)=>{
    const entry=submitted.find(row=>row.prompt_id===id),prefix=entry.prompt.save.inputs.filename_prefix,file=prefix+'_00001_.mp4',absolute=path.join(outputDir,...file.split('/'));
    fs.mkdirSync(path.dirname(absolute),{recursive:true});fs.writeFileSync(absolute,MP4);
    const descriptor={filename:path.posix.basename(file),subfolder:path.posix.dirname(file),type:'output'};
    pending.delete(id);running.delete(id);history.set(id,{status:{status_str:'success',completed:true},outputs:{save:{images:[descriptor]}}});await f.photoVideos.tick();return absolute;
  };
  const stop=async()=>{await new Promise(resolve=>server.close(resolve));instance.store.close();};
  f.restart=async()=>{await stop();await start();};
  f.close=async()=>{
    await stop();const resolved=path.resolve(dataDir);
    if(path.dirname(resolved)!==path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('PhotoCreate-video-')) throw new Error('Unsafe video fixture cleanup');
    fs.rmSync(resolved,{recursive:true,force:true});
  };
  return f;
}
