import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.js';
import { buildShotPlans } from '../shared/domain.js';
import { DRAFT, fixtureState } from './fixtures.js';

test('SQLite 中文短詞、英文全文、分類、分頁與索引更新',t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-test-store-'));
  let store = createStore(dir);
  t.after(() => {store.close();});
  const existingTurnPoses=store.searchPresets({q:'回眸',category:'pose'}).total;
  const rows = Array.from({length:125},(_,i) => ({id:`bulk-${i}`,category:'pose',name:`海邊回眸 ${i}`,prompt:'Turning near the seaside, natural shoulder posture.',tags:['夕陽','回眸']}));
  store.mutate(state => {state.presets.push(...rows);state.draft = {extra:'保留衣服細節'};});
  assert.equal(store.searchPresets({q:'回眸',category:'pose',limit:24}).total,125+existingTurnPoses);
  assert.equal(store.searchPresets({q:'seaside',category:'pose',limit:24,offset:24}).rows.length,24);
  assert.equal(store.searchPresets({q:'海邊回',category:'pose'}).total,125);
  assert.equal(store.searchPresets({q:'seaside 夕陽'}).total,125);
  assert.equal(store.searchPresets({q:'seaside',category:'camera'}).total,0);
  assert.equal(store.searchPresets({q:'" OR *'}).total,0);
  store.mutate(state => {const row = state.presets.find(row => row.id === 'bulk-0');row.name = '森林漫步';row.prompt = 'Forest walk';row.tags = ['森林'];});
  assert.equal(store.searchPresets({q:'海邊回'}).total,124);
  assert.equal(store.searchPresets({q:'Forest walk',category:'pose'}).total,1);
  store.mutate(state => {state.presets = state.presets.filter(row => row.id !== 'bulk-0');});
  assert.equal(store.searchPresets({q:'Forest walk',category:'pose'}).total,0);
  store.mutate(state => {state.garments.unshift({id:'older',name:'舊服裝',tags:[]});});
  store.mutate(state => {state.garments.unshift({id:'newer',name:'新服裝',tags:[]});});
  assert.throws(() => store.mutate(state => {state.presets[0].name = 'bad';throw new Error('rollback');}),/rollback/);
  assert.notEqual(store.read().presets[0].name,'bad');
  store.close();store = createStore(dir);
  assert.equal(store.read().draft.extra,'保留衣服細節');
  assert.deepEqual(store.read().garments.map(row => row.id),['newer','older']);
  assert.equal(store.searchPresets({q:'海邊回'}).total,124);
});

test('舊版 SQLite 清單自動分組，重開後保留名稱、歸屬與生成任務',t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-test-batches-'));
  let store = createStore(dir);
  t.after(() => store.close());
  const shots = buildShotPlans(fixtureState(),DRAFT).map((shot,index) => ({...shot,status:'queued',createdAt:'2026-10-08T16:00:08.276Z',promptId:`existing-${index}`,images:[]}));
  store.mutate(state => {state.version = 1;state.jobs = shots;state.batches = [];});
  store.close();store = createStore(dir);
  const migrated = store.read();
  assert.equal(migrated.batches.length,1);assert.equal(migrated.jobs.length,8);
  assert.deepEqual(migrated.jobs.map(job => job.promptId),shots.map(job => job.promptId));
  assert.ok(migrated.jobs.every(job => job.status === 'queued' && job.batchId === migrated.batches[0].id));
  const batchId = migrated.batches[0].id;
  store.mutate(state => {state.batches[0].name = '保存後的拍攝組';state.jobs[0].createdAt = '2026-10-09T03:00:00.000Z';});
  store.close();store = createStore(dir);
  assert.equal(store.read().batches[0].name,'保存後的拍攝組');assert.equal(store.read().batches[0].id,batchId);
  assert.ok(store.read().jobs.every(job => job.batchId === batchId));
});

test('既有提詞庫只補入一次場景範例，保留自訂內容與刪除結果',t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-test-interactions-'));
  let store = createStore(dir);
  t.after(() => store.close());
  store.mutate(state => {
    state.interactionPresetsVersion = 0;
    state.presets = state.presets.filter(row => row.category !== 'interaction');
    state.presets.push({id:'interaction-window',category:'interaction',name:'我的窗邊互動',prompt:'Custom window interaction.',tags:['窗邊']});
    state.draft = {interactionId:'',sceneInteraction:''};
  });
  store.close();store = createStore(dir);
  assert.equal(store.searchPresets({category:'interaction'}).total,3);
  assert.equal(store.read().presets.find(row => row.id === 'interaction-window').prompt,'Custom window interaction.');
  assert.equal(store.read().draft.interactionId,'');
  store.mutate(state => {state.presets = state.presets.filter(row => row.id !== 'interaction-bed');});
  store.close();store = createStore(dir);
  assert.equal(store.searchPresets({category:'interaction'}).total,2);
  assert.equal(store.searchPresets({q:'窗邊',category:'interaction'}).rows[0].id,'interaction-window');
});

test('升級補入表情與服裝狀態，保留自訂提詞、既有任務、草稿與刪除結果',t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-test-details-'));
  let store = createStore(dir);
  t.after(() => store.close());
  const existingJob = {...buildShotPlans(fixtureState(),DRAFT)[0],status:'completed',createdAt:'2026-10-09T01:00:00Z',promptId:'preserved',images:[{filename:'existing.png'}]};
  store.mutate(state => {
    state.detailPresetsVersion = 0;
    state.presets = state.presets.filter(row => !['expression','clothing_state'].includes(row.category));
    state.presets.push({id:'expression-smile',category:'expression',name:'我的微笑',prompt:'A personal smile.',tags:['自訂']});
    state.jobs = [existingJob];state.draft = {expressionId:'',clothingStateId:'',extra:'舊草稿'};
  });
  store.close();store = createStore(dir);
  assert.equal(store.searchPresets({category:'expression'}).total,3);
  assert.equal(store.searchPresets({category:'clothing_state'}).total,4);
  assert.equal(store.searchPresets({q:'自訂',category:'expression'}).rows[0].prompt,'A personal smile.');
  assert.deepEqual(store.read().draft,{expressionId:'',clothingStateId:'',extra:'舊草稿'});
  assert.equal(store.read().jobs[0].prompt,existingJob.prompt);assert.equal(store.read().jobs[0].promptId,'preserved');
  store.mutate(state => {
    state.presets = state.presets.filter(row => row.id !== 'clothing-state-breeze');
    state.draft.expressionId = 'expression-smile';state.draft.clothingStateId = 'clothing-state-folds';
  });
  store.close();store = createStore(dir);
  assert.equal(store.searchPresets({category:'clothing_state'}).total,3);
  assert.equal(store.read().draft.expressionId,'expression-smile');assert.equal(store.read().draft.clothingStateId,'clothing-state-folds');
});
