import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import legacy from '../server/legacy-body-poses.json' with {type:'json'};
import legacyRailing from '../server/legacy-railing-poses.json' with {type:'json'};
import {migratePoseBodyPositions} from '../server/pose-preset-migrations.js';
import {hasBodyPosition,withBodyPosition} from '../shared/pose-body.js';
import {createStore} from '../server/store.js';
import {DEFAULT_PRESETS} from '../shared/domain.js';

const old=id=>structuredClone(legacy.find(row=>row.id===id));
const emptyReport={updatedPoseIds:[],addedPoseIds:[],publishedPoseIds:[],publishedNewPoseIds:[]};

test('known poses and unspecified custom gestures gain body positions without rewriting photographs or unrelated published choices',()=>{
  const plush=old('pose-portrait-action-plush-hug'),heart=old('pose-portrait-action-hand-heart');
  const custom={id:'custom-heart',category:'pose',name:'我的比愛心',prompt:'Both hands forming a heart in front of the chest.',tags:['私藏'],reviewed:true};
  const seated={id:'custom-seated',category:'pose',name:'我的坐姿',prompt:'Sitting on a chair holding a book.',tags:['私藏']};
  const historical={id:'finished',status:'completed',pose:structuredClone(plush),prompt:`Pose: ${plush.prompt}`};
  const state={presets:[plush,heart,custom,seated],jobs:[historical],draft:{poseIds:[plush.id]},
    customerRecipe:{settings:{steps:40},pools:{pose:[structuredClone(plush)],interaction:[{id:'scene-private',prompt:'Custom scene.'}]}}};
  const before=structuredClone(state),report=migratePoseBodyPositions(state,{now:()=> 'fixed-time'});
  assert.match(state.presets.find(row=>row.id===plush.id).prompt,/lies on the back/);
  assert.match(state.presets.find(row=>row.id===heart.id).prompt,/sits cross-legged/);
  const revised=state.presets.find(row=>row.id===custom.id);
  assert(hasBodyPosition(revised.prompt));assert.ok(revised.prompt.endsWith(custom.prompt));assert.equal(revised.reviewed,true);assert.ok(revised.tags.includes('私藏'));
  assert.deepEqual(state.presets.find(row=>row.id===seated.id),seated);
  assert.deepEqual(state.jobs,before.jobs);assert.deepEqual(state.draft,before.draft);
  assert.deepEqual(state.customerRecipe.settings,before.customerRecipe.settings);
  assert.deepEqual(state.customerRecipe.pools.interaction,before.customerRecipe.pools.interaction);
  assert.deepEqual(state.customerRecipe.pools.pose.map(row=>row.id),[plush.id]);
  assert.equal(state.customerRecipe.updatedAt,'fixed-time');assert.equal(report.addedPoseIds.length,12);
  assert.ok(!state.presets.some(row=>row.id==='pose-standing'),'Deleted original choices must not return');
  const after=structuredClone(state);assert.deepEqual(migratePoseBodyPositions(state),emptyReport);assert.deepEqual(state,after);
});

test('an all-poses published pool receives new poses while a selected subset stays selected',()=>{
  const source=[old('pose-standing'),old('pose-portrait-action-banana-bite')];
  const state={presets:structuredClone(source),customerRecipe:{pools:{pose:structuredClone(source)},settings:{extra:'keep'}}};
  const report=migratePoseBodyPositions(state);
  assert.equal(report.publishedNewPoseIds.length,12);assert.equal(state.customerRecipe.pools.pose.length,14);
  assert.equal(new Set(state.customerRecipe.pools.pose.map(row=>row.id)).size,14);
  assert.ok(state.customerRecipe.pools.pose.every(row=>hasBodyPosition(row.prompt)));
  assert.deepEqual(state.customerRecipe.settings,{extra:'keep'});
});

test('SQLite upgrade persists revised gestures and new choices, and later edits or withdrawals survive reopen',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-body-poses-'));
  let store=createStore(directory);t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});
  const original=old('pose-portrait-action-banana-bite');
  store.mutate(state=>{state.bodyPosingVersion=0;state.presets=[original];state.jobs=[{id:'original-photo',status:'completed',createdAt:'2026-10-01',pose:structuredClone(original)}];});
  store.close();store=createStore(directory);
  const revised=store.read().presets.find(row=>row.id===original.id);
  assert.match(revised.name,/跪坐/);assert(hasBodyPosition(revised.prompt));
  assert.equal(store.read().jobs[0].pose.prompt,original.prompt);
  const removed='pose-portrait-action-plush-straight-leg-seat';
  store.mutate(state=>{state.presets=state.presets.filter(row=>row.id!==removed);state.presets.find(row=>row.id===original.id).prompt='My later custom gesture.';});
  store.close();store=createStore(directory);
  assert.equal(store.read().presets.some(row=>row.id===removed),false);
  assert.equal(store.read().presets.find(row=>row.id===original.id).prompt,'My later custom gesture.');
});

