import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {createApp} from '../server/index.js';
import {fixtureState,TEMPLATE,PNG,DRAFT} from './fixtures.js';
import {loginBrowser} from './auth-client.js';

async function fixture(t) {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-configs-ui-'));
  const instance=createApp({dataDir,fetchImpl:async()=>Response.json({devices:[],queue_running:[],queue_pending:[]})});
  instance.store.mutate(state=>{
    const videoPresets=state.presets.filter(row=>row.category==='video');
    Object.assign(state,fixtureState(),{workflow:TEMPLATE,draft:{...DRAFT,mode:'random',cameraEnabled:false}});
    state.presets.push(...videoPresets);
  });
  for(const row of [...instance.store.read().characters,...instance.store.read().garments]) fs.writeFileSync(path.join(dataDir,'uploads',row.fileName),PNG);
  const server=instance.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({executablePath:process.env.PHOTOCREATE_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  await page.emulateMedia({reducedMotion:'reduce'});page.on('pageerror',error=>errors.push(error.message));
  t.after(async()=>{
    await browser.close();await new Promise(resolve=>server.close(resolve));instance.store.close();
    const target=fs.realpathSync(dataDir);assert.equal(path.dirname(target),fs.realpathSync(os.tmpdir()));assert(path.basename(target).startsWith('PhotoCreate-configs-ui-'));
    fs.rmSync(target,{recursive:true,force:true});assert.deepEqual(errors,[]);
  });
  await loginBrowser(page,base);
  return {page,base};
}

test('管理員可在設定頁命名設定檔、勾選服裝和動作，保存後重新開啟仍保留',async t=>{
  const {page}=await fixture(t);
  await expect(page.getByRole('button',{name:'參數設定檔',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'參數設定檔',exact:true}).click();
  await page.getByRole('button',{name:'新增設定檔',exact:true}).click();
  await page.getByLabel('新設定檔名稱',{exact:true}).fill('週末方案');
  await page.getByRole('button',{name:'建立設定檔',exact:true}).click();
  await expect(page.getByLabel('設定檔名稱',{exact:true})).toHaveValue('週末方案');
  await page.getByRole('button',{name:'設定服裝候選',exact:true}).click();
  await page.getByRole('checkbox',{name:'白色洋裝',exact:true}).uncheck();
  await page.getByRole('checkbox',{name:'黑色外套',exact:true}).check();
  await page.getByRole('button',{name:'設定動作候選',exact:true}).click();
  await page.getByRole('button',{name:'清空此分類',exact:true}).click();
  await page.getByRole('checkbox',{name:'側坐回眸',exact:true}).check();
  await page.getByRole('button',{name:'保存設定檔',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('設定檔已保存');
  await page.reload();await page.getByRole('button',{name:'參數設定檔',exact:true}).click();
  await page.getByRole('combobox',{name:'參數設定檔',exact:true}).selectOption({label:'週末方案'});
  await page.getByRole('button',{name:'設定服裝候選',exact:true}).click();
  await expect(page.getByRole('checkbox',{name:'白色洋裝',exact:true})).not.toBeChecked();
  await expect(page.getByRole('checkbox',{name:'黑色外套',exact:true})).toBeChecked();
  await page.getByRole('button',{name:'設定動作候選',exact:true}).click();
  await expect(page.getByRole('checkbox',{name:'側坐回眸',exact:true})).toBeChecked();
  await expect(page.getByRole('checkbox',{name:'自然半蹲前傾',exact:true})).not.toBeChecked();
  fs.mkdirSync('test-results',{recursive:true});
  await page.screenshot({path:'test-results/customer-configs-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'test-results/customer-configs-mobile.png',fullPage:true});
});

test('帳號頁可建立顧客並用對話框修改參數設定檔，重新載入仍顯示已指定名稱',async t=>{
  const {page,base}=await fixture(t);
  const response=await page.request.post(base+'/api/customer-configs',{data:{name:'專屬候選'}});
  assert.equal(response.status(),201);const config=await response.json();
  await page.getByRole('button',{name:'顧客帳號',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'顧客參數設定檔',exact:true})).toBeVisible();
  await page.getByRole('textbox',{name:'顧客名稱',exact:true}).fill('小林');
  await page.getByRole('textbox',{name:'顧客帳號',exact:true}).fill('member-config');
  await page.getByLabel('初始密碼',{exact:true}).fill('customer-secret');
  await page.getByRole('combobox',{name:'顧客參數設定檔',exact:true}).selectOption(config.id);
  await page.getByRole('button',{name:'建立顧客帳號',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('顧客帳號已建立');
  await page.reload();await page.getByRole('button',{name:'顧客帳號',exact:true}).click();
  const row=page.locator('.account-row').filter({hasText:'member-config'});
  await expect(row).toContainText('專屬候選');
  await page.getByRole('button',{name:'修改 member-config 帳號',exact:true}).click();
  const editor=page.getByRole('dialog',{name:'修改 member-config 帳號',exact:true});
  await expect(editor).toBeVisible();
  await editor.getByRole('combobox',{name:'顧客參數設定檔',exact:true}).selectOption({label:'一般會員'});
  fs.mkdirSync('test-results',{recursive:true});
  await page.screenshot({path:'test-results/account-edit-dialog-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'test-results/account-edit-dialog-mobile.png',fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  await page.keyboard.press('Escape');
  await expect(editor).not.toBeVisible();await expect(row).toContainText('專屬候選');
  await expect(page.getByRole('button',{name:'修改 member-config 帳號',exact:true})).toBeFocused();
  await page.getByRole('button',{name:'修改 member-config 帳號',exact:true}).click();
  await expect(editor.getByRole('combobox',{name:'顧客參數設定檔',exact:true})).toHaveValue(config.id);
  await editor.getByRole('combobox',{name:'顧客參數設定檔',exact:true}).selectOption({label:'一般會員'});
  await editor.getByRole('button',{name:'保存顧客設定',exact:true}).click();
  await expect(editor).not.toBeVisible();
  await expect(row).toContainText('一般會員');
});

test('後台隨機拍攝預設使用一般會員設定檔，也能選另一份設定檔建立相同候選的清單',async t=>{
  const {page,base}=await fixture(t);
  await expect(page.getByRole('combobox',{name:'隨機拍攝設定檔',exact:true})).toBeVisible();
  const chosen=await page.getByRole('combobox',{name:'隨機拍攝設定檔',exact:true}).inputValue();
  const defaults=await (await page.request.get(base+'/api/customer-configs')).json();assert.equal(chosen,defaults.defaultId);
  const response=await page.request.post(base+'/api/customer-configs',{data:{name:'外套坐姿',draft:{...DRAFT,mode:'random',randomPoolMode:'selected',characterIds:['character'],garmentIds:['garment-b'],poseIds:['pose-sitting'],cameraEnabled:false}}});
  assert.equal(response.status(),201);const config=await response.json();
  await page.reload();
  await page.getByRole('combobox',{name:'隨機拍攝設定檔',exact:true}).selectOption(config.id);
  await page.getByRole('spinbutton',{name:'隨機張數',exact:true}).fill('2');
  const generated=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/jobs' && response.request().method()==='POST');
  await page.getByRole('button',{name:'建立隨機清單',exact:true}).click();
  const result=await generated;assert.equal(result.status(),201);const jobs=await result.json();
  assert.equal(jobs.length,2);assert(jobs.every(job=>job.garment.id==='garment-b' && job.pose.id==='pose-sitting'));
});

test('保存設定檔後預覽與實際清單同步，並保留這次拍攝張數與比例',async t=>{
  const {page}=await fixture(t);
  await page.getByRole('spinbutton',{name:'隨機張數',exact:true}).fill('2');
  await page.getByRole('combobox',{name:'輸出比例',exact:true}).selectOption('16:9');
  await page.getByRole('button',{name:'參數設定檔',exact:true}).click();
  await page.getByRole('button',{name:'設定服裝候選',exact:true}).click();
  await page.getByRole('checkbox',{name:'白色洋裝',exact:true}).uncheck();
  await page.getByRole('button',{name:'保存設定檔',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('設定檔已保存');
  await page.getByRole('button',{name:'拍攝工作檯',exact:true}).click();
  await page.getByRole('button',{name:/^候選範圍/}).click();
  await expect(page.locator('.pool-scope-row').filter({has:page.getByText('服裝',{exact:true})})).toContainText('1 項候選');
  await expect(page.getByRole('spinbutton',{name:'隨機張數',exact:true})).toHaveValue('2');
  await expect(page.getByRole('combobox',{name:'輸出比例',exact:true})).toHaveValue('16:9');
  const generated=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/jobs' && response.request().method()==='POST');
  await page.getByRole('button',{name:'建立隨機清單',exact:true}).click();
  const response=await generated;assert.equal(response.status(),201);
  const jobs=await response.json();assert.equal(jobs.length,2);
  assert(jobs.every(job=>job.garment.id==='garment-b' && job.aspectRatio==='16:9'));
});

test('參數設定檔的角色與服裝縮圖可正常載入',async t=>{
  const {page,base}=await fixture(t);
  await page.getByRole('button',{name:'參數設定檔',exact:true}).click();
  await expect(page.locator('.config-choice img')).toHaveCount(1);
  const response=await page.request.get(new URL(await page.locator('.config-choice img').getAttribute('src'),base).href);
  assert.equal(response.status(),200,response.status()===200 ? undefined : await response.text());
  await expect.poll(()=>page.locator('.config-choice img').evaluateAll(images=>images.length>0 && images.every(image=>image.complete && image.naturalWidth>0))).toBe(true);
  await page.getByRole('button',{name:'設定服裝候選',exact:true}).click();
  await expect.poll(()=>page.locator('.config-choice img').evaluateAll(images=>images.length===2 && images.every(image=>image.complete && image.naturalWidth>0))).toBe(true);
});
