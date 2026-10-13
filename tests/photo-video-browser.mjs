import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {videoFixture} from './photo-video-fixture.js';
import {loginBrowser} from './auth-client.js';
import {DEFAULT_VIDEO_PROMPT} from '../shared/photo-video.js';

const f=await videoFixture(),browser=await chromium.launch({executablePath:process.env.PHOTOCREATE_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.emulateMedia({reducedMotion:'reduce'});
fs.mkdirSync('test-results',{recursive:true});
try {
  await loginBrowser(page,f.base);await page.getByRole('button',{name:'影片設定',exact:true}).click();
  await expect(page.getByRole('spinbutton',{name:'影片 Megapixels',exact:true})).toHaveValue('1');
  await page.getByRole('combobox',{name:'預設影片秒數',exact:true}).selectOption('7');await expect(page.getByRole('combobox',{name:'預設影片比例',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'保存影片設定',exact:true}).click();await expect(page.getByText('影片設定已保存，新影片會使用這些工作流參數。')).toBeVisible();
  await f.request('/presets',{id:'video-breeze',category:'video',name:'微風吹拂',prompt:'讓衣角隨微風自然擺動。',tags:[]});await f.request('/photo-videos/selection',{selectedPromptIds:f.photoVideos.settings().prompts.map(row=>row.id)},'PATCH');await f.request('/photo-videos/publish',{});await page.screenshot({path:'test-results/photo-video-admin-settings.png',fullPage:true});
  const alice=await f.customer('ui');
  f.store.mutate(state=>{state.jobs[0].visitorId=alice.ownerId;state.jobs.push({...structuredClone(state.jobs[0]),id:'plain-photo',rootJobId:'plain-photo',createdAt:'2026-10-01T00:00:00Z'});});
  await alice.request('/gallery',{jobId:'plain-photo',imageIndex:0});
  await page.context().clearCookies();await loginBrowser(page,f.base,alice.username,'fixture-pass');
  await page.locator('#photos').getByRole('button',{name:'資料夾 全部照片',exact:true}).click();await page.getByRole('button',{name:'打開第 1 張照片',exact:true}).click();
  let photo=page.getByRole('dialog',{name:'我的照片',exact:true});await photo.getByRole('button',{name:/^產影片/}).click();
  const creator=page.getByRole('dialog',{name:'產影片',exact:true});
  await expect(creator.getByRole('radio',{name:'7 秒',exact:true})).toBeChecked();await expect(creator.getByRole('combobox',{name:'官方影片提詞',exact:true})).toHaveValue('natural');
  await expect(creator.getByText('影片比例沿用這張照片',{exact:true})).toBeVisible();await expect(creator.getByRole('radio',{name:'方形 1:1',exact:true})).toHaveCount(0);
  await creator.getByRole('combobox',{name:'官方影片提詞',exact:true}).selectOption(f.photoVideos.settings().prompts[1].id);await expect(creator.getByText('讓衣角隨微風自然擺動。')).toBeVisible();
  await creator.getByRole('button',{name:'自行輸入',exact:true}).click();await creator.getByRole('textbox',{name:'影片提詞',exact:true}).fill('自然眨眼，緩緩抬頭。');await creator.getByRole('radio',{name:'10 秒',exact:true}).check();
  
  await page.screenshot({path:'test-results/photo-video-customer-desktop.png'});
  await page.setViewportSize({width:390,height:844});await expect(creator.getByRole('button',{name:'開始產影片',exact:true})).toBeEnabled();
  const bounds=await creator.evaluate(node=>({width:innerWidth,controls:[...node.querySelectorAll('select,textarea,.photo-video-durations label,.photo-video-generate')].map(child=>({left:child.getBoundingClientRect().left,right:child.getBoundingClientRect().right}))}));assert.ok(bounds.controls.every(row=>row.left>=0 && row.right<=bounds.width),JSON.stringify(bounds));
  await page.screenshot({path:'test-results/photo-video-customer-mobile.png'});
  await creator.getByRole('button',{name:'開始產影片',exact:true}).click();await expect.poll(()=>f.store.read().photoVideos.length).toBe(1);
  await f.photoVideos.tick();assert.equal(f.submitted[0].prompt.encode.inputs.prompt,'自然眨眼，緩緩抬頭。');assert.equal(f.submitted[0].prompt.trim_frames.inputs.length,240);assert.equal(f.submitted[0].prompt.encode.inputs.width,1024);assert.equal(f.submitted[0].prompt.encode.inputs.height,1024);assert.equal(f.store.read().photoVideos[0].aspectRatio,'reference');assert.equal(f.store.read().photoVideos[0].imageIndex,0);
  await f.finish();await expect(creator.locator('video')).toBeVisible();await expect.poll(()=>creator.locator('video').evaluate(node=>node.readyState)).toBeGreaterThan(1);
  await creator.getByRole('button',{name:'返回照片',exact:true}).click();photo=page.getByRole('dialog',{name:'我的照片',exact:true});await photo.getByRole('button',{name:'將這段影片加入精選',exact:true}).click();await expect(photo.getByText('這段影片已加入精選')).toBeVisible();await photo.getByRole('button',{name:'關閉照片',exact:true}).click();
  await page.setViewportSize({width:1440,height:1050});await page.locator('#gallery').getByRole('button',{name:'資料夾 全部照片',exact:true}).click();
  await expect(page.getByRole('button',{name:'播放影片 · 10 秒',exact:true})).toBeVisible();await page.getByRole('button',{name:'播放影片 · 10 秒',exact:true}).click();
  const viewer=page.getByRole('dialog',{name:'播放影片',exact:true});await expect(viewer).toBeVisible();await viewer.getByRole('button',{name:'關閉影片',exact:true}).click();
  await page.getByRole('button',{name:'播放精選',exact:true}).click();const player=page.getByRole('dialog',{name:'精選全螢幕播放',exact:true}),video=player.locator('video.pc-player-photo');
  await expect(video).toBeVisible();await expect.poll(()=>video.evaluate(node=>node.paused)).toBe(false);
  await player.getByRole('button',{name:'暫停精選輪播',exact:true}).click();await expect.poll(()=>video.evaluate(node=>node.paused)).toBe(true);const time=await video.evaluate(node=>node.currentTime);await page.waitForTimeout(500);assert.equal(await video.evaluate(node=>node.currentTime),time);
  await player.getByRole('combobox',{name:'輪播秒數',exact:true}).selectOption('3');await player.getByRole('button',{name:'播放精選輪播',exact:true}).click();await page.waitForTimeout(3300);await expect(video).toBeVisible();await expect(player.getByRole('status',{name:'目前播放照片',exact:true})).toHaveText('1 / 2');
  await expect(player.locator('img.pc-player-photo')).toBeVisible({timeout:3500});await player.getByRole('button',{name:'暫停精選輪播',exact:true}).click();
  await player.getByRole('button',{name:'播放第 1 張精選',exact:true}).click();await expect(video).toBeVisible();const retained=await video.elementHandle();await player.getByRole('button',{name:'關閉精選播放',exact:true}).click();assert.equal(await retained.evaluate(node=>node.paused),true);
  assert.deepEqual(errors,[]);console.log('Video UI passed: admin prompts/default duration, official/custom inputs, desktop/mobile, generated playback, mixed gallery timing, pause and cleanup; mocked H3 generation.');
} finally {await browser.close();await f.close();}
