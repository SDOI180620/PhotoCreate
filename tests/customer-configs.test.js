import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/index.js';
import {createStore} from '../server/store.js';
import {fixtureState,TEMPLATE,PNG,DRAFT} from './fixtures.js';
import {login} from './auth-client.js';
import {videoFixture} from './photo-video-fixture.js';

async function fixture(t) {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-configs-'));
  const initial=createStore(dataDir);
  initial.mutate(state=>Object.assign(state,fixtureState(),{workflow:TEMPLATE,draft:{...DRAFT,mode:'random',cameraEnabled:false}}));
  for(const row of [...initial.read().characters,...initial.read().garments]) fs.writeFileSync(path.join(dataDir,'uploads',row.fileName),PNG);
  initial.close();
  let instance,server,base,adminCookie;
  const start=async()=>{
    instance=createApp({dataDir,fetchImpl:async()=>Response.json({})});
    server=instance.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    base=`http://127.0.0.1:${server.address().port}`;
    adminCookie=(await login(base)).cookie;
  };
  const close=async()=>{await new Promise(resolve=>server.close(resolve));instance.store.close();};
  await start();
  t.after(async()=>{
    await close();
    const target=fs.realpathSync(dataDir);
    assert.equal(path.dirname(target),fs.realpathSync(os.tmpdir()));assert(path.basename(target).startsWith('PhotoCreate-configs-'));
    fs.rmSync(target,{recursive:true,force:true});
  });
  const request=async(route,{cookie=adminCookie,body,method=body===undefined ? 'GET' : 'POST'}={})=>{
    const response=await fetch(base+route,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},...(body===undefined ? {} : {body:JSON.stringify(body)})});
    return {status:response.status,data:(response.headers.get('content-type') || '').includes('json') ? await response.json() : await response.text()};
  };
  return {request,restart:async()=>{await close();await start();},get base(){return base;}};
}

test('目前已發布的參數成為一般會員預設檔，重開服務仍保留原本選項',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('/api/customer-recipe',{method:'PUT',body:{...DRAFT,mode:'random',randomPoolMode:'selected',garmentIds:['garment-b'],poseIds:['pose-sitting'],cameraEnabled:false}})).status,200);
  await f.restart();
  const result=await f.request('/api/customer-configs');
  assert.equal(result.status,200);
  assert.equal(result.data.configs?.length,1);
  const config=result.data.configs[0];
  assert.equal(config.name,'一般會員');assert.equal(result.data.defaultId,config.id);
  assert.deepEqual(config.recipe.pools.garment.map(row=>row.id),['garment-b']);
  assert.deepEqual(config.recipe.pools.pose.map(row=>row.id),['pose-sitting']);
  await f.restart();
  assert.deepEqual((await f.request('/api/customer-configs')).data,result.data);
});

test('管理員可自由命名並保存不同參數設定檔，修改其中一份不影響預設檔',async t=>{
  const f=await fixture(t);
  const created=await f.request('/api/customer-configs',{body:{name:'朋友限定',draft:{...DRAFT,mode:'random',randomPoolMode:'selected',characterIds:['character'],garmentIds:['garment-b'],poseIds:['pose-sitting'],cameraEnabled:false}}});
  assert.equal(created.status,201);
  assert.equal(created.data.name,'朋友限定');
  assert.deepEqual(created.data.recipe.pools.garment.map(row=>row.id),['garment-b']);
  assert.deepEqual(created.data.recipe.pools.pose.map(row=>row.id),['pose-sitting']);
  const edited=await f.request(`/api/customer-configs/${created.data.id}`,{method:'PATCH',body:{name:'朋友試玩',draft:{...DRAFT,mode:'random',randomPoolMode:'selected',characterIds:[],garmentIds:['garment-a'],poseIds:['pose-standing'],cameraEnabled:false}}});
  assert.equal(edited.status,200);
  await f.restart();
  const saved=(await f.request('/api/customer-configs')).data;
  const selected=saved.configs.find(row=>row.id===created.data.id);
  assert.equal(selected.name,'朋友試玩');assert.deepEqual(selected.recipe.characterIds,[]);
  assert.deepEqual(selected.recipe.pools.garment.map(row=>row.id),['garment-a']);
  assert.deepEqual(selected.recipe.pools.pose.map(row=>row.id),['pose-standing']);
  assert.deepEqual(saved.configs.find(row=>row.id===saved.defaultId).recipe.pools.garment.map(row=>row.id),['garment-a','garment-b']);
});

