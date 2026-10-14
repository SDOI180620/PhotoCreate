import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {chromium,expect} from '@playwright/test';
import {buildShotPlans} from '../shared/domain.js';
import {DRAFT,PNG} from './fixtures.js';
import {login,loginBrowser} from './auth-client.js';
import {previewFixture,until} from './preset-preview-fixture.js';

const f=await previewFixture(),browser=await chromium.launch({executablePath:process.env.PHOTOCREATE_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const videoPrompts=f.photoVideos.publicSettings().prompts;
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],closed=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('request',request=>{if(request.method()==='DELETE' && /\/api\/preset-previews\/[^/]+$/.test(new URL(request.url()).pathname)) closed.push(new URL(request.url()).pathname.split('/').at(-1));});
const prompt='A cream short-sleeved knit top and matching high-waisted long skirt, fine ribbed fabric and a silver belt buckle.';
const completeTrial=async(index,editor)=>{await until(()=>f.submitted.length===index+1);f.complete(f.submitted[index].id);await f.presetPreviews.sync();await f.presetPreviews.sync();await expect(editor.locator('.preset-trial .preset-photo-tile').first()).toBeVisible();await expect(editor.getByRole('button',{name:'再試拍一張',exact:true})).toBeEnabled();};
const inputCount=entry=>Object.values(entry.prompt).filter(node=>node.class_type==='LoadImage').length;
const overflow=element=>element.scrollWidth>element.clientWidth;
fs.mkdirSync('test-results',{recursive:true});
try {
  f.store.mutate(state=>{
    for(const row of videoPrompts) if(!state.presets.some(preset=>preset.id===row.id)) state.presets.push({...row,category:'video',tags:[]});
    const [plan]=buildShotPlans(state,{...DRAFT,copies:1,garmentIds:['garment-a'],poseIds:['pose-standing'],cameraMode:'multiangle',cameraEnabled:false});
    const base={...plan,status:'completed',createdAt:'2026-10-12T00:00:00Z',images:[{filename:'wardrobe-history.png',subfolder:'PhotoCreate',type:'output'}]};
    state.jobs=Array.from({length:7},(_,i)=>({...base,id:`wardrobe-history-${i}`,name:`服裝成果 ${i+1}`}));
    state.draft={...state.draft,characterId:'character',characterIds:['character']};
  });
  fs.mkdirSync(path.join(f.outputDir,'PhotoCreate'),{recursive:true});fs.writeFileSync(path.join(f.outputDir,'PhotoCreate','wardrobe-history.png'),PNG);
  await loginBrowser(page,f.base);await page.getByRole('button',{name:'服裝圖庫',exact:true}).click();
  await page.getByRole('button',{name:'新增提詞服裝',exact:true}).click();
  const fresh=page.getByRole('dialog',{name:'新增提詞服裝',exact:true});
  await expect(fresh.getByRole('button',{name:'保存服裝',exact:true})).toBeDisabled();
  await expect(fresh.getByRole('button',{name:'試拍一張',exact:true})).toBeDisabled();
  await fresh.getByRole('textbox',{name:'服裝名稱',exact:true}).fill('奶油白針織套裝');await fresh.getByRole('textbox',{name:'服裝提詞',exact:true}).fill(prompt);
  const first=f.submitted.length;await expect(fresh.getByRole('button',{name:'試拍一張',exact:true})).toBeEnabled();await fresh.getByRole('combobox',{name:'試拍比例',exact:true}).selectOption('1:1');await fresh.getByRole('button',{name:'試拍一張',exact:true}).click();await completeTrial(first,fresh);
  assert.equal(inputCount(f.submitted[first]),1);assert.equal(f.store.read().garments.length,2,'Unsaved trial does not add a wardrobe entry');
  await fresh.screenshot({path:path.resolve('test-results/garment-prompt-desktop.png')});
  await fresh.getByRole('button',{name:'保存服裝',exact:true}).click();await expect(fresh).toHaveCount(0);await until(()=>closed.length>0);
  const saved=f.store.read().garments.find(row=>row.name==='奶油白針織套裝');assert.equal(saved.prompt,prompt);assert.equal(saved.fileName,undefined);
  await expect(page.locator('.garment-card')).toHaveCount(3);await page.getByRole('group',{name:'服裝版本篩選',exact:true}).getByRole('button',{name:/提詞版/}).click();await expect(page.locator('.garment-card')).toHaveCount(1);
  await page.getByRole('group',{name:'服裝版本篩選',exact:true}).getByRole('button',{name:/圖片版/}).click();await page.getByRole('button',{name:'編輯服裝 白色洋裝',exact:true}).click();
  const editor=page.getByRole('dialog',{name:'編輯服裝',exact:true});
  await expect(editor.locator('.preset-photo-sample .preset-photo-tile')).toHaveCount(5);await expect(editor.locator('.preset-related h3')).toContainText('7 張');
  await editor.getByRole('button',{name:'更多',exact:true}).click();const gallery=page.getByRole('dialog',{name:'服裝關聯成果',exact:true});await expect(gallery.locator('figure')).toHaveCount(7);await page.keyboard.press('Escape');await expect(gallery).toHaveCount(0);await expect(editor).toBeVisible();
  const imageIndex=f.submitted.length;await expect(editor.getByRole('button',{name:'試拍一張',exact:true})).toBeEnabled();await editor.getByRole('button',{name:'試拍一張',exact:true}).click();await completeTrial(imageIndex,editor);assert.equal(inputCount(f.submitted[imageIndex]),2);
  await editor.getByRole('group',{name:'服裝生成版本',exact:true}).getByRole('button',{name:/提詞版/}).click();await editor.getByRole('textbox',{name:'服裝提詞',exact:true}).fill('A charcoal linen suit with a white cotton shirt.');
  const textIndex=f.submitted.length;await editor.getByRole('button',{name:'再試拍一張',exact:true}).click();await completeTrial(textIndex,editor);assert.equal(inputCount(f.submitted[textIndex]),1);await expect(editor.locator('.preset-trial-details').first()).toContainText('提詞版');await expect(editor.locator('.preset-trial-details').last()).toContainText('圖片版');
  await editor.screenshot({path:path.resolve('test-results/garment-versions-desktop.png')});
  await page.keyboard.press('Escape');await expect(editor).toHaveCount(0);assert.equal(f.store.read().garments.find(row=>row.id==='garment-a').sourceType,undefined,'Closing unsaved editing preserves the existing image garment');
  await page.getByRole('button',{name:'編輯服裝 白色洋裝',exact:true}).click();const cancelIndex=f.submitted.length;await expect(editor.getByRole('button',{name:'試拍一張',exact:true})).toBeEnabled();await editor.getByRole('button',{name:'試拍一張',exact:true}).click();await until(()=>f.submitted.length===cancelIndex+1);await page.keyboard.press('Escape');await until(()=>f.cancelled.includes(f.submitted[cancelIndex].id));

  // Mobile editor: its footer stays reachable while both content columns stack.
  await page.setViewportSize({width:390,height:844});await page.getByRole('group',{name:'服裝版本篩選',exact:true}).getByRole('button',{name:/提詞版/}).click();await page.getByRole('button',{name:'編輯服裝 奶油白針織套裝',exact:true}).click();
  await expect(editor.getByRole('textbox',{name:'服裝提詞',exact:true})).toBeVisible();assert.equal(await editor.evaluate(overflow),false);assert.equal(await editor.locator('.garment-editor-body').evaluate(overflow),false);await editor.screenshot({path:path.resolve('test-results/garment-prompt-mobile.png')});
  await editor.locator('.preset-photos').scrollIntoViewIfNeeded();assert.equal(await editor.locator('.preset-trial-controls').evaluate(overflow),false);await editor.screenshot({path:path.resolve('test-results/garment-trial-mobile.png')});await page.keyboard.press('Escape');

  // Workbench choices stay local; save customer availability in the account configuration.
  await page.setViewportSize({width:1440,height:1000});await page.getByRole('button',{name:'拍攝工作檯',exact:true}).click();await page.getByRole('button',{name:'隨機寫真',exact:true}).click();
  await page.getByRole('button',{name:'選擇角色參考圖',exact:true}).click();const characterPicker=page.getByRole('dialog',{name:/選擇角色參考圖/});const selectAllCharacters=characterPicker.getByRole('button',{name:'全選',exact:true});if(await selectAllCharacters.isEnabled())await selectAllCharacters.click();await characterPicker.getByRole('button',{name:'使用所選圖片',exact:true}).click();
  await page.getByRole('button',{name:'選擇服裝',exact:true}).click();const emptyPicker=page.getByRole('dialog',{name:'選擇服裝',exact:true});await emptyPicker.getByRole('button',{name:'清空已選',exact:true}).click();await emptyPicker.getByRole('button',{name:'使用所選服裝',exact:true}).click();await expect(emptyPicker).toHaveCount(0);
  await page.getByRole('button',{name:'選擇服裝',exact:true}).click();const picker=page.getByRole('dialog',{name:'選擇服裝',exact:true});await expect(picker.getByRole('button',{name:'清空已選',exact:true})).toBeDisabled();await picker.getByRole('button',{name:'選擇服裝 白色洋裝',exact:true}).click();await picker.getByRole('button',{name:'選擇服裝 奶油白針織套裝',exact:true}).click();await picker.getByRole('button',{name:'使用所選服裝',exact:true}).click();
  await expect(page.getByRole('button',{name:'套用至顧客攝影棚',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'參數設定檔',exact:true}).click();await page.getByRole('button',{name:'設定服裝候選',exact:true}).click();
  await page.getByRole('button',{name:'清空此分類',exact:true}).click();await page.getByRole('checkbox',{name:'白色洋裝',exact:true}).check();await page.getByRole('checkbox',{name:'奶油白針織套裝',exact:true}).check();
  await page.getByRole('button',{name:'保存設定檔',exact:true}).click();await expect.poll(()=>f.store.read().customerRecipe?.pools.garment.map(row=>row.id).sort()).toEqual(['garment-a',saved.id].sort());

  await f.authentication.createCustomer({username:'wardrobe-browser',password:'customer-pass'});const customer=await login(f.base,'wardrobe-browser','customer-pass');
  const accounts=new DatabaseSync(path.join(f.dataDir,'accounts.sqlite'),{readOnly:true});const ownerId=accounts.prepare('SELECT owner_id FROM accounts WHERE id=?').get(customer.user.id).owner_id;accounts.close();
  f.store.mutate(state=>state.jobs.push({...structuredClone(state.jobs[0]),id:'customer-outfit',name:'顧客服裝成果',visitorId:ownerId}));
  const visitor=await browser.newPage({viewport:{width:390,height:844}});visitor.on('pageerror',error=>errors.push(error.message));await loginBrowser(visitor,f.base,'wardrobe-browser','customer-pass');
  await visitor.locator('#photos').getByRole('button',{name:'資料夾 全部照片',exact:true}).click();await visitor.locator('.pc-photo-card').filter({has:visitor.locator('img[src*="/jobs/customer-outfit/image"]')}).click();await visitor.getByRole('button',{name:/^自訂拍攝/}).click();const custom=visitor.getByRole('dialog',{name:'自訂拍攝',exact:true});await custom.getByRole('checkbox',{name:'服裝沿用原設定',exact:true}).uncheck();await custom.getByRole('group',{name:'換裝方式',exact:true}).getByRole('button',{name:'官方選項',exact:true}).click();await custom.getByRole('button',{name:'選擇官方服裝',exact:true}).click();
  const official=visitor.getByRole('dialog',{name:'選擇服裝',exact:true});await expect(official.locator('.garment-picker-option')).toHaveCount(2);assert.equal(await official.evaluate(overflow),false);await official.screenshot({path:path.resolve('test-results/garment-customer-picker-mobile.png')});await visitor.keyboard.press('Escape');await expect(official).toHaveCount(0);await expect(custom).toBeVisible();
  await custom.getByRole('button',{name:'選擇官方服裝',exact:true}).click();await official.getByRole('button',{name:'選擇服裝 奶油白針織套裝',exact:true}).click();await official.getByRole('button',{name:'使用所選服裝',exact:true}).click();await expect(custom.locator('.photo-catalog-trigger').filter({hasText:'奶油白針織套裝'})).toContainText('提詞版');
  const customerIndex=f.submitted.length;await custom.getByRole('button',{name:'開始自訂拍攝',exact:true}).click();await until(()=>f.submitted.length===customerIndex+1);assert.equal(inputCount(f.submitted[customerIndex]),1);assert.ok(Object.values(f.submitted[customerIndex].prompt).some(node=>node.inputs.prompt?.includes(prompt)));assert.equal(f.store.read().jobs.find(row=>row.sourceJobId==='customer-outfit').garment.id,saved.id);
  f.complete(f.submitted[customerIndex].id);await until(async()=>{await f.stageRunner.tick();return f.store.read().jobs.find(row=>row.sourceJobId==='customer-outfit')?.status==='completed';});await visitor.close();

  // The requested single-photo remake submits only that photo, keeps the source
  // and disables duplicate clicks during generation.
  await page.getByRole('button',{name:'成果畫廊',exact:true}).click();const card=page.locator('.gallery-card[data-job-id="wardrobe-history-0"]');await expect(card.locator('.gallery-remake')).toBeEnabled();await card.screenshot({path:path.resolve('test-results/garment-gallery-remake-desktop.png')});
  const remakeIndex=f.submitted.length;await card.locator('.gallery-remake').click();await until(()=>f.submitted.length===remakeIndex+1);await expect(card.locator('.gallery-remake')).toBeDisabled();
  const state=f.store.read(),remake=state.jobs.find(row=>row.sourceJobId==='wardrobe-history-0');assert.ok(remake);assert.equal(remake.deleteSourceOnComplete,false);assert.notEqual(remake.seed,state.jobs.find(row=>row.id==='wardrobe-history-0').seed);assert.equal(state.jobs.find(row=>row.id==='wardrobe-history-0').images.length,1);
  f.complete(f.submitted[remakeIndex].id);await until(async()=>{await f.stageRunner.tick();return f.store.read().jobs.find(row=>row.id===remake.id)?.status==='completed';});
  await page.locator('.gallery-card[data-job-id="wardrobe-history-1"] .gallery-photo>button').click();const lightbox=page.getByRole('dialog',{name:'成果放大檢視',exact:true});await expect(lightbox.locator('.gallery-remake')).toBeEnabled();
  const lightboxIndex=f.submitted.length;await lightbox.locator('.gallery-remake').click();await until(async()=>{await f.stageRunner.tick();return f.submitted.length===lightboxIndex+1;});await expect(lightbox.locator('.gallery-remake')).toBeDisabled();assert.equal(f.store.read().jobs.find(row=>row.sourceJobId==='wardrobe-history-1').deleteSourceOnComplete,false);await lightbox.getByRole('button',{name:'關閉成果檢視',exact:true}).click();

  // Image import and its notes remain editable in the new wardrobe dialog.
  await page.getByRole('button',{name:'服裝圖庫',exact:true}).click();await page.locator('.garment-library input[type=file]').setInputFiles({name:'亞麻外套.png',mimeType:'image/png',buffer:PNG});await page.getByRole('button',{name:'編輯服裝 亞麻外套',exact:true}).click();await editor.getByRole('textbox',{name:/^圖片備註/}).fill('展示用管理備註');await editor.getByRole('button',{name:'保存服裝',exact:true}).click();await expect(editor).toHaveCount(0);assert.equal(f.store.read().garments.find(row=>row.name==='亞麻外套').description,'展示用管理備註');
  assert.deepEqual(errors,[]);
  console.log('Wardrobe UI passed: image import/notes, unsaved prompt/image trials, version snapshots, related gallery, cancellation, save, desktop/mobile layout, published customer selection and generation, and card/lightbox remakes without deleting the source.');
} finally {await browser.close();await f.close();}
