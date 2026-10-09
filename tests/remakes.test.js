import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRemakePlans, collectGalleryItems, pendingRemakeRoots } from '../shared/remakes.js';
import { buildShotPlans } from '../shared/domain.js';
import { DRAFT, TEMPLATE, fixtureState } from './fixtures.js';

function stateWithResults() {
  return {batches:[{id:'batch',name:'夏日寫真'}],jobs:buildShotPlans(fixtureState(),{...DRAFT,aspectRatio:'9:16',expressionId:'expression-smile',clothingStateId:'clothing-state-folds',interactionId:'interaction-window'}).map(shot => ({...shot,batchId:'batch',status:'completed',createdAt:'2026-10-09T01:00:00Z',promptId:'original-prompt',apiPrompt:structuredClone(TEMPLATE),images:[{filename:`${shot.id}.png`,subfolder:'PhotoCreate/test',type:'output'}]}))};
}

test('重製保留參考與提詞快照，使用新的 ID、Seed 與獨立執行紀錄',() => {
  const state = stateWithResults();
  const source = state.jobs[0];
  const before = structuredClone(source);
  const [shot] = buildRemakePlans(state,[source.id],{requestId:'request',deleteSourceOnComplete:true});
  assert.notEqual(shot.id,source.id);assert.notEqual(shot.seed,source.seed);
  assert.equal(shot.sourceJobId,source.id);assert.equal(shot.rootJobId,source.id);assert.equal(shot.remakeVersion,1);
  assert.equal(shot.batchId,source.batchId);assert.equal(shot.deleteSourceOnComplete,true);
  for(const field of ['character','garment','pose','expression','clothingState','interaction','prompt','negative','resolution','steps','aspectRatio','outputWidth','outputHeight']) assert.deepEqual(shot[field],source[field]);
  assert.deepEqual(shot.workflowSnapshot,source.apiPrompt);
  assert.equal(shot.apiPrompt,undefined);assert.equal(shot.promptId,undefined);assert.equal(shot.images,undefined);
  assert.deepEqual(source,before);
  source.interaction.prompt = 'Changed';assert.notEqual(shot.interaction.prompt,'Changed');
  source.expression.prompt = 'Changed';source.clothingState.prompt = 'Changed';
  assert.notEqual(shot.expression.prompt,'Changed');assert.notEqual(shot.clothingState.prompt,'Changed');
});

test('同一鏡頭不重複建立待執行版本，完成後可再次重製並遞增版本',() => {
  const state = stateWithResults();
  const source = state.jobs[0];
  const [first] = buildRemakePlans(state,[source.id]);
  state.jobs.unshift({...first,status:'queued',images:[]});
  assert.ok(pendingRemakeRoots(state.jobs).has(source.id));
  assert.throws(() => buildRemakePlans(state,[source.id]),/已有重製/);
  state.jobs[0].status = 'completed';state.jobs[0].images = [{filename:'new.png',subfolder:'PhotoCreate/test'}];
  assert.throws(() => buildRemakePlans(state,[source.id,first.id]),/一個版本/);
  const [second] = buildRemakePlans(state,[first.id]);assert.equal(second.remakeVersion,2);assert.equal(second.rootJobId,source.id);
  assert.throws(() => buildRemakePlans(state,[]),/1–100/);
  assert.throws(() => buildRemakePlans(state,['missing']),/已完成/);
  assert.throws(() => buildRemakePlans(state,Array(101).fill(source.id)),/1–100/);
});

test('畫廊只列成果，可篩拍攝組、搜尋與切換最新或所有版本',() => {
  const state = stateWithResults();
  const source = state.jobs[0];
  const [remake] = buildRemakePlans(state,[source.id]);
  state.jobs.unshift({...remake,status:'completed',createdAt:'2026-10-09T02:00:00Z',images:[{filename:'new.png'},{filename:'new-2.png'}]});
  assert.equal(collectGalleryItems(state).length,9);
  assert.equal(collectGalleryItems(state,{latestOnly:false}).length,10);
  assert.equal(collectGalleryItems(state,{batchId:'missing'}).length,0);
  assert.equal(collectGalleryItems(state,{query:'夏日 白色'}).length,5);
  assert.equal(collectGalleryItems(state)[0].job.id,remake.id);
  state.jobs[0].images = [];assert.equal(collectGalleryItems(state).length,8);
});
