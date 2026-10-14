import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/index.js';
import {fixtureState,TEMPLATE,PNG,DRAFT} from './fixtures.js';
import {login} from './auth-client.js';
import {CAMERA_TEMPLATE} from './camera-fixtures.js';
import {SINGLE_SUBJECT_PROMPT,SINGLE_SUBJECT_NEGATIVE} from '../shared/subject.js';
const assertSinglePositive=positive=>assert.equal(positive.split(SINGLE_SUBJECT_PROMPT).length,2);
const assertSingleNegative=negative=>{const terms=negative.split(',').map(term=>term.trim());for(const term of SINGLE_SUBJECT_NEGATIVE.split(', ')) assert.ok(terms.includes(term),term);};

async function fixture(t) {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-customer-shoot-'));
  const pending=new Set(),history=new Map();
  const outputDir=path.join(dataDir,'output');fs.mkdirSync(outputDir);
  const instance=createApp({dataDir,comfyOutputDir:outputDir,fetchImpl:async(url,options={})=>{
    const route=new URL(url).pathname;
    if(route==='/upload/image') return Response.json({name:options.body.get('image').name,subfolder:'PhotoCreate'});
    if(route==='/prompt') {const body=JSON.parse(options.body);pending.add(body.prompt_id);return Response.json({prompt_id:body.prompt_id});}
    if(route==='/queue') return Response.json({queue_running:[],queue_pending:[...pending].map(id=>[0,id])});
    if(route.startsWith('/history/')) {const id=route.split('/').at(-1);return Response.json(history.has(id) ? {[id]:history.get(id)} : {});}
    if(route==='/view') return new Response(PNG,{headers:{'content-type':'image/png'}});
    if(route.startsWith('/api/jobs/') && route.endsWith('/cancel')) return Response.json({cancelled:pending.delete(route.split('/')[3])});
    return Response.json({devices:[]});
  }});
  instance.store.mutate(state=>Object.assign(state,fixtureState(),{workflow:TEMPLATE,cameraWorkflow:CAMERA_TEMPLATE,draft:{...DRAFT,mode:'random',cameraEnabled:false}}));
  for(const asset of [...instance.store.read().characters,...instance.store.read().garments]) fs.writeFileSync(path.join(dataDir,'uploads',asset.fileName),PNG);
  const server=instance.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`,admin=await login(base);
  t.after(async()=>{
    await new Promise(resolve=>server.close(resolve));instance.store.close();
    const target=fs.realpathSync(dataDir);
    assert.equal(path.dirname(target),fs.realpathSync(os.tmpdir()));assert(path.basename(target).startsWith('PhotoCreate-customer-shoot-'));
    fs.rmSync(target,{recursive:true,force:true});
  });
  const request=async(route,body,{cookie=admin.cookie,method=body===undefined ? 'GET' : 'POST'}={})=>{
    const form=body instanceof FormData;
    const response=await fetch(base+route,{method,headers:{Cookie:cookie,...(form ? {} : {'Content-Type':'application/json'})},...(body===undefined ? {} : {body:form ? body : JSON.stringify(body)})});
    return {status:response.status,data:await response.json()};
  };
  const customer=async(username='custom-customer',customerConfigId)=>{
    assert.equal((await request('/api/accounts',{username,password:'customer-secret',...(customerConfigId ? {customerConfigId} : {})})).status,201);
    const {cookie}=await login(base,username,'customer-secret');
    return {request:(route,body,options={})=>request('/api/studio'+route,body,{...options,cookie})};
  };
  const finish=async()=>{
    assert.equal((await request('/api/jobs/sync',{})).status,200);assert(pending.size>0,'The fake image engine must have received a shot.');
    fs.mkdirSync(path.join(outputDir,'PhotoCreate'),{recursive:true});fs.writeFileSync(path.join(outputDir,'PhotoCreate','custom-result.png'),PNG);
    for(const id of pending) history.set(id,{status:{status_str:'success',completed:true},outputs:{'9':{images:[{filename:'custom-result.png',subfolder:'PhotoCreate',type:'output'}]}}});
    pending.clear();assert.equal((await request('/api/jobs/sync',{})).status,200);
  };
  return {request,customer,base,finish};
}

test('顧客自訂動作保留原文，正向提詞恢復單人限制',async t=>{
  const f=await fixture(t),customer=await f.customer();
  const action='Two adult friends sit together on a park bench, talking.';
  const result=await customer.request('/shoots',{characterId:'character',mode:'custom',count:1,aspectRatio:'16:9',requestId:randomUUID(),selections:{
    clothing:[{source:'official',id:'garment-b'}],pose:[{source:'temporary',name:'兩人聊天',prompt:action}],
  }});
  assert.equal(result.status,202);
  const details=await customer.request(`/jobs/${result.data.jobs[0].id}/prompts`);assert.equal(details.status,200);
  const {positive}=details.data.stages.find(stage=>stage.id==='base');
  assert.ok(positive.includes(`Pose: ${action}`));
  assertSinglePositive(positive);
});

test('顧客隨機使用舊設定檔仍保留單人、畫質與版面負面限制',async t=>{
  const f=await fixture(t);
  const config=await f.request('/api/customer-configs',{name:'原有人數限制',draft:{...DRAFT,mode:'random',randomPoolMode:'selected',cameraEnabled:false,
    negative:'blurry, multiple people, more than one person, two people, three people, group shot, crowd, extra person, duplicate person, cloned person, multiple bodies, multiple faces, repeated subject, multiple poses, repeated body, side by side figures, multiple views, collage, watermark',
  }});
  assert.equal(config.status,201);const customer=await f.customer('multi-person-random',config.data.id);
  const result=await customer.request('/shoots',{characterId:'character',count:1,requestId:randomUUID()});assert.equal(result.status,202);
  const details=await customer.request(`/jobs/${result.data.jobs[0].id}/prompts`);assert.equal(details.status,200);
  const {negative}=details.data.stages.find(stage=>stage.id==='base');
  assertSingleNegative(negative);
  for(const term of ['blurry','watermark','multiple views','collage']) assert.ok(negative.split(',').map(value=>value.trim()).includes(term),term);
});

test('舊設定檔保留服裝單人限制及手寫動作',async t=>{
  const f=await fixture(t),action='Two adult friends stand side by side and wave.';
  const extra=`Show only the character from <image1> wearing the referenced outfit.\n\n${action}`;
  const config=await f.request('/api/customer-configs',{name:'舊服裝參考',draft:{...DRAFT,mode:'random',randomPoolMode:'selected',cameraEnabled:false,extra}});
  assert.equal(config.status,201);const customer=await f.customer('multi-person-legacy',config.data.id);
  const result=await customer.request('/shoots',{characterId:'character',count:1,requestId:randomUUID()});assert.equal(result.status,202);await f.finish();
  const details=await customer.request(`/jobs/${result.data.jobs[0].id}/prompts`);assert.equal(details.status,200);
  const base=details.data.stages.find(stage=>stage.id==='base');assert.equal(base.source,'snapshot');
  assert.ok(base.positive.includes(action));
  assert.match(base.positive,/Show only the character from <image1>/);assertSinglePositive(base.positive);
});

test('不同角度拍攝與細節修復恢復單人正負提詞且保留原紀錄',async t=>{
  const f=await fixture(t),customer=await f.customer(),action='Two adult friends sit together on a park bench, talking.';
  const source=await customer.request('/shoots',{characterId:'character',mode:'custom',count:1,aspectRatio:'16:9',requestId:randomUUID(),selections:{pose:[{source:'temporary',name:'兩人聊天',prompt:action}]}});
  assert.equal(source.status,202);const original=source.data.jobs[0];await f.finish();
  const before=(await customer.request(`/jobs/${original.id}/prompts`)).data;
  const result=await customer.request(`/jobs/${original.id}/angle`,{requestId:randomUUID(),imageIndex:0,angle:{horizontalAngle:45,verticalAngle:0,zoom:5}});
  assert.equal(result.status,202);await f.finish();await f.finish();
  const details=await customer.request(`/jobs/${result.data.job.id}/prompts`);assert.equal(details.status,200);
  for(const stage of details.data.stages) {
    assert.equal(stage.source,'snapshot');
    assertSinglePositive(stage.positive);
    assertSingleNegative(stage.negative);
  }
  assert.ok(details.data.stages.find(stage=>stage.id==='base').positive.includes(action));
  assert.deepEqual((await customer.request(`/jobs/${original.id}/prompts`)).data,before);
});

test('照片重製保留動作與原紀錄，恢復單人提詞',async t=>{
  const f=await fixture(t),customer=await f.customer(),action='Two adult friends stand side by side and wave.';
  const source=await customer.request('/shoots',{characterId:'character',mode:'custom',count:1,aspectRatio:'1:1',requestId:randomUUID(),selections:{pose:[{source:'temporary',name:'兩人揮手',prompt:action}]}});
  assert.equal(source.status,202);const original=source.data.jobs[0];await f.finish();
  const before=(await customer.request(`/jobs/${original.id}/prompts`)).data;
  const result=await customer.request(`/jobs/${original.id}/remake`,{requestId:randomUUID()});assert.equal(result.status,202);await f.finish();
  const job=result.data.jobs[0];assert.equal(job.rootId,original.id);assert.equal(job.aspectRatio,'1:1');
  const details=await customer.request(`/jobs/${job.id}/prompts`);assert.equal(details.status,200);
  const base=details.data.stages.find(stage=>stage.id==='base');assert.equal(base.source,'snapshot');
  assert.ok(base.positive.includes(action));
  assertSinglePositive(base.positive);
  assertSingleNegative(base.negative);
  assert.deepEqual((await customer.request(`/jobs/${original.id}/prompts`)).data,before);
});

test('顧客自定義拍攝只使用勾選分類，未指定分類不隨機補上且保留張數與比例',async t=>{
  const f=await fixture(t),customer=await f.customer();
  const result=await customer.request('/shoots',{characterId:'character',mode:'custom',count:4,aspectRatio:'16:9',requestId:randomUUID(),selections:{
    clothing:[{source:'official',id:'garment-b'}],pose:[{source:'official',id:'pose-sitting'}],
  }});
  assert.equal(result.status,202);assert.equal(result.data.jobs.length,4);
  for(const job of result.data.jobs) {
    assert.equal(job.garment,'黑色外套');assert.equal(job.pose,'側坐回眸');assert.equal(job.aspectRatio,'16:9');
    assert.deepEqual(job.settings.filter(row=>['lighting','color','quality','scene','expression','gaze','clothingState'].includes(row.key)),[]);
  }
  const state=(await customer.request('/state')).data;
  assert.deepEqual(state.jobs.map(job=>job.id).sort(),result.data.jobs.map(job=>job.id).sort());
});

test('自定義全取消仍可拍攝，提詞與參考圖不加入任何未選分類或設定檔補充',async t=>{
  const f=await fixture(t),customer=await f.customer();
  const result=await customer.request('/shoots',{characterId:'character',mode:'custom',count:2,aspectRatio:'1:1',requestId:randomUUID(),selections:{clothing:[],pose:[],scene:[]}});
  assert.equal(result.status,202);assert.equal(result.data.jobs.length,2);
  for(const job of result.data.jobs) {
    assert.equal(job.aspectRatio,'1:1');
    assert.deepEqual(job.settings.filter(row=>row.key!=='character' && row.key!=='camera'),[]);
    const details=await customer.request(`/jobs/${job.id}/prompts`);assert.equal(details.status,200);
    const base=details.data.stages.find(stage=>stage.id==='base');
    assert.match(base.positive,/<image1>/);
    assert.doesNotMatch(base.positive,/<image2>|Pose:|Gaze direction:|Scene:|Lighting:|Color treatment:|Photographic quality:|Clothing state:|保持刺繡细節/);
    assert.deepEqual(base.references,[{label:'<image1>',name:'角色'}]);
  }
});

test('自定義未選服裝的完成照片可拍攝不同角度，保留來源、空白分類與原比例',async t=>{
  const f=await fixture(t),customer=await f.customer();
  const source=await customer.request('/shoots',{characterId:'character',mode:'custom',count:1,aspectRatio:'1:1',requestId:randomUUID(),selections:{scene:[{source:'temporary',name:'窗邊',prompt:'A quiet room beside the window.'}]}});
  assert.equal(source.status,202);const original=source.data.jobs[0];await f.finish();
  assert.equal((await customer.request('/state')).data.jobs.find(job=>job.id===original.id).status,'completed');
  const result=await customer.request(`/jobs/${original.id}/angle`,{requestId:randomUUID(),imageIndex:0,angle:{horizontalAngle:45,verticalAngle:-30,zoom:5}});
  assert.equal(result.status,202);assert.equal(result.data.job.rootId,original.id);assert.equal(result.data.job.garment,'');assert.equal(result.data.job.pose,'');assert.equal(result.data.job.aspectRatio,'1:1');
  assert.equal(result.data.job.settings.find(row=>row.key==='scene')?.value,'窗邊');
  const details=await customer.request(`/jobs/${result.data.job.id}/prompts`);assert.equal(details.status,200);
  assert(details.data.stages.find(stage=>stage.id==='base').image.startsWith(`/api/studio/jobs/${original.id}/image/0`));
});

test('自定義全取消的完成照片重製保留原提詞，不補入動作或視線且保留比例與來源',async t=>{
  const f=await fixture(t),customer=await f.customer();
  const source=await customer.request('/shoots',{characterId:'character',mode:'custom',count:1,aspectRatio:'16:9',requestId:randomUUID(),selections:{}});
  assert.equal(source.status,202);const original=source.data.jobs[0];await f.finish();
  const before=(await customer.request(`/jobs/${original.id}/prompts`)).data.stages.find(stage=>stage.id==='base').positive;
  assert.doesNotMatch(before,/Pose:|Gaze direction:|Scene:|Lighting:|Color treatment:|Photographic quality:/);
  const result=await customer.request(`/jobs/${original.id}/remake`,{requestId:randomUUID()});
  assert.equal(result.status,202);assert.equal(result.data.jobs.length,1);
  const job=result.data.jobs[0];assert.equal(job.rootId,original.id);assert.equal(job.garment,'');assert.equal(job.pose,'');assert.equal(job.aspectRatio,'16:9');
  const after=(await customer.request(`/jobs/${job.id}/prompts`)).data.stages.find(stage=>stage.id==='base').positive;
  assert.equal(after,before);
});

test('顧客保存過的提詞可作為同一分類的拍攝候選，服裝文字與場景也能直接選用',async t=>{
  const f=await fixture(t),customer=await f.customer();
  const clothing=(await customer.request('/prompts',{field:'clothing',name:'我的藍色毛衣',prompt:'A blue knitted sweater and cream trousers.'})).data;
  const scene=(await customer.request('/prompts',{field:'scene',name:'我的書店',prompt:'Inside a quiet independent bookshop with wooden shelves.'})).data;
  const result=await customer.request('/shoots',{characterId:'character',mode:'custom',count:2,aspectRatio:'1:1',requestId:randomUUID(),selections:{
    clothing:[{source:'saved',id:clothing.id}],pose:[{source:'official',id:'pose-sitting'}],scene:[{source:'saved',id:scene.id}],
  }});
  assert.equal(result.status,202);assert.equal(result.data.jobs.length,2);
  for(const job of result.data.jobs) {
    assert.equal(job.garment,'我的藍色毛衣');assert.equal(job.pose,'側坐回眸');
    assert.equal(job.settings.find(row=>row.key==='scene')?.value,'我的書店');assert.equal(job.aspectRatio,'1:1');
  }
});

test('本次臨時提詞能覆蓋各拍攝分類，拍攝後不會自動加入顧客收藏',async t=>{
  const f=await fixture(t),customer=await f.customer();
  const values={
    clothing:['臨時連帽外套','Wear a green hooded jacket and black trousers.'],
    pose:['臨時盤腿坐姿','Sit cross-legged with relaxed shoulders.'],
    scene:['臨時雨中車站','A covered railway platform in the rain.'],
    expression:['臨時微笑','A subtle warm smile.'],gaze:['臨時看窗外','Look toward the window.'],
    clothingState:['臨時袖口','Sleeves rolled up to the elbows.'],lighting:['臨時晚光','Warm evening light from the side.'],
    color:['臨時底片色','Muted warm film colors.'],quality:['臨時質感','Fine natural detail and realistic textures.'],
  };
  const selections=Object.fromEntries(Object.entries(values).map(([field,[name,prompt]])=>[field,[{source:'temporary',name,prompt}]]));
  const result=await customer.request('/shoots',{characterId:'character',mode:'custom',count:1,aspectRatio:'9:16',requestId:randomUUID(),selections});
  assert.equal(result.status,202);assert.equal(result.data.jobs.length,1);
  const job=result.data.jobs[0];
  for(const [field,[name]] of Object.entries(values)) assert.equal(job.settings.find(row=>row.key===field)?.value,name);
  assert.deepEqual((await customer.request('/prompts')).data,[]);
  assert.deepEqual((await customer.request('/state')).data.customerPrompts,[]);
});

test('自定義 API 拒絕設定檔外選項、別人的收藏與分類不符的收藏，失敗不建立照片',async t=>{
  const f=await fixture(t);
  const config=await f.request('/api/customer-configs',{name:'受限方案',draft:{...DRAFT,mode:'random',randomPoolMode:'selected',garmentIds:['garment-b'],poseIds:['pose-sitting'],cameraEnabled:false}});
  assert.equal(config.status,201);
  const customer=await f.customer('limited-customer',config.data.id),other=await f.customer('other-customer');
  const foreign=(await other.request('/prompts',{field:'pose',name:'他人的動作',prompt:'Wave to the camera.'})).data;
  const ownScene=(await customer.request('/prompts',{field:'scene',name:'自己的場景',prompt:'A small garden.'})).data;
  for(const selections of [
    {clothing:[{source:'official',id:'garment-a'}]},
    {pose:[{source:'official',id:'pose-standing'}]},
    {pose:[{source:'saved',id:foreign.id}]},
    {pose:[{source:'saved',id:ownScene.id}]},
    {scene:[{source:'temporary',name:'空提詞',prompt:'   '}]},
    {pose:[{source:'temporary',name:'太長',prompt:'a'.repeat(2001)}]},
  ]) {
    const result=await customer.request('/shoots',{characterId:'character',mode:'custom',count:1,requestId:randomUUID(),selections});
    assert.equal(result.status,400);
  }
  assert.deepEqual((await customer.request('/state')).data.jobs,[]);
});

test('本人服裝收藏的圖片可加入拍攝候選，其他顧客不能使用同一服裝 ID',async t=>{
  const f=await fixture(t),customer=await f.customer(),other=await f.customer('wardrobe-other');
  const body=new FormData();body.append('image',new Blob([PNG],{type:'image/png'}),'my-coat.png');
  const uploaded=await customer.request('/garments',body);assert.equal(uploaded.status,201);
  const options={characterId:'character',mode:'custom',count:1,requestId:randomUUID(),selections:{clothing:[{source:'wardrobe',id:uploaded.data.id}]}};
  const result=await customer.request('/shoots',options);
  assert.equal(result.status,202);assert.equal(result.data.jobs[0].garment,uploaded.data.name);
  const denied=await other.request('/shoots',{...options,requestId:randomUUID()});
  assert.equal(denied.status,400);assert.deepEqual((await other.request('/state')).data.jobs,[]);
});

test('重送相同拍攝請求不重複建立照片，改變自定義候選或模式須使用新的請求',async t=>{
  const f=await fixture(t),customer=await f.customer();
  const options={characterId:'character',mode:'custom',count:1,requestId:randomUUID(),selections:{clothing:[{source:'official',id:'garment-b'}]}};
  const first=await customer.request('/shoots',options);assert.equal(first.status,202);
  const repeated=await customer.request('/shoots',options);assert.equal(repeated.status,200);
  assert.equal(repeated.data.created,false);assert.deepEqual(repeated.data.jobs.map(row=>row.id),first.data.jobs.map(row=>row.id));
  const changed=await customer.request('/shoots',{...options,selections:{clothing:[{source:'official',id:'garment-a'}]}});
  assert.equal(changed.status,409);
  assert.equal((await customer.request('/shoots',{...options,mode:'random'})).status,409);
  assert.equal((await customer.request('/state')).data.jobs.length,1);
});

test('官方、收藏與臨時候選可混合複選，1／2／4／8／12 都是總張數且不抽到未選項目',async t=>{
  const f=await fixture(t);
  const config=(await f.request('/api/customer-configs',{name:'固定風格',draft:{...DRAFT,mode:'random',randomPoolMode:'selected',garmentIds:['garment-b'],poseIds:['pose-sitting'],lightingIds:['light-window'],colorIds:['color-natural'],qualityIds:['quality-editorial'],cameraEnabled:false}})).data;
  const customer=await f.customer('mixed-customer',config.id);
  const saved=(await customer.request('/prompts',{field:'clothing',name:'收藏雨衣',prompt:'A yellow raincoat.'})).data;
  const selections={clothing:[{source:'official',id:'garment-b'},{source:'saved',id:saved.id}],pose:[{source:'official',id:'pose-sitting'},{source:'temporary',name:'本次蹲姿',prompt:'Crouch beside the chair with both knees bent.'}]};
  for(const count of [1,2,4,8,12]) {
    const result=await customer.request('/shoots',{characterId:'character',mode:'custom',count,aspectRatio:'9:16',requestId:randomUUID(),selections});
    assert.equal(result.status,202);assert.equal(result.data.jobs.length,count);
    assert(result.data.jobs.every(job=>['黑色外套','收藏雨衣'].includes(job.garment) && ['側坐回眸','本次蹲姿'].includes(job.pose) && job.aspectRatio==='9:16'));
    if(count>=4) {
      assert.deepEqual([...new Set(result.data.jobs.map(job=>job.garment))].sort(),['收藏雨衣','黑色外套']);
      assert.deepEqual([...new Set(result.data.jobs.map(job=>job.pose))].sort(),['側坐回眸','本次蹲姿']);
    }
  }
});
