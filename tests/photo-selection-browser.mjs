import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {chromium,expect} from '@playwright/test';
import {createApp} from '../server/index.js';
import {buildShotPlans} from '../shared/domain.js';
import {DRAFT,TEMPLATE,PNG,fixtureState} from './fixtures.js';
import {loginBrowser} from './auth-client.js';

const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-photo-selection-ui-'));
const outputDir=path.join(dataDir,'output');fs.mkdirSync(path.join(outputDir,'PhotoCreate'),{recursive:true});
const fetchImpl=async url=>{
  const route=new URL(url).pathname;
  if(route==='/prompt') throw new Error('Selecting photos must not submit a generation request.');
  if(route==='/view') return new Response(PNG,{headers:{'content-type':'image/png'}});
  if(route==='/queue') return Response.json({queue_running:[[0,'working-prompt']],queue_pending:[]});
  if(route==='/userdata') return Response.json([]);
  return Response.json({devices:[{name:'Test GPU'}]});
};
const {app,store,authentication}=createApp({dataDir,comfyOutputDir:outputDir,fetchImpl});
const customer=await authentication.createCustomer({username:'selection-customer',password:'selection-test-password'});
const accounts=new DatabaseSync(path.join(dataDir,'accounts.sqlite'),{readOnly:true});
const ownerId=accounts.prepare('SELECT owner_id FROM accounts WHERE id=?').get(customer.id).owner_id;accounts.close();
const fixture=fixtureState();
const [template]=buildShotPlans(fixture,{...DRAFT,cameraEnabled:false,garmentIds:['garment-a'],poseIds:['pose-standing'],copies:1});
const job=(id,folderId='',extra={})=>{
  const filename=`${id}.png`;fs.writeFileSync(path.join(outputDir,'PhotoCreate',filename),PNG);
  return {...structuredClone(template),id,rootJobId:id,visitorId:ownerId,status:'completed',folderId,batchId:'selection-test',createdAt:new Date().toISOString(),images:[{filename,subfolder:'PhotoCreate',type:'output'}],apiPrompt:TEMPLATE,workflowSnapshot:TEMPLATE,comfyOutputDir:outputDir,...extra};
};
const folder=(id,name)=>({id,name,ownerId,createdAt:new Date().toISOString()});
const entry=(id,jobId,folderId='')=>({id,jobId,folderId,ownerId,imageIndex:0,addedAt:new Date().toISOString()});
const original=job('photo-a','photo-folder'),version=job('photo-a-version','photo-folder',{rootJobId:'photo-a',sourceJobId:'photo-a',remakeVersion:1});
const initialJobs=[original,version,job('photo-b','photo-folder'),job('photo-c'),job('photo-working','photo-folder',{status:'running',promptId:'working-prompt'}),job('photo-trash','photo-folder',{visitorDeletedAt:new Date().toISOString()}),job('foreign-photo','',{visitorId:'someone-else'})];
store.mutate(state=>Object.assign(state,fixture,{workflow:TEMPLATE,jobs:initialJobs,
  photoFolders:[folder('photo-folder','旅行照片'),folder('empty-folder','空資料夾'),folder('bulk-photos','大量照片'),folder('photo-destination','移動目的地')],
  galleryFolders:[folder('gallery-folder','旅行精選'),folder('empty-gallery','空精選'),folder('bulk-gallery','大量精選'),folder('gallery-destination','精選目的地')],
  galleryEntries:[entry('entry-a',original.id,'gallery-folder'),entry('entry-version',version.id,'gallery-folder'),entry('entry-b','photo-b','gallery-folder'),entry('entry-c','photo-c'),{...entry('foreign-entry','foreign-photo'),ownerId:'someone-else'}]}));