test('the revised catalog covers body support, and fallback preserves explicit crouching and bending',()=>{
  assert.ok(DEFAULT_PRESETS.filter(row=>row.category==='pose').every(row=>hasBodyPosition(row.prompt)));
  const bent={id:'bent',category:'pose',name:'彎腰扶桌',prompt:'Bending forward from the hips while resting both hands on the desk.'};
  assert.equal(withBodyPosition(bent),bent);
  const upright={id:'upright',category:'pose',name:'站姿拿書',prompt:'Standing with a book held in both hands.',tags:['站姿']};
  const seated=withBodyPosition(upright);assert.match(seated.prompt,/Sitting on a stable low seat/);assert.doesNotMatch(seated.prompt,/\bStanding\b/);assert.ok(!seated.tags.includes('站姿'));
});

test('the railing revision updates lowered poses without changing seated-on-rail poses, custom edits or published selections',()=>{
  const seated=DEFAULT_PRESETS.filter(row=>row.category==='pose' && /Sitting.*\brail\b/i.test(row.prompt));
  const custom={...structuredClone(legacyRailing[0]),name:'我的扶欄',tags:['私藏','彎腰'],reviewed:true};
  const edited={...structuredClone(legacyRailing[1]),prompt:'My own railing pose.'};
  const state={bodyPosingVersion:1,presets:[custom,edited,...structuredClone(legacyRailing.slice(2)),...structuredClone(seated)],
    customerRecipe:{settings:{extra:'Keep.'},pools:{pose:structuredClone(legacyRailing)}},
    draft:{poseIds:[custom.id]},jobs:[{id:'history',pose:structuredClone(custom),prompt:custom.prompt}]};
  const before=structuredClone(state),report=migratePoseBodyPositions(state,{now:()=> 'railing-time'});
  const revised=state.presets.find(row=>row.id===custom.id);
  assert.match(revised.prompt,/Standing/);assert.match(revised.prompt,/other knee slightly/);assert.match(revised.prompt,/normal standing height/);
  assert.equal(revised.name,custom.name);assert.equal(revised.reviewed,true);assert.ok(revised.tags.includes('私藏'));assert.ok(revised.tags.includes('站姿'));assert.ok(!revised.tags.includes('彎腰'));
  assert.deepEqual(state.presets.find(row=>row.id===edited.id),edited);
  assert.deepEqual(state.presets.filter(row=>seated.some(old=>old.id===row.id)),seated);
  assert.deepEqual(state.jobs,before.jobs);assert.deepEqual(state.draft,before.draft);
  assert.deepEqual(state.customerRecipe.settings,before.customerRecipe.settings);
  assert.deepEqual(state.customerRecipe.pools.pose.map(row=>row.id),before.customerRecipe.pools.pose.map(row=>row.id));
  assert.equal(report.updatedPoseIds.length,7);assert.equal(report.publishedPoseIds.length,8);assert.equal(report.addedPoseIds.length,0);
  assert.equal(state.customerRecipe.updatedAt,'railing-time');assert.equal(state.bodyPosingVersion,2);
  const after=structuredClone(state);assert.deepEqual(migratePoseBodyPositions(state),emptyReport);assert.deepEqual(state,after);
});

test('a version-one SQLite library keeps seated rail poses and persists standing rail changes only once',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-standing-rail-'));
  let store=createStore(directory);t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});
  const original=legacyRailing.find(row=>row.id==='pose-portrait-action-rail-squat');
  const seated=DEFAULT_PRESETS.find(row=>row.id==='pose-scene-railing-rest');
  store.mutate(state=>{state.bodyPosingVersion=1;state.presets=[structuredClone(original),structuredClone(seated)];state.customerRecipe={pools:{pose:[structuredClone(original)]}};});
  store.close();store=createStore(directory);
  assert.match(store.read(state=>state.presets.find(row=>row.id===original.id).prompt),/stands side-on/);
  assert.deepEqual(store.read(state=>state.presets.find(row=>row.id===seated.id)),seated);
  assert.equal(store.read(state=>state.customerRecipe.pools.pose[0].id),original.id);
  assert.equal(store.searchPresets({category:'pose',q:'單腳微彎'}).rows[0].id,original.id);
  store.mutate(state=>{state.presets=state.presets.filter(row=>row.id!==seated.id);state.presets.find(row=>row.id===original.id).prompt='My later custom rail pose.';});
  store.close();store=createStore(directory);
  assert.equal(store.read(state=>state.presets.some(row=>row.id===seated.id)),false);
  assert.equal(store.read(state=>state.presets.find(row=>row.id===original.id).prompt),'My later custom rail pose.');
});

test('unspecified railing contact gains a standing lean while sitting on the rail stays explicit',()=>{
  const contact={category:'pose',name:'輕扶欄杆',prompt:'Rest one forearm naturally on the railing.',tags:['扶欄']};
  const standing=withBodyPosition(contact);
  assert.match(standing.prompt,/Standing beside/);assert.match(standing.prompt,/other knee slightly/);assert.ok(standing.prompt.endsWith(contact.prompt));
  assert.ok(hasBodyPosition(standing.prompt));assert.equal(withBodyPosition(standing),standing);
  const seated=DEFAULT_PRESETS.find(row=>row.id==='pose-scene-railing-rest');
  assert.equal(withBodyPosition(seated),seated);
});
