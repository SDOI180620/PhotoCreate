import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {videoFixture} from './photo-video-fixture.js';
import {loginBrowser} from './auth-client.js';
import {PNG} from './fixtures.js';

const f=await videoFixture(),browser=await chromium.launch({executablePath:process.env.PHOTOCREATE_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.emulateMedia({reducedMotion:'reduce'});fs.mkdirSync('test-results',{recursive:true});
try {
  await loginBrowser(page,f.base);await page.getByRole('button',{name:'影片設定',exact:true}).click();
  const sampler=page.getByRole('combobox',{name:'影片 K 採樣器',exact:true}),scheduler=page.getByRole('combobox',{name:'影片 BasicScheduler',exact:true}),mp=page.getByRole('spinbutton',{name:'影片 Megapixels',exact:true});
  await expect(sampler).toHaveValue('euler');await expect(scheduler).toHaveValue('simple');await expect(mp).toHaveValue('1');
  await scheduler.selectOption('beta');await mp.fill('0.6');await page.getByRole('button',{name:'保存影片設定',exact:true}).click();await expect(page.getByText('影片設定已保存，新影片會使用這些工作流參數。',{exact:true})).toBeVisible();
  assert.equal((await f.request('/photo-videos/parameters')).data.megapixels,0.6);await scheduler.selectOption('simple');await mp.fill('1');await page.getByRole('button',{name:'保存影片設定',exact:true}).click();await expect.poll(async()=>(await f.request('/photo-videos/parameters')).data.megapixels).toBe(1);
  await page.screenshot({path:'test-results/video-settings-controls.png'});
  const version=page.getByRole('combobox',{name:'影片生成版本',exact:true});await version.selectOption('two-pass');
  const outputMP=page.getByRole('spinbutton',{name:'二採輸出 Megapixels',exact:true});await expect(outputMP).toBeEnabled();await expect(mp).toHaveValue('0.4');await expect(outputMP).toHaveValue('1');
  await page.getByRole('button',{name:'保存影片設定',exact:true}).click();await expect.poll(()=>f.photoVideos.settings().generationVersion).toBe('two-pass');await expect(sampler).toBeEnabled();
  assert.equal((await f.request('/photo-videos/parameters')).data.refineSteps,3);await page.screenshot({path:'test-results/video-two-pass-settings.png'});
  await version.selectOption('single');await expect(mp).toBeEnabled();await expect(mp).toHaveValue('1');await expect(outputMP).toHaveCount(0);await page.getByRole('button',{name:'保存影片設定',exact:true}).click();await expect.poll(()=>f.photoVideos.settings().generationVersion).toBe('single');
  await page.getByRole('button',{name:'到提詞庫管理影片提詞',exact:true}).click();await page.getByRole('button',{name:/^影片\s*1$/}).click();await expect(page.getByRole('button',{name:'編輯提詞 自然演繹',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'編輯提詞 自然演繹',exact:true}).click();let editor=page.getByRole('dialog',{name:'編輯提詞',exact:true});
  const testPanel=editor.getByRole('complementary',{name:'影片提詞測試',exact:true});await expect(testPanel).toBeVisible();await expect(editor.getByRole('combobox',{name:'分類',exact:true})).toHaveValue('video');
  await editor.getByRole('textbox',{name:'提詞內容',exact:true}).fill('The subject gently sways while the camera slowly frames the upper body.');await testPanel.getByRole('button',{name:/^測試照片/}).first().click();await testPanel.getByRole('button',{name:'測試產影片',exact:true}).click();await expect.poll(()=>f.store.read().photoVideos.length).toBe(1);
  const stop=testPanel.getByRole('button',{name:'停止影片',exact:true});await expect(stop).toBeVisible();await expect(stop).toHaveCSS('font-weight','600');assert.ok((await stop.boundingBox()).height>=32);await page.screenshot({path:'test-results/video-prompt-test-existing-stop.png'});
  await f.photoVideos.tick();assert.equal(f.submitted[0].prompt.encode.inputs.prompt,'The subject gently sways while the camera slowly frames the upper body.');assert.equal(f.photoVideos.publicSettings().prompts[0].prompt.includes("preserving the person's appearance"),true);
  await stop.click();await expect(testPanel.getByText('影片已停止',{exact:true})).toBeVisible();await testPanel.getByRole('button',{name:'刪除影片',exact:true}).click();
  let confirmation=page.getByRole('dialog',{name:'確認刪除影片',exact:true});await expect(confirmation).toBeVisible();await confirmation.getByRole('button',{name:'取消',exact:true}).click();await expect(confirmation).toHaveCount(0);assert.equal(f.store.read().photoVideos.length,1);
  await testPanel.getByRole('button',{name:'刪除影片',exact:true}).click();confirmation=page.getByRole('dialog',{name:'確認刪除影片',exact:true});await page.screenshot({path:'test-results/video-delete-confirm-dialog.png'});await confirmation.getByRole('button',{name:'確認刪除影片',exact:true}).click();await expect(confirmation).toHaveCount(0);await expect.poll(()=>f.store.read().photoVideos.length).toBe(0);
  await testPanel.locator('input[type=file]').setInputFiles({name:'temporary.png',mimeType:'image/png',buffer:PNG});await expect(testPanel.getByRole('img',{name:'臨時測試圖片',exact:true})).toBeVisible();await testPanel.getByRole('combobox',{name:'影片測試秒數',exact:true}).selectOption('7');await testPanel.getByRole('button',{name:'測試產影片',exact:true}).click();await expect.poll(()=>f.store.read().photoVideos.length).toBe(1);await f.photoVideos.tick();assert.equal(f.submitted[1].prompt.trim_frames.inputs.length,168);await f.finish();await expect(testPanel.getByText('影片已完成',{exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/video-prompt-test-upload.png'});await page.setViewportSize({width:390,height:844});await expect(testPanel.getByRole('button',{name:'刪除影片',exact:true})).toBeVisible();await testPanel.getByRole('button',{name:'刪除影片',exact:true}).click();confirmation=page.getByRole('dialog',{name:'確認刪除影片',exact:true});await expect(confirmation).toBeVisible();
  const bounds=await confirmation.boundingBox();assert.ok(bounds.x>=0 && bounds.x+bounds.width<=390);await page.screenshot({path:'test-results/video-delete-confirm-mobile.png'});await confirmation.getByRole('button',{name:'取消',exact:true}).click();await expect(editor).toBeVisible();
  assert.deepEqual(errors,[]);console.log('Video library UI passed: shared editor, editable sampler/scheduler/1 MP, generated/uploaded test images, clear stop action and desktop/mobile delete dialog.');
} finally {await browser.close();await f.close();}
