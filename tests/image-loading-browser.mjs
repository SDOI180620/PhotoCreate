import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {chromium,expect} from '@playwright/test';
import {buildShotPlans} from '../shared/domain.js';
import {DRAFT} from './fixtures.js';
import {previewFixture} from './preset-preview-fixture.js';
import {loginBrowser} from './auth-client.js';

const f=await previewFixture(),width=1152,height=2048,pixels=Buffer.alloc(width*height*3);let seed=37;
for(let i=0;i<pixels.length;i++) {seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;pixels[i]=seed&255;}
const original=await sharp(pixels,{raw:{width,height,channels:3}}).png().toBuffer();
const folder=path.join(f.outputDir,'PhotoCreate','many');fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'original.png'),original);
f.store.mutate(state=>{
  const shot=buildShotPlans(state,{...DRAFT,garmentIds:['garment-a'],poseIds:['pose-standing'],copies:1})[0];
  const graph={fixture:{class_type:'FixtureNode',inputs:{value:'x'.repeat(8000)}}};
  state.jobs=Array.from({length:1000},(_,index)=>({...shot,id:`many-${index}`,batchId:'many-photos',name:`寫真 ${index+1}`,createdAt:'2026-10-11T03:00:00Z',status:'completed',
    workflowSnapshot:graph,apiPrompt:graph,stageResults:{base:{completed:true,apiPrompt:graph}},images:[{filename:'original.png',subfolder:'PhotoCreate/many',type:'output'}]}));
  state.batches=[{id:'many-photos',name:'千張寫真',createdAt:state.jobs[0].createdAt}];
});
await f.photoStorage.archive();
const browser=await chromium.launch({executablePath:process.env.PHOTOCREATE_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true}),errors=[],requests=[];
page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.resourceType()==='image') requests.push(request.url());});
let releaseConnection;const connectionGate=new Promise(resolve=>{releaseConnection=resolve;});
await page.route('**/api/comfy/status',async route=>{await connectionGate;await route.continue();});
try {
  await loginBrowser(page,f.base);
  await expect(page.getByRole('button',{name:'成果畫廊',exact:true})).toBeVisible({timeout:4000});
  // The connection response is still pending: saved photos must open independently.
  await page.getByRole('button',{name:'成果畫廊',exact:true}).click();
  await expect(page.locator('.gallery-card')).toHaveCount(24);releaseConnection();
  await expect.poll(()=>page.locator('.gallery-grid img').evaluateAll(images=>images.slice(0,4).every(img=>img.complete && img.naturalWidth>0)),{timeout:15000}).toBe(true);
  const cards=await page.locator('.gallery-grid img').evaluateAll(images=>images.map(img=>({width:img.naturalWidth,height:img.naturalHeight,src:img.src})));
  assert.ok(cards.every(img=>new URL(img.src).searchParams.get('thumbnail')==='1'));
  assert.ok(cards.every(img=>Math.max(img.width,img.height)<=640));
  assert.ok(new Set(requests.filter(url=>url.includes('/jobs/')).map(url=>new URL(url).pathname)).size<=24,'Only the current page requests photo previews');
  const state=await (await page.request.get(f.base+'/api/state')).json();assert.equal(state.jobs.length,1000);assert.equal(state.jobs[0].apiPrompt,undefined);
  const first=page.locator('.gallery-card').first(),firstId=await first.getAttribute('data-job-id');
  await first.locator('.gallery-photo button').click();
  const dialog=page.getByRole('dialog',{name:'成果放大檢視',exact:true});
  await expect.poll(()=>dialog.locator('.gallery-expand img').evaluate(img=>img.complete && img.naturalHeight)).toBe(height);
  const image=await dialog.locator('.gallery-expand img').getAttribute('src');assert.equal(new URL(image,f.base).searchParams.has('thumbnail'),false);
  const downloaded=await page.request.get(f.base+image+'?download=1');assert.deepEqual(await downloaded.body(),original);
  await dialog.getByRole('button',{name:'關閉成果檢視',exact:true}).click();
  await page.getByRole('button',{name:'下一頁',exact:true}).click();await expect(page.locator('.gallery-card')).toHaveCount(24);
  assert.notEqual(await page.locator('.gallery-card').first().getAttribute('data-job-id'),firstId);
  await page.getByRole('button',{name:'工作流與連線設定',exact:true}).click();await page.getByRole('tab',{name:'資料搬移',exact:true}).click();
  await expect(page.getByRole('heading',{name:'完整備份（含照片）',exact:true})).toBeVisible();
  fs.mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/photo-storage-backup-settings.png'});
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'下載完整備份',exact:true}).click();
  const backup=await download;assert.match(backup.suggestedFilename(),/^PhotoCreate-backup-.*\.zip$/);assert.equal(await backup.failure(),null);
  await expect(page.getByText(/完整備份已開始下載/)).toBeVisible();
  assert.deepEqual(errors,[]);
  console.log('Image loading UI passed: 1,000 photos, 24 mounted cards, 640px previews, original viewer/download, pagination, independent connection status and full backup download.');
} finally {releaseConnection();await browser.close();await f.close();}
