import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildShotPlans,REFERENCE_INSTRUCTION,referenceOnlyPrompt} from '../shared/domain.js';
import {SINGLE_SUBJECT_PROMPT} from '../shared/subject.js';
import {buildRemakePlans} from '../shared/remakes.js';
import {createStore} from '../server/store.js';
import {createApp} from '../server/index.js';
import {buildComfyPrompt} from '../server/workflow.js';
import {DRAFT,TEMPLATE,fixtureState} from './fixtures.js';

const LEGACY = 'Picture 1 is the character identity reference: preserve the same face, hairstyle and distinctive appearance. Picture 2 is the clothing reference: dress the character in this garment, preserving its cut, material, colors and fine design details.';
function legacyShot() {
  const state = fixtureState();
  state.garments[0].description = 'LIBRARY_ONLY_NOTE\n\nSecond line of private clothing notes.';
  const shot = buildShotPlans(state,DRAFT)[0];
  shot.prompt = shot.prompt.replace(REFERENCE_INSTRUCTION,LEGACY) + `\n\nClothing: ${shot.garment.description}\n\nClothing: User explicitly added a scarf.`;
  return shot;
}

test('服裝備註改名、多段修改與清空不改變生成提詞，圖片索引仍對應兩張圖',() => {
  const state = fixtureState();
  const original = buildShotPlans(state,DRAFT)[0];
  state.garments[0].name = 'PRIVATE_LIBRARY_NAME';
  state.garments[0].description = 'PRIVATE_NOTE\n\nMore notes: reference image2.png';
  const edited = buildShotPlans(state,DRAFT)[0];
  assert.equal(edited.prompt,original.prompt);
  assert.equal(edited.garment.description,state.garments[0].description);
  const graph = buildComfyPrompt(TEMPLATE,edited,{character:'person.png',garment:'outfit.png'});
  const encoder = graph['12'];
  assert.equal(graph[encoder.inputs['images.image_1'][0]].inputs.image,'person.png');
  assert.equal(graph[encoder.inputs['images.image_2'][0]].inputs.image,'outfit.png');
  assert.ok(encoder.inputs.prompt.includes(REFERENCE_INSTRUCTION));
  assert.doesNotMatch(encoder.inputs.prompt,/PRIVATE_NOTE|PRIVATE_LIBRARY_NAME|Picture 1|Picture 2|<image 2>/);
  state.garments[0].description = '';
  assert.equal(buildShotPlans(state,DRAFT)[0].prompt,original.prompt);
});

test('舊版參考指令只移除自動附加的服裝備註，保留手寫提詞並可重複執行',() => {
  const old = legacyShot();
  const prompt = referenceOnlyPrompt(old);
  assert(prompt.startsWith(`${SINGLE_SUBJECT_PROMPT}\n\n`));
  assert(prompt.includes(REFERENCE_INSTRUCTION));
  assert.doesNotMatch(prompt,/LIBRARY_ONLY_NOTE|Second line|Picture 1 is/);
  assert.match(prompt,/Clothing: User explicitly added a scarf\./);
  assert.equal(referenceOnlyPrompt({...old,prompt}),prompt);
  assert.equal(referenceOnlyPrompt({...old,prompt:'Custom request\n\nClothing: a blue coat'}),'Custom request\n\nClothing: a blue coat');
  assert.match(old.prompt,/LIBRARY_ONLY_NOTE/);
});

test('舊成果重製採用正確圖片索引與純服裝參照，其餘快照與原紀錄保留',() => {
  const source = {...legacyShot(),status:'completed',batchId:'batch',images:[{filename:'old.png'}],apiPrompt:structuredClone(TEMPLATE)};
  const before = structuredClone(source);
  const [remake] = buildRemakePlans({jobs:[source]},[source.id],{requestId:'reference-fix'});
  assert.equal(remake.prompt,referenceOnlyPrompt(source));
  for(const field of ['character','garment','pose','camera','lighting','color','quality','resolution','steps']) assert.deepEqual(remake[field],source[field]);
  assert.deepEqual(source,before);
  const graph = buildComfyPrompt(remake.workflowSnapshot,remake,{character:'person.png',garment:'outfit.png'});
  assert.equal(graph['12'].inputs.prompt,remake.prompt);
  assert.doesNotMatch(graph['12'].inputs.prompt,/LIBRARY_ONLY_NOTE/);
});

test('啟動只修正未送出舊草稿，已提交、已完成、不確定與自訂紀錄保持原樣',t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-reference-migration-'));
  const seedStore = createStore(dataDir);
  const statuses = ['draft','queued','completed','uncertain','failed'];
  const jobs = statuses.map((status,index)=>({...legacyShot(),id:`legacy-${index}`,status,images:[]}));
  jobs.push({...legacyShot(),id:'draft-already-submitted',status:'draft',promptId:'existing-prompt'});
  jobs.push({...legacyShot(),id:'draft-custom',status:'draft',prompt:'Custom user prompt with Clothing: user instructions.'});
  for(const job of jobs) {job.createdAt='2026-10-08T00:00:00.000Z';job.batchId='reference-batch';}
  seedStore.mutate(state=>{
    state.jobs=structuredClone(jobs);
    state.batches=[{id:'reference-batch',name:'參考圖測試',createdAt:jobs[0].createdAt}];
    state.workflow=structuredClone(TEMPLATE);
  });
  seedStore.close();
  const {store} = createApp({dataDir});
  t.after(()=>store.close());
  const after = store.read().jobs;
  assert.equal(after.find(row=>row.id==='legacy-0').prompt,referenceOnlyPrompt(jobs[0]));
  for(const expected of jobs.slice(1)) assert.deepEqual(after.find(row=>row.id===expected.id),expected);
  const {prompt:oldPrompt,...otherBefore} = jobs[0];
  const {prompt:newPrompt,...otherAfter} = after.find(row=>row.id==='legacy-0');
  assert.deepEqual(otherAfter,otherBefore);
});