test('已開放提詞改名稱或內容立即同步預設與命名設定檔，新提詞不自動開放',async t=>{
  const f=await fixture(t),draft={...DRAFT,mode:'random',randomPoolMode:'selected',garmentIds:['garment-b'],poseIds:['pose-sitting'],cameraEnabled:false};
  assert.equal((await f.request('/api/customer-recipe',{method:'PUT',body:draft})).status,200);
  const config=(await f.request('/api/customer-configs',{body:{name:'坐姿方案',draft}})).data;
  const customers=[];
  for(const [username,customerConfigId] of [['sync-default','default'],['sync-named',config.id]]) {
    assert.equal((await f.request('/api/accounts',{body:{username,password:'customer-secret',customerConfigId}})).status,201);
    customers.push((await login(f.base,username,'customer-secret')).cookie);
  }
  const updated={id:'pose-sitting',category:'pose',name:'坐在窗邊看書',prompt:'Sit beside the window and read an open book.',tags:['坐姿']};
  assert.equal((await f.request('/api/presets',{body:updated})).status,200);
  assert.equal((await f.request('/api/presets',{body:{id:'unpublished-pose',category:'pose',name:'未開放的新動作',prompt:'Stand beside a new chair.',tags:[]}})).status,200);
  for(const cookie of customers) {
    const state=(await f.request('/api/studio/state',{cookie})).data,poses=state.presets.filter(row=>row.category==='pose');
    assert.deepEqual(poses.map(row=>({id:row.id,name:row.name})),[{id:'pose-sitting',name:'坐在窗邊看書'}]);
  }
  await f.restart();
  const profiles=(await f.request('/api/customer-configs')).data.configs;
  for(const id of ['default',config.id]) {
    const poses=profiles.find(row=>row.id===id).recipe.pools.pose;
    assert.deepEqual(poses.map(row=>({id:row.id,name:row.name,prompt:row.prompt})),[{id:'pose-sitting',name:'坐在窗邊看書',prompt:'Sit beside the window and read an open book.'}]);
  }
  const preview=await f.request('/api/shots/preview',{body:{...draft,customerConfigId:config.id,randomCount:1}});
  assert.equal(preview.status,200);assert.match(preview.data[0].prompt,/Sit beside the window and read an open book\./);
});

test('已開放服裝提詞修改立即同步顧客與新拍攝，已建立照片保留原提詞',async t=>{
  const f=await fixture(t);
  const garment=(await f.request('/api/garments',{body:{name:'原本針織套裝',sourceType:'prompt',prompt:'A cream knit sweater and long skirt.',tags:[]}})).data;
  const draft={...DRAFT,mode:'random',randomPoolMode:'selected',garmentIds:[garment.id],poseIds:['pose-sitting'],cameraEnabled:false,randomCount:1};
  assert.equal((await f.request('/api/customer-recipe',{method:'PUT',body:draft})).status,200);
  const config=(await f.request('/api/customer-configs',{body:{name:'服裝同步',draft}})).data;
  await f.request('/api/accounts',{body:{username:'sync-clothing',password:'customer-secret',customerConfigId:config.id}});
  const customer=await login(f.base,'sync-clothing','customer-secret');
  const original=await f.request('/api/jobs',{body:{...draft,customerConfigId:config.id}});assert.equal(original.status,201);
  assert.equal((await f.request(`/api/assets/garments/${garment.id}`,{method:'PATCH',body:{name:'藍色針織套裝',prompt:'A navy knit cardigan and grey trousers.'}})).status,200);
  const state=(await f.request('/api/studio/state',{cookie:customer.cookie})).data;
  assert.deepEqual(state.garments.map(row=>({id:row.id,name:row.name})),[{id:garment.id,name:'藍色針織套裝'}]);
  for(const id of ['default',config.id]) {
    const profile=(await f.request('/api/customer-configs')).data.configs.find(row=>row.id===id);
    assert.equal(profile.recipe.pools.garment[0].name,'藍色針織套裝');assert.equal(profile.recipe.pools.garment[0].prompt,'A navy knit cardigan and grey trousers.');
  }
  const next=await f.request('/api/shots/preview',{body:{...draft,customerConfigId:config.id}});
  assert.equal(next.status,200);assert.match(next.data[0].prompt,/A navy knit cardigan and grey trousers\./);
  const history=await f.request(`/api/jobs/${original.data[0].id}/prompts`);assert.equal(history.status,200);
  assert.match(history.data.stages[0].positive,/A cream knit sweater and long skirt\./);assert.doesNotMatch(history.data.stages[0].positive,/A navy knit cardigan/);
});

