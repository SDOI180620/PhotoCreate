import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizePresetImport,buildShotPlans} from '../shared/domain.js';
import {createStore} from '../server/store.js';
import {portablePresets} from '../server/transfer-schema.js';
import {createCustomerRecipe} from '../server/customer-recipe.js';
import {customerRecipeMatches} from '../shared/customer-recipe.js';
import {DRAFT,fixtureState} from './fixtures.js';
import {previewFixture} from './preset-preview-fixture.js';
import {login} from './auth-client.js';

test('確認標記在提詞 JSON 與可攜資料包往返，保留舊版未標記資料',()=>{
  const presets=fixtureState().presets.filter(row=>['pose-standing','camera-full'].includes(row.id)).map(row=>({...row,reviewed:true}));
  assert.ok(normalizePresetImport({version:1,presets}).every(row=>row.reviewed===true));
  assert.ok(portablePresets(presets).every(row=>row.reviewed===true));
  assert.equal(normalizePresetImport([{...presets[0],reviewed:false}])[0].reviewed,false);
  const legacy={...presets[0]};delete legacy.reviewed;
  assert.equal(Object.hasOwn(normalizePresetImport([legacy])[0],'reviewed'),false);
  for(const reviewed of ['true',1,null]) assert.throws(()=>normalizePresetImport([{...presets[0],reviewed}]),/reviewed/);
});

test('獨立確認 API 保存至 SQLite，保持內容、草稿、正式成果與已發布設定不變',async t=>{
  const f=await previewFixture({camera:false});t.after(()=>f.close());
  const draft={...DRAFT,mode:'random',randomPoolMode:'selected',characterIds:['character'],cameraEnabled:false};
  f.store.mutate(state=>{state.draft=draft;state.customerRecipe=createCustomerRecipe(state,draft);state.jobs=buildShotPlans(state,{...draft,randomCount:1}).map(job=>({...job,status:'draft',createdAt:new Date().toISOString()}));});
  const before=f.store.read(),preset=before.presets.find(row=>row.id==='pose-standing');
  const response=await f.request('/presets/pose-standing/review',{reviewed:true},'PATCH');
  assert.equal(response.status,200);assert.deepEqual(response.data,{...preset,reviewed:true});
  const after=f.store.read();
  for(const key of ['draft','customerRecipe','jobs']) assert.deepEqual(after[key],before[key]);
  assert.equal(customerRecipeMatches(after,draft),true);
  assert.equal((await f.request('/presets/search?q=自然站姿')).data.rows[0].reviewed,true);
  const reopened=createStore(f.dataDir);
  try {assert.equal(reopened.read().presets.find(row=>row.id===preset.id).reviewed,true);} finally {reopened.close();}
  assert.equal((await f.request('/presets/pose-standing/review',{reviewed:false},'PATCH')).data.reviewed,false);
});

test('編輯與匯入不遺失確認標記，顯式標記可更新，錯誤及顧客請求不修改資料',async t=>{
  const f=await previewFixture({camera:false});t.after(()=>f.close());
  const preset=f.store.read().presets.find(row=>row.id==='pose-standing');
  await f.request('/presets/pose-standing/review',{reviewed:true},'PATCH');
  const edit=await f.request('/presets',{...preset,name:'已修改名稱'});assert.equal(edit.data.reviewed,true);
  await f.request('/presets/import',{version:1,presets:[{...preset,prompt:'Updated prompt'}]});
  assert.equal(f.store.read().presets.find(row=>row.id===preset.id).reviewed,true);
  await f.request('/presets/import',[{...preset,reviewed:false}]);assert.equal(f.store.read().presets.find(row=>row.id===preset.id).reviewed,false);
  const before=f.store.read();
  for(const reviewed of [null,'true',1]) assert.equal((await f.request('/presets/pose-standing/review',{reviewed},'PATCH')).status,400);
  assert.equal((await f.request('/presets/missing/review',{reviewed:true},'PATCH')).status,404);
  assert.deepEqual(f.store.read(),before);
  await f.authentication.createCustomer({username:'review-customer',password:'test-password'});
  const customer=await login(f.base,'review-customer','test-password');
  const denied=await fetch(f.base+'/api/presets/pose-standing/review',{method:'PATCH',headers:{'content-type':'application/json',Cookie:customer.cookie},body:JSON.stringify({reviewed:true})});
  assert.equal(denied.status,403);assert.deepEqual(f.store.read(),before);
});
