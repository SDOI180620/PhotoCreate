import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {chromium,expect} from '@playwright/test';
import {videoFixture} from './photo-video-fixture.js';
import {loginBrowser} from './auth-client.js';
import sharp from 'sharp';

async function fixture(t) {
  const f=await videoFixture(),browser=await chromium.launch({executablePath:process.env.PHOTOCREATE_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));await page.emulateMedia({reducedMotion:'reduce'});
  t.after(async()=>{await browser.close();await f.close();assert.deepEqual(errors,[]);});
  await loginBrowser(page,f.base);await page.getByRole('button',{name:'提詞資料庫',exact:true}).click();
  await page.getByRole('button',{name:/^影片\s*1$/}).click();await page.getByRole('button',{name:'編輯提詞 自然演繹',exact:true}).click();
  const panel=page.getByRole('dialog',{name:'編輯提詞',exact:true}).getByRole('complementary',{name:'影片提詞測試',exact:true});
  return {f,page,panel};
}

test('後台影片提詞測試完成後，照片卡片提供播放入口且影片能實際播放',async t=>{
  const {f,page,panel}=await fixture(t);
  await panel.getByRole('button',{name:/^測試照片/}).first().click();
  const response=page.waitForResponse(row=>new URL(row.url()).pathname==='/api/photo-videos/tests' && row.request().method()==='POST');
  await panel.getByRole('button',{name:'測試產影片',exact:true}).click();assert.equal((await response).status(),202);
  await f.photoVideos.tick();await f.finish();await expect(panel.getByText('影片已完成',{exact:true})).toBeVisible();
  const play=panel.locator('.video-test-photos').getByRole('button',{name:/^播放影片 /}).first();
  await expect(play).toBeVisible();fs.mkdirSync('test-results',{recursive:true});await panel.screenshot({path:'test-results/video-prompt-playback-card.png'});await play.click();
  const viewer=page.getByRole('dialog',{name:'播放影片',exact:true}),video=viewer.locator('video');
  await expect(viewer).toBeVisible();await expect.poll(()=>video.evaluate(node=>node.readyState)).toBeGreaterThanOrEqual(2);
  await expect.poll(()=>video.evaluate(node=>node.currentTime)).toBeGreaterThan(0);
  assert.equal(await video.evaluate(node=>node.error?.code || 0),0);
  const src=await video.getAttribute('src'),media=await page.request.get(f.base+src,{headers:{Range:'bytes=0-99'}});
  assert.equal(media.status(),206);assert.match(media.headers()['content-type'],/^video\/mp4/);
  fs.mkdirSync('test-results',{recursive:true});await viewer.screenshot({path:'test-results/video-prompt-playback-desktop.png'});
  const player=await video.elementHandle();await viewer.getByRole('button',{name:'關閉影片',exact:true}).click();
  assert.equal(await player.evaluate(node=>node.paused),true);
  await page.setViewportSize({width:390,height:844});await play.click();await expect(viewer).toBeVisible();
  const bounds=await viewer.boundingBox();assert(bounds.x>=0 && bounds.x+bounds.width<=390);
  await viewer.screenshot({path:'test-results/video-prompt-playback-mobile.png'});
  await viewer.getByRole('button',{name:'關閉影片',exact:true}).click();
});

test('上傳臨時圖片測試完成後改選照片，原影片封面仍可載入並保留上傳圖片',async t=>{
  const {f,page,panel}=await fixture(t);
  const upload=await sharp({create:{width:3,height:2,channels:4,background:'#274753'}}).png().toBuffer();
  await panel.getByLabel('上傳影片測試圖片',{exact:true}).setInputFiles({name:'my-source.png',mimeType:'image/png',buffer:upload});
  const response=page.waitForResponse(row=>new URL(row.url()).pathname==='/api/photo-videos/tests' && row.request().method()==='POST');
  await panel.getByRole('button',{name:'測試產影片',exact:true}).click();assert.equal((await response).status(),202);
  await f.photoVideos.tick();await f.finish();await expect(panel.getByText('影片已完成',{exact:true})).toBeVisible();
  await panel.getByRole('button',{name:'改用已產出的照片',exact:true}).click();
  await panel.getByRole('button',{name:/^測試照片/}).first().click();
  const video=panel.locator('.photo-video-result video');await expect(video).toHaveAttribute('poster',/.+/);
  const dimensions=await video.evaluate(async node=>{
    const bitmap=await createImageBitmap(await (await fetch(node.poster)).blob());
    const result={width:bitmap.width,height:bitmap.height};bitmap.close();return result;
  });
  assert.deepEqual(dimensions,{width:3,height:2});
});

test('播放已完成測試影片時封面綁定該影片來源，切換目前選中的照片不會改掉封面',async t=>{
  const {f,page,panel}=await fixture(t);
  await panel.getByRole('button',{name:/^測試照片/}).first().click();
  const response=page.waitForResponse(row=>new URL(row.url()).pathname==='/api/photo-videos/tests' && row.request().method()==='POST');
  await panel.getByRole('button',{name:'測試產影片',exact:true}).click();assert.equal((await response).status(),202);
  await f.photoVideos.tick();await f.finish();await expect(panel.getByText('影片已完成',{exact:true})).toBeVisible();
  await panel.getByRole('button',{name:/^測試照片/}).nth(1).click();
  await expect(panel.locator('.photo-video-result video')).toHaveAttribute('poster','/api/jobs/original/image/0');
  await panel.locator('.photo-video-result').getByRole('button',{name:'播放影片',exact:true}).click();
  const viewer=page.getByRole('dialog',{name:'播放影片',exact:true});
  await expect(viewer.locator('video')).toHaveAttribute('poster','/api/jobs/original/image/0');
  await viewer.getByRole('button',{name:'關閉影片',exact:true}).click();
});