test('顧客帳號可指定任意參數設定檔，未指定時使用預設檔且重開後保留指定',async t=>{
  const f=await fixture(t),{defaultId}=(await f.request('/api/customer-configs')).data;
  const ordinary=await f.request('/api/accounts',{body:{username:'ordinary',password:'customer-secret'}});
  assert.equal(ordinary.status,201);assert.equal(ordinary.data.customerConfigId,defaultId);
  const config=(await f.request('/api/customer-configs',{body:{name:'週末拍攝'}})).data;
  const assigned=await f.request('/api/accounts',{body:{username:'weekend',password:'customer-secret',customerConfigId:config.id}});
  assert.equal(assigned.status,201);assert.equal(assigned.data.customerConfigId,config.id);
  assert.equal((await f.request(`/api/accounts/${ordinary.data.id}`,{method:'PATCH',body:{customerConfigId:config.id}})).data.customerConfigId,config.id);
  await f.restart();
  const accounts=(await f.request('/api/accounts')).data.accounts;
  assert.equal(accounts.find(row=>row.username==='ordinary').customerConfigId,config.id);
  assert.equal(accounts.find(row=>row.username==='weekend').customerConfigId,config.id);
  const customer=await login(f.base,'ordinary','customer-secret');
  assert.equal(customer.user.customerConfigId,config.id);
  assert.equal((await f.request(`/api/accounts/${ordinary.data.id}`,{method:'PATCH',body:{customerConfigId:defaultId}})).data.customerConfigId,defaultId);
});

test('顧客只看到帳號設定檔開放的官方選項，改指定後立即使用新的選項',async t=>{
  const f=await fixture(t),{defaultId}=(await f.request('/api/customer-configs')).data;
  const config=(await f.request('/api/customer-configs',{body:{name:'只穿外套',draft:{...DRAFT,mode:'random',randomPoolMode:'selected',characterIds:[],garmentIds:['garment-b'],poseIds:['pose-sitting'],cameraEnabled:false}}})).data;
  const account=(await f.request('/api/accounts',{body:{username:'limited',password:'customer-secret',customerConfigId:config.id}})).data;
  const customer=await login(f.base,'limited','customer-secret');
  const state=(await f.request('/api/studio/state',{cookie:customer.cookie})).data;
  assert.deepEqual(state.characters,[]);
  assert.deepEqual(state.garments.map(row=>row.id),['garment-b']);assert.equal(state.wardrobeCount,1);
  assert.deepEqual(state.presets.filter(row=>row.category==='pose').map(row=>row.id),['pose-sitting']);
  assert.equal((await f.request(`/api/accounts/${account.id}`,{method:'PATCH',body:{customerConfigId:defaultId}})).status,200);
  const updated=(await f.request('/api/studio/state',{cookie:customer.cookie})).data;
  assert.deepEqual(updated.characters.map(row=>row.id),['character']);
  assert.deepEqual(updated.garments.map(row=>row.id),['garment-a','garment-b']);
});

test('後台與顧客隨機拍攝都只使用指定設定檔的角色、服裝與動作',async t=>{
  const f=await fixture(t);
  const config=(await f.request('/api/customer-configs',{body:{name:'外套坐姿',draft:{...DRAFT,mode:'random',randomPoolMode:'selected',characterIds:['character'],garmentIds:['garment-b'],poseIds:['pose-sitting'],cameraEnabled:false}}})).data;
  await f.request('/api/accounts',{body:{username:'shooting',password:'customer-secret',customerConfigId:config.id}});
  const customer=await login(f.base,'shooting','customer-secret');
  const shoot=await f.request('/api/studio/shoots',{cookie:customer.cookie,body:{characterId:'character',count:2,cameraEnabled:false,requestId:randomUUID()}});
  assert.equal(shoot.status,202);assert.equal(shoot.data.jobs.length,2);
  assert(shoot.data.jobs.every(job=>job.garment==='黑色外套' && job.pose==='側坐回眸'));
  await f.request('/api/studio/jobs/stop',{cookie:customer.cookie,body:{all:true}});
  const body={...DRAFT,mode:'random',randomCount:3,randomPoolMode:'selected',customerConfigId:config.id,garmentIds:['garment-a'],poseIds:['pose-standing'],cameraEnabled:false};
  const preview=await f.request('/api/shots/preview',{body});
  assert.equal(preview.status,200);assert.equal(preview.data.length,3);
  assert(preview.data.every(job=>job.character.id==='character' && job.garment.id==='garment-b' && job.pose.id==='pose-sitting'));
  const generated=await f.request('/api/jobs',{body});
  assert.equal(generated.status,201);assert.equal(generated.data.length,3);
  assert(generated.data.every(job=>job.character.id==='character' && job.garment.id==='garment-b' && job.pose.id==='pose-sitting'));
});

