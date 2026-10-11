import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PORTRAIT_ACTION_PRESETS} from '../shared/portrait-actions.js';
import {DEFAULT_PRESETS,normalizePresetImport,composePrompt} from '../shared/domain.js';
import {createStore} from '../server/store.js';

test('40 個成人寫真動作可匯入，包含道具、可愛手勢及性感姿勢，表情保持獨立',()=>{
  const rows=normalizePresetImport(PORTRAIT_ACTION_PRESETS);
  assert.equal(rows.length,40);
  assert.equal(new Set(rows.map(row=>row.id)).size,40);
  assert.equal(new Set(rows.map(row=>row.name)).size,40);
  assert(rows.every(row=>row.category==='pose' && row.prompt.startsWith('An adult person ') && row.prompt.length>100));
  assert.equal(rows.filter(row=>row.tags.includes('道具')).length,12);
  assert.equal(rows.filter(row=>row.tags.includes('可愛')).length,8);
  assert.equal(rows.filter(row=>row.tags.includes('性感')).length,20);
  for(const tag of ['娃娃','看書','蘋果','香蕉','愛心','束髮','前傾','側躺','跪坐']) assert(rows.some(row=>row.tags.includes(tag)),tag);
  for(const row of rows) {
    assert.doesNotMatch(row.prompt,/\b(smile\w*|grin\w*|wink\w*|pout\w*|gaze\w*|expression\w*|happy|seductive|sultry|flirt\w*|tongue|nude|naked|undress\w*)\b/i,row.name);
    assert.doesNotMatch(row.name,/微笑|眨眼|噘嘴|鼓腮|表情/);
  }
  assert.deepEqual(normalizePresetImport(JSON.parse(fs.readFileSync(new URL('../examples/portrait-actions-40.json',import.meta.url),'utf8'))),rows);
  assert.equal(DEFAULT_PRESETS.filter(row=>row.id.startsWith('pose-portrait-action-')).length,40);
  assert.equal(new Set(DEFAULT_PRESETS.map(row=>row.id)).size,DEFAULT_PRESETS.length);
  const book=rows.find(row=>row.id.endsWith('book-seated-reading'));
  const expression={id:'expression-test',name:'自選表情',prompt:'Chosen expression remains independent.'};
  const prompt=composePrompt({pose:book,expression,character:{name:'Adult portrait reference'}});
  assert(prompt.includes(book.prompt));
  assert(prompt.includes(expression.prompt));
});

test('動作保存在提詞庫；編輯和刪除後重開仍保留，已發布候選不會被新增內容改動',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-test-portrait-actions-'));
  let store=createStore(directory);
  t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});
  const first=PORTRAIT_ACTION_PRESETS[0],removed=PORTRAIT_ACTION_PRESETS[1];
  const edited={...first,name:'我的抱娃娃',prompt:'Holding one plush toy in both arms.',tags:['自訂'],reviewed:true};
  const standing=store.read(state=>state.presets.find(row=>row.id==='pose-standing'));
  const recipe={pools:{pose:[standing]},publishedAt:'2026-10-12T00:00:00Z'};
  assert.equal(store.read(state=>state.presets.filter(row=>row.id.startsWith('pose-portrait-action-')).length),40);
  store.mutate(state=>{
    state.presets=state.presets.filter(row=>row.id!==removed.id).map(row=>row.id===first.id?edited:row);
    state.customerRecipe=structuredClone(recipe);
    state.draft={poseIds:[standing.id]};
  });
  store.close();store=createStore(directory);
  assert.deepEqual(store.read(state=>state.presets.find(row=>row.id===first.id)),edited);
  assert.equal(store.read(state=>state.presets.some(row=>row.id===removed.id)),false);
  assert.deepEqual(store.read(state=>state.customerRecipe),recipe);
  assert.deepEqual(store.read(state=>state.draft.poseIds),[standing.id]);
});
