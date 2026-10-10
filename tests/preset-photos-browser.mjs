import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {buildShotPlans} from '../shared/domain.js';
import {DRAFT,fixtureState} from './fixtures.js';
import {loginBrowser} from './auth-client.js';
import {previewFixture,until} from './preset-preview-fixture.js';

const f=await previewFixture();
const plan=buildShotPlans(fixtureState(),{...DRAFT,copies:1,garmentIds:['garment-a'],poseIds:['pose-standing']})[0];
f.store.mutate(state=>{
  state.jobs=Array.from({length:26},(_,i)=>({...plan,id:`history-${i}`,name:`正式成果 ${i+1}`,status:'completed',createdAt:`2026-10-11T00:${String(i).padStart(2,'0')}:00Z`,images:[{filename:`history-${i}.png`,subfolder:'PhotoCreate',type:'output'}]}));
  state.jobs.push({...state.jobs[0],id:'private-history',name:'PRIVATE PHOTO',visitorId:'customer'});
});
const browser=await chromium.launch({executablePath:process.env.PHOTOCREATE_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],sessions=[],closedSessions=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('request',request=>{
  const route=new URL(request.url()).pathname;
  if(/^\/api\/preset-previews\/[^/]+$/.test(route)) {
    if(request.method()==='PUT') sessions.push(route.split('/').at(-1));
    if(request.method()==='DELETE') closedSessions.push(route.split('/').at(-1));
  }
});
await page.route('**/api/preset-previews/*/jobs/*/image/*',async route=>{
  const parts=new URL(route.request().url()).pathname.split('/'),status=(await f.request(`/preset-previews/${parts[3]}`)).data;
  const job=status.jobs.find(row=>row.id===parts[5]),width=job.outputWidth || 1,height=job.outputHeight || 1;
  await route.fulfill({status:200,contentType:'image/svg+xml',body:`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#dfe6d6"/></svg>`});
});
fs.mkdirSync('test-results',{recursive:true});
const editor=page.getByRole('dialog',{name:'編輯提詞',exact:true});
const ratio=()=>editor.getByRole('combobox',{name:'試拍比例',exact:true});
const openPreset=async()=>{await page.locator('.preset-card').filter({has:page.getByRole('heading',{name:'自然站姿',exact:true})}).click();await expect(editor).toBeVisible();await expect(editor.getByRole('button',{name:'試拍一張',exact:true})).toBeEnabled();};
try {
  await loginBrowser(page,f.base);
  await page.getByRole('button',{name:'提詞資料庫',exact:true}).click();await openPreset();
  await expect(editor.locator('.preset-photo-sample .preset-photo-tile')).toHaveCount(5);
  await expect(editor.locator('.preset-related h3')).toContainText('26 張');
  await editor.getByRole('button',{name:'更多',exact:true}).click();
  const gallery=page.getByRole('dialog',{name:'提詞關聯成果',exact:true});
  await expect(gallery.locator('.preset-photo-gallery-grid figure')).toHaveCount(24);
  await expect(gallery).not.toContainText('PRIVATE PHOTO');
  await gallery.locator('.preset-photo-tile').first().click();
  await expect(page.locator('.pc-image-viewer')).toBeVisible();await page.keyboard.press('ArrowRight');await expect(page.locator('.pc-image-viewer-navigation')).toContainText('2 / 24');
  await page.keyboard.press('Escape');await expect(page.locator('.pc-image-viewer')).toHaveCount(0);await expect(gallery).toBeVisible();await expect(editor).toBeVisible();
  await gallery.getByRole('button',{name:'下一頁',exact:true}).click();await expect(gallery.locator('.preset-photo-gallery-grid figure')).toHaveCount(2);
  await page.keyboard.press('Escape');await expect(gallery).toHaveCount(0);await expect(editor).toBeVisible();
  assert.equal(closedSessions.includes(sessions.at(-1)),false,'Closing the small gallery keeps the preview session alive');
  await expect(ratio()).toBeEnabled();await expect(ratio()).toHaveValue('9:16');await ratio().selectOption('16:9');
  await editor.getByRole('textbox',{name:'提詞內容',exact:true}).fill('UNSAVED BROWSER PREVIEW');
  await editor.getByRole('button',{name:'試拍一張',exact:true}).click();await until(()=>f.submitted.length===1);
  assert.ok(Object.values(f.submitted[0].prompt).some(node=>node.class_type==='TextEncodeQwenImage21' && node.inputs.prompt.includes('UNSAVED BROWSER PREVIEW')));
  await expect(editor.getByRole('button',{name:'試拍中…',exact:true})).toBeDisabled();
  await expect(ratio()).toBeDisabled();
  await expect(editor.locator('.preset-trials .preset-photo-help')).toContainText('只產一張原圖');
  f.complete(f.submitted[0].id);await f.presetPreviews.sync();
  await expect(editor.locator('.preset-trial .preset-photo-tile')).toHaveCount(1);await expect(editor.getByRole('button',{name:'再試拍一張',exact:true})).toBeEnabled();
  await f.presetPreviews.sync();assert.equal(f.submitted.length,1,'Original-image completion does not queue angle or refine even with a camera workflow installed');
  await expect(editor.locator('.preset-trial-details')).toContainText('自然站姿');await expect(editor.locator('.preset-bound')).toContainText('固定');
  await expect(editor.locator('.preset-trial-size')).toHaveText('橫式 16:9 · 1536 × 864');
  assert.equal(f.store.read().presets.find(row=>row.id==='pose-standing').prompt.includes('UNSAVED'),false,'Trial does not save editing changes');
  assert.equal(f.store.read().jobs.length,27,'Trial does not enter the real gallery');
  await editor.screenshot({path:path.resolve('test-results/preset-photos-desktop.png')});
  for(const value of ['9:16','1:1','reference']) {
    const index=f.submitted.length;await ratio().selectOption(value);
    await editor.getByRole('button',{name:'再試拍一張',exact:true}).click();await until(()=>f.submitted.length===index+1);
    f.complete(f.submitted[index].id);await f.presetPreviews.sync();
    const latest=editor.locator('.preset-trial').first();await expect(latest.locator('.preset-photo-tile')).toHaveCount(1);
    await latest.locator('.preset-photo-tile').scrollIntoViewIfNeeded();
    await expect.poll(()=>latest.locator('img').evaluate(img=>img.complete && img.naturalWidth>0)).toBe(true);
    const dimensions=await latest.locator('img').evaluate(img=>({natural:img.naturalWidth/img.naturalHeight,rendered:img.getBoundingClientRect().width/img.getBoundingClientRect().height,fit:getComputedStyle(img).objectFit}));
    assert.ok(Math.abs(dimensions.natural-dimensions.rendered)<0.002,'Trial thumbnails preserve the complete source ratio');assert.equal(dimensions.fit,'contain');
    await expect(editor.locator('.preset-trial-size').last()).toContainText('橫式 16:9');
    await expect(editor.getByRole('button',{name:'再試拍一張',exact:true})).toBeEnabled();
  }
  assert.equal(f.submitted.length,4,'Each selected ratio produces exactly one original image');
  const completedSession=sessions.at(-1),directory=path.join(f.outputDir,'PhotoCreate','_previews',completedSession);
  await editor.getByRole('button',{name:'關閉視窗',exact:true}).click();await expect(editor).toHaveCount(0);
  await until(()=>!fs.existsSync(directory));assert.ok(closedSessions.includes(completedSession));
  assert.equal(f.store.read().jobs.length,27);

  // Closing during generation cancels only the currently open preview.
  await openPreset();const runningSession=sessions.at(-1),runningIndex=f.submitted.length;
  await editor.getByRole('button',{name:'試拍一張',exact:true}).click();await until(()=>f.submitted.length===runningIndex+1);
  await page.keyboard.press('Escape');await expect(editor).toHaveCount(0);await until(()=>f.cancelled.includes(f.submitted[runningIndex].id));
  assert.ok(closedSessions.includes(runningSession));

  // An unsaved new preset can be tried, and saving closes/cleans the session.
  await page.getByRole('button',{name:'新增提詞',exact:true}).click();
  const fresh=page.getByRole('dialog',{name:'新增提詞',exact:true});
  await expect(fresh.getByRole('button',{name:'試拍一張',exact:true})).toBeDisabled();
  await fresh.getByRole('textbox',{name:'提詞名稱',exact:true}).fill('全新臨時提詞');await fresh.getByRole('textbox',{name:'提詞內容',exact:true}).fill('New temporary expression');
  const freshIndex=f.submitted.length;await fresh.getByRole('button',{name:'試拍一張',exact:true}).click();await until(()=>f.submitted.length===freshIndex+1);
  const newSession=sessions.at(-1);f.complete(f.submitted[freshIndex].id);await f.presetPreviews.sync();
  await expect(fresh.locator('.preset-trial .preset-photo-tile')).toHaveCount(1);
  await fresh.getByRole('button',{name:'保存提詞',exact:true}).click();await expect(fresh).toHaveCount(0);
  await until(()=>closedSessions.includes(newSession));await until(()=>!fs.existsSync(path.join(f.outputDir,'PhotoCreate','_previews',newSession)));
  assert.ok(f.store.read().presets.some(row=>row.name==='全新臨時提詞'));

  // Mobile stack and nested gallery remain within the viewport.
  await page.setViewportSize({width:390,height:844});await openPreset();
  await expect(ratio()).toBeEnabled();await ratio().selectOption('16:9');
  assert.equal(await editor.locator('.preset-trial-controls').evaluate(element=>element.scrollWidth>element.clientWidth),false);
  assert.equal(await editor.evaluate(element=>element.scrollWidth>element.clientWidth),false);
  await editor.locator('.preset-photos').scrollIntoViewIfNeeded();await editor.screenshot({path:path.resolve('test-results/preset-photos-mobile.png')});
  await editor.getByRole('button',{name:'更多',exact:true}).click();await expect(gallery.locator('.preset-photo-gallery-grid figure')).toHaveCount(24);
  assert.equal(await gallery.evaluate(element=>element.scrollWidth>element.clientWidth),false);
  await gallery.screenshot({path:path.resolve('test-results/preset-photos-gallery-mobile.png')});await page.keyboard.press('Escape');await expect(editor).toBeVisible();await page.keyboard.press('Escape');

  // Zero and fewer than five completed photos use their actual count.
  f.store.mutate(state=>{state.jobs=state.jobs.slice(0,3);});await page.reload();await page.getByRole('button',{name:'提詞資料庫',exact:true}).click();await openPreset();
  await expect(editor.locator('.preset-photo-sample .preset-photo-tile')).toHaveCount(3);await expect(editor.getByRole('button',{name:'更多',exact:true})).toHaveCount(0);await page.keyboard.press('Escape');
  f.store.mutate(state=>{state.jobs=[];});await page.reload();await page.getByRole('button',{name:'提詞資料庫',exact:true}).click();await openPreset();
  await expect(editor.locator('.preset-related')).toContainText('還沒有使用這項提詞的完成照片。');await page.keyboard.press('Escape');

  // A process with the older preview API must not silently ignore ratio selection.
  const legacyState=(await f.request('/state')).data;delete legacyState.features.presetPreviewRatios;
  await page.route('**/api/state',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(legacyState)}));
  await page.reload();await page.getByRole('button',{name:'提詞資料庫',exact:true}).click();await openPreset();
  await expect(ratio()).toBeDisabled();await expect(editor.locator('.preset-trials')).toContainText('重新啟動 PhotoCreate 後，即可選擇試拍比例');
  await page.keyboard.press('Escape');await page.unroute('**/api/state');

  // New static assets can be served by an older process before it is restarted.
  const oldState=(await f.request('/state')).data;delete oldState.features.presetPreviews;
  await page.route('**/api/state',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(oldState)}));
  const openedBefore=sessions.length;await page.reload();await page.getByRole('button',{name:'提詞資料庫',exact:true}).click();
  await page.locator('.preset-card').filter({has:page.getByRole('heading',{name:'自然站姿',exact:true})}).click();
  await expect(editor.locator('.preset-related')).toContainText('重新啟動 PhotoCreate');await expect(editor.getByRole('button',{name:'試拍一張',exact:true})).toBeDisabled();
  assert.equal(sessions.length,openedBefore,'Old backend does not receive unsupported preview API calls');await page.keyboard.press('Escape');
  assert.deepEqual(errors,[]);
  console.log('Preset photos UI passed: random five, paginated gallery, nested viewer, unsaved trials with portrait/landscape/square/reference ratios, uncropped thumbnails, completion/close cancellation, save cleanup, actual counts, mobile and old-backend guards.');
} finally {await browser.close();await f.close();}