test('設定檔勾選的動畫提詞提供給該帳號使用，未開放的官方動畫不能送出',async t=>{
  const f=await videoFixture();t.after(()=>f.close());
  const prompt=(await f.request('/photo-videos/prompts',{name:'輕輕揮手',prompt:'Wave gently while preserving the original person and scene.'})).data;
  const config=(await f.request('/customer-configs',{name:'揮手方案',videoPromptIds:[prompt.id]})).data;
  const customer=await f.customer('config'),account=(await f.request('/accounts')).data.accounts.find(row=>row.username===customer.username);
  assert.equal((await f.request(`/accounts/${account.id}`,{customerConfigId:config.id},'PATCH')).status,200);
  f.store.mutate(state=>{state.jobs[0].visitorId=customer.ownerId;});
  const state=(await customer.request('/state')).data;
  assert.deepEqual(state.videoSettings.prompts.map(row=>row.id),[prompt.id]);
  const created=await customer.request('/jobs/original/video',{requestId:randomUUID(),imageIndex:0,duration:5,mode:'official',presetId:prompt.id});
  assert.equal(created.status,202);assert.equal(created.data.video.prompt,'Wave gently while preserving the original person and scene.');
  const hidden=await customer.request('/jobs/original/video',{requestId:randomUUID(),imageIndex:0,duration:5,mode:'official',presetId:'natural'});
  assert.equal(hidden.status,400);
});

test('已開放動畫提詞更名與內容修改立即同步顧客，選擇範圍不變且新影片使用新內容',async t=>{
  const f=await videoFixture();t.after(()=>f.close());
  const prompt=(await f.request('/photo-videos/prompts',{name:'原本揮手',prompt:'Wave once.'})).data;
  await f.request('/photo-videos/selection',{selectedPromptIds:[prompt.id]},'PATCH');
  assert.equal((await f.request('/photo-videos/publish',{})).status,200);
  const config=(await f.request('/customer-configs',{name:'動畫同步',videoPromptIds:[prompt.id]})).data;
  const ordinary=await f.customer('sync-video-default'),assigned=await f.customer('sync-video-named');
  const account=(await f.request('/accounts')).data.accounts.find(row=>row.username===assigned.username);
  await f.request(`/accounts/${account.id}`,{customerConfigId:config.id},'PATCH');
  assert.equal((await f.request(`/photo-videos/prompts/${prompt.id}`,{name:'揮手後轉身',prompt:'Wave gently, then turn toward the window.'},'PATCH')).status,200);
  await f.request('/photo-videos/prompts',{name:'尚未開放',prompt:'An unpublished new motion.'});
  for(const customer of [ordinary,assigned]) {
    const settings=(await customer.request('/state')).data.videoSettings;
    assert.deepEqual(settings.prompts,[{id:prompt.id,name:'揮手後轉身',prompt:'Wave gently, then turn toward the window.'}]);
  }
  await f.restart();
  const profiles=(await f.request('/customer-configs')).data.configs;
  for(const id of ['default',config.id]) assert.deepEqual(profiles.find(row=>row.id===id).videoPrompts,[{id:prompt.id,name:'揮手後轉身',prompt:'Wave gently, then turn toward the window.'}]);
  f.store.mutate(state=>{state.jobs[0].visitorId=assigned.ownerId;});
  const result=await assigned.request('/jobs/original/video',{requestId:randomUUID(),mode:'official',presetId:prompt.id,duration:5});
  assert.equal(result.status,202);assert.equal(result.data.video.presetName,'揮手後轉身');assert.equal(result.data.video.prompt,'Wave gently, then turn toward the window.');
});

test('顧客自訂拍攝只接受設定檔開放的官方服裝與動作',async t=>{
  const f=await videoFixture();t.after(()=>f.close());
  const config=(await f.request('/customer-configs',{name:'外套坐姿',draft:{...DRAFT,mode:'random',randomPoolMode:'selected',characterIds:['character'],garmentIds:['garment-b'],poseIds:['pose-sitting'],cameraEnabled:false}})).data;
  const customer=await f.customer('custom'),account=(await f.request('/accounts')).data.accounts.find(row=>row.username===customer.username);
  await f.request(`/accounts/${account.id}`,{customerConfigId:config.id},'PATCH');
  f.store.mutate(state=>{state.jobs[0].visitorId=customer.ownerId;});
  const clothing=garmentId=>({requestId:randomUUID(),customization:{useOriginal:{clothing:false},clothingMode:'reference',garmentId}});
  assert.equal((await customer.request('/jobs/original/custom',clothing('garment-a'))).status,400);
  assert.equal((await customer.request('/jobs/original/custom',{requestId:randomUUID(),customization:{useOriginal:{pose:false},fieldModes:{pose:'preset'},presetIds:{pose:'pose-standing'}}})).status,400);
  const accepted=await customer.request('/jobs/original/custom',clothing('garment-b'));
  assert.equal(accepted.status,202);assert.equal(accepted.data.job.garment,'黑色外套');
  await customer.request('/jobs/stop',{all:true});
});

