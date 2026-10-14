import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {previewFixture,until} from './preset-preview-fixture.js';
import {defaultCharacterPromptSettings} from '../shared/character-profile.js';
import {createStore} from '../server/store.js';
import {login} from './auth-client.js';
import {DRAFT,PNG} from './fixtures.js';

const settingsFor=label=>{
  const settings=defaultCharacterPromptSettings();
  settings.heightPrompts['160to170']=`${label} height description`;
  settings.cupPrompts.B=`${label} cup description`;
  settings.turnaroundPrompt=`${label} character turnaround on a plain background`;
  settings.turnaroundNegative=`${label} turnaround exclusions`;
  return settings;
};
async function profile(f,label) {
  const result=await f.request('/character-prompt-profiles',{id:randomUUID(),name:label,settings:settingsFor(label)});
  assert.equal(result.status,201);return result.data.selectedId;
}
async function config(f,name,characterPromptProfileId,extra={}) {
  const result=await f.request('/customer-configs',{name,characterPromptProfileId,draft:{...DRAFT,mode:'random',randomPoolMode:'selected',characterIds:['character'],cameraEnabled:false,...extra}});
  assert.equal(result.status,201);return result.data;
}
async function customer(f,username,customerConfigId) {
  assert.equal((await f.request('/accounts',{username,password:'fixture-pass',customerConfigId})).status,201);
  const {cookie}=await login(f.base,username,'fixture-pass');
  return async(route,body,method=body===undefined ? 'GET' : 'POST')=>{
    const response=await fetch(f.base+'/api/studio'+route,{method,headers:{Cookie:cookie,...(body instanceof FormData ? {} : {'Content-Type':'application/json'})},...(body===undefined ? {} : {body:body instanceof FormData ? body : JSON.stringify(body)})});
    return {status:response.status,data:await response.json()};
  };
}

test('帳號依參數設定檔使用角色提詞，預覽和實際拍攝一致，更新提詞保留舊照片快照',async t=>{
  const f=await previewFixture();t.after(()=>f.close());
  f.store.mutate(state=>Object.assign(state.characters[0],{heightCm:165,cupSize:'B'}));
  const a=await profile(f,'profile A'),b=await profile(f,'profile B');
  const ca=await config(f,'方案 A',a),cb=await config(f,'方案 B',b);
  assert.equal((await f.request(`/character-prompt-profiles/${b}`,{activate:true},'PUT')).status,200);
  const alice=await customer(f,'bound-alice',ca.id),bob=await customer(f,'bound-bob',cb.id);
  const before=await alice('/shoots',{characterId:'character',count:1,requestId:randomUUID(),characterPromptProfileId:b});
  assert.equal(before.status,202);
  const original=f.store.read().jobs.find(row=>row.id===before.data.jobs[0].id);
  assert.match(original.prompt,/profile A height description/);assert.match(original.prompt,/profile A cup description/);assert.doesNotMatch(original.prompt,/profile B/);
  const result=await bob('/shoots',{characterId:'character',mode:'custom',count:1,requestId:randomUUID(),selections:{pose:[{source:'temporary',name:'揮手',prompt:'Wave one hand.'}]}});
  assert.equal(result.status,202);assert.match(f.store.read().jobs.find(row=>row.id===result.data.jobs[0].id).prompt,/profile B height description/);
  const preview=await f.request('/shots/preview',{...DRAFT,mode:'random',customerConfigId:ca.id,randomCount:1});
  assert.equal(preview.status,200);assert.match(preview.data[0].prompt,/profile A height description/);assert.doesNotMatch(preview.data[0].prompt,/profile B/);
  const local=await f.request('/shots/preview',{...DRAFT,mode:'random',customerConfigId:'',characterPromptProfileId:a,randomCount:1});
  assert.equal(local.status,200);assert.match(local.data[0].prompt,/profile A cup description/);
  assert.equal((await f.request(`/character-prompt-profiles/${a}`,{settings:settingsFor('updated A')},'PUT')).status,200);
  const next=await alice('/shoots',{characterId:'character',count:1,requestId:randomUUID()});assert.equal(next.status,202);
  assert.match(f.store.read().jobs.find(row=>row.id===next.data.jobs[0].id).prompt,/updated A height description/);
  assert.equal(f.store.read().jobs.find(row=>row.id===original.id).prompt,original.prompt);
  assert.equal((await f.request(`/character-prompt-profiles/${a}`,undefined,'DELETE')).status,409);
  assert.equal((await f.request(`/customer-configs/${ca.id}`,{characterPromptProfileId:b},'PATCH')).status,200);
  assert.equal((await f.request(`/character-prompt-profiles/${a}`,undefined,'DELETE')).status,200);
});

