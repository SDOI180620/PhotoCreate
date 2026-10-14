import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {previewFixture,until} from './preset-preview-fixture.js';
import {loginBrowser} from './auth-client.js';
import {PNG} from './fixtures.js';
import {defaultCharacterPromptSettings} from '../shared/character-profile.js';

const f=await previewFixture();
const settings=defaultCharacterPromptSettings();settings.turnaroundPrompt='Create three consistent full-body views, front, side and back.';settings.cupPrompts.C='custom medium bust';settings.heightPrompts['160to170']='custom medium stature';
await f.request('/character-prompt-settings',settings,'PUT');
await f.authentication.createCustomer({username:'turnaround-ui',password:'turnaround-password'});
const browser=await chromium.launch({executablePath:process.env.PHOTOCREATE_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const admin=await browser.newPage({viewport:{width:1440,height:1000}}),customer=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
for(const page of [admin,customer]) page.on('pageerror',error=>errors.push(error.message));
const original=Buffer.concat([PNG,Buffer.from('original-reference')]),file=name=>({name,mimeType:'image/png',buffer:original});
const editor=page=>page.getByRole('dialog',{name:'上傳角色',exact:true});
const row=(page,index=0)=>editor(page).getByRole('region',{name:`角色資料 ${index+1}`,exact:true});
const submit=(page,count=1)=>editor(page).getByRole('button',{name:`上傳 ${count} 個角色`,exact:true});
const finish=async(page,index=0)=>{f.complete(f.submitted.at(-1).id);await expect(row(page,index).getByRole('button',{name:'使用這張三視圖',exact:true})).toBeVisible();};
try {
  fs.mkdirSync('test-results',{recursive:true});
  await loginBrowser(admin,f.base);await admin.getByRole('button',{name:'角色參考',exact:true}).click();
  const count=f.store.read().characters.length;
  await admin.locator('input[type=file]').setInputFiles([file('converted-admin.png'),file('original-admin.png')]);
  await row(admin).getByRole('combobox',{name:'胸部尺寸',exact:true}).selectOption('C');await row(admin).getByRole('spinbutton',{name:'身高（公分）',exact:true}).fill('166');
  await row(admin,1).getByRole('combobox',{name:'胸部尺寸',exact:true}).selectOption('B');await row(admin,1).getByRole('spinbutton',{name:'身高（公分）',exact:true}).fill('145');
  await row(admin).getByRole('button',{name:'轉成三視圖',exact:true}).click();await until(()=>f.submitted.length===1);
  await expect(submit(admin,2)).toBeDisabled();await expect(row(admin).getByRole('spinbutton',{name:'身高（公分）',exact:true})).toBeDisabled();
  assert.equal(f.store.read().characters.length,count);assert.equal(f.store.read().jobs.length,0);
  const prompt=Object.values(f.submitted[0].prompt).find(node=>node.class_type==='TextEncodeQwenImage21').inputs.prompt;
  assert(prompt.includes(settings.turnaroundPrompt));assert(prompt.includes('custom medium bust'));assert(prompt.includes('custom medium stature'));
  await finish(admin);await editor(admin).screenshot({path:'test-results/character-turnaround-admin.png'});
  await row(admin).getByRole('button',{name:'重新轉圖',exact:true}).click();await until(()=>f.submitted.length===2);await finish(admin);
  await row(admin).getByRole('button',{name:'使用這張三視圖',exact:true}).click();await expect(row(admin).getByRole('status')).toContainText('已確認');await expect(submit(admin,2)).toBeEnabled();
  await row(admin).getByRole('spinbutton',{name:'身高（公分）',exact:true}).fill('167');
  await expect(row(admin).getByRole('alert')).toContainText('尺寸已修改');await expect(submit(admin,2)).toBeDisabled();
  await row(admin).getByRole('button',{name:'重新轉圖',exact:true}).click();await until(()=>f.submitted.length===3);await finish(admin);
  await row(admin).getByRole('button',{name:'使用這張三視圖',exact:true}).click();await expect(submit(admin,2)).toBeEnabled();await submit(admin,2).click();await expect(editor(admin)).toHaveCount(0);
  const converted=f.store.read().characters.find(asset=>asset.name==='converted-admin-three-view'),unchanged=f.store.read().characters.find(asset=>asset.name==='original-admin');
  assert(converted);assert(unchanged);assert.equal(converted.heightCm,167);assert.equal(converted.cupSize,'C');assert.equal(unchanged.heightCm,145);
  assert.deepEqual(fs.readFileSync(path.join(f.dataDir,'uploads',converted.fileName)),PNG);assert.deepEqual(fs.readFileSync(path.join(f.dataDir,'uploads',unchanged.fileName)),original);

  // Closing while the input upload is in flight cancels only this conversion.
  let release;f.control.uploadGate=new Promise(resolve=>{release=resolve;});const previousUploads=f.calls.filter(route=>route==='/upload/image').length;
  await admin.locator('input[type=file]').setInputFiles(file('cancelled-turnaround.png'));await row(admin).getByRole('button',{name:'轉成三視圖',exact:true}).click();
  await until(()=>f.calls.filter(route=>route==='/upload/image').length>previousUploads);
  await editor(admin).getByRole('button',{name:'取消',exact:true}).click();release();f.control.uploadGate=null;await expect(editor(admin)).toHaveCount(0);
  await until(()=>!f.characterTurnarounds.hasWork());assert.equal(f.submitted.length,3);assert.equal(f.store.read().characters.length,count+2);

  // An engine failure keeps the source available; the user may explicitly use it.
  await admin.locator('input[type=file]').setInputFiles(file('failed-turnaround.png'));await row(admin).getByRole('button',{name:'轉成三視圖',exact:true}).click();await until(()=>f.submitted.length===4);
  const failedId=f.submitted.at(-1).id;f.pending.delete(failedId);f.history.set(failedId,{status:{status_str:'error',completed:false},outputs:{}});
  await expect(row(admin).getByRole('alert')).toBeVisible();await expect(submit(admin)).toBeDisabled();await row(admin).getByRole('button',{name:'沿用原圖',exact:true}).click();await expect(submit(admin)).toBeEnabled();
  await submit(admin).click();await expect(editor(admin)).toHaveCount(0);assert(f.store.read().characters.some(asset=>asset.name==='failed-turnaround'));

  await loginBrowser(customer,f.base,'turnaround-ui','turnaround-password');
  await customer.locator('input[type=file]').setInputFiles(file('customer-turnaround.png'));await row(customer).getByRole('combobox',{name:'胸部尺寸',exact:true}).selectOption('D');await row(customer).getByRole('spinbutton',{name:'身高（公分）',exact:true}).fill('172');
  await row(customer).getByRole('button',{name:'轉成三視圖',exact:true}).click();await until(()=>f.submitted.length===5);await finish(customer);
  const box=await editor(customer).boundingBox();assert(box.x>=0 && box.x+box.width<=390,'Turnaround dialog fits a mobile viewport');
  assert(await editor(customer).evaluate(element=>element.scrollWidth<=element.clientWidth),'Turnaround comparison fits a mobile dialog');
  await editor(customer).screenshot({path:'test-results/character-turnaround-customer-mobile.png'});
  await expect(submit(customer)).toBeDisabled();await row(customer).getByRole('button',{name:'使用這張三視圖',exact:true}).click();await expect(submit(customer)).toBeEnabled();await submit(customer).click();await expect(editor(customer)).toHaveCount(0);
  const customerAsset=f.store.read().characters.find(asset=>asset.name==='customer-turnaround-three-view');assert(customerAsset?.visitorId);assert.equal(customerAsset.cupSize,'D');assert.equal(customerAsset.heightCm,172);
  assert.deepEqual(fs.readFileSync(path.join(f.dataDir,'uploads',customerAsset.fileName)),PNG);
  await customer.getByRole('button',{name:`選擇角色 ${customerAsset.name}`,exact:true}).click();
  const edit=customer.getByRole('dialog',{name:'編輯角色',exact:true});
  await expect(edit).toHaveCount(0);await customer.getByRole('button',{name:`編輯角色 ${customerAsset.name}`,exact:true}).click();
  await expect(edit.getByLabel('胸部尺寸',{exact:true})).toHaveValue('D');await expect(edit.getByLabel('身高（公分）',{exact:true})).toHaveValue('172');
  await edit.getByLabel('胸部尺寸',{exact:true}).selectOption('C');await edit.getByLabel('身高（公分）',{exact:true}).fill('166');
  await edit.getByRole('button',{name:'轉成三視圖',exact:true}).click();await until(()=>f.submitted.length===6);
  await expect(edit.getByRole('button',{name:'儲存角色設定',exact:true})).toBeDisabled();assert.equal(f.store.read().characters.find(asset=>asset.id===customerAsset.id).fileName,customerAsset.fileName);
  const editPrompt=Object.values(f.submitted.at(-1).prompt).find(node=>node.class_type==='TextEncodeQwenImage21').inputs.prompt;assert(editPrompt.includes('custom medium bust'));assert(editPrompt.includes('height 166 cm'));
  f.complete(f.submitted.at(-1).id);await edit.getByRole('button',{name:'使用這張三視圖',exact:true}).click();
  await expect(edit.getByRole('button',{name:'儲存角色設定',exact:true})).toBeEnabled();assert.equal(f.store.read().characters.find(asset=>asset.id===customerAsset.id).fileName,customerAsset.fileName);
  await edit.screenshot({path:'test-results/customer-character-editor-turnaround-mobile.png'});
  await edit.getByRole('button',{name:'儲存角色設定',exact:true}).click();await expect(edit).toHaveCount(0);
  const editedAsset=f.store.read().characters.find(asset=>asset.id===customerAsset.id);assert.notEqual(editedAsset.fileName,customerAsset.fileName);assert.equal(editedAsset.heightCm,166);assert.equal(editedAsset.cupSize,'C');assert.equal(f.store.read().characters.filter(asset=>asset.visitorId===customerAsset.visitorId).length,1);
  assert.equal(f.store.read().jobs.length,0);assert(!f.calls.includes('/interrupt'));assert(!f.calls.includes('/free'));assert.deepEqual(errors,[]);
  console.log('Character turnaround UI passed: combined prompts, preview before import, regenerate, measurement invalidation, mixed batch originals/results, cancellation, failure recovery, and customer mobile confirmation.');
} finally {await browser.close();await f.close();}
