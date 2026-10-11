import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {LEGACY_PORTRAIT_SCENE_PRESETS} from '../server/legacy-portrait-scenes.js';
import legacyBasicScenes from '../server/legacy-basic-scenes.json' with {type:'json'};
import {migrateSceneDescriptions} from '../server/scene-preset-migrations.js';
import {PORTRAIT_SCENE_PAIRS} from '../shared/portrait-scenes.js';
import {SCENE_DESCRIPTION_PAIRS} from '../shared/scene-presets.js';
import {CATEGORIES,composePrompt} from '../shared/domain.js';
import {customPhotoPrompt} from '../shared/photo-customization.js';
import {createStore} from '../server/store.js';

const oldScenes=[...LEGACY_PORTRAIT_SCENE_PRESETS,...legacyBasicScenes];
const pose={id:'pose-test-seated',category:'pose',name:'自然坐姿',prompt:'Sitting comfortably on a chair with relaxed shoulders.',tags:['坐姿']};
const oldState=()=>({presets:structuredClone([...oldScenes,pose]),sceneDescriptionsVersion:0,
  draft:{poseIds:[pose.id],interactionIds:[oldScenes[0].id]},workbenchDrafts:{random:{poseIds:[pose.id],interactionIds:[oldScenes[0].id]}},
  customerRecipe:{updatedAt:'2026-10-01T00:00:00Z',settings:{extra:'Keep the existing settings.'},pools:{interaction:structuredClone(oldScenes),pose:[structuredClone(pose)]}},
  jobs:[{id:'existing-photo',batchId:'existing-batch',status:'completed',createdAt:'2026-10-01T00:00:00Z',interaction:structuredClone(oldScenes[0]),prompt:`Scene interaction: ${oldScenes[0].prompt}`}],batches:[]});

test('場景與動作分離，77 個場景和已發布候選不再混入人物姿勢',()=>{
  const state=oldState(),before=structuredClone(state),report=migrateSceneDescriptions(state,{now:()=> '2026-10-12T00:00:00Z'});
  assert.equal(report.updatedSceneIds.length,77);assert.equal(report.publishedSceneIds.length,77);assert.equal(report.addedPoseIds.length,62);
  const pairs=[...PORTRAIT_SCENE_PAIRS,...SCENE_DESCRIPTION_PAIRS];
  for(const {scene,pose:action} of pairs) {
    assert.deepEqual(state.presets.find(row=>row.id===scene.id),scene);
    assert.deepEqual(state.customerRecipe.pools.interaction.find(row=>row.id===scene.id),scene);
    if(action) assert.deepEqual(state.presets.find(row=>row.id===action.id),action);
    assert.doesNotMatch(scene.prompt,/\b(character|subject|figure|body|hands?|feet|skin|standing|sitting|kneeling|reclining)\b/i,scene.name);
  }
  assert.deepEqual(state.customerRecipe.pools.pose,before.customerRecipe.pools.pose,'New actions must not silently change the selected customer pose pool');
  assert.deepEqual(state.customerRecipe.settings,before.customerRecipe.settings);
  assert.deepEqual(state.draft,before.draft);assert.deepEqual(state.workbenchDrafts,before.workbenchDrafts);
  assert.deepEqual(state.jobs,before.jobs);assert.deepEqual(state.batches,before.batches);
  assert.equal(state.customerRecipe.updatedAt,'2026-10-12T00:00:00Z');
  assert.deepEqual(migrateSceneDescriptions(state),{updatedSceneIds:[],addedPoseIds:[],publishedSceneIds:[]});
});

test('分離保留自訂內容、名稱、標籤、既有動作及已刪除場景',()=>{
  const state=oldState(),[first,second,third]=PORTRAIT_SCENE_PAIRS;
  const original=state.presets.find(row=>row.id===first.scene.id);
  original.name='我的森林背景';original.tags=['私藏'];original.reviewed=true;
  const custom=state.presets.find(row=>row.id===second.scene.id);custom.prompt='My own cedar environment.';
  const customBefore=structuredClone(custom),existingAction={...first.pose,name:'我的葉片動作',prompt:'My custom pose.'};
  state.presets.push(existingAction);state.presets=state.presets.filter(row=>row.id!==third.scene.id);
  const report=migrateSceneDescriptions(state);
  assert.deepEqual(state.presets.find(row=>row.id===custom.id),customBefore);
  assert.deepEqual(state.presets.find(row=>row.id===first.scene.id),{...original,prompt:first.scene.prompt});
  assert.deepEqual(state.presets.find(row=>row.id===first.pose.id),existingAction);
  assert(!state.presets.some(row=>row.id===third.scene.id || row.id===third.pose.id));
  assert(!report.updatedSceneIds.includes(custom.id));
  assert.equal(state.customerRecipe.pools.interaction.find(row=>row.id===custom.id).prompt,second.scene.prompt,'The old published snapshot upgrades without publishing an unrelated library edit');
});

test('SQLite 升級一次，刪除抽出的動作後重新開啟不會補回',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-scene-split-'));
  let store=createStore(directory);t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});
  const prior=oldState();store.mutate(state=>Object.assign(state,prior,{portraitScenePresetsVersion:1,interactionPresetsVersion:1}));
  store.close();store=createStore(directory);
  assert.equal(store.read().sceneDescriptionsVersion,1);
  const first=PORTRAIT_SCENE_PAIRS[0];
  assert.equal(store.read().presets.find(row=>row.id===first.scene.id).prompt,first.scene.prompt);
  assert.deepEqual(store.read().jobs,prior.jobs);
  assert.equal(store.searchPresets({category:'pose',q:'漫步輕拂葉片'}).rows[0].id,first.pose.id);
  store.mutate(state=>{state.presets=state.presets.filter(row=>row.id!==first.pose.id);});
  store.close();store=createStore(directory);
  assert(!store.read().presets.some(row=>row.id===first.pose.id));
});

test('新提詞只有一段動作，場景標題改為場景並只包含環境',()=>{
  const {scene,pose:action}=PORTRAIT_SCENE_PAIRS.find(row=>row.scene.id==='interaction-portrait-park-bench');
  const prompt=composePrompt({interaction:scene,pose:action});
  assert.deepEqual(CATEGORIES.interaction,{label:'場景',plural:'場景提詞'});
  assert.equal(prompt.split('Scene: ').length,2);assert.equal(prompt.split('Pose: ').length,2);
  assert.ok(prompt.includes(`Scene: ${scene.prompt}`));assert.ok(prompt.includes(`Pose: ${action.prompt}`));
  assert.doesNotMatch(prompt,/Scene interaction:/);
});

test('舊照片的 Scene interaction 區段仍可替換為純場景，不會追加第二段',()=>{
  const old=LEGACY_PORTRAIT_SCENE_PRESETS[0],replacement=PORTRAIT_SCENE_PAIRS[10].scene;
  const shot={interaction:old,pose,prompt:`Scene interaction: ${old.prompt}\n\nPose: ${pose.prompt}`};
  const prompt=customPhotoPrompt({useOriginal:{scene:false},changes:{scene:replacement.prompt}},shot);
  assert.ok(prompt.includes(`Scene: ${replacement.prompt}`));assert.ok(prompt.includes(`Pose: ${pose.prompt}`));
  assert.doesNotMatch(prompt,/Scene interaction:/);assert.ok(!prompt.includes(old.prompt));
  assert.equal(prompt.split('Scene: ').length,2);
});