test('設定檔同步撤回已不存在的動畫，其餘已開放提詞同步內容且仍可保存名稱',async t=>{
  const f=await fixture(t),{defaultId}=(await f.request('/api/customer-configs')).data;
  const first=(await f.request('/api/photo-videos/prompts',{body:{name:'揮手',prompt:'Wave gently.'}})).data;
  const second=(await f.request('/api/photo-videos/prompts',{body:{name:'回眸',prompt:'Turn back gently.'}})).data;
  const config=(await f.request('/api/customer-configs',{body:{name:'動態方案',videoPromptIds:[first.id,second.id]}})).data;
  await f.request(`/api/customer-configs/${defaultId}`,{method:'PATCH',body:{videoPromptIds:[first.id,second.id]}});
  await f.request('/api/accounts',{body:{username:'withdrawal',password:'customer-secret',customerConfigId:config.id}});
  const customer=await login(f.base,'withdrawal','customer-secret');
  await f.request(`/api/photo-videos/prompts/${second.id}`,{method:'PATCH',body:{name:'回眸',prompt:'Unpublished changed direction.'}});
  assert.equal((await f.request(`/api/presets/${first.id}`,{method:'DELETE'})).status,200);
  const saved=(await f.request('/api/customer-configs')).data;
  for(const row of saved.configs) {
    assert.deepEqual(row.videoPromptIds,[second.id]);assert.equal(row.videoPrompts[0].prompt,'Unpublished changed direction.');
  }
  assert.deepEqual((await f.request('/api/studio/state',{cookie:customer.cookie})).data.videoSettings.prompts.map(row=>row.id),[second.id]);
  assert.equal((await f.request(`/api/customer-configs/${config.id}`,{method:'PATCH',body:{name:'動態方案改名'}})).status,200);
});

test('已撤回的角色、服裝與動作不再出現在指定設定檔或顧客選項',async t=>{
  const f=await fixture(t);
  const config=(await f.request('/api/customer-configs',{body:{name:'拍攝方案',draft:{...DRAFT,mode:'random',randomPoolMode:'selected',characterIds:['character'],cameraEnabled:false}}})).data;
  await f.request('/api/accounts',{body:{username:'removed-options',password:'customer-secret',customerConfigId:config.id}});
  const customer=await login(f.base,'removed-options','customer-secret');
  for(const route of ['/api/assets/characters/character','/api/assets/garments/garment-a','/api/presets/pose-standing']) assert.equal((await f.request(route,{method:'DELETE'})).status,200);
  const saved=(await f.request('/api/customer-configs')).data.configs.find(row=>row.id===config.id);
  assert.deepEqual(saved.recipe.characterIds,[]);
  assert.deepEqual(saved.recipe.pools.garment.map(row=>row.id),['garment-b']);
  assert.deepEqual(saved.recipe.pools.pose.map(row=>row.id),['pose-sitting']);
  const state=(await f.request('/api/studio/state',{cookie:customer.cookie})).data;
  assert.deepEqual(state.characters,[]);assert.deepEqual(state.garments.map(row=>row.id),['garment-b']);
  assert.deepEqual(state.presets.filter(row=>row.category==='pose').map(row=>row.id),['pose-sitting']);
});

test('既有影片發布操作仍更新預設設定檔的動畫選項',async t=>{
  const f=await fixture(t),{defaultId}=(await f.request('/api/customer-configs')).data;
  await f.request(`/api/customer-configs/${defaultId}`,{method:'PATCH',body:{videoPromptIds:[]}});
  const prompt=(await f.request('/api/photo-videos/prompts',{body:{name:'新動畫',prompt:'Move gently with the original appearance.'}})).data;
  await f.request('/api/photo-videos/selection',{method:'PATCH',body:{selectedPromptIds:[prompt.id]}});
  assert.equal((await f.request('/api/photo-videos/publish',{body:{}})).status,200);
  const config=(await f.request('/api/customer-configs')).data.configs.find(row=>row.id===defaultId);
  assert.deepEqual(config.videoPromptIds,[prompt.id]);
});
