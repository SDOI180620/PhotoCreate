import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildShotPlans,normalizePresetImport} from '../shared/domain.js';
import {GAZE_PRESETS,NATURAL_GAZE_PROMPT} from '../shared/gaze.js';
import {customerRecipeMatches} from '../shared/customer-recipe.js';
import {createCustomerRecipe,customerDraft,customerProductionState} from '../server/customer-recipe.js';
import {customPhotoPrompt,photoSettings} from '../shared/photo-customization.js';
import {buildRemakePlans} from '../shared/remakes.js';
import {portableDraft} from '../server/transfer-schema.js';
import {createStore} from '../server/store.js';
import {DRAFT,fixtureState} from './fixtures.js';

const base={...DRAFT,copies:1,garmentIds:['garment-a'],poseIds:['pose-standing'],expressionIds:['expression-smile']};

test('gaze candidates compose independently of expression and default to action-aware eye direction',()=>{
  const state=fixtureState(),shots=buildShotPlans(state,{...base,gazeIds:['gaze-left','gaze-object']});
  assert.equal(shots.length,2);
  for(const shot of shots) {
    assert.equal(shot.expression.id,'expression-smile');
    assert.match(shot.prompt,/Facial expression: A gentle natural smile/);
    assert.ok(shot.prompt.includes(`Gaze direction: ${shot.gaze.prompt}`));
    assert.equal(shot.prompt.split('Gaze direction:').length,2);
    assert.ok(!shot.prompt.includes(GAZE_PRESETS.find(row=>row.id!==shot.gaze.id && ['gaze-left','gaze-object'].includes(row.id)).prompt));
    assert.ok(shot.name.includes(shot.gaze.name));
  }
  const [natural]=buildShotPlans(state,{...base,gazeIds:[]});
  assert.equal(natural.gaze,null);assert.ok(natural.prompt.includes(NATURAL_GAZE_PROMPT));
  assert.equal(natural.prompt.split('Gaze direction:').length,2);
  assert.equal(normalizePresetImport(GAZE_PRESETS).length,7);
  for(const gazeIds of [null,'gaze-left',['expression-smile'],['missing']]) assert.throws(()=>buildShotPlans(state,{...base,gazeIds}),/視線/);
});

test('random gaze selection uses every combination before repeating and published snapshots survive library edits',()=>{
  const state=fixtureState(),draft={...base,mode:'random',randomPoolMode:'selected',randomCount:6,gazeIds:['gaze-left','gaze-right','gaze-down'],seed:123};
  const shots=buildShotPlans(state,draft);
  assert.equal(new Set(shots.slice(0,3).map(row=>row.gaze.id)).size,3);
  assert.deepEqual(shots.map(row=>row.gaze.id),buildShotPlans(state,draft).map(row=>row.gaze.id));
  const recipe=createCustomerRecipe(state,draft),published=structuredClone(recipe);
  state.presets.find(row=>row.id==='gaze-left').prompt='Unpublished gaze.';
  const customerShots=buildShotPlans(customerProductionState(state,recipe),customerDraft(recipe,{characterId:'character',count:6,aspectRatio:'reference'}));
  for(const shot of customerShots) assert.equal(shot.gaze.prompt,published.pools.gaze.find(row=>row.id===shot.gaze.id).prompt);
  assert.deepEqual(recipe,published);
  assert.deepEqual(portableDraft(draft,state,state.presets).gazeIds,draft.gazeIds);
});

test('older customer recipes without a gaze pool remain compatible and naturally choose eye direction',()=>{
  const state=fixtureState(),draft={...base,mode:'random',randomPoolMode:'selected'};
  const recipe=createCustomerRecipe(state,draft);delete recipe.pools.gaze;state.customerRecipe=recipe;
  assert.equal(customerRecipeMatches(state,draft),true);
  const [shot]=buildShotPlans(customerProductionState(state,recipe),customerDraft(recipe,{characterId:'character',count:1,aspectRatio:'reference'}));
  assert.equal(shot.gaze,null);assert.ok(shot.prompt.includes(NATURAL_GAZE_PROMPT));
});

test('photo customization replaces gaze without duplicating it or changing the pose and expression',()=>{
  const state=fixtureState(),[source]=buildShotPlans(state,{...base,gazeIds:['gaze-camera']});
  const selected=GAZE_PRESETS.find(row=>row.id==='gaze-distant');
  const prompt=customPhotoPrompt({useOriginal:{gaze:false},fieldModes:{gaze:'preset'},presetIds:{gaze:selected.id}},source,{gaze:selected});
  assert.ok(prompt.includes(`Gaze direction: ${selected.prompt}`));assert.ok(!prompt.includes(source.gaze.prompt));
  assert.equal(prompt.split('Gaze direction:').length,2);assert.ok(prompt.includes(source.pose.prompt));assert.ok(prompt.includes(source.expression.prompt));
  const [natural]=buildShotPlans(state,base),custom=customPhotoPrompt({useOriginal:{gaze:false},changes:{gaze:'Look toward the flower already held.'}},natural);
  assert.ok(!custom.includes(NATURAL_GAZE_PROMPT));assert.equal(custom.split('Gaze direction:').length,2);
  const rebuilt=customPhotoPrompt({useOriginal:{gaze:false},changes:{gaze:'Look to the side.'}},{...source,jobKind:'angle-edit'});
  assert.match(rebuilt,/Gaze direction: Look to the side\./);
  assert.deepEqual(photoSettings(source).find(row=>row.key==='gaze'),{key:'gaze',label:'視線',value:source.gaze.name,source:'preset'});
  const completed={...source,status:'completed',createdAt:'2026-10-13T00:00:00Z',images:[{filename:'photo.png'}]};
  const [remake]=buildRemakePlans({...state,jobs:[completed]},[completed.id]);
  assert.deepEqual(remake.gaze,source.gaze);assert.ok(remake.prompt.includes(source.gaze.prompt));
});

test('existing libraries gain gaze choices once; edits, withdrawals, customer selections and photo history survive reopen',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-gaze-'));
  let store=createStore(directory);t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});
  store.mutate(state=>{
    state.gazePresetsVersion=0;state.presets=state.presets.filter(row=>row.category!=='gaze');
    state.customerRecipe={pools:{pose:[structuredClone(state.presets.find(row=>row.category==='pose'))]}};
    state.jobs=[{id:'old-photo',batchId:'legacy-old-photo',status:'completed',createdAt:'2026-10-13T00:00:00Z',prompt:'Existing saved photograph.'}];
  });
  const before=store.read();store.close();store=createStore(directory);
  assert.equal(store.read(state=>state.presets.filter(row=>row.category==='gaze').length),7);
  assert.deepEqual(store.read(state=>state.customerRecipe),before.customerRecipe);assert.deepEqual(store.read(state=>state.jobs),before.jobs);
  store.mutate(state=>{state.presets=state.presets.filter(row=>row.id!=='gaze-left');state.presets.find(row=>row.id==='gaze-camera').prompt='My custom eye direction.';});
  store.close();store=createStore(directory);
  assert.equal(store.read(state=>state.presets.some(row=>row.id==='gaze-left')),false);
  assert.equal(store.read(state=>state.presets.find(row=>row.id==='gaze-camera').prompt),'My custom eye direction.');
});
