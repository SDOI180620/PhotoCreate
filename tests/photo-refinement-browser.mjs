import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {chromium,expect} from '@playwright/test';
import {previewFixture,until} from './preset-preview-fixture.js';
import {loginBrowser} from './auth-client.js';
import {DRAFT,PNG} from './fixtures.js';
import {buildShotPlans} from '../shared/domain.js';
import {REFINE_PROMPT,cameraPrompt} from '../shared/camera.js';

const f=await previewFixture(),browser=await chromium.launch({executablePath:process.env.PHOTOCREATE_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1080}}),errors=[],requests=[];
const angle={horizontalAngle:300,verticalAngle:51,zoom:9};
page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(request.method()==='POST' && /\/jobs\/[^/]+\/(refine|remake|custom)$/.test(new URL(request.url()).pathname))requests.push({path:new URL(request.url()).pathname,body:request.postDataJSON()});});
fs.mkdirSync('test-results',{recursive:true});
const dialog=()=>page.getByRole('dialog',{name:'我的照片',exact:true});
const openLatest=async()=>{await page.locator('#photos').getByRole('button',{name:'資料夾 全部照片',exact:true}).click();await page.locator('.pc-photo-card').first().click();await expect(dialog()).toBeVisible();};
const close=()=>dialog().getByRole('button',{name:'關閉照片',exact:true}).click();
try {
  const customer=await f.authentication.createCustomer({username:'refinement-customer',password:'fixture-pass'}),db=new DatabaseSync(path.join(f.dataDir,'accounts.sqlite'),{readOnly:true});const ownerId=db.prepare('SELECT owner_id FROM accounts WHERE id=?').get(customer.id).owner_id;db.close();
  fs.mkdirSync(path.join(f.outputDir,'PhotoCreate'),{recursive:true});for(const file of ['original.png','angle.png','angle-second.png'])fs.writeFileSync(path.join(f.outputDir,'PhotoCreate',file),PNG);
  f.store.mutate(state=>{
    const [plan]=buildShotPlans(state,{...DRAFT,copies:1,garmentIds:['garment-a'],poseIds:['pose-standing'],cameraMode:'multiangle',cameraEnabled:false,aspectRatio:'9:16'});
    const original={...plan,id:'refine-original',visitorId:ownerId,status:'completed',createdAt:'2026-10-12T00:00:00Z',seed:123,images:[{filename:'original.png',subfolder:'PhotoCreate',type:'output'}]};
    const selected={...structuredClone(original),id:'selected-angle',rootJobId:original.id,sourceJobId:original.id,remakeVersion:1,jobKind:'angle-edit',cameraEnabled:true,camera:{id:'saved-angle',name:'自訂角度',angle,prompt:cameraPrompt(angle)},cameraSource:{jobId:original.id,seed:original.seed,stage:'source',imageIndex:0,image:original.images[0],comfyUrl:state.settings.comfyUrl},sourceImage:original.images[0],sourceComfyUrl:state.settings.comfyUrl,images:[{filename:'angle.png',subfolder:'PhotoCreate',type:'output'},{filename:'angle-second.png',subfolder:'PhotoCreate',type:'output'}]};
    state.jobs=[selected,original];state.settings.releaseGpuMemory=false;state.galleryEntries=[{id:'selected-second-output',jobId:selected.id,imageIndex:1,ownerId,addedAt:original.createdAt}];
  });
  await loginBrowser(page,f.base,'refinement-customer','fixture-pass');await openLatest();
  await expect(dialog().getByRole('button',{name:'版本 2',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(dialog().getByRole('group',{name:'製作階段',exact:true}).getByRole('button',{name:'不同角度拍攝',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(dialog().locator('.pc-prompt-parameters')).toContainText('300° / 51° / Zoom 9');
  await dialog().locator('.pc-photo-actions').screenshot({path:path.resolve('test-results/photo-refinement-actions-desktop.png')});
  await page.setViewportSize({width:390,height:844});assert.equal(await dialog().evaluate(el=>el.scrollWidth>el.clientWidth),false);await dialog().locator('.pc-photo-actions').screenshot({path:path.resolve('test-results/photo-refinement-actions-mobile.png')});await page.setViewportSize({width:1440,height:1080});
  await dialog().getByRole('group',{name:'製作階段',exact:true}).getByRole('button',{name:'拍攝來源',exact:true}).click();
  await dialog().getByRole('group',{name:'照片版本',exact:true}).getByRole('button',{name:'原圖',exact:true}).click();
  await expect(dialog().getByRole('group',{name:'製作階段',exact:true}).getByRole('button',{name:'原始生成',exact:true})).toHaveAttribute('aria-pressed','true');
  await dialog().getByRole('button',{name:'版本 2',exact:true}).click();
  await expect(dialog().getByRole('group',{name:'製作階段',exact:true}).getByRole('button',{name:'不同角度拍攝',exact:true})).toHaveAttribute('aria-pressed','true');
  await dialog().getByRole('button',{name:/^重新拍一張/}).click();await until(()=>f.submitted.length===1);
  assert.equal(requests[0].path,'/api/studio/jobs/selected-angle/remake','Remake must target the visible angle version');
  const remake=f.store.read().jobs.find(job=>job.sourceJobId==='selected-angle'),encoder=Object.values(f.submitted[0].prompt).find(node=>node.class_type==='TextEncodeQwenImageEditPlus');
  assert.deepEqual(remake.camera.angle,angle);assert.equal(encoder.inputs.prompt,cameraPrompt(angle));assert.deepEqual(encoder._meta.cameraAngle,angle);assert.notEqual(remake.seed,123);
  f.complete(f.submitted[0].id);await f.stageRunner.tick();assert.equal(f.submitted.length,2);f.complete(f.submitted[1].id);await f.stageRunner.tick();assert.equal(f.store.read().jobs.find(job=>job.id===remake.id).status,'completed');
  await close();

  // Keeping every original setting must also execute the selected angle.
  await page.reload();await openLatest();await dialog().getByRole('button',{name:/^自訂拍攝/}).click();
  const customDialog=page.getByRole('dialog',{name:'自訂拍攝',exact:true});await customDialog.getByRole('button',{name:'開始自訂拍攝',exact:true}).click();await until(()=>f.submitted.length===3);
  assert.equal(requests.at(-1).path,`/api/studio/jobs/${remake.id}/custom`);assert.equal(requests.at(-1).body.customization.preserveOriginal,true);
  const custom=f.store.read().jobs.find(job=>job.jobKind==='photo-edit');assert.equal(custom.cameraEnabled,true);assert.deepEqual(custom.camera.angle,angle);
  f.complete(f.submitted[2].id);await f.stageRunner.tick();assert.equal(f.submitted.length,4);const customCamera=Object.values(f.submitted[3].prompt).find(node=>node._meta?.cameraAngle);assert.deepEqual(customCamera._meta.cameraAngle,angle);assert.equal(customCamera.inputs.prompt,cameraPrompt(angle));
  f.complete(f.submitted[3].id);await f.stageRunner.tick();assert.equal(f.submitted.length,5);f.complete(f.submitted[4].id);await f.stageRunner.tick();assert.equal(f.store.read().jobs.find(job=>job.id===custom.id).status,'completed');
  await close();await page.reload();await openLatest();await expect(dialog().getByRole('group',{name:'製作階段',exact:true}).getByRole('button',{name:'不同角度拍攝',exact:true})).toHaveAttribute('aria-pressed','true');await expect(dialog().locator('.pc-prompt-parameters')).toContainText('300° / 51° / Zoom 9');await dialog().locator('.pc-prompt-parameters').screenshot({path:path.resolve('test-results/retake-preserved-camera.png')});await close();

  // The selected featured output opens the exact version and image index.
  f.store.mutate(state=>{state.cameraWorkflow=null;state.customerRecipe=null;state.garments=[];state.presets=[];});await page.reload();
  const gallery=page.locator('#gallery');await gallery.getByRole('button',{name:'資料夾 全部照片',exact:true}).click();await gallery.getByRole('button',{name:'查看照片',exact:true}).click();
  await expect(dialog().getByRole('button',{name:'版本 2',exact:true})).toHaveAttribute('aria-pressed','true');
  const refine=dialog().locator('.pc-photo-actions').getByRole('button',{name:/^畫質優化/});await expect(refine).toBeEnabled();await expect(dialog().locator('.pc-photo-actions').getByRole('button',{name:/^不同角度拍攝/})).toBeDisabled();
  await page.setViewportSize({width:390,height:844});await expect(refine).toBeVisible();assert.equal(await dialog().evaluate(el=>el.scrollWidth>el.clientWidth),false);
  await refine.click();await until(()=>f.submitted.length===6);await expect(refine).toBeDisabled();assert.equal(requests.filter(row=>row.path.endsWith('/refine')).length,1);
  const submitted=requests.at(-1);assert.equal(submitted.path,'/api/studio/jobs/selected-angle/refine');assert.equal(submitted.body.imageIndex,1);
  const refined=f.store.read().jobs.find(job=>job.jobKind==='refine-edit'),graph=f.submitted[5].prompt,sampler=Object.values(graph).find(node=>node.class_type==='KSampler');
  assert.equal(refined.sourceImage.filename,'angle-second.png');assert.equal(refined.sourceImageIndex,1);assert.equal(refined.rootJobId,'refine-original');assert.equal(sampler.inputs.steps,20);assert.equal(sampler.inputs.denoise,0.2);assert.equal(Object.values(graph).filter(node=>node.class_type==='LoadImage').length,1);assert.ok(Object.values(graph).some(node=>node.inputs.prompt===REFINE_PROMPT));assert.ok(!Object.values(graph).some(node=>node.class_type==='TextEncodeQwenImageEditPlus'));
  f.complete(f.submitted[5].id);await f.stageRunner.tick();assert.equal(f.store.read().jobs.find(job=>job.id===refined.id).status,'completed');assert.equal(f.store.read().jobs.find(job=>job.id==='selected-angle').images.length,2);
  await close();await page.reload();await openLatest();await expect(dialog().getByRole('button',{name:'版本 5',exact:true})).toHaveAttribute('aria-pressed','true');await expect(dialog().getByRole('group',{name:'製作階段',exact:true}).getByRole('button',{name:'畫質優化',exact:true})).toHaveAttribute('aria-pressed','true');await expect(dialog().getByText('步數 20',{exact:false})).toBeVisible();
  await close();await page.route('**/api/studio/state',async route=>{const response=await route.fetch(),data=await response.json();data.photoRefinement=1;data.refineReady=true;await route.fulfill({response,json:data});});await page.reload();await openLatest();await expect(dialog().locator('.pc-photo-actions').getByRole('button',{name:/^畫質優化/})).toBeDisabled();await expect(dialog().getByText('畫質優化已更新，請重新啟動 PhotoCreate 後再使用。',{exact:true})).toBeVisible();
  await close();await page.route('**/api/studio/state',async route=>{const response=await route.fetch(),data=await response.json();delete data.photoRefinement;delete data.refineReady;await route.fulfill({response,json:data});});await page.reload();await openLatest();await expect(dialog().locator('.pc-photo-actions').getByRole('button',{name:/^畫質優化/})).toBeDisabled();
  assert.deepEqual(errors,[]);console.log('Photo actions passed: visible angle version remakes and original-setting custom photos execute saved camera parameters; refinement uses the selected output at 20 steps, preserves source and versions, locks duplicates, works without camera/catalog, and fits desktop/mobile.');
} finally {await browser.close();await f.close();}
