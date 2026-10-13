import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {createApp} from '../server/index.js';
import {videoEnvironmentFixture} from './video-environment-fixture.js';
import {loginBrowser} from './auth-client.js';

const f=videoEnvironmentFixture(),instance=createApp({...f,environmentOptions:f,photoVideoOptions:{intervalMs:0}});
instance.store.mutate(state=>Object.assign(state.settings,{connectionMode:'directory',comfyDirectory:f.root}));
const server=instance.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const browser=await chromium.launch({executablePath:process.env.PHOTOCREATE_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1080}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.emulateMedia({reducedMotion:'reduce'});fs.mkdirSync('test-results',{recursive:true});
try {
  await loginBrowser(page,`http://127.0.0.1:${server.address().port}`);await page.getByRole('button',{name:'影片設定',exact:true}).click();
  await page.getByRole('combobox',{name:'預設影片秒數',exact:true}).selectOption('7');await page.getByRole('button',{name:'保存影片設定',exact:true}).click();await expect(page.getByText('影片設定已保存，新影片會使用這些工作流參數。',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'開啟 H3 環境與模型下載',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'工作室設定',exact:true}),install=dialog.getByRole('button',{name:'安裝環境',exact:true});
  await expect(install).toHaveCount(1);await expect(install).toBeEnabled();await expect(dialog.getByRole('button',{name:/下載 H3|安裝／更新 H3|檢查並載入/})).toHaveCount(0);
  await expect(dialog.getByText('拍照與換角度',{exact:true})).toBeVisible();await expect(dialog.getByText('照片產影片',{exact:true})).toBeVisible();
  await dialog.locator('.environment-advanced>summary').click();const panel=dialog.getByRole('region',{name:'H3 影片環境',exact:true});
  await panel.getByRole('combobox',{name:'影片 VAE',exact:true}).selectOption('minimax_h3_video_vae_fp16.safetensors');await expect(install).toBeEnabled();
  let bounds=await install.boundingBox();assert.ok(bounds.y>=0 && bounds.y+bounds.height<=1080,'Install action stays in the visible footer');
  await page.screenshot({path:'test-results/environment-unified-desktop.png'});
  f.controls.delay=35;await install.click();await expect(dialog.getByRole('button',{name:'暫停下載',exact:true})).toBeVisible();
  await expect.poll(()=>instance.environment.status().currentBytes || 0).toBeGreaterThan(8192);
  assert.equal(instance.environment.status().purpose,'studio');assert.equal(instance.photoVideos.settings().models.videoVae,'minimax_h3_video_vae_fp16.safetensors');assert.equal(instance.photoVideos.settings().defaultDuration,7);
  await expect(panel.getByRole('combobox',{name:'FastH3 Trim 8 步模型',exact:true})).toBeDisabled();await page.screenshot({path:'test-results/environment-unified-progress.png'});
  await dialog.getByRole('button',{name:'暫停下載',exact:true}).click();await expect(dialog.getByText('下載已暫停・進度已保留',{exact:true})).toBeVisible();await expect(install).toBeEnabled();
  f.controls.delay=2;await install.click();await expect(dialog.getByText('環境已安裝並載入，可以開始拍攝與產影片。',{exact:true})).toBeVisible({timeout:15000});
  assert.ok(f.controls.videoRequests.some(row=>row.offset>0));assert.equal(instance.store.read().settings.connectionMode,'directory');
  const requests=f.controls.videoRequests.length;await install.click();await expect.poll(()=>instance.environment.status().resourceCount).toBe(0);await expect(dialog.getByText('環境已安裝並載入，可以開始拍攝與產影片。',{exact:true})).toBeVisible();assert.equal(f.controls.videoRequests.length,requests);
  await page.setViewportSize({width:390,height:844});bounds=await install.boundingBox();assert.ok(bounds.x>=0 && bounds.x+bounds.width<=390);assert.ok(bounds.y>=0 && bounds.y+bounds.height<=844);
  const controls=await panel.evaluate(node=>[...node.querySelectorAll('select,button')].map(el=>({left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right})));assert.ok(controls.every(r=>r.left>=0 && r.right<=390));
  await page.screenshot({path:'test-results/environment-unified-mobile.png'});assert.deepEqual(errors,[]);console.log('Unified installer UI passed: one fixed action, automatic photo/video install and activation, skip/repeat, pause/resume, model selection and mobile.');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));instance.store.close();f.cleanup();}
