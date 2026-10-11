import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {defaultCharacterPromptSettings} from '../shared/character-profile.js';
import {CHARACTER_PROMPT_PROFILE_LIMIT} from '../shared/character-prompt-profiles.js';
import {createStore} from '../server/store.js';
import {previewFixture,until} from './preset-preview-fixture.js';
import {login,adminFetch} from './auth-client.js';
import {DRAFT,PNG} from './fixtures.js';

const configured=label=>{const settings=defaultCharacterPromptSettings();settings.turnaroundPrompt=`${label}: create front, side and back views.`;settings.heightPrompts['160to170']=`${label}: height appearance`;settings.cupPrompts.B=`${label}: cup appearance`;return settings;};
const convert=async f=>{const id=randomUUID(),body=new FormData();body.append('image',new Blob([PNG],{type:'image/png'}),'profile.png');body.append('profile',JSON.stringify({heightCm:165,cupSize:'B'}));const response=await adminFetch(`${f.base}/api/character-turnarounds/${id}`,{method:'PUT',body});assert.equal(response.status,202);return response.json();};

test('既有提詞完整保存為第一份設定檔，SQLite 重開後保留自訂與留白',async t=>{
  const f=await previewFixture();t.after(()=>f.close());
  const settings=configured('existing');settings.heightPrompts.below140='';settings.cupPrompts.Z='';
  f.store.mutate(state=>{state.settings.characterPrompts=settings;delete state.settings.characterPromptProfiles;});
  const reopened=createStore(f.dataDir);
  try {
    const state=reopened.read(),library=state.settings.characterPromptProfiles;
    assert.equal(library.profiles.length,1);assert.equal(library.profiles[0].id,library.activeId);assert.equal(library.profiles[0].name,'目前設定');
    assert.deepEqual(library.profiles[0].settings,settings);assert.deepEqual(state.settings.characterPrompts,settings);
  } finally {reopened.close();}
});

test('多份提詞各自保存；套用同時更新產圖提詞，既有拍攝與轉圖保留送出時的內容',async t=>{
  const f=await previewFixture();t.after(()=>f.close());
  f.store.mutate(state=>{Object.assign(state.characters[0],{heightCm:165,cupSize:'B'});});
  const first=configured('first'),second=configured('second');
  await f.request('/character-prompt-settings',first,'PUT');
  const oldShot=(await f.request('/jobs',DRAFT)).data[0],originalId=f.store.read().settings.characterPromptProfiles.activeId;
  const oldTurn=await convert(f);await until(()=>f.submitted.length===1);
  const created=await f.request('/character-prompt-profiles',{id:randomUUID(),name:'棚拍角色',settings:second});assert.equal(created.status,201);
  const id=created.data.selectedId;assert.equal(created.data.activeId,originalId);assert.deepEqual(f.store.read().settings.characterPrompts,first);
  second.heightPrompts['160to170']='second: edited height appearance';
  const saved=await f.request(`/character-prompt-profiles/${id}`,{name:'寫真棚拍',settings:second},'PUT');assert.equal(saved.status,200);assert.deepEqual(f.store.read().settings.characterPrompts,first);
  const applied=await f.request(`/character-prompt-profiles/${id}`,{activate:true},'PUT');assert.equal(applied.status,200);assert.equal(applied.data.activeId,id);assert.deepEqual(f.store.read().settings.characterPrompts,second);
  const nextShot=(await f.request('/jobs',DRAFT)).data[0];assert(nextShot.prompt.includes('second: edited height appearance'));assert(nextShot.prompt.includes('second: cup appearance'));
  assert.equal(f.store.read().jobs.find(row=>row.id===oldShot.id).prompt,oldShot.prompt);assert(oldShot.prompt.includes('first: height appearance'));
  assert(oldTurn.prompt.includes(first.turnaroundPrompt));const nextTurn=await convert(f);assert(nextTurn.prompt.includes(second.turnaroundPrompt));assert(nextTurn.prompt.includes('second: edited height appearance'));
  f.complete(f.submitted[0].id);await f.characterTurnarounds.tick();await until(()=>f.submitted.length===2);
  const queuedPrompt=Object.values(f.submitted[0].prompt).find(node=>node.class_type==='TextEncodeQwenImage21').inputs.prompt;assert(queuedPrompt.includes(first.turnaroundPrompt));assert(!queuedPrompt.includes('second:'));
  const currentPrompt=Object.values(f.submitted[1].prompt).find(node=>node.class_type==='TextEncodeQwenImage21').inputs.prompt;assert(currentPrompt.includes(second.turnaroundPrompt));
  const updated=configured('legacy update');await f.request('/character-prompt-settings',updated,'PUT');
  const library=f.store.read().settings.characterPromptProfiles;assert.deepEqual(library.profiles.find(row=>row.id===id).settings,updated);assert.deepEqual(library.profiles.find(row=>row.id===originalId).settings,first);
  const reopened=createStore(f.dataDir);try {assert.deepEqual(reopened.read().settings.characterPromptProfiles,library);assert.deepEqual(reopened.read().settings.characterPrompts,updated);} finally {reopened.close();}
});

