import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {buildShotPlans} from '../shared/domain.js';
import {createCustomerRecipe} from '../server/customer-recipe.js';
import {DRAFT} from './fixtures.js';
import {loginBrowser} from './auth-client.js';
import {previewFixture} from './preset-preview-fixture.js';

const f=await previewFixture({camera:false});
const draft={...f.store.read().draft,...DRAFT,mode:'random',randomPoolMode:'selected',characterIds:['character'],cameraEnabled:false,randomCount:1,copies:1,
  cameraIds:['camera-full'],lightingIds:['light-window'],colorIds:['color-natural'],qualityIds:['quality-editorial'],
  expressionIds:['expression-smile'],clothingStateIds:['clothing-state-breeze'],interactionIds:['interaction-window']};
f.store.mutate(state=>{
  state.draft=draft;state.workbenchDrafts={random:draft};state.customerRecipe=createCustomerRecipe(state,draft);
  const plan=buildShotPlans(state,{...draft,cameraEnabled:true,garmentIds:['garment-a'],poseIds:['pose-standing']})[0];
  const base={...plan,batchId:'review-batch',status:'completed',createdAt:'2026-10-11T00:00:00Z',images:[{filename:'review.png',subfolder:'PhotoCreate',type:'output'}]};
  state.jobs=[{...base,id:'review-photo',name:'測試成果'}, {...base,id:'deleted-photo',name:'已刪提詞成果',pose:{id:'deleted-pose',category:'pose',name:'自然站姿',prompt:'Old action',tags:[]}}];
  state.batches=[{id:'review-batch',name:'確認測試',createdAt:base.createdAt}];
});
const browser=await chromium.launch({executablePath:process.env.PHOTOCREATE_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
fs.mkdirSync('test-results',{recursive:true});
const apply=page.getByRole('button',{name:'套用至顧客攝影棚',exact:true});
const editor=page.getByRole('dialog',{name:'編輯提詞',exact:true});
const closeEditor=async()=>{await page.getByRole('dialog').last().getByRole('button',{name:'關閉視窗',exact:true}).click();await expect(editor).toHaveCount(0);};
const poseName=f.store.read().presets.find(row=>row.id==='pose-standing').name;
const poseCard=()=>page.locator('.preset-card').filter({has:page.getByRole('heading',{name:poseName,exact:true})});
try {
  await loginBrowser(page,f.base);await expect(apply).toBeDisabled();
  await page.getByRole('spinbutton',{name:'採樣步數',exact:true}).fill('60');await expect(apply).toBeEnabled();
  await page.getByRole('spinbutton',{name:'採樣步數',exact:true}).fill('40');await expect(apply).toBeDisabled();
  await page.getByRole('spinbutton',{name:'隨機張數',exact:true}).fill('5');await expect(apply).toBeDisabled();
  await page.getByRole('combobox',{name:'輸出比例',exact:true}).selectOption('16:9');await expect(apply).toBeDisabled();
  await page.getByRole('spinbutton',{name:'採樣步數',exact:true}).fill('60');await apply.click();
  await expect.poll(()=>Number(f.store.read().customerRecipe.settings.steps)).toBe(60);await expect(apply).toBeDisabled();
  await page.reload();await expect(apply).toBeDisabled();
  await page.locator('.customer-publish-panel').screenshot({path:path.resolve('test-results/customer-publish-unchanged.png')});

  await page.getByRole('button',{name:'提詞資料庫',exact:true}).click();
  await poseCard().getByRole('button',{name:`標記為已確認 ${poseName}`,exact:true}).click();
  await expect(poseCard().getByRole('button',{name:`取消已確認 ${poseName}`,exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();await page.getByRole('button',{name:'提詞資料庫',exact:true}).click();
  await expect(poseCard().getByRole('img',{name:'已確認',exact:true})).toBeVisible();
  await poseCard().getByRole('button',{name:`編輯提詞 ${poseName}`,exact:true}).click();
  await expect(editor.getByRole('checkbox',{name:'已確認這個提詞',exact:true})).toBeChecked();
  await expect(editor.locator('.preset-photo-sample .preset-photo-tile')).toHaveCount(1);
  await editor.getByRole('textbox',{name:'提詞內容',exact:true}).fill('Updated browser pose');
  await editor.getByRole('button',{name:'保存提詞',exact:true}).click();await expect(editor).toHaveCount(0);
  await expect.poll(()=>f.store.read().presets.find(row=>row.id==='pose-standing').prompt).toBe('Updated browser pose');
  await expect(poseCard().getByRole('img',{name:'已確認',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'拍攝工作檯',exact:true}).click();await expect(apply).toBeEnabled();
  await apply.click();await expect(apply).toBeDisabled();
  await page.getByRole('button',{name:'選擇動作提詞',exact:true}).click();
  const picker=page.getByRole('dialog',{name:'選擇動作提詞 · 可複選',exact:true});
  const pose=picker.getByRole('button',{name:poseName,exact:true});
  await expect(pose.getByRole('img',{name:'已確認',exact:true})).toBeVisible();
  await expect(pose).toHaveAttribute('aria-pressed','true');
  const mark=await pose.locator('.preset-review-mark').boundingBox(),box=await pose.boundingBox();
  assert.ok(mark.x>box.x+box.width/2,'Review icon is on the right, separate from the selection box');
  await picker.screenshot({path:path.resolve('test-results/preset-review-picker.png')});
  await pose.click();await expect(pose).toHaveAttribute('aria-pressed','false');await expect(pose.getByRole('img',{name:'已確認',exact:true})).toBeVisible();
  await picker.getByRole('button',{name:'取消',exact:true}).click();await expect(apply).toBeDisabled();

  await page.getByRole('button',{name:'成果畫廊',exact:true}).click();
  let photo=page.locator('.gallery-card[data-job-id="review-photo"]');
  await expect(photo.locator('.shot-tag-link')).toHaveCount(8);
  await expect(page.locator('.gallery-card[data-job-id="deleted-photo"] .tag-pose')).toHaveText('自然站姿');
  await expect(page.locator('.gallery-card[data-job-id="deleted-photo"] .tag-pose')).not.toHaveAttribute('aria-haspopup','dialog');
  for(const label of ['動作','表情','服裝狀態','場景','攝影角度','光線','色彩','畫質']) {
    await photo.getByRole('button',{name:new RegExp(`^開啟${label}提詞 `)}).click();
    await expect(page.getByRole('dialog').last()).toBeVisible();
    await expect(page.getByRole('dialog').last().locator('.preset-related')).toBeVisible();
    await closeEditor();
  }
  assert.equal(f.store.read().jobs[0].pose.prompt.includes('Updated browser'),false,'Opening/editing tags keeps original photo snapshots');
  await photo.getByRole('button',{name:'詳細',exact:true}).click();
  const inspector=page.getByRole('dialog');await expect(inspector.locator('.shot-options')).toBeVisible();
  await inspector.getByRole('button',{name:`開啟動作提詞 ${poseName}`,exact:true}).click();await expect(editor).toBeVisible();
  await closeEditor();await expect(page.getByRole('dialog').locator('.shot-options')).toBeVisible();
  await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
  await photo.getByRole('button',{name:/^放大成果 /}).click();
  await page.getByRole('dialog',{name:'成果放大檢視',exact:true}).getByRole('button',{name:`開啟動作提詞 ${poseName}`,exact:true}).click();
  await expect(editor).toBeVisible();await expect(page.getByRole('dialog',{name:'成果放大檢視',exact:true})).toHaveCount(0);await closeEditor();

  await page.getByRole('button',{name:'拍攝清單',exact:true}).click();
  await page.getByRole('button',{name:'開啟拍攝組 確認測試',exact:true}).click();
  await page.getByRole('button',{name:'任務清單',exact:true}).click();
  await page.locator('.job-card').first().getByRole('button',{name:`開啟動作提詞 ${poseName}`,exact:true}).click();await expect(editor).toBeVisible();await closeEditor();

  await page.getByRole('button',{name:'提詞資料庫',exact:true}).click();
  await poseCard().getByRole('button',{name:`取消已確認 ${poseName}`,exact:true}).click();
  await expect(poseCard().getByRole('button',{name:`標記為已確認 ${poseName}`,exact:true})).toHaveAttribute('aria-pressed','false');
  await poseCard().getByRole('button',{name:`編輯提詞 ${poseName}`,exact:true}).click();
  await editor.getByRole('checkbox',{name:'已確認這個提詞',exact:true}).check();
  await editor.getByRole('button',{name:'保存提詞',exact:true}).click();await expect(editor).toHaveCount(0);
  await expect(poseCard().getByRole('img',{name:'已確認',exact:true})).toBeVisible();
  await page.screenshot({path:path.resolve('test-results/preset-review-library.png')});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:path.resolve('test-results/preset-review-mobile.png')});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile has no horizontal overflow');
  await page.getByRole('button',{name:'拍攝工作檯',exact:true}).click();await expect(apply).toBeDisabled();
  if(errors.length) throw new Error(errors.join('\n'));
  console.log('UI passed: persistent review toggles, separate selection/review icons, all eight photo tag dialogs, preserved shot snapshots, deleted ID safety, inspector return, lightbox close, unchanged/change/revert/apply tracking and mobile layout.');
} finally {await browser.close();await f.close();}
