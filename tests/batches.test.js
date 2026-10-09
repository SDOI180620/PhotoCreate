import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectShootBatches, matchesBatchFilter, migrateShootBatches } from '../shared/batches.js';
import { buildShotPlans } from '../shared/domain.js';
import { DRAFT, fixtureState } from './fixtures.js';

test('100 張照片歸為一個拍攝組，混合進度以照片狀態計算',() => {
  const state = fixtureState();
  const shots = buildShotPlans(state,{...DRAFT,poseIds:state.presets.filter(row => row.category === 'pose').slice(0,5).map(row => row.id),copies:10});
  const jobs = shots.map((shot,index) => ({...shot,batchId:'group-a',createdAt:'2026-10-08T16:00:08.276Z',status:index < 30 ? 'completed' : index === 30 ? 'running' : index < 70 ? 'queued' : index === 70 ? 'failed' : 'draft'}));
  const [batch] = collectShootBatches({jobs,batches:[{id:'group-a',name:'海邊寫真',createdAt:jobs[0].createdAt}]});
  assert.equal(batch.total,100);assert.equal(batch.completed,30);assert.equal(batch.counts.queued,39);assert.equal(batch.counts.draft,29);
  assert.equal(batch.retryableIds.length,30);assert.equal(batch.status,'running');assert.equal(batch.garments.length,2);assert.equal(batch.poses.length,5);
  assert.equal(matchesBatchFilter(batch,'draft'),true);assert.equal(matchesBatchFilter(batch,'active'),true);assert.equal(matchesBatchFilter(batch,'issues'),true);assert.equal(matchesBatchFilter(batch,'completed'),false);
});

test('同一時間建立的兩組保持獨立，狀態與選取不跨組',() => {
  const shots = buildShotPlans(fixtureState(),DRAFT);
  const jobs = shots.map((shot,index) => ({...shot,batchId:index < 4 ? 'group-a' : 'group-b',status:index < 4 ? 'completed' : 'draft',createdAt:'2026-10-08T16:00:08.276Z'}));
  const batches = collectShootBatches({jobs,batches:[{id:'group-a',name:'已完成的一組'},{id:'group-b',name:'新的一組'}]});
  assert.equal(batches.length,2);assert.equal(batches[0].total,4);assert.equal(batches[1].total,4);
  assert.equal(batches[0].status,'completed');assert.equal(batches[0].retryableIds.length,0);assert.equal(batches[1].retryableIds.length,4);
  assert.equal(batches[1].name,'新的一組');
});

test('停止中的組保持進行中，確認停止後可篩選與重新生成並保留完成進度',() => {
  const jobs = buildShotPlans(fixtureState(),DRAFT).slice(0,3).map((job,index) => ({...job,batchId:'stopped-group',status:['completed','stopped','stopping'][index]}));
  let [batch] = collectShootBatches({jobs,batches:[]});
  assert.equal(batch.status,'stopping');assert.equal(batch.active,true);assert.equal(batch.completed,1);
  assert.deepEqual(batch.retryableIds,[jobs[1].id]);
  assert.equal(matchesBatchFilter(batch,'stopped'),true);
  jobs[2].status = 'stopped';
  [batch] = collectShootBatches({jobs,batches:[]});
  assert.equal(batch.status,'stopped');assert.equal(batch.active,false);assert.equal(batch.completed,1);
  assert.deepEqual(batch.retryableIds,[jobs[1].id,jobs[2].id]);
});

test('舊照片分組保留 job ID、prompt ID、執行狀態與輸出',() => {
  const shots = buildShotPlans(fixtureState(),DRAFT).map((shot,index) => ({...shot,createdAt:new Date(Date.parse('2026-10-08T16:00:08.276Z') + index).toISOString(),status:index === 0 ? 'running' : 'queued',promptId:`comfy-${index}`,images:[{filename:`old-${index}.png`}]}));
  const state = {version:1,jobs:shots};
  const before = structuredClone(shots);
  migrateShootBatches(state);
  assert.equal(state.version,2);assert.equal(state.batches.length,1);assert.equal(new Set(state.jobs.map(job => job.batchId)).size,1);
  for(const [index,job] of state.jobs.entries()) {const {batchId,...rest} = job;assert.deepEqual(rest,before[index]);assert.ok(batchId);}
  const snapshot = structuredClone(state);migrateShootBatches(state);assert.deepEqual(state,snapshot);
});