for(const row of [...fixture.characters,...fixture.garments]) fs.writeFileSync(path.join(dataDir,'uploads',row.fileName),PNG);
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const httpHost=os.hostname().toLowerCase(),base=`http://${httpHost}:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.PHOTOCREATE_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:[`--host-resolver-rules=MAP ${httpHost} 127.0.0.1`,'--no-proxy-server']});
const page=await browser.newPage({viewport:{width:1440,height:1080}}),errors=[],requests=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('request',request=>{const route=new URL(request.url()).pathname;if(request.method()==='POST' && /\/(photos|gallery)\/(move|delete|purge|remove)$/.test(route)) requests.push({route,body:request.postDataJSON()});});
const photos=page.locator('#photos'),gallery=page.locator('#gallery');
const allPhotos=()=>photos.getByRole('button',{name:'全選我的照片',exact:true}),allGallery=()=>gallery.getByRole('button',{name:'全選精選照片',exact:true});
const choosePhotoFolder=name=>photos.getByRole('button',{name:`資料夾 ${name}`,exact:true}).click();
const chooseGalleryFolder=name=>gallery.getByRole('button',{name:`資料夾 ${name}`,exact:true}).click();
fs.mkdirSync('test-results',{recursive:true});
try {
  await loginBrowser(page,base,'selection-customer','selection-test-password');
  assert.equal(await page.evaluate(()=>window.isSecureContext),false);
  await expect(photos.locator('.pc-photo-card-shell')).toHaveCount(4);
  await allPhotos().click();await expect(photos.locator('input:checked')).toHaveCount(4);
  await expect(photos.locator('.photo-folder-move')).toContainText('已選 4 張');
  await expect(photos.getByRole('button',{name:'刪除所選',exact:true})).toBeDisabled();
  await photos.getByRole('button',{name:'取消全選我的照片',exact:true}).click();
  await expect(photos.locator('input:checked')).toHaveCount(0);
  await photos.getByRole('checkbox',{name:'勾選第 1 張照片',exact:true}).check();
  await allPhotos().click();await expect(photos.locator('input:checked')).toHaveCount(4);
  await choosePhotoFolder('旅行照片');await expect(photos.locator('input:checked')).toHaveCount(0);
  await expect(photos.locator('.pc-photo-card-shell')).toHaveCount(3);
  await photos.getByRole('button',{name:'已完成',exact:true}).click();await allPhotos().click();
  await expect(photos.locator('input:checked')).toHaveCount(2);
  await expect(photos.getByRole('button',{name:'刪除所選',exact:true})).toBeEnabled();
  await photos.screenshot({path:path.resolve('test-results/photos-select-all-desktop.png'),animations:'disabled'});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Photo selection overflows on mobile');
  await photos.screenshot({path:path.resolve('test-results/photos-select-all-mobile.png'),animations:'disabled'});
  await photos.getByRole('button',{name:'拍攝中',exact:true}).click();await allPhotos().click();
  await expect(photos.locator('input:checked')).toHaveCount(1);
  await expect(photos.getByRole('button',{name:'刪除所選',exact:true})).toBeDisabled();
  await choosePhotoFolder('空資料夾');await expect(allPhotos()).toBeDisabled();
  await expect(photos.locator('input:checked')).toHaveCount(0);
  await photos.getByRole('button',{name:'回收區',exact:true}).click();await choosePhotoFolder('旅行照片');
  await photos.getByRole('button',{name:'全選回收區照片',exact:true}).click();
  await photos.getByRole('button',{name:'永久刪除所選',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('永久刪除 1 張照片？');
  await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
  await photos.getByRole('button',{name:'取消全選回收區照片',exact:true}).click();
  assert.equal(requests.length,0,'Selecting or cancelling must not mutate photos');

  await expect(gallery.getByRole('searchbox')).toHaveCount(0);
  await expect(gallery.locator('.pc-featured-card')).toHaveCount(4);
  assert.equal(await gallery.locator('.pc-featured-toolbar').evaluate(element=>element.previousElementSibling.classList.contains('photo-folders')),true,'Select all belongs after the folder filters');
  await allGallery().click();await expect(gallery.locator('input:checked')).toHaveCount(4);
  await gallery.getByRole('button',{name:'取消全選精選照片',exact:true}).click();
  await expect(gallery.locator('input:checked')).toHaveCount(0);
  await chooseGalleryFolder('旅行精選');await allGallery().click();
  await expect(gallery.locator('input:checked')).toHaveCount(3);
  await gallery.screenshot({path:path.resolve('test-results/featured-select-all-mobile.png'),animations:'disabled'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Featured selection overflows on mobile');
  await page.setViewportSize({width:1440,height:1080});
  await gallery.screenshot({path:path.resolve('test-results/featured-select-all-desktop.png'),animations:'disabled'});
  await chooseGalleryFolder('空精選');await expect(allGallery()).toBeDisabled();
  await expect(gallery.locator('input:checked')).toHaveCount(0);

  const bulkJobs=Array.from({length:101},(_,index)=>job(`bulk-${index}`,'bulk-photos'));
  const bulkVersion=job('bulk-version','bulk-photos',{rootJobId:'bulk-0',sourceJobId:'bulk-0',remakeVersion:1});
  store.mutate(state=>{state.jobs.push(...bulkJobs,bulkVersion);state.galleryEntries.push(...bulkJobs.map(row=>entry(`entry-${row.id}`,row.id,'bulk-gallery')));});
  await page.reload();await chooseGalleryFolder('大量精選');await allGallery().click();
  await expect(gallery.locator('.pc-featured-card')).toHaveCount(24);
  await expect(gallery.locator('input:checked')).toHaveCount(24);
  await expect(gallery.locator('.photo-folder-move')).toContainText('已選 101 張');
  await gallery.getByRole('button',{name:'下一頁精選',exact:true}).click();
  await expect(gallery.locator('input:checked')).toHaveCount(24);
  await gallery.getByRole('button',{name:'取消全選精選照片',exact:true}).click();
  await expect(gallery.locator('input:checked')).toHaveCount(0);
  await allGallery().click();await gallery.getByRole('combobox',{name:'移動所選照片至',exact:true}).selectOption('gallery-destination');
  await gallery.getByRole('button',{name:'移動照片',exact:true}).click();
  await expect.poll(()=>store.read().galleryEntries.filter(row=>row.folderId==='gallery-destination').length).toBe(101);
  await expect(allGallery()).toBeDisabled();await chooseGalleryFolder('精選目的地');await allGallery().click();
  await gallery.getByRole('button',{name:'移出畫廊',exact:true}).click();await expect(allGallery()).toBeDisabled();
  assert.equal(store.read().jobs.filter(row=>row.id.startsWith('bulk-') && !row.visitorDeletedAt).length,102,'Removing from the gallery must preserve originals and versions');

  await photos.getByRole('button',{name:'全部',exact:true}).click();await choosePhotoFolder('大量照片');await allPhotos().click();
  await expect(photos.locator('input:checked')).toHaveCount(101);
  await expect(photos.locator('.photo-folder-move')).toContainText('已選 101 張');
  await photos.getByRole('combobox',{name:'移動所選照片至',exact:true}).selectOption('photo-destination');
  await photos.getByRole('button',{name:'移動照片',exact:true}).click();await expect(allPhotos()).toBeDisabled();
  assert.equal(store.read().jobs.filter(row=>row.folderId==='photo-destination').length,102,'Moving 101 families must include every version');
  await choosePhotoFolder('移動目的地');await allPhotos().click();await photos.getByRole('button',{name:'刪除所選',exact:true}).click();
  await expect(allPhotos()).toBeDisabled();
  assert.equal(store.read().jobs.filter(row=>row.id.startsWith('bulk-') && row.visitorDeletedAt).length,102);
  await photos.getByRole('button',{name:'回收區',exact:true}).click();
  await expect(photos.locator('.pc-trash-card')).toHaveCount(101);
  await photos.getByRole('button',{name:'全選回收區照片',exact:true}).click();
  await photos.getByRole('button',{name:'永久刪除所選',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('永久刪除 101 張照片？');
  await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
  assert.equal(store.read().jobs.filter(row=>row.id.startsWith('bulk-')).length,102);
  let purgeCalls=0;
  await page.route('**/api/studio/photos/purge',route=>++purgeCalls===2
    ? route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'測試第二批暫時失敗，請重試。'})})
    : route.continue());
  await photos.getByRole('button',{name:'永久刪除所選',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'確認永久刪除',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('永久刪除 1 張照片？');
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('第二批暫時失敗');
  assert.equal(store.read().jobs.filter(row=>row.id.startsWith('bulk-')).length,1,'After a batch fails, retry only the remaining photo');
  await page.getByRole('dialog').getByRole('button',{name:'確認永久刪除',exact:true}).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(photos.getByRole('button',{name:'全選回收區照片',exact:true})).toBeDisabled();
  assert.equal(store.read().jobs.filter(row=>row.id.startsWith('bulk-')).length,0);
  assert.deepEqual(store.read().jobs,initialJobs,'Bulk operations must preserve unrelated and other customers’ photos');
  for(const route of ['/gallery/move','/gallery/remove','/photos/move','/photos/delete','/photos/purge']) {
    assert.deepEqual(requests.filter(request=>request.route===`/api/studio${route}`).map(request=>request.body.ids.length),route==='/photos/purge' ? [100,1,1] : [100,1],`${route} must handle more than 100 selected photos`);
  }
  assert.equal(fs.existsSync(path.join(outputDir,'PhotoCreate','bulk-0.png')),false);
  assert.equal(fs.existsSync(path.join(outputDir,'PhotoCreate','photo-a.png')),true);
  assert.deepEqual(errors,[]);
  console.log('Photos and featured gallery: select all/cancel, partial selection, folder and status filters, version grouping, active deletion guard, empty folders, mobile; featured search removed; cross-page and 101-family move/remove/delete/purge; partial failure and retry; unrelated photos preserved');
} catch(error) {
  await page.screenshot({path:path.resolve('test-results/photo-selection-failure.png'),fullPage:true});
  console.error('Photo selection browser errors:',JSON.stringify(errors));throw error;
} finally {
  await browser.close();await new Promise(resolve=>server.close(resolve));store.close();
  assert.equal(path.dirname(path.resolve(dataDir)),path.resolve(os.tmpdir()));
  assert.ok(path.basename(dataDir).startsWith('PhotoCreate-photo-selection-ui-'));
  fs.rmSync(dataDir,{recursive:true,force:true});
}
