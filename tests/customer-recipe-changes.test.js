import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCustomerRecipe} from '../server/customer-recipe.js';
import {customerRecipeMatches} from '../shared/customer-recipe.js';
import {DRAFT,fixtureState} from './fixtures.js';

const draft=()=>({...DRAFT,mode:'random',randomPoolMode:'selected',characterIds:['character'],cameraEnabled:false});
const published=()=>{const state=fixtureState(),input=draft();state.customerRecipe=createCustomerRecipe(state,input);return {state,input};};

test('套用判斷比對已發布候選與設定：步數、角色、提詞變更啟用，還原後回到未變更',()=>{
  const {state,input}=published();
  assert.equal(customerRecipeMatches(state,input),true);
  assert.equal(customerRecipeMatches(state,{...input,steps:60}),false);
  assert.equal(customerRecipeMatches(state,{...input,steps:'40'}),true);
  assert.equal(customerRecipeMatches(state,{...input,characterIds:[]}),false);
  assert.equal(customerRecipeMatches(state,{...input,poseIds:['pose-standing']}),false);
  assert.equal(customerRecipeMatches(state,{...input,expressionIds:['expression-smile']}),false);
  assert.equal(customerRecipeMatches(state,{...input,cameraIds:['camera-close']}),false,'Disabled initial camera still publishes the available angle presets');
  assert.equal(customerRecipeMatches(state,input),true);
  assert.equal(customerRecipeMatches({...state,customerRecipe:null},input),false);
});

test('測試張數、資料夾、照片比例、排列與確認標記不構成顧客設定更新',()=>{
  const {state,input}=published();
  assert.equal(customerRecipeMatches(state,{...input,randomCount:99,copies:10,seed:999,aspectRatio:'16:9',batchName:'試拍',folderId:'folder'}),true);
  assert.equal(customerRecipeMatches(state,{...input,garmentIds:[...input.garmentIds].reverse(),poseIds:[...input.poseIds].reverse(),randomOptional:{expression:true}}),true);
  state.presets.find(row=>row.id==='pose-standing').reviewed=true;
  state.presets.find(row=>row.id==='camera-full').mappingNote='確認映射';
  assert.equal(customerRecipeMatches(state,input),true);
  state.customerRecipe.updatedAt='other date';
  assert.equal(customerRecipeMatches(state,input),true);
});

test('相同 ID 的內容修改及全部圖庫新增項目需要重新套用，未選項目不影響設定',()=>{
  const {state,input}=published(),pose=state.presets.find(row=>row.id==='pose-standing'),original=pose.prompt;
  pose.prompt='Updated action';assert.equal(customerRecipeMatches(state,input),false);
  pose.prompt=original;assert.equal(customerRecipeMatches(state,input),true);
  state.presets.push({id:'new-pose',category:'pose',name:'新動作',prompt:'New action',tags:[]});
  assert.equal(customerRecipeMatches(state,input),true);
  const all={...input,randomPoolMode:'all',garmentIds:[]};
  state.customerRecipe=createCustomerRecipe(state,all);assert.equal(customerRecipeMatches(state,all),true);
  state.presets.push({id:'another-pose',category:'pose',name:'另一動作',prompt:'Another action',tags:[]});
  assert.equal(customerRecipeMatches(state,all),false);
});

test('舊版全部角色與目前全選視為一致，空角色池仍可發布',()=>{
  const state=fixtureState(),input=draft();delete input.characterIds;
  state.characters.push({...state.characters[0],id:'private',visitorId:'customer'});
  state.customerRecipe=createCustomerRecipe(state,input);
  assert.equal(customerRecipeMatches(state,{...input,characterIds:['character']}),true);
  assert.equal(customerRecipeMatches(state,{...input,characterIds:[]}),false);
  state.customerRecipe=createCustomerRecipe(state,{...input,characterIds:[]});
  assert.equal(customerRecipeMatches(state,{...input,characterIds:[]}),true);
  assert.equal(customerRecipeMatches(state,{...input,characterIds:['private']}),false);
});
