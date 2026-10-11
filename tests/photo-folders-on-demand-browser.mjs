import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {chromium,expect} from '@playwright/test';
import {previewFixture} from './preset-preview-fixture.js';
import {buildShotPlans} from '../shared/domain.js';
import {DRAFT,PNG} from './fixtures.js';
import {loginBrowser} from './auth-client.js';

const f=await previewFixture(),account=await f.authentication.createCustomer({username:'folders-customer',password:'folders-test-password'});
const accounts=new DatabaseSync(path.join(f.dataDir,'accounts.sqlite'),{readOnly:true});
const owner=accounts.prepare('SELECT owner_id FROM accounts WHERE id=?').get(account.id).owner_id;accounts.close();
f.store.mutate(state=>{
  const plan=buildShotPlans(state,{...DRAFT,garmentIds:['garment-a'],poseIds:['pose-standing'],copies:1,cameraEnabled:false})[0];
  state.jobs=Array.from({length:143},(_,index)=>({...plan,id:`folder-photo-${index}`,visitorId:owner,rootJobId:`folder-photo-${index}`,status:'completed',
    createdAt:'2026-10-11T03:00:00Z',folderId:index<2 ? 'forest' : '',images:[{filename:`folder-photo-${index}.png`,subfolder:'PhotoCreate',type:'output'}]}));
  state.photoFolders=[{id:'forest',name:'森林寫真',ownerId:owner,createdAt:'2026-10-11T03:00:00Z'}];
  state.galleryFolders=[{id:'selected',name:'精選森林',ownerId:owner,createdAt:'2026-10-11T03:00:00Z'}];
  state.galleryEntries=state.jobs.map((job,index)=>({id:`featured-${index}`,jobId:job.id,imageIndex:0,ownerId:owner,folderId:index<2 ? 'selected' : '',addedAt:job.createdAt}));
});
fs.mkdirSync(path.join(f.outputDir,'PhotoCreate'),{recursive:true});
for(const job of f.store.read().jobs) fs.writeFileSync(path.join(f.outputDir,'PhotoCreate',job.images[0].filename),PNG);
const browser=await chromium.launch({executablePath:process.env.PHOTOCREATE_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),images=[],errors=[];
await page.emulateMedia({reducedMotion:'reduce'});
page.on('pageerror',error=>errors.push(error.message));
page.on('request',request=>{if(request.resourceType()==='image' && /\/api\/studio\/jobs\/[^/]+\/image\//.test(request.url())) images.push(request.url());});
try {
  await loginBrowser(page,f.base,'folders-customer','folders-test-password');
  const photos=page.locator('#photos'),gallery=page.locator('#gallery');
  const choose=(section,name)=>section.getByRole('button',{name:`資料夾 ${name}`,exact:true}).click();
  const close=section=>section.getByRole('button',{name:'收起照片',exact:true}).click();
  const closed=async()=>{
    await expect(photos.locator('.pc-photo-card-shell')).toHaveCount(0);
    await expect(gallery.locator('.pc-featured-card')).toHaveCount(0);
    await expect(page.locator('.photo-folder-tab[aria-pressed="true"]')).toHaveCount(0);
    await expect(gallery.getByRole('button',{name:'播放精選',exact:true})).toBeDisabled();
  };
  await expect(photos.getByRole('button',{name:'資料夾 全部照片',exact:true})).toBeEnabled();
  await photos.scrollIntoViewIfNeeded();await gallery.scrollIntoViewIfNeeded();await closed();
  await expect(photos.getByRole('button',{name:'資料夾 全部照片',exact:true})).toHaveText('全部照片143');
  await expect(gallery.getByRole('button',{name:'資料夾 全部照片',exact:true})).toHaveText('全部照片143');
  assert.equal(images.length,0,'Opening and scrolling the studio must not request photo files');
  await photos.getByRole('button',{name:'重新整理我的照片',exact:true}).click();
  await gallery.getByRole('button',{name:'更新畫廊',exact:true}).click();
  const focusedUpdate=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/studio/state');
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await focusedUpdate;
  await closed();assert.equal(images.length,0,'Refreshing data must keep both galleries closed');
  for(const name of ['已完成','拍攝中','回收區','全部']) {
    await photos.getByRole('button',{name,exact:true}).click();await closed();
  }
  assert.equal(images.length,0,'Changing the photo status filter must not open a folder');
  fs.mkdirSync('test-results',{recursive:true});
  await photos.screenshot({path:path.resolve('test-results/photos-on-demand-desktop.png'),animations:'disabled'});
  await gallery.screenshot({path:path.resolve('test-results/featured-on-demand-desktop.png'),animations:'disabled'});
  await page.setViewportSize({width:390,height:844});await photos.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Closed folders overflow on mobile');
  await photos.screenshot({path:path.resolve('test-results/photos-on-demand-mobile.png'),animations:'disabled'});
  await gallery.screenshot({path:path.resolve('test-results/featured-on-demand-mobile.png'),animations:'disabled'});
  await page.setViewportSize({width:1440,height:1000});

  await choose(photos,'森林寫真');await expect(photos.locator('.pc-photo-card-shell')).toHaveCount(2);
  await expect.poll(()=>photos.locator('.pc-photo-image img').evaluateAll(nodes=>nodes.every(node=>node.complete && node.naturalWidth>0))).toBe(true);
  await expect(gallery.locator('.pc-featured-card')).toHaveCount(0);
  assert.ok(images.length>0);assert.ok(images.every(url=>/\/jobs\/folder-photo-[01]\/image\//.test(url)),'Opening a folder fetched unrelated photos');
  await photos.getByRole('button',{name:'全選我的照片',exact:true}).click();await close(photos);await closed();
  await expect(photos.locator('.photo-folder-move')).toHaveCount(0);
  await choose(gallery,'精選森林');await expect(gallery.locator('.pc-featured-card')).toHaveCount(2);
  await expect(photos.locator('.pc-photo-card-shell')).toHaveCount(0);
  await expect(gallery.getByRole('button',{name:'播放精選',exact:true})).toBeEnabled();
  await gallery.getByRole('button',{name:'全選精選照片',exact:true}).click();await close(gallery);await closed();
  await expect(gallery.locator('.photo-folder-move')).toHaveCount(0);

  await choose(photos,'全部照片');await expect(photos.locator('.pc-photo-card-shell')).toHaveCount(24);
  await expect(photos.locator('.pc-photo-pagination')).toHaveText('1 / 6');
  await photos.getByRole('button',{name:'全選我的照片',exact:true}).click();
  await expect(photos.locator('.photo-folder-move')).toContainText('已選 143 張');
  await photos.getByRole('button',{name:'下一頁照片',exact:true}).click();
  await expect(photos.locator('input:checked')).toHaveCount(24);
  await expect(photos.getByRole('button',{name:'打開第 25 張照片',exact:true})).toBeVisible();
  await photos.getByRole('button',{name:'重新整理我的照片',exact:true}).click();
  await expect(photos.locator('.pc-photo-pagination')).toHaveText('2 / 6');
  await expect(photos.locator('input:checked')).toHaveCount(24);
  for(let index=0;index<4;index++) await photos.getByRole('button',{name:'下一頁照片',exact:true}).click();
  await expect(photos.locator('.pc-photo-card-shell')).toHaveCount(23);
  await expect(photos.getByRole('button',{name:'下一頁照片',exact:true})).toBeDisabled();
  await choose(photos,'森林寫真');await expect(photos.locator('.pc-photo-card-shell')).toHaveCount(2);
  await expect(photos.locator('input:checked')).toHaveCount(0);await close(photos);

  await choose(gallery,'全部照片');await expect(gallery.locator('.pc-featured-card')).toHaveCount(24);
  await gallery.getByRole('button',{name:'全選精選照片',exact:true}).click();
  await expect(gallery.locator('.photo-folder-move')).toContainText('已選 143 張');
  await gallery.getByRole('button',{name:'下一頁精選',exact:true}).click();
  await expect(gallery.locator('input:checked')).toHaveCount(24);
  await choose(gallery,'精選森林');await expect(gallery.locator('.pc-featured-card')).toHaveCount(2);
  await expect(gallery.locator('input:checked')).toHaveCount(0);
  await gallery.getByRole('button',{name:'刪除資料夾',exact:true}).click();
  await gallery.getByRole('button',{name:'確認刪除資料夾（照片保留）',exact:true}).click();
  await expect(gallery.getByRole('button',{name:'資料夾 精選森林',exact:true})).toHaveCount(0);await closed();
  assert.equal(f.store.read().galleryEntries.length,143,'Deleting a gallery folder must preserve its photos');

  await choose(photos,'森林寫真');await photos.getByRole('button',{name:'刪除資料夾',exact:true}).click();
  const deletion=page.getByRole('dialog',{name:'刪除資料夾「森林寫真」？',exact:true});
  await deletion.getByRole('button',{name:'取消',exact:true}).click();await expect(photos.locator('.pc-photo-card-shell')).toHaveCount(2);
  await photos.getByRole('button',{name:'刪除資料夾',exact:true}).click();
  await deletion.getByRole('button',{name:'確認永久刪除',exact:true}).click();
  await expect(deletion).toHaveCount(0);await closed();
  await expect(photos.getByRole('button',{name:'資料夾 全部照片',exact:true})).toHaveText('全部照片141');
  await expect(gallery.getByRole('button',{name:'資料夾 全部照片',exact:true})).toHaveText('全部照片141');
  assert.equal(f.store.read().jobs.length,141);

  images.length=0;await page.reload();await expect(photos.getByRole('button',{name:'資料夾 全部照片',exact:true})).toBeEnabled();
  await photos.scrollIntoViewIfNeeded();await gallery.scrollIntoViewIfNeeded();await closed();
  assert.equal(images.length,0,'Reloading must not reopen the last viewed folder or request photos');
  assert.deepEqual(errors,[]);
  console.log('143-photo studio: both galleries default closed with zero photo requests, refresh/focus/status/reload stay closed, independent folder clicks, close and clear, 24 per page, cross-page select all, cancelled/confirmed folder deletion, desktop/mobile.');
} finally {await browser.close();await f.close();}
