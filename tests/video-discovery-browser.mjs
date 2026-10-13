import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {videoFixture} from './photo-video-fixture.js';
import {loginBrowser} from './auth-client.js';

const f=await videoFixture(),browser=await chromium.launch({executablePath:process.env.PHOTOCREATE_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];page.on('pageerror',e=>errors.push(e.message));fs.mkdirSync('test-results',{recursive:true});
try {
  f.store.mutate(state=>state.jobs.push({...structuredClone(state.jobs[0]),id:'derived-photo',sourceJobId:'original',rootJobId:'original',remakeVersion:1,name:'New photo version',images:[state.jobs[0].images[0]]}));
  await f.request('/jobs/original/video',{requestId:'find-existing-video',mode:'custom',prompt:'Gentle motion.',imageIndex:1});await f.photoVideos.tick();await f.finish();
  await loginBrowser(page,f.base);await page.getByRole('button',{name:'成果畫廊',exact:true}).click();
  const badge=page.getByRole('button',{name:'查看影片 New photo version',exact:true});await expect(badge).toBeVisible();await expect(badge).toContainText('其他版本');await badge.click();
  let dialog=page.getByRole('dialog',{name:'產影片',exact:true});await expect(dialog.locator('.photo-video-admin-source')).toHaveAttribute('src','/api/jobs/original/image/1');await expect(dialog.locator('video')).toBeVisible();await page.screenshot({path:'test-results/admin-video-source-badge.png'});
  const alice=await f.customer('discovery');f.store.mutate(state=>{for(const job of state.jobs) job.visitorId=alice.ownerId;for(const clip of state.photoVideos) clip.ownerId=alice.ownerId;});
  const customer=await browser.newPage({viewport:{width:1200,height:1000}});customer.on('pageerror',e=>errors.push(e.message));await loginBrowser(customer,f.base,alice.username,'fixture-pass');
  await customer.locator('#photos').getByRole('button',{name:'資料夾 全部照片',exact:true}).click();
  await customer.getByRole('button',{name:'打開第 1 張照片',exact:true}).click();dialog=customer.getByRole('dialog',{name:'我的照片',exact:true});
  const original=dialog.getByRole('group',{name:'照片版本',exact:true}).getByRole('button',{name:'原圖',exact:true});await expect(original.getByRole('img',{name:'已有 1 段影片',exact:true})).toBeVisible();await original.click();
  const output=dialog.getByRole('group',{name:'照片輸出',exact:true}).getByRole('button',{name:'照片 2',exact:true});await expect(output.getByRole('img',{name:'已有 1 段影片',exact:true})).toBeVisible();await output.click();
  await customer.screenshot({path:'test-results/customer-video-version-icon.png'});await dialog.getByRole('button',{name:/^產影片/}).click();dialog=customer.getByRole('dialog',{name:'產影片',exact:true});
  await dialog.getByRole('button',{name:'開始產影片',exact:true}).click();await expect.poll(()=>f.store.read().photoVideos.length).toBe(2);
  const row=dialog.locator('.photo-video-submit-row'),generate=row.getByRole('button',{name:'影片製作中',exact:true}),stop=row.getByRole('button',{name:'停止影片',exact:true});await expect(stop).toBeVisible();await expect(dialog.locator('.photo-video-production')).toHaveCount(0);
  let a=await generate.boundingBox(),b=await stop.boundingBox();assert.ok(Math.abs(a.y-b.y)<2 && b.x>=a.x+a.width);
  await customer.screenshot({path:'test-results/video-stop-beside-generation.png'});await customer.setViewportSize({width:390,height:844});a=await generate.boundingBox();b=await stop.boundingBox();assert.ok(Math.abs(a.y-b.y)<2 && b.x+b.width<=390);await customer.screenshot({path:'test-results/video-stop-beside-generation-mobile.png'});
  await stop.click();await expect.poll(()=>f.store.read().photoVideos[0].status).toBe('stopped');assert.deepEqual(errors,[]);
  console.log('Video discovery UI passed: original-version icons, gallery links to the source version, and stop beside the generation button on desktop/mobile.');
} finally {await browser.close();await f.close();}
