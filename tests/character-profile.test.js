import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {characterProfile,characterProfilePrompt,CUP_SIZES} from '../shared/character-profile.js';
import {buildShotPlans} from '../shared/domain.js';
import {customPhotoPrompt,normalizePhotoCustomization} from '../shared/photo-customization.js';
import {buildComfyPrompt} from '../server/workflow.js';
import {createStore} from '../server/store.js';
import {previewFixture,until} from './preset-preview-fixture.js';
import {adminFetch,login} from './auth-client.js';
import {fixtureState,DRAFT,TEMPLATE,PNG} from './fixtures.js';

test('角色尺寸 A–Z 與公分獨立選填；空白不產生外觀限制，無效資料拒絕',()=>{
  assert.equal(CUP_SIZES.length,26);
  for(const cupSize of CUP_SIZES) assert.deepEqual(characterProfile({cupSize}),{cupSize});
  assert.deepEqual(characterProfile({cupSize:'',heightCm:null}),{});
  assert.deepEqual(characterProfile({cupSize:'F',heightCm:'168.5'}),{cupSize:'F',heightCm:168.5});
  assert.equal(characterProfilePrompt({}),'');
  assert.equal(characterProfilePrompt({cupSize:'F',heightCm:168.5}),'Character measurements: height 168.5 cm; breast size F cup.');
  for(const input of [{cupSize:'AA'},{cupSize:'f'},{cupSize:false},{heightCm:-1},{heightCm:0},{heightCm:1001},{heightCm:Infinity},{heightCm:true},{heightCm:[]},{heightCm:'1e2'},{heightCm:'168 cm'}]) assert.throws(()=>characterProfile(input));
});

test('角色尺寸進入原圖及自訂拍攝提詞，未填角色保留既有提詞',()=>{
  const state=fixtureState(),baseline=buildShotPlans(state,DRAFT)[0];
  state.characters[0]={...state.characters[0],cupSize:'F',heightCm:168};
  const shot=buildShotPlans(state,{...DRAFT,characterId:state.characters[0].id})[0];
  for(const renderStyle of ['realistic','anime_cg']) {
    const graph=buildComfyPrompt(TEMPLATE,{...shot,renderStyle},{character:'role.png',garment:'outfit.png'});
    const input=Object.values(graph).find(row=>row.class_type==='TextEncodeQwenImage21').inputs;
    assert.match(input.prompt,/height 168 cm; breast size F cup/);
    assert.doesNotMatch(input.prompt,/Keep the breast size the same|sole reference for the character's identity and anatomy/);
  }
  const settings=normalizePhotoCustomization({useOriginal:{pose:false},changes:{pose:'Standing beside a tree.'}});
  assert.match(customPhotoPrompt(settings,shot),/height 168 cm; breast size F cup/);
  assert.match(customPhotoPrompt(settings,{...shot,jobKind:'angle-edit'}),/height 168 cm; breast size F cup/);
  assert.equal(baseline.prompt,shot.prompt.replace('\n\nCharacter measurements: height 168 cm; breast size F cup.',''));
});

test('批次角色每張保留獨立資料；編輯可保留或清除尺寸，錯誤上傳不寫入圖片',async t=>{
  const f=await previewFixture();t.after(()=>f.close());
  const post=async profiles=>{const form=new FormData();for(const name of ['one','two']) form.append('images',new Blob([PNG],{type:'image/png'}),name+'.png');if(profiles!==undefined) form.append('profiles',JSON.stringify(profiles));const response=await adminFetch(f.base+'/api/assets/characters',{method:'POST',body:form});return {status:response.status,data:await response.json()};};
  const result=await post([{cupSize:'A',heightCm:160},{cupSize:'Z',heightCm:180.5}]);assert.equal(result.status,201);
  const [first,second]=result.data;assert.equal(first.cupSize,'A');assert.equal(first.heightCm,160);assert.equal(second.cupSize,'Z');assert.equal(second.heightCm,180.5);
  const saved=createStore(f.dataDir);assert.equal(saved.read().characters.find(row=>row.id===second.id).cupSize,'Z');saved.close();
  const fields={name:first.name,description:'Character note.',tags:[]};
  assert.equal((await f.request(`/assets/characters/${first.id}`,fields,'PATCH')).status,200);
  assert.equal(f.store.read().characters.find(row=>row.id===first.id).cupSize,'A');
  assert.equal((await f.request(`/assets/characters/${first.id}`,{...fields,cupSize:'C',heightCm:165},'PATCH')).status,200);
  assert.equal((await f.request(`/assets/characters/${first.id}`,{...fields,cupSize:'',heightCm:''},'PATCH')).status,200);
  assert.equal(f.store.read().characters.find(row=>row.id===first.id).cupSize,undefined);
  assert.equal(f.store.read().characters.find(row=>row.id===first.id).heightCm,undefined);
  const files=fs.readdirSync(path.join(f.dataDir,'uploads')),count=f.store.read().characters.length;
  for(const profiles of [[{}],[{cupSize:'AA'},{}],[{}, {heightCm:'invalid'}]]) assert.equal((await post(profiles)).status,400);
  assert.deepEqual(fs.readdirSync(path.join(f.dataDir,'uploads')),files);assert.equal(f.store.read().characters.length,count);
  assert.equal((await post(undefined)).status,201);
});

test('顧客角色資料保存至帳號、供拍攝使用，其他顧客看不到角色',async t=>{
  const f=await previewFixture();t.after(()=>f.close());
  await f.authentication.createCustomer({username:'profile-alice',password:'profile-password'});await f.authentication.createCustomer({username:'profile-bob',password:'profile-password'});
  const alice=await login(f.base,'profile-alice','profile-password'),bob=await login(f.base,'profile-bob','profile-password');
  const call=async(route,body,session=alice)=>{const response=await fetch(f.base+'/api/studio'+route,{method:body ? 'POST' : 'GET',headers:{Cookie:session.cookie,...(body && !(body instanceof FormData) ? {'content-type':'application/json'} : {})},...(body ? {body:body instanceof FormData ? body : JSON.stringify(body)} : {})});return {status:response.status,data:await response.json()};};
  const form=new FormData();form.append('image',new Blob([PNG],{type:'image/png'}),'profile.png');form.append('profiles',JSON.stringify([{cupSize:'D',heightCm:172}]));
  const result=await call('/characters',form);assert.equal(result.status,201);assert.equal(result.data.cupSize,'D');assert.equal(result.data.heightCm,172);
  assert.equal((await call('/state')).data.characterProfile,1);assert((await call('/state')).data.characters.some(row=>row.id===result.data.id));assert(!(await call('/state',undefined,bob)).data.characters.some(row=>row.id===result.data.id));
  const shots=await call('/shoots',{characterId:result.data.id,count:1,aspectRatio:'9:16',renderStyle:'realistic',requestId:randomUUID()});assert.equal(shots.status,202);
  await until(()=>f.submitted.length>0);const graph=f.submitted[0].prompt;
  assert.match(Object.values(graph).find(row=>row.class_type==='TextEncodeQwenImage21').inputs.prompt,/height 172 cm; breast size D cup/);
});
