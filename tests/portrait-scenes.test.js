import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PORTRAIT_SCENE_PRESETS} from '../shared/portrait-scenes.js';
import {DEFAULT_PRESETS,normalizePresetImport} from '../shared/domain.js';
import {createStore} from '../server/store.js';

test('50 個寫真場景可完整匯入，涵蓋森林、公園、瀑布及室內外互動',()=>{
  const rows=normalizePresetImport(PORTRAIT_SCENE_PRESETS);
  assert.equal(rows.length,50);assert.equal(new Set(rows.map(row=>row.name)).size,50);
  assert(rows.every(row=>row.category==='interaction' && row.prompt.length>100 && row.tags.includes('寫真')));
  for(const tag of ['森林','公園','瀑布','海邊','花田','室內']) assert(rows.some(row=>row.tags.includes(tag)));
  assert.deepEqual(normalizePresetImport(JSON.parse(fs.readFileSync(new URL('../examples/portrait-scenes-50.json',import.meta.url),'utf8'))),rows);
  assert.equal(DEFAULT_PRESETS.filter(row=>row.id.startsWith('interaction-portrait-')).length,50);
});

test('升級補齊 50 個場景，保留既有編輯、顧客候選與使用者刪除結果',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-test-portrait-scenes-'));
  let store=createStore(directory);t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});
  const first=PORTRAIT_SCENE_PRESETS[0],second=PORTRAIT_SCENE_PRESETS[1];
  const edited={...first,name:'我的森林場景',prompt:'My custom forest interaction.',tags:['自訂']};
  const window=store.read().presets.find(row=>row.id==='interaction-window');
  store.mutate(state=>{
    state.portraitScenePresetsVersion=0;
    state.presets=state.presets.filter(row=>!row.id.startsWith('interaction-portrait-'));
    state.presets.push(edited);
    state.draft={interactionIds:['interaction-window']};
    state.customerRecipe={pools:{interaction:[window]},publishedAt:'2026-10-10T00:00:00Z'};
  });
  store.close();store=createStore(directory);
  assert.equal(store.read().presets.filter(row=>row.id.startsWith('interaction-portrait-')).length,50);
  assert.deepEqual(store.read().presets.find(row=>row.id===first.id),edited);
  assert.deepEqual(store.read().draft.interactionIds,['interaction-window']);
  assert.deepEqual(store.read().customerRecipe.pools.interaction,[window]);
  assert.equal(store.searchPresets({q:'瀑布',category:'interaction'}).total,3);
  store.mutate(state=>{state.presets=state.presets.filter(row=>row.id!==second.id);});
  store.close();store=createStore(directory);
  assert.equal(store.read().presets.filter(row=>row.id.startsWith('interaction-portrait-')).length,49);
  assert(!store.read().presets.some(row=>row.id===second.id));
});
