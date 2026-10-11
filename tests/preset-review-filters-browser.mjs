import assert from 'node:assert/strict';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {DRAFT} from './fixtures.js';
import {loginBrowser} from './auth-client.js';
import {previewFixture} from './preset-preview-fixture.js';

const f=await previewFixture({camera:false});
const rows=Array.from({length:24},(_,index)=>({
  id:`pose-review-filter-${index}`,category:'pose',name:`篩選動作 ${String(index+1).padStart(2,'0')}`,
  prompt:'Standing with both feet grounded and one hand resting beside the body.',
  tags:index<4?['搜尋匹配']:['分頁測試'],
  ...(index<20&&index%2===0?{reviewed:true}:index%2?{reviewed:false}:{}),
}));
const confirmed=rows.filter(row=>row.reviewed===true);
const draft={...f.store.read().draft,...DRAFT,mode:'random',randomPoolMode:'selected',randomCount:1,
  characterIds:['character'],garmentIds:['garment-a'],poseIds:['pose-standing'],cameraEnabled:false,
  lightingIds:['light-window'],colorIds:['color-natural'],qualityIds:['quality-editorial']};
f.store.mutate(state=>{
  state.presets=state.presets.filter(row=>row.category!=='pose'||row.id==='pose-standing').concat(rows);
  state.presets.find(row=>row.id==='expression-smile').reviewed=true;
  state.draft=draft;state.workbenchDrafts={random:draft};
});
const originalPresets=f.store.read(state=>state.presets);
const browser=await chromium.launch({executablePath:process.env.PHOTOCREATE_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1080}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
try {
  await loginBrowser(page,f.base);
  await page.getByRole('button',{name:'選擇動作提詞',exact:true}).click();
  const picker=page.getByRole('dialog',{name:'選擇動作提詞 · 可複選',exact:true});
  const filters=picker.getByRole('group',{name:'提詞確認分類',exact:true});
  const search=picker.getByRole('textbox',{name:'搜尋動作名稱、標籤、提詞…',exact:true});
  const status=label=>filters.getByRole('button',{name:label,exact:true});
  const choose=index=>picker.getByRole('button',{name:rows[index].name,exact:true});
  const selected=count=>expect(picker.locator('.pool-picker-toolbar')).toContainText(`已選 ${count} 項`);
  await expect(status('全部')).toHaveAttribute('aria-pressed','true');
  await expect(status('全部')).toContainText('25');
  await expect(status('已確認')).toContainText('10');
  await expect(status('未確認')).toContainText('15');
  await expect(picker.locator('.pool-option')).toHaveCount(8);

  await status('已確認').click();
  await expect(picker.locator('.pool-option')).toHaveCount(8);
  await expect(picker.locator('.pool-option .preset-review-mark')).toHaveCount(8);
  await selected(1); // The selected legacy preset remains selected in another filter.
  await picker.getByRole('button',{name:'動作下一頁',exact:true}).click();
  await expect(picker.locator('.pool-option')).toHaveCount(2);
  await expect(picker.locator('.optional-pagination')).toContainText('2 / 2');
  await choose(18).click();await selected(2);

  await status('未確認').click();
  await expect(picker.locator('.optional-pagination')).toContainText('1 / 2');
  await expect(picker.locator('.pool-option .preset-review-mark')).toHaveCount(0);
  await choose(1).click();await selected(3);
  await search.fill('搜尋匹配');
  await expect(picker.locator('.pool-option')).toHaveCount(2);
  await expect(choose(0)).toHaveCount(0);
  await picker.getByRole('button',{name:'全選搜尋結果',exact:true}).click();await selected(4);
  await expect(choose(3)).toHaveAttribute('aria-pressed','true');
  await status('已確認').click();
  await expect(search).toHaveValue('搜尋匹配');
  await expect(picker.locator('.pool-option')).toHaveCount(2);
  await picker.getByRole('button',{name:'全選搜尋結果',exact:true}).click();await selected(6);
  await search.fill('');
  await picker.getByRole('button',{name:'全選已確認',exact:true}).click();await selected(13);
  await picker.getByRole('button',{name:'動作下一頁',exact:true}).click();
  await expect(choose(18)).toHaveAttribute('aria-pressed','true');
  await picker.getByRole('button',{name:'取消本頁',exact:true}).click();await selected(11);
  await picker.getByRole('button',{name:'選取本頁',exact:true}).click();await selected(13);
  await picker.screenshot({path:path.resolve('test-results/preset-review-filter-confirmed.png')});
  await status('全部').click();
  await expect(picker.locator('.pool-option')).toHaveCount(8);
  await expect(choose(1)).toHaveAttribute('aria-pressed','true');
  await picker.getByRole('button',{name:'取消',exact:true}).click();
  assert.deepEqual(f.store.read(state=>state.draft.poseIds),['pose-standing']);

  await page.getByRole('button',{name:'選擇動作提詞',exact:true}).click();
  await status('已確認').click();
  await picker.getByRole('button',{name:'全選已確認',exact:true}).click();await selected(11);
  await status('未確認').click();await choose(1).click();await selected(12);
  await picker.getByRole('button',{name:'使用所選提詞 (12)',exact:true}).click();
  const expected=['pose-standing',...confirmed.map(row=>row.id),rows[1].id].sort();
  await expect.poll(()=>f.store.read(state=>state.draft.poseIds).slice().sort()).toEqual(expected);
  assert.deepEqual(f.store.read(state=>state.presets),originalPresets,'Filtering and selection never change review marks or prompts');

  await page.getByRole('button',{name:'選擇表情提詞',exact:true}).click();
  const expressionPicker=page.getByRole('dialog',{name:'選擇表情提詞 · 可複選',exact:true});
  await expressionPicker.getByRole('group',{name:'提詞確認分類'}).getByRole('button',{name:'已確認',exact:true}).click();
  await expect(expressionPicker.locator('.pool-option')).toHaveCount(1);
  await expressionPicker.getByRole('button',{name:'取消',exact:true}).click();

  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'選擇動作提詞',exact:true}).click();
  await status('未確認').click();
  await expect(status('未確認')).toHaveAttribute('aria-pressed','true');
  await search.fill('不存在的篩選詞');
  await expect(picker.locator('.pool-option')).toHaveCount(0);
  await expect(picker.getByText('沒有符合的提詞，可以新增或換個搜尋詞。',{exact:true})).toBeVisible();
  await selected(12);
  await search.fill('');
  await picker.screenshot({path:path.resolve('test-results/preset-review-filter-mobile.png')});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Filters fit on mobile without horizontal overflow');
  await picker.getByRole('button',{name:'取消',exact:true}).click();
  await page.reload();
  await expect.poll(()=>f.store.read(state=>state.draft.poseIds).slice().sort()).toEqual(expected);
  assert.equal(f.submitted.length,0,'Browsing classifications never generates an image');
  assert.deepEqual(errors,[]);
  console.log('UI passed: review counts, legacy/unconfirmed classification, search, global and page selection, cross-filter/page persistence, cancel/apply, other categories, empty results and mobile.');
} finally {await browser.close();await f.close();}
