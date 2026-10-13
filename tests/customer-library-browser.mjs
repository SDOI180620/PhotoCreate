import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import sharp from 'sharp';
import {chromium,expect} from '@playwright/test';
import {previewFixture,until} from './preset-preview-fixture.js';
import {loginBrowser} from './auth-client.js';
import {DRAFT,PNG} from './fixtures.js';
import {buildShotPlans} from '../shared/domain.js';

const f=await previewFixture(),browser=await chromium.launch({executablePath:process.env.PHOTOCREATE_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const errors=[],contexts=[];
const newPage=async()=>{
  const context=await browser.newContext({viewport:{width:1440,height:1080}});contexts.push(context);
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));return page;
};
const openCustom=async page=>{
  await page.locator('#photos').getByRole('button',{name:'資料夾 全部照片',exact:true}).click();
  await page.locator('.pc-photo-card').first().click();
  await page.getByRole('dialog',{name:'我的照片',exact:true}).locator('.pc-photo-actions').getByRole('button',{name:/^自訂拍攝/}).click();
  const dialog=page.getByRole('dialog',{name:'自訂拍攝',exact:true});await expect(dialog).toBeVisible();return dialog;
};
const field=async(dialog,label)=>{
  const checkbox=dialog.getByRole('checkbox',{name:`${label}沿用原設定`,exact:true});await checkbox.uncheck();
  return dialog.locator(`.photo-change-option:has(input[aria-label="${label}沿用原設定"])`);
};
const savePrompt=async(section,label,name,prompt)=>{
  await section.getByRole('textbox',{name:`自訂${label}`,exact:true}).fill(prompt);
  await section.getByRole('button',{name:'保存到我的提詞',exact:true}).click();
  await expect(section.getByRole('textbox',{name:`${label}提詞名稱`,exact:true})).toHaveValue('');
  await expect(section.getByRole('button',{name:'保存提詞',exact:true})).toBeDisabled();
  await section.getByRole('textbox',{name:`${label}提詞名稱`,exact:true}).fill('   ');
  await expect(section.getByRole('button',{name:'保存提詞',exact:true})).toBeDisabled();
  await section.getByRole('textbox',{name:`${label}提詞名稱`,exact:true}).fill(name);
  await section.getByRole('button',{name:'保存提詞',exact:true}).click();
  await expect(section.getByRole('status')).toContainText('已保存');
};
fs.mkdirSync('test-results',{recursive:true});
try {
  const customers=[];
  for(const username of ['library-customer','library-other']) customers.push(await f.authentication.createCustomer({username,password:'fixture-pass'}));
  const database=new DatabaseSync(path.join(f.dataDir,'accounts.sqlite'),{readOnly:true});
  const owners=customers.map(row=>database.prepare('SELECT owner_id FROM accounts WHERE id=?').get(row.id).owner_id);database.close();
  fs.mkdirSync(path.join(f.outputDir,'PhotoCreate'),{recursive:true});fs.writeFileSync(path.join(f.outputDir,'PhotoCreate','library-source.png'),PNG);
  f.store.mutate(state=>{
    const [plan]=buildShotPlans(state,{...DRAFT,copies:1,garmentIds:['garment-a'],poseIds:['pose-standing'],cameraMode:'multiangle',cameraEnabled:false,aspectRatio:'9:16'});
    state.jobs=owners.map((visitorId,index)=>({...structuredClone(plan),id:`library-source-${index}`,visitorId,status:'completed',createdAt:'2026-10-12T00:00:00Z',images:[{filename:'library-source.png',subfolder:'PhotoCreate',type:'output'}]}));
  });
  const outfit=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500" viewBox="0 0 400 500"><rect width="400" height="500" fill="#f1edf5"/><path d="M145 80 L105 100 L45 235 L100 255 L130 180 L125 415 L275 415 L270 180 L300 255 L355 235 L295 100 L255 80 L232 125 L168 125 Z" fill="#304366"/><path d="M200 125 V410" stroke="#b4c0d3" stroke-width="3"/><g fill="#e5e8ef"><circle cx="212" cy="170" r="5"/><circle cx="212" cy="230" r="5"/><circle cx="212" cy="290" r="5"/><circle cx="212" cy="350" r="5"/></g></svg>')).png().toBuffer();
  const page=await newPage();await loginBrowser(page,f.base,'library-customer','fixture-pass');
  let dialog=await openCustom(page),section=await field(dialog,'服裝');
  await section.getByRole('button',{name:'我的服裝',exact:true}).click();
  await section.getByLabel('上傳我的服裝圖片',{exact:true}).setInputFiles({name:'my-blue-jacket.png',mimeType:'image/png',buffer:outfit});
  const selected=section.getByRole('button',{name:'選擇我的服裝 my-blue-jacket',exact:true});
  await expect(selected).toHaveAttribute('aria-pressed','true');
  const garment=f.store.read(state=>state.garments.find(row=>row.visitorId===owners[0]));assert.ok(garment);
  await section.screenshot({path:path.resolve('test-results/customer-wardrobe-desktop.png')});
  await page.setViewportSize({width:390,height:844});assert.equal(await dialog.evaluate(node=>node.scrollWidth>node.clientWidth),false);
  await section.screenshot({path:path.resolve('test-results/customer-wardrobe-mobile.png')});await page.setViewportSize({width:1440,height:1080});
  await section.getByRole('button',{name:'重新命名服裝 my-blue-jacket',exact:true}).click();
  await section.getByRole('textbox',{name:'我的服裝名稱',exact:true}).fill('我的藍色外套');await section.getByRole('button',{name:'保存名稱',exact:true}).click();
  await expect(section.getByRole('button',{name:'選擇我的服裝 我的藍色外套',exact:true})).toBeVisible();
  await dialog.getByRole('button',{name:'開始自訂拍攝',exact:true}).click();await until(()=>f.submitted.length>0);
  const shot=f.store.read(state=>state.jobs.find(row=>row.jobKind==='photo-edit'));
  assert.equal(shot.garment.id,garment.id);
  const graph=f.submitted[0].prompt,encoder=Object.values(graph).find(node=>node.class_type==='TextEncodeQwenImage21');
  assert.ok(graph[encoder.inputs['images.image_2'][0]].inputs.image.includes(garment.fileName));
  for(let i=0;i<6 && f.store.read(state=>state.jobs.find(row=>row.id===shot.id).status)!=='completed';i++) {
    await until(()=>f.pending.size>0 || f.store.read(state=>state.jobs.find(row=>row.id===shot.id).status)==='completed');
    for(const id of [...f.pending]) f.complete(id);
    await f.stageRunner.tick();
  }
  assert.equal(f.store.read(state=>state.jobs.find(row=>row.id===shot.id).status),'completed');
  await page.reload();dialog=await openCustom(page);section=await field(dialog,'服裝');
  const outfitPrompt='A navy long-sleeve jacket with silver buttons and a white shirt.';
  await savePrompt(section,'服裝','海軍藍外套',outfitPrompt);
  const poseSection=await field(dialog,'動作');await savePrompt(poseSection,'動作','雙手扶腰','Standing with both hands resting on the waist.');
  await section.screenshot({path:path.resolve('test-results/customer-prompts-desktop.png')});
  await page.setViewportSize({width:390,height:844});assert.equal(await dialog.evaluate(node=>node.scrollWidth>node.clientWidth),false);
  await section.screenshot({path:path.resolve('test-results/customer-prompts-mobile.png')});
  const prompts=f.store.read(state=>state.customerPrompts.filter(row=>row.ownerId===owners[0]));assert.equal(prompts.length,2);
  // A separate browser session uses the same account's persistent library.
  const returning=await newPage();await loginBrowser(returning,f.base,'library-customer','fixture-pass');
  let returningDialog=await openCustom(returning),returningSection=await field(returningDialog,'服裝');
  await returningSection.getByRole('button',{name:'我的服裝',exact:true}).click();await expect(returningSection.getByRole('button',{name:'選擇我的服裝 我的藍色外套',exact:true})).toBeVisible();
  await returningSection.getByRole('button',{name:'自行輸入',exact:true}).click();
  const clothingPrompt=prompts.find(row=>row.field==='clothing');
  await returningSection.getByRole('combobox',{name:'我的服裝提詞',exact:true}).selectOption(clothingPrompt.id);
  await expect(returningSection.getByRole('textbox',{name:'自訂服裝',exact:true})).toHaveValue(outfitPrompt);
  const returningPose=await field(returningDialog,'動作');await returningPose.getByRole('combobox',{name:'我的動作提詞',exact:true}).selectOption(prompts.find(row=>row.field==='pose').id);
  await expect(returningPose.getByRole('textbox',{name:'自訂動作',exact:true})).toHaveValue('Standing with both hands resting on the waist.');
  await returningSection.getByRole('textbox',{name:'自訂服裝',exact:true}).fill('A navy jacket with brass buttons.');await returningSection.getByRole('button',{name:'保存變更',exact:true}).click();
  await returningSection.locator('.customer-prompt-editor').getByRole('button',{name:'保存變更',exact:true}).click();await expect(returningSection.getByRole('status')).toContainText('已保存');
  assert.equal(f.store.read(state=>state.customerPrompts.find(row=>row.id===clothingPrompt.id).prompt),'A navy jacket with brass buttons.');
  const other=await newPage();await loginBrowser(other,f.base,'library-other','fixture-pass');
  const otherDialog=await openCustom(other),otherSection=await field(otherDialog,'服裝');
  await expect(otherSection.getByRole('combobox',{name:'我的服裝提詞',exact:true})).toBeDisabled();
  await otherSection.getByRole('button',{name:'我的服裝',exact:true}).click();await expect(otherSection.getByRole('group',{name:'我的服裝收藏',exact:true})).toContainText('我的服裝 · 0 套');
  assert.equal(await otherSection.getByRole('button',{name:/^選擇我的服裝/}).count(),0);
  await returningSection.getByRole('button',{name:'移除服裝提詞 海軍藍外套',exact:true}).click();await returningSection.getByRole('button',{name:'確定移除提詞',exact:true}).click();
  await expect(returningSection.getByRole('combobox',{name:'我的服裝提詞',exact:true})).toBeDisabled();
  await returningSection.getByRole('button',{name:'我的服裝',exact:true}).click();await returningSection.getByRole('button',{name:'移除我的服裝 我的藍色外套',exact:true}).click();await returningSection.getByRole('button',{name:'確定移除服裝',exact:true}).click();
  await expect(returningSection.getByRole('group',{name:'我的服裝收藏',exact:true})).toContainText('我的服裝 · 0 套');
  assert.equal(f.store.read(state=>state.jobs.find(row=>row.id===shot.id).garment.id),garment.id);
  assert.ok(fs.existsSync(path.join(f.dataDir,'uploads',garment.fileName)));
  assert.deepEqual(errors,[]);
  console.log('PASS: upload, reference image2, rename, saved clothing/pose prompts, new login, editing, owner isolation, removal and desktop/mobile layout.');
} catch(error) {
  for(let index=0;index<contexts.length;index++) for(const page of contexts[index].pages()) await page.screenshot({path:path.resolve(`test-results/customer-library-failure-${index}.png`),fullPage:true}).catch(()=>{});
  throw error;
} finally {await browser.close();await f.close();}
