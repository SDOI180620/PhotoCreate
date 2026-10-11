import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildShotPlans,optionalPresetSelections} from '../shared/domain.js';
import {createCustomerRecipe,customerDraft,customerProductionState} from '../server/customer-recipe.js';
import {portableDraft} from '../server/transfer-schema.js';
import {DRAFT,fixtureState} from './fixtures.js';

const base={...DRAFT,garmentIds:['garment-a'],poseIds:['pose-standing'],copies:1};
const choices={expressionIds:['expression-smile','expression-calm'],clothingStateIds:['clothing-state-neat','clothing-state-folds'],interactionIds:['interaction-window','interaction-railing']};
const fields={expression:'expressionIds',clothingState:'clothingStateIds',interaction:'interactionIds'};
const signature=shot=>Object.keys(fields).map(key=>shot[key]?.id || '').join('|');

test('選填複選會展開候選組合，每張各取一項提詞且不混合互斥內容',()=>{
  const state=fixtureState(),shots=buildShotPlans(state,{...base,...choices});
  assert.equal(shots.length,8);assert.equal(new Set(shots.map(signature)).size,8);
  for(const shot of shots) for(const [key,field] of Object.entries(fields)) {
    assert(choices[field].includes(shot[key].id));assert(shot.prompt.includes(shot[key].prompt));
    const other=state.presets.find(row=>choices[field].includes(row.id) && row.id!==shot[key].id);
    assert(!shot.prompt.includes(other.prompt));
  }
});

test('隨機模式遵守選填清單，空清單略過該類，即使舊啟用旗標仍存在',()=>{
  const state=fixtureState(),draft={...base,...choices,mode:'random',randomPoolMode:'all',randomCount:30,randomOptional:{expression:false,clothing_state:false,interaction:false}};
  for(const shot of buildShotPlans(state,draft)) for(const [key,field] of Object.entries(fields)) assert(choices[field].includes(shot[key].id));
  const cleared={...draft,expressionIds:[],clothingStateIds:[],interactionIds:[],expressionId:'expression-smile',randomOptional:{expression:true,clothing_state:true,interaction:true}};
  for(const shot of buildShotPlans(state,cleared)) {
    for(const key of Object.keys(fields)) assert.equal(shot[key],null);
    assert.doesNotMatch(shot.prompt,/Facial expression:|Clothing state:|Scene:/);
  }
});

test('舊草稿轉為複選仍保留啟用範圍；停用項目不會意外加入拍攝',()=>{
  const state=fixtureState(),legacy={...base,expressionId:'expression-smile',clothingStateId:'clothing-state-neat',interactionId:'interaction-window'};
  const combinations=optionalPresetSelections(state,legacy);
  assert.deepEqual(combinations,{expressionIds:['expression-smile'],clothingStateIds:['clothing-state-neat'],interactionIds:['interaction-window']});
  const selected={...legacy,mode:'random',randomPoolMode:'selected',randomCount:4,randomOptional:{expression:true,clothing_state:false,interaction:true}};
  const migrated=optionalPresetSelections(state,selected);
  assert.deepEqual(migrated,{expressionIds:['expression-smile'],clothingStateIds:[],interactionIds:['interaction-window']});
  assert.deepEqual(buildShotPlans(state,{...selected,...migrated}).map(signature),buildShotPlans(state,selected).map(signature));
  const all={...selected,randomPoolMode:'all'},allSelections=optionalPresetSelections(state,all);
  assert.deepEqual(allSelections.expressionIds,state.presets.filter(row=>row.category==='expression').map(row=>row.id));
  assert.deepEqual(allSelections.interactionIds,state.presets.filter(row=>row.category==='interaction').map(row=>row.id));
  assert.deepEqual(allSelections.clothingStateIds,[]);
});

test('選填清單拒絕格式、分類與不存在的候選，並去除重複項目',()=>{
  const state=fixtureState();
  for(const expressionIds of ['expression-smile',null,['light-window'],['missing'],Array(10001).fill('expression-smile')]) assert.throws(()=>buildShotPlans(state,{...base,expressionIds}),/表情/);
  assert.equal(buildShotPlans(state,{...base,expressionIds:['expression-smile','expression-smile']}).length,1);
});

test('顧客拍攝使用已發布的複選快照，未發布的圖庫修改不會改變效果',()=>{
  const state=fixtureState(),recipe=createCustomerRecipe(state,{...base,...choices,mode:'random',randomPoolMode:'selected'});
  for(const key of Object.keys(fields)) assert.equal(recipe.pools[key].length,2);
  const published=structuredClone(recipe);
  state.presets.find(row=>row.id==='expression-smile').prompt='An unpublished expression.';
  state.presets.push({id:'unpublished-expression',category:'expression',name:'New expression',prompt:'Unpublished.',tags:[]});
  const draft=customerDraft(recipe,{characterId:'character',count:8,aspectRatio:'reference'});
  const shots=buildShotPlans(customerProductionState(state,recipe),draft);
  assert.equal(new Set(shots.map(signature)).size,8);
  for(const shot of shots) for(const [key,field] of Object.entries(fields)) {
    assert(choices[field].includes(shot[key].id));
    assert.equal(shot[key].prompt,published.pools[key].find(row=>row.id===shot[key].id).prompt);
  }
  assert.deepEqual(recipe,published);
});

test('資料搬移保留複選與清空結果，也將舊版全部啟用轉成完整候選',()=>{
  const state=fixtureState(),draft=portableDraft({...base,...choices,expressionIds:[...choices.expressionIds,'expression-smile']},state,state.presets);
  for(const field of Object.values(fields)) assert.deepEqual(draft[field],choices[field]);
  const cleared=portableDraft({...base,expressionIds:[],expressionId:'expression-smile',randomOptional:{expression:true}},state,state.presets);
  assert.deepEqual(cleared.expressionIds,[]);
  const legacy=portableDraft({...base,mode:'random',randomPoolMode:'all',randomOptional:{expression:true}},state,state.presets);
  assert.deepEqual(legacy.expressionIds,state.presets.filter(row=>row.category==='expression').map(row=>row.id));
  assert.deepEqual(legacy.clothingStateIds,[]);assert.deepEqual(legacy.interactionIds,[]);
});