test('命名、設定、數量與 ID 完整驗證，重複請求不多建，使用中設定檔不能刪除',async t=>{
  const f=await previewFixture();t.after(()=>f.close());const before=f.store.read().settings.characterPromptProfiles;
  for(const body of [null,[],{}, {name:''},{name:'  '},{name:42},{name:'x'.repeat(61)},{name:'valid',settings:null},{name:'valid',id:'../escape'}]) {
    assert.equal((await f.request('/character-prompt-profiles',body)).status,400);assert.deepEqual(f.store.read().settings.characterPromptProfiles,before);
  }
  const body={id:randomUUID(),name:'  Studio preset  ',settings:configured('another')},created=await f.request('/character-prompt-profiles',body);assert.equal(created.status,201);
  assert.equal((await f.request('/character-prompt-profiles',body)).data.profiles.length,2);
  assert.equal((await f.request('/character-prompt-profiles',{...body,name:'Changed name'})).status,409);
  assert.equal((await f.request('/character-prompt-profiles',{name:'studio preset'})).status,409);
  const id=created.data.selectedId,snapshot=f.store.read().settings;
  for(const update of [{},{activate:'yes'},{name:'目前設定'},{name:'new name',activate:true,settings:{}}]) {
    assert([400,409].includes((await f.request(`/character-prompt-profiles/${id}`,update,'PUT')).status));assert.deepEqual(f.store.read().settings,snapshot);
  }
  assert.equal((await f.request('/character-prompt-profiles/unknown',{activate:true},'PUT')).status,404);
  assert.equal((await f.request(`/character-prompt-profiles/${before.activeId}`,undefined,'DELETE')).status,409);
  assert.equal((await f.request(`/character-prompt-profiles/${id}`,undefined,'DELETE')).status,200);assert.deepEqual(f.store.read().settings.characterPrompts,snapshot.characterPrompts);
  const reopened=createStore(f.dataDir);try {assert.equal(reopened.read().settings.characterPromptProfiles.profiles.length,1);} finally {reopened.close();}
  f.store.mutate(state=>{const library=state.settings.characterPromptProfiles;library.profiles.push(...Array.from({length:CHARACTER_PROMPT_PROFILE_LIMIT-1},(_,index)=>({id:`limit-${index}`,name:`Limit ${index}`,settings:defaultCharacterPromptSettings()})));});
  assert.equal((await f.request('/character-prompt-profiles',{name:'One too many'})).status,409);assert.equal(f.store.read().settings.characterPromptProfiles.profiles.length,CHARACTER_PROMPT_PROFILE_LIMIT);
});

test('設定檔僅管理員可讀取及修改，顧客新拍攝直接使用目前套用的提詞',async t=>{
  const f=await previewFixture();t.after(()=>f.close());const second=configured('customer active');
  const result=await f.request('/character-prompt-profiles',{name:'顧客寫真',settings:second});await f.request(`/character-prompt-profiles/${result.data.selectedId}`,{activate:true},'PUT');
  await f.authentication.createCustomer({username:'config-customer',password:'config-password'});const customer=await login(f.base,'config-customer','config-password');
  for(const [method,route,body] of [['GET','',undefined],['POST','',{name:'private'}],['PUT',`/${result.data.selectedId}`,{activate:true}],['DELETE',`/${result.data.selectedId}`,undefined]]) {
    const response=await fetch(f.base+'/api/character-prompt-profiles'+route,{method,headers:{Cookie:customer.cookie,'content-type':'application/json'},...(body && {body:JSON.stringify(body)})});assert.equal(response.status,403);
  }
  assert.equal((await fetch(f.base+'/api/character-prompt-profiles')).status,401);
  const call=(route,body)=>fetch(f.base+'/api/studio'+route,{method:'POST',headers:{Cookie:customer.cookie,...(body instanceof FormData ? {} : {'content-type':'application/json'})},body:body instanceof FormData ? body : JSON.stringify(body)});
  const upload=new FormData();upload.append('image',new Blob([PNG],{type:'image/png'}),'customer.png');upload.append('profiles',JSON.stringify([{heightCm:165,cupSize:'B'}]));
  const asset=await (await call('/characters',upload)).json();const shoot=await call('/shoots',{characterId:asset.id,count:1,aspectRatio:'9:16',requestId:randomUUID()});assert.equal(shoot.status,202);
  await until(()=>f.submitted.length===1);const prompt=Object.values(f.submitted[0].prompt).find(node=>node.class_type==='TextEncodeQwenImage21').inputs.prompt;assert(prompt.includes('customer active: height appearance'));assert(prompt.includes('customer active: cup appearance'));
});