test('舊參數設定檔保存當時使用的角色提詞綁定，重開後保留且拒絕無效綁定',async t=>{
  const f=await previewFixture();t.after(()=>f.close());
  const initial=(await f.request('/customer-configs')).data,active=f.store.read().settings.characterPromptProfiles.activeId;
  assert.equal(initial.configs[0].characterPromptProfileId,active);
  const created=await f.request('/customer-configs',{name:'沿用預設角色提詞'});assert.equal(created.status,201);assert.equal(created.data.characterPromptProfileId,active);
  const alternate=await profile(f,'alternate');await f.request(`/character-prompt-profiles/${alternate}`,{activate:true},'PUT');
  assert((await f.request('/customer-configs')).data.configs.every(row=>row.characterPromptProfileId===active));
  const reopened=createStore(f.dataDir);
  try {assert(reopened.read().customerConfigs.every(row=>row.characterPromptProfileId===active));} finally {reopened.close();}
  for(const id of ['missing-profile','',null,[]]) assert.equal((await f.request(`/customer-configs/${created.data.id}`,{characterPromptProfileId:id},'PATCH')).status,400);
  assert.equal((await f.request(`/customer-configs/${created.data.id}`,{name:'保留綁定'},'PATCH')).data.characterPromptProfileId,active);
});

test('角色轉圖使用帳號綁定的正負提詞及參數，顧客不能改用其他設定檔',async t=>{
  const f=await previewFixture();t.after(()=>f.close());
  const a=await profile(f,'turn A'),b=await profile(f,'turn B');
  const ca=await config(f,'轉圖 A',a,{steps:60,resolution:2048}),cb=await config(f,'轉圖 B',b,{steps:20,resolution:1024});
  const alice=await customer(f,'turn-bound-alice',ca.id),body=new FormData();
  body.append('image',new Blob([PNG],{type:'image/png'}),'role.png');body.append('profile',JSON.stringify({heightCm:165,cupSize:'B'}));
  body.append('characterPromptProfileId',b);body.append('customerConfigId',cb.id);
  const first=await alice('/character-turnarounds/'+randomUUID(),body,'PUT');assert.equal(first.status,202);
  assert.match(first.data.prompt,/turn A character turnaround/);assert.match(first.data.prompt,/turn A height description/);assert.doesNotMatch(first.data.prompt,/turn B/);
  assert.equal(first.data.negative,'turn A turnaround exclusions');
  await until(()=>f.submitted.length===1);
  const graph=f.submitted[0].prompt,input=Object.values(graph).find(node=>node.class_type==='TextEncodeQwenImage21').inputs;
  assert.equal(input.prompt,first.data.prompt);assert.equal(input.negative_prompt,first.data.negative);assert.equal(input.resolution,2048);
  assert.equal(Object.values(graph).find(node=>node.class_type==='KSampler').inputs.steps,60);
  await f.request(`/character-prompt-profiles/${a}`,{settings:settingsFor('updated turn A')},'PUT');
  assert.equal((await alice('/character-turnarounds/'+first.data.id)).data.prompt,first.data.prompt);
  const admin=new FormData();admin.append('image',new Blob([PNG],{type:'image/png'}),'admin.png');admin.append('profile',JSON.stringify({heightCm:165,cupSize:'B'}));admin.append('customerConfigId',cb.id);
  const {cookie}=await login(f.base),response=await fetch(f.base+'/api/character-turnarounds/'+randomUUID(),{method:'PUT',headers:{Cookie:cookie},body:admin});
  const second=await response.json();assert.equal(response.status,202,JSON.stringify(second));
  assert.match(second.prompt,/turn B character turnaround/);assert.equal(second.negative,'turn B turnaround exclusions');
});
