import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {environmentFixture} from './environment-fixtures.js';
import {videoObjectInfo} from './photo-video-fixture.js';
import {DEFAULT_VIDEO_MODELS} from '../shared/photo-video.js';
import {videoTemplate,videoUiTemplate} from '../server/video-workflow.js';
import {DEFAULT_VIDEO_WORKFLOW_PATH} from '../shared/photo-video.js';

export function videoEnvironmentFixture() {
  const f=environmentFixture(),source='workflows/MiniMax H3/fixture.json',workflow=Buffer.from(JSON.stringify(videoUiTemplate()));
  fs.mkdirSync(path.dirname(path.join(f.bundleDir,source)),{recursive:true});fs.writeFileSync(path.join(f.bundleDir,source),workflow);
  const folders={unet:'diffusion_models',videoVae:'vae',audioVae:'vae',clip:'text_encoders'};
  const choices=[...Object.entries(DEFAULT_VIDEO_MODELS),['videoVae','minimax_h3_video_vae_fp16.safetensors'],['clip','qwen3vl_32b_minimax_h3_int8_convrot.safetensors']];
  const resources=choices.map(([role,fileName])=>({id:'video-'+fileName,role,fileName,kind:'model',label:fileName,target:`models/${folders[role]}/${fileName}`,size:f.model.length,sha256:createHash('sha256').update(f.model).digest('hex'),url:'https://video-models.test/'+fileName,sourceUrl:'https://video-models.test/source/'+fileName}));
  const videoManifest={name:'FastH3 Trim fixture',resources:[{id:'video-workflow',kind:'workflow',label:'FastH3 Trim 圖生影片工作流',source,target:'user/default/workflows/'+DEFAULT_VIDEO_WORKFLOW_PATH,size:workflow.length,sha256:createHash('sha256').update(workflow).digest('hex')},...resources]};
  Object.assign(f,{videoManifest,videoResources:resources});
  const original=f.fetchImpl;
  Object.assign(f.controls,{delay:0,corrupt:false,missingVideoNode:false,videoRequests:[]});
  f.fetchImpl=async(url,options={})=> {
    const parsed=new URL(url);
    if(parsed.pathname.startsWith('/userdata/') && options.method==='POST') {
      const file=path.join(f.root,'user/default',decodeURIComponent(parsed.pathname.slice('/userdata/'.length)));
      fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,options.body);return Response.json(file);
    }
    if(parsed.hostname==='video-models.test') {
      const offset=Number(options.headers?.Range?.match(/bytes=(\d+)-/)?.[1] || 0);
      f.controls.videoRequests.push({url,offset});
      const model=f.controls.corrupt ? Buffer.alloc(f.model.length,0) : f.model;
      let cursor=offset,cancelled=false;
      return new Response(new ReadableStream({async pull(controller) {
        if(f.controls.delay) await new Promise(resolve=>setTimeout(resolve,f.controls.delay));
        if(cancelled) return;if(cursor>=model.length) return controller.close();
        controller.enqueue(model.subarray(cursor,cursor+8192));cursor+=8192;
      },cancel(){cancelled=true;}}),{status:offset ? 206 : 200,headers:offset ? {'content-range':`bytes ${offset}-${model.length-1}/${model.length}`} : {}});
    }
    if(parsed.pathname==='/object_info') {
      const info=videoObjectInfo();
      const installed=role=>resources.filter(row=>row.role===role && fs.existsSync(path.join(f.root,row.target))).map(row=>row.fileName);
      info.UNETLoader.input.required.unet_name=[installed('unet')];
      info.VAELoader.input.required.vae_name=[[...installed('videoVae'),...installed('audioVae')]];
      info.CLIPLoader.input.required.clip_name=[installed('clip')];
      if(f.controls.missingVideoNode) delete info[videoTemplate().encode.class_type];
      return Response.json(info);
    }
    if(parsed.pathname==='/userdata') {
      const rows=await (await original(url,options)).json();
      if(fs.existsSync(path.join(f.root,videoManifest.resources[0].target))) rows.push(DEFAULT_VIDEO_WORKFLOW_PATH);
      return Response.json(rows);
    }
    return original(url,options);
  };
  f.cleanup=()=> {
    const target=path.resolve(f.temporary);
    if(path.dirname(target)!==path.resolve(os.tmpdir()) || !path.basename(target).startsWith('PhotoCreate-env-')) throw new Error('Unsafe fixture cleanup');
    fs.rmSync(target,{recursive:true,force:true});
  };
  return f;
}
