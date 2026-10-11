import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createStore} from '../server/store.js';
import {createCustomerRecipe} from '../server/customer-recipe.js';
import {fixtureState,DRAFT} from './fixtures.js';
import {reconcileLibrarySelections} from '../shared/library-selections.js';

test('撤除 CG 後清理所有草稿設定，保留完成照片的歷史紀錄',()=>{
  const fixture=fixtureState(),draft={...DRAFT,renderStyle:'anime_cg'},job={id:'historical-cg',renderStyle:'anime_cg',prompt:'Historical prompt'};
  const state={...fixture,draft,workbenchDrafts:{random:{...draft,mode:'random'},combinations:{...draft,mode:'combinations'}},customerRecipe:{settings:{steps:30,renderStyle:'anime_cg'},pools:{}},jobs:[job]};
  reconcileLibrarySelections(state);
  assert.equal(Object.hasOwn(state.draft,'renderStyle'),false);
  assert.deepEqual(state.draft,DRAFT);
  for(const candidate of Object.values(state.workbenchDrafts)) assert.equal(Object.hasOwn(candidate,'renderStyle'),false);
  assert.deepEqual(state.customerRecipe.settings,{steps:30});
  assert.equal(draft.renderStyle,'anime_cg');
  assert.deepEqual(state.jobs,[job]);
});

test('重開後清理已刪候選：兩種草稿與顧客名單一致，既有照片保留快照',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-library-selection-'));
  let store=createStore(directory);
  t.after(()=>{store.close();assert.equal(path.dirname(fs.realpathSync(directory)),fs.realpathSync(os.tmpdir()));fs.rmSync(directory,{recursive:true,force:true});});
  const fixture=fixtureState(),draft={...DRAFT,mode:'random',randomPoolMode:'selected',characterIds:['character'],cameraEnabled:false,expressionIds:['expression-smile'],expressionId:'expression-smile'};
  const recipe=createCustomerRecipe(fixture,draft),snapshot=fixture.presets.find(row=>row.id==='expression-smile');
  store.mutate(state=>Object.assign(state,fixture,{draft,workbenchDrafts:{random:draft,combinations:{...draft,mode:'combinations'}},customerRecipe:recipe,jobs:[{id:'retained-photo',batchId:'retained-batch',name:'Retained photo',status:'completed',createdAt:new Date().toISOString(),expression:snapshot,prompt:snapshot.prompt}]}));
  store.mutate(state=>state.presets=state.presets.filter(row=>row.id!=='expression-smile'));
  const originalJob=store.read().jobs[0];store.close();store=createStore(directory);
  const after=store.read();
  assert.deepEqual(after.draft.expressionIds,[]);assert.equal(after.draft.expressionId,'');
  for(const draft of Object.values(after.workbenchDrafts)) {assert.deepEqual(draft.expressionIds,[]);assert.equal(draft.expressionId,'');}
  assert.deepEqual(after.customerRecipe.pools.expression,[]);
  assert.deepEqual(after.jobs[0],originalJob);
  store.close();store=createStore(directory);assert.deepEqual(store.read(),after);
});
