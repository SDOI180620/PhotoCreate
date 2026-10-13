import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {createApp} from '../server/index.js';
import {fixtureState,TEMPLATE,PNG,DRAFT} from './fixtures.js';
import {login,loginBrowser} from './auth-client.js';

async function fixture(t) {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-custom-shoot-ui-')),pending=new Set();
  const instance=createApp({dataDir,fetchImpl:async(url,options={})=>{
    const route=new URL(url).pathname;
    if(route==='/upload/image') return Response.json({name:options.body.get('image').name,subfolder:'PhotoCreate'});
    if(route==='/prompt') {const body=JSON.parse(options.body);pending.add(body.prompt_id);return Response.json({prompt_id:body.prompt_id});}
    if(route==='/queue') return Response.json({queue_running:[],queue_pending:[...pending].map(id=>[0,id])});
    if(route.startsWith('/api/jobs/') && route.endsWith('/cancel')) return Response.json({cancelled:pending.delete(route.split('/')[3])});
    return Response.json({devices:[]});
  }});
  instance.store.mutate(state=>Object.assign(state,fixtureState(),{workflow:TEMPLATE,draft:{...DRAFT,mode:'random',cameraEnabled:false}}));
  for(const asset of [...instance.store.read().characters,...instance.store.read().garments]) fs.writeFileSync(path.join(dataDir,'uploads',asset.fileName),PNG);
  const server=instance.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`,admin=await login(base);
  const adminRequest=async(route,body,method=body===undefined ? 'GET' : 'POST')=>{
    const response=await fetch(base+'/api'+route,{method,headers:{Cookie:admin.cookie,'Content-Type':'application/json'},...(body===undefined ? {} : {body:JSON.stringify(body)})});
    assert(response.ok);return response.json();
  };
  const config=await adminRequest('/customer-configs',{name:'顧客候選',draft:{...DRAFT,mode:'random',randomPoolMode:'selected',garmentIds:['garment-b'],poseIds:['pose-sitting'],lightingIds:['light-window'],colorIds:['color-natural'],qualityIds:['quality-editorial'],cameraEnabled:false}});
  await adminRequest('/accounts',{username:'custom-shoot-ui',password:'customer-secret',customerConfigId:config.id});
  const browser=await chromium.launch({executablePath:process.env.PHOTOCREATE_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],shoots=[];
  page.setDefaultTimeout(10000);
  await page.emulateMedia({reducedMotion:'reduce'});page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(new URL(request.url()).pathname==='/api/studio/shoots' && request.method()==='POST') shoots.push(request.postDataJSON());});
  t.after(async()=>{
    await browser.close();await new Promise(resolve=>server.close(resolve));instance.store.close();
    const target=fs.realpathSync(dataDir);assert.equal(path.dirname(target),fs.realpathSync(os.tmpdir()));assert(path.basename(target).startsWith('PhotoCreate-custom-shoot-ui-'));
    fs.rmSync(target,{recursive:true,force:true});assert.deepEqual(errors,[]);
  });
  await loginBrowser(page,base,'custom-shoot-ui','customer-secret');
  return {page,base,shoots,config,adminRequest};
}

test('顧客預設隨機，切換自定義只展開設定，張數與比例保留且按拍攝才建立照片',async t=>{
  const {page,shoots}=await fixture(t);
  const modes=page.getByRole('group',{name:'拍攝模式',exact:true}),custom=page.getByRole('group',{name:'自定義拍攝候選',exact:true});
  await expect(modes.getByRole('button',{name:'隨機',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(custom).toHaveCount(0);
  await page.getByRole('button',{name:'選擇角色 角色',exact:true}).click();
  await page.getByRole('button',{name:'拍攝 2 張',exact:true}).click();
  await page.getByRole('button',{name:'橫式',exact:true}).click();
  await modes.getByRole('button',{name:'自定義',exact:true}).click();
  await expect(custom).toBeVisible();await expect(custom.getByRole('button',{name:'設定服裝候選',exact:true})).toBeVisible();
  assert.equal(shoots.length,0);
  await modes.getByRole('button',{name:'隨機',exact:true}).click();await expect(custom).toHaveCount(0);
  await expect(page.getByRole('button',{name:'拍攝 2 張',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('button',{name:'橫式',exact:true})).toHaveAttribute('aria-pressed','true');
  const response=page.waitForResponse(row=>new URL(row.url()).pathname==='/api/studio/shoots' && row.request().method()==='POST');
  await page.locator('.pc-shoot-button').click();const result=await response;assert.equal(result.status(),202);
  const jobs=(await result.json()).jobs;assert.equal(jobs.length,2);assert(jobs.every(job=>job.aspectRatio==='16:9' && job.garment==='黑色外套'));
});

test('自定義未指定分類顯示不加入提詞，全取消套用後拍攝不補回隨機候選',async t=>{
  const {page}=await fixture(t);
  await page.getByRole('button',{name:'選擇角色 角色',exact:true}).click();
  await page.getByRole('button',{name:'自定義',exact:true}).click();
  await expect(page.getByRole('button',{name:'設定服裝候選',exact:true})).toContainText('未指定，不加入提詞');
  await page.getByRole('button',{name:'設定動作候選',exact:true}).click();
  const picker=page.getByRole('dialog',{name:'選擇動作候選',exact:true});
  await picker.getByRole('checkbox',{name:'側坐回眸',exact:true}).check();
  await picker.getByRole('button',{name:'全取消',exact:true}).click();
  await expect(picker.locator('footer')).toContainText('不加入動作提詞');
  await picker.getByRole('button',{name:'套用動作候選',exact:true}).click();
  await expect(page.getByRole('button',{name:'設定動作候選',exact:true})).toContainText('未指定，不加入提詞');
  await page.getByRole('button',{name:'拍攝 1 張',exact:true}).click();
  const response=page.waitForResponse(row=>new URL(row.url()).pathname==='/api/studio/shoots' && row.request().method()==='POST');
  await page.locator('.pc-shoot-button').click();const result=await response;assert.equal(result.status(),202);
  const jobs=(await result.json()).jobs;
  assert.equal(jobs.length,1);assert.equal(jobs[0].garment,'');assert.equal(jobs[0].pose,'');
  assert.deepEqual(jobs[0].settings.filter(row=>row.key!=='character' && row.key!=='camera'),[]);
});

test('選擇視窗合併帳號開放的服裝與本人提詞，可搜尋、複選，套用後拍攝只用所選候選',async t=>{
  const {page,base,shoots}=await fixture(t);
  const saved=await page.request.post(base+'/api/studio/prompts',{data:{field:'clothing',name:'收藏海軍外套',prompt:'A navy pea coat with brass buttons.'}});assert.equal(saved.status(),201);
  await page.reload();await page.getByRole('button',{name:'選擇角色 角色',exact:true}).click();
  await page.getByRole('button',{name:'自定義',exact:true}).click();
  await page.getByRole('button',{name:'設定服裝候選',exact:true}).click();
  const picker=page.getByRole('dialog',{name:'選擇服裝候選',exact:true});
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('checkbox',{name:'白色洋裝',exact:true})).toHaveCount(0);
  await expect(picker.getByRole('checkbox',{name:'黑色外套',exact:true})).toBeVisible();
  await expect(picker.getByRole('checkbox',{name:'收藏海軍外套',exact:true})).toBeVisible();
  await picker.getByRole('textbox',{name:'搜尋服裝選項',exact:true}).fill('navy');
  await expect(picker.getByRole('checkbox',{name:'黑色外套',exact:true})).toHaveCount(0);
  await picker.getByRole('checkbox',{name:'收藏海軍外套',exact:true}).check();
  await picker.getByRole('button',{name:'清除搜尋',exact:true}).click();
  await picker.getByRole('checkbox',{name:'黑色外套',exact:true}).check();
  await picker.getByRole('button',{name:'套用服裝候選',exact:true}).click();await expect(picker).toHaveCount(0);
  await expect(page.getByRole('button',{name:'設定服裝候選',exact:true})).toContainText('已選 2 個');
  assert.equal(shoots.length,0);
  await page.getByRole('button',{name:'拍攝 2 張',exact:true}).click();
  const response=page.waitForResponse(row=>new URL(row.url()).pathname==='/api/studio/shoots' && row.request().method()==='POST');
  await page.locator('.pc-shoot-button').click();const result=await response;assert.equal(result.status(),202);
  const jobs=(await result.json()).jobs;assert.equal(jobs.length,2);
  assert.deepEqual(jobs.map(job=>job.garment).sort(),['收藏海軍外套','黑色外套']);
});

test('顧客可加入本次臨時場景並拍攝，未保存的提詞不會出現在下次登入的收藏',async t=>{
  const {page,base,shoots}=await fixture(t);
  await page.getByRole('button',{name:'自定義',exact:true}).click();
  await page.getByRole('button',{name:'設定場景候選',exact:true}).click();
  const picker=page.getByRole('dialog',{name:'選擇場景候選',exact:true});
  await picker.getByRole('button',{name:'加入臨時提詞',exact:true}).click();
  await picker.getByRole('textbox',{name:'場景臨時提詞名稱',exact:true}).fill('本次海邊咖啡館');
  await picker.getByRole('textbox',{name:'臨時場景提詞',exact:true}).fill('A cozy seaside cafe with sunlight coming through the windows.');
  await picker.getByRole('button',{name:'加入本次候選',exact:true}).click();
  await expect(picker.getByRole('checkbox',{name:'本次海邊咖啡館',exact:true})).toBeChecked();
  await expect(picker).toContainText('本次加入');assert.equal(shoots.length,0);
  await picker.getByRole('button',{name:'套用場景候選',exact:true}).click();
  await page.getByRole('button',{name:'選擇角色 角色',exact:true}).click();await page.getByRole('button',{name:'拍攝 1 張',exact:true}).click();
  const response=page.waitForResponse(row=>new URL(row.url()).pathname==='/api/studio/shoots' && row.request().method()==='POST');
  await page.locator('.pc-shoot-button').click();const result=await response;assert.equal(result.status(),202);
  assert.equal((await result.json()).jobs[0].settings.find(row=>row.key==='scene')?.value,'本次海邊咖啡館');
  assert.deepEqual(await (await page.request.get(base+'/api/studio/prompts')).json(),[]);
  await page.reload();await page.getByRole('button',{name:'自定義',exact:true}).click();
  await page.getByRole('button',{name:'設定場景候選',exact:true}).click();
  await expect(picker.getByRole('checkbox',{name:'本次海邊咖啡館',exact:true})).toHaveCount(0);
});

test('更多設定逐步展開其他分類，選用本人表情與官方光線後傳入本次拍攝',async t=>{
  const {page,base}=await fixture(t);
  const saved=await page.request.post(base+'/api/studio/prompts',{data:{field:'expression',name:'收藏含笑',prompt:'A soft smile with relaxed eyes.'}});assert.equal(saved.status(),201);
  await page.reload();await page.getByRole('button',{name:'選擇角色 角色',exact:true}).click();
  await page.getByRole('button',{name:'自定義',exact:true}).click();
  await expect(page.getByRole('button',{name:'設定表情候選',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'更多設定',exact:true}).click();
  for(const label of ['表情','視線','服裝狀態','光線','色彩','畫質']) await expect(page.getByRole('button',{name:`設定${label}候選`,exact:true})).toBeVisible();
  await page.getByRole('button',{name:'設定表情候選',exact:true}).click();
  const expression=page.getByRole('dialog',{name:'選擇表情候選',exact:true});
  await expression.getByRole('checkbox',{name:'收藏含笑',exact:true}).check();
  await expression.getByRole('button',{name:'套用表情候選',exact:true}).click();
  await page.getByRole('button',{name:'設定光線候選',exact:true}).click();
  const lighting=page.getByRole('dialog',{name:'選擇光線候選',exact:true});
  await expect(lighting.getByRole('checkbox',{name:'陰天漫射光',exact:true})).toHaveCount(0);
  await lighting.getByRole('checkbox',{name:'柔和窗光',exact:true}).check();
  await lighting.getByRole('button',{name:'套用光線候選',exact:true}).click();
  await expect(page.getByRole('region',{name:'開始一組拍攝',exact:true}).getByRole('status')).toContainText('未指定的分類不加入提詞');
  await page.getByRole('button',{name:'拍攝 4 張',exact:true}).click();
  const response=page.waitForResponse(row=>new URL(row.url()).pathname==='/api/studio/shoots' && row.request().method()==='POST');
  await page.locator('.pc-shoot-button').click();const result=await response;assert.equal(result.status(),202);
  const jobs=(await result.json()).jobs;assert.equal(jobs.length,4);
  assert(jobs.every(job=>job.settings.find(row=>row.key==='expression')?.value==='收藏含笑' && job.settings.find(row=>row.key==='lighting')?.value==='柔和窗光'));
});

test('臨時提詞可明確保存成本人收藏，重新載入後能從整體候選選用',async t=>{
  const {page,base}=await fixture(t);
  await page.getByRole('button',{name:'自定義',exact:true}).click();await page.getByRole('button',{name:'設定動作候選',exact:true}).click();
  const picker=page.getByRole('dialog',{name:'選擇動作候選',exact:true});
  await picker.getByRole('button',{name:'加入臨時提詞',exact:true}).click();
  await picker.getByRole('textbox',{name:'動作臨時提詞名稱',exact:true}).fill('收藏斜坐');
  await picker.getByRole('textbox',{name:'臨時動作提詞',exact:true}).fill('Sit sideways on a wooden chair with relaxed shoulders.');
  await picker.getByRole('button',{name:'加入本次候選',exact:true}).click();
  await picker.getByRole('button',{name:'保存提詞 收藏斜坐',exact:true}).click();
  await expect(picker.getByRole('status')).toContainText('已保存到我的提詞');
  await expect(picker.getByRole('checkbox',{name:'收藏斜坐',exact:true})).toBeChecked();
  const prompts=await (await page.request.get(base+'/api/studio/prompts')).json();assert.equal(prompts.length,1);
  assert.equal(prompts[0].field,'pose');assert.equal(prompts[0].name,'收藏斜坐');assert.equal(prompts[0].prompt,'Sit sideways on a wooden chair with relaxed shoulders.');
  await picker.getByRole('button',{name:'套用動作候選',exact:true}).click();
  await page.reload();await page.getByRole('button',{name:'自定義',exact:true}).click();await page.getByRole('button',{name:'設定動作候選',exact:true}).click();
  await expect(picker).toContainText('我的提詞');await picker.getByRole('checkbox',{name:'收藏斜坐',exact:true}).check();
  await picker.getByRole('button',{name:'套用動作候選',exact:true}).click();
  await page.getByRole('button',{name:'選擇角色 角色',exact:true}).click();await page.getByRole('button',{name:'拍攝 1 張',exact:true}).click();
  const response=page.waitForResponse(row=>new URL(row.url()).pathname==='/api/studio/shoots' && row.request().method()==='POST');
  await page.locator('.pc-shoot-button').click();const result=await response;assert.equal(result.status(),202);assert.equal((await result.json()).jobs[0].pose,'收藏斜坐');
});

test('關閉或 Escape 取消候選草稿，已套用選擇不變且焦點回到原分類',async t=>{
  const {page,shoots}=await fixture(t);
  await page.getByRole('button',{name:'自定義',exact:true}).click();
  const trigger=page.getByRole('button',{name:'設定服裝候選',exact:true}),picker=page.getByRole('dialog',{name:'選擇服裝候選',exact:true});
  await trigger.click();await picker.getByRole('checkbox',{name:'黑色外套',exact:true}).check();await picker.getByRole('button',{name:'套用服裝候選',exact:true}).click();
  await trigger.click();await picker.getByRole('checkbox',{name:'黑色外套',exact:true}).uncheck();
  await picker.getByRole('button',{name:'關閉候選視窗',exact:true}).click();
  await expect(trigger).toContainText('已選 1 個');await expect(trigger).toBeFocused();
  await trigger.click();await expect(picker.getByRole('checkbox',{name:'黑色外套',exact:true})).toBeChecked();
  await picker.getByRole('checkbox',{name:'黑色外套',exact:true}).uncheck();await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);await expect(trigger).toContainText('已選 1 個');await expect(trigger).toBeFocused();assert.equal(shoots.length,0);
});

test('切回隨機不帶入自定義候選，再切回可沿用選擇，桌面與手機都能操作',async t=>{
  const {page,base,shoots}=await fixture(t);
  assert.equal((await page.request.post(base+'/api/studio/prompts',{data:{field:'clothing',name:'收藏亞麻長裙',prompt:'A cream linen maxi dress with long sleeves.'}})).status(),201);
  await page.reload();await page.getByRole('button',{name:'選擇角色 角色',exact:true}).click();
  await page.getByRole('button',{name:'自定義',exact:true}).click();await page.getByRole('button',{name:'設定服裝候選',exact:true}).click();
  const picker=page.getByRole('dialog',{name:'選擇服裝候選',exact:true});
  await picker.getByRole('button',{name:'加入臨時提詞',exact:true}).click();
  await picker.getByRole('textbox',{name:'服裝臨時提詞名稱',exact:true}).fill('本次紫色裙裝');
  await picker.getByRole('textbox',{name:'臨時服裝提詞',exact:true}).fill('A violet silk dress with a pleated skirt.');
  await picker.getByRole('button',{name:'加入本次候選',exact:true}).click();
  fs.mkdirSync('test-results',{recursive:true});
  await picker.screenshot({path:'test-results/customer-custom-picker-desktop.png'});
  await picker.getByRole('button',{name:'套用服裝候選',exact:true}).click();
  await page.getByRole('button',{name:'拍攝 2 張',exact:true}).click();await page.getByRole('button',{name:'橫式',exact:true}).click();
  await page.locator('.pc-shoot-settings').screenshot({path:'test-results/customer-custom-card-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.locator('.pc-shoot-settings').screenshot({path:'test-results/customer-custom-card-mobile.png'});
  await page.getByRole('button',{name:'設定服裝候選',exact:true}).click();
  await expect(picker.getByRole('checkbox',{name:'本次紫色裙裝',exact:true})).toBeChecked();
  await page.screenshot({path:'test-results/customer-custom-picker-mobile.png'});await page.keyboard.press('Escape');
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'隨機',exact:true}).click();assert.equal(shoots.length,0);
  let response=page.waitForResponse(row=>new URL(row.url()).pathname==='/api/studio/shoots' && row.request().method()==='POST');
  await page.locator('.pc-shoot-button').click();let result=await response;assert.equal(result.status(),202);
  let jobs=(await result.json()).jobs;assert.equal(jobs.length,2);assert(jobs.every(job=>job.garment==='黑色外套' && job.aspectRatio==='16:9'));
  await page.getByRole('button',{name:'自定義',exact:true}).click();await expect(page.getByRole('button',{name:'設定服裝候選',exact:true})).toContainText('本次紫色裙裝');
  await page.getByRole('button',{name:'拍攝 1 張',exact:true}).click();
  response=page.waitForResponse(row=>new URL(row.url()).pathname==='/api/studio/shoots' && row.request().method()==='POST');
  await page.locator('.pc-shoot-button').click();result=await response;assert.equal(result.status(),202);
  jobs=(await result.json()).jobs;assert.equal(jobs.length,1);assert.equal(jobs[0].garment,'本次紫色裙裝');assert.equal(jobs[0].aspectRatio,'16:9');
});

test('自定義模式直接顯示服裝狀態，能選用本人提詞且展開更多設定不重複出現',async t=>{
  const {page,base}=await fixture(t);
  assert.equal((await page.request.post(base+'/api/studio/prompts',{data:{field:'clothingState',name:'袖口捲起',prompt:'Sleeves rolled up to the elbows.'}})).status(),201);
  await page.reload();await page.getByRole('button',{name:'自定義',exact:true}).click();
  const trigger=page.getByRole('button',{name:'設定服裝狀態候選',exact:true});await expect(trigger).toBeVisible();
  await trigger.click();const picker=page.getByRole('dialog',{name:'選擇服裝狀態候選',exact:true});
  await picker.getByRole('checkbox',{name:'袖口捲起',exact:true}).check();await picker.getByRole('button',{name:'套用服裝狀態候選',exact:true}).click();
  await page.getByRole('button',{name:'更多設定',exact:true}).click();await expect(trigger).toHaveCount(1);
  await page.getByRole('button',{name:'選擇角色 角色',exact:true}).click();await page.getByRole('button',{name:'拍攝 1 張',exact:true}).click();
  const response=page.waitForResponse(row=>new URL(row.url()).pathname==='/api/studio/shoots' && row.request().method()==='POST');
  await page.locator('.pc-shoot-button').click();const result=await response;assert.equal(result.status(),202);
  assert.equal((await result.json()).jobs[0].settings.find(row=>row.key==='clothingState')?.value,'袖口捲起');
});

test('臨時提詞保存成已勾選的相同收藏時，只保留一個候選與正確選中數量',async t=>{
  const {page,base}=await fixture(t),name='已收藏的斜坐',prompt='Sit sideways on a wooden chair.';
  assert.equal((await page.request.post(base+'/api/studio/prompts',{data:{field:'pose',name,prompt}})).status(),201);
  await page.reload();await page.getByRole('button',{name:'自定義',exact:true}).click();await page.getByRole('button',{name:'設定動作候選',exact:true}).click();
  const picker=page.getByRole('dialog',{name:'選擇動作候選',exact:true});await picker.getByRole('checkbox',{name,exact:true}).check();
  await picker.getByRole('button',{name:'加入臨時提詞',exact:true}).click();
  await picker.getByRole('textbox',{name:'動作臨時提詞名稱',exact:true}).fill(name);await picker.getByRole('textbox',{name:'臨時動作提詞',exact:true}).fill(prompt);
  await picker.getByRole('button',{name:'加入本次候選',exact:true}).click();await picker.getByRole('button',{name:`保存提詞 ${name}`,exact:true}).click();
  await expect(picker.getByRole('status')).toContainText('已保存到我的提詞');
  await expect(picker.getByRole('checkbox',{name,exact:true})).toHaveCount(1);await expect(picker.getByRole('checkbox',{name,exact:true})).toBeChecked();
  await expect(picker.locator('footer')).toContainText('已選 1 個');
  assert.equal((await (await page.request.get(base+'/api/studio/prompts')).json()).length,1);
  await picker.getByRole('button',{name:'套用動作候選',exact:true}).click();await expect(page.getByRole('button',{name:'設定動作候選',exact:true})).toContainText('已選 1 個');
});

test('取消勾選臨時提詞只改變拍攝選擇，重新開啟分類仍能在本次操作選回',async t=>{
  const {page,base}=await fixture(t);
  await page.getByRole('button',{name:'自定義',exact:true}).click();await page.getByRole('button',{name:'設定場景候選',exact:true}).click();
  const picker=page.getByRole('dialog',{name:'選擇場景候選',exact:true});await picker.getByRole('button',{name:'加入臨時提詞',exact:true}).click();
  await picker.getByRole('textbox',{name:'場景臨時提詞名稱',exact:true}).fill('本次夜市');await picker.getByRole('textbox',{name:'臨時場景提詞',exact:true}).fill('A lively night market under warm lantern light.');
  await picker.getByRole('button',{name:'加入本次候選',exact:true}).click();await picker.getByRole('checkbox',{name:'本次夜市',exact:true}).uncheck();
  await picker.getByRole('button',{name:'套用場景候選',exact:true}).click();await expect(page.getByRole('button',{name:'設定場景候選',exact:true})).toContainText('未指定，不加入提詞');
  await page.getByRole('button',{name:'設定場景候選',exact:true}).click();
  await expect(picker.getByRole('checkbox',{name:'本次夜市',exact:true})).toBeVisible();await expect(picker.getByRole('checkbox',{name:'本次夜市',exact:true})).not.toBeChecked();
  await picker.getByRole('checkbox',{name:'本次夜市',exact:true}).check();await picker.getByRole('button',{name:'套用場景候選',exact:true}).click();
  await expect(page.getByRole('button',{name:'設定場景候選',exact:true})).toContainText('本次夜市');assert.deepEqual(await (await page.request.get(base+'/api/studio/prompts')).json(),[]);
});

test('動作候選沿用既有分類並包含本人提詞，跨分類切換保留勾選且不顯示未開放動作',async t=>{
  const {page,base,shoots}=await fixture(t);
  for(const [name,prompt] of [['我的跪蹲姿勢','Kneel on both knees beside a chair.'],['坐姿手持相機','Sit holding a camera with both hands.']]) assert.equal((await page.request.post(base+'/api/studio/prompts',{data:{field:'pose',name,prompt}})).status(),201);
  await page.reload();await page.getByRole('button',{name:'自定義',exact:true}).click();await page.getByRole('button',{name:'設定動作候選',exact:true}).click();
  const picker=page.getByRole('dialog',{name:'選擇動作候選',exact:true}),groups=picker.getByRole('group',{name:'動作分類',exact:true});
  await expect(groups).toBeVisible();await groups.getByRole('button',{name:'跪蹲',exact:true}).click();
  await expect(picker.getByRole('checkbox',{name:'側坐回眸',exact:true})).toHaveCount(0);
  await expect(picker.getByRole('checkbox',{name:'自然半蹲前傾',exact:true})).toHaveCount(0);
  await picker.getByRole('checkbox',{name:'我的跪蹲姿勢',exact:true}).check();
  await groups.getByRole('button',{name:'坐姿',exact:true}).click();await expect(picker.getByRole('checkbox',{name:'我的跪蹲姿勢',exact:true})).toHaveCount(0);
  await picker.getByRole('checkbox',{name:'側坐回眸',exact:true}).check();
  await groups.getByRole('button',{name:'全部分類',exact:true}).click();
  await expect(picker.getByRole('checkbox',{name:'我的跪蹲姿勢',exact:true})).toBeChecked();await expect(picker.getByRole('checkbox',{name:'側坐回眸',exact:true})).toBeChecked();
  await expect(picker.getByRole('checkbox',{name:'坐姿手持相機',exact:true})).not.toBeChecked();assert.equal(shoots.length,0);
  await picker.getByRole('button',{name:'套用動作候選',exact:true}).click();await expect(page.getByRole('button',{name:'設定動作候選',exact:true})).toContainText('已選 2 個');
});

test('候選能按官方、本人收藏與本次加入篩選，切換來源不清除隱藏的勾選',async t=>{
  const {page,base,shoots}=await fixture(t);
  assert.equal((await page.request.post(base+'/api/studio/prompts',{data:{field:'clothing',name:'收藏風衣',prompt:'A tan trench coat with dark trousers.'}})).status(),201);
  await page.reload();await page.getByRole('button',{name:'自定義',exact:true}).click();await page.getByRole('button',{name:'設定服裝候選',exact:true}).click();
  const picker=page.getByRole('dialog',{name:'選擇服裝候選',exact:true});await picker.getByRole('button',{name:'加入臨時提詞',exact:true}).click();
  await picker.getByRole('textbox',{name:'服裝臨時提詞名稱',exact:true}).fill('本次棕色裙裝');await picker.getByRole('textbox',{name:'臨時服裝提詞',exact:true}).fill('A brown pleated dress.');
  await picker.getByRole('button',{name:'加入本次候選',exact:true}).click();
  const sources=picker.getByRole('group',{name:'服裝來源',exact:true});await expect(sources).toBeVisible();
  await sources.getByRole('button',{name:'我的提詞',exact:true}).click();
  await expect(picker.getByRole('checkbox',{name:'黑色外套',exact:true})).toHaveCount(0);await expect(picker.getByRole('checkbox',{name:'本次棕色裙裝',exact:true})).toHaveCount(0);
  await picker.getByRole('checkbox',{name:'收藏風衣',exact:true}).check();
  await sources.getByRole('button',{name:'官方選項',exact:true}).click();await picker.getByRole('checkbox',{name:'黑色外套',exact:true}).check();
  await sources.getByRole('button',{name:'本次加入',exact:true}).click();await expect(picker.getByRole('checkbox',{name:'本次棕色裙裝',exact:true})).toBeChecked();await picker.getByRole('checkbox',{name:'本次棕色裙裝',exact:true}).uncheck();
  await sources.getByRole('button',{name:'全部來源',exact:true}).click();
  await expect(picker.getByRole('checkbox',{name:'收藏風衣',exact:true})).toBeChecked();await expect(picker.getByRole('checkbox',{name:'黑色外套',exact:true})).toBeChecked();
  await expect(picker.getByRole('checkbox',{name:'本次棕色裙裝',exact:true})).not.toBeChecked();assert.equal(shoots.length,0);
  await picker.getByRole('button',{name:'套用服裝候選',exact:true}).click();await expect(page.getByRole('button',{name:'設定服裝候選',exact:true})).toContainText('已選 2 個');
});

test('服裝可依圖片版與提詞版篩選，官方服裝、本人服裝與文字收藏的勾選跨版本保留',async t=>{
  const {page,base}=await fixture(t);
  assert.equal((await page.request.post(base+'/api/studio/prompts',{data:{field:'clothing',name:'收藏毛衣',prompt:'A soft blue knitted sweater.'}})).status(),201);
  const upload=await page.request.post(base+'/api/studio/garments',{multipart:{image:{name:'my-jacket.png',mimeType:'image/png',buffer:PNG}}});assert.equal(upload.status(),201);const garment=await upload.json();
  await page.reload();await page.getByRole('button',{name:'自定義',exact:true}).click();await page.getByRole('button',{name:'設定服裝候選',exact:true}).click();
  const picker=page.getByRole('dialog',{name:'選擇服裝候選',exact:true}),versions=picker.getByRole('group',{name:'服裝版本',exact:true});
  await expect(versions).toBeVisible();await versions.getByRole('button',{name:'提詞版',exact:true}).click();
  await expect(picker.getByRole('checkbox',{name:'黑色外套',exact:true})).toHaveCount(0);await expect(picker.getByRole('checkbox',{name:garment.name,exact:true})).toHaveCount(0);
  await picker.getByRole('checkbox',{name:'收藏毛衣',exact:true}).check();
  await versions.getByRole('button',{name:'圖片版',exact:true}).click();await expect(picker.getByRole('checkbox',{name:'收藏毛衣',exact:true})).toHaveCount(0);
  await expect(picker.getByRole('checkbox',{name:'黑色外套',exact:true})).toBeVisible();await picker.getByRole('checkbox',{name:garment.name,exact:true}).check();
  await versions.getByRole('button',{name:'全部版本',exact:true}).click();await expect(picker.getByRole('checkbox',{name:'收藏毛衣',exact:true})).toBeChecked();await expect(picker.getByRole('checkbox',{name:garment.name,exact:true})).toBeChecked();
  await expect(picker.getByRole('checkbox',{name:'黑色外套',exact:true})).not.toBeChecked();
  await picker.getByRole('button',{name:'套用服裝候選',exact:true}).click();await expect(page.getByRole('button',{name:'設定服裝候選',exact:true})).toContainText('已選 2 個');
});

test('全選只加入目前分類、來源與搜尋結果，保留隱藏勾選且重按不重複計數',async t=>{
  const {page,base}=await fixture(t);
  for(const name of ['我的跪姿一','我的跪姿二','我的坐姿']) assert.equal((await page.request.post(base+'/api/studio/prompts',{data:{field:'pose',name,prompt:`A natural portrait pose: ${name}.`}})).status(),201);
  await page.reload();await page.getByRole('button',{name:'自定義',exact:true}).click();await page.getByRole('button',{name:'設定動作候選',exact:true}).click();
  const picker=page.getByRole('dialog',{name:'選擇動作候選',exact:true});await picker.getByRole('checkbox',{name:'我的坐姿',exact:true}).check();
  await picker.getByRole('group',{name:'動作來源',exact:true}).getByRole('button',{name:'我的提詞',exact:true}).click();
  await picker.getByRole('group',{name:'動作分類',exact:true}).getByRole('button',{name:'跪蹲',exact:true}).click();await picker.getByRole('textbox',{name:'搜尋動作選項',exact:true}).fill('一');
  const selectAll=picker.getByRole('button',{name:'全選',exact:true});await expect(selectAll).toBeVisible();await selectAll.click();await selectAll.click();
  await expect(picker.locator('footer')).toContainText('已選 2 個');await expect(picker.getByRole('checkbox',{name:'我的跪姿一',exact:true})).toBeChecked();
  await picker.getByRole('button',{name:'清除搜尋',exact:true}).click();await selectAll.click();await expect(picker.locator('footer')).toContainText('已選 3 個');
  await picker.getByRole('group',{name:'動作分類',exact:true}).getByRole('button',{name:'全部分類',exact:true}).click();await picker.getByRole('group',{name:'動作來源',exact:true}).getByRole('button',{name:'全部來源',exact:true}).click();
  for(const name of ['我的跪姿一','我的跪姿二','我的坐姿']) await expect(picker.getByRole('checkbox',{name,exact:true})).toBeChecked();
  await expect(picker.getByRole('checkbox',{name:'側坐回眸',exact:true})).not.toBeChecked();
  await picker.getByRole('button',{name:'套用動作候選',exact:true}).click();await expect(page.getByRole('button',{name:'設定動作候選',exact:true})).toContainText('已選 3 個');
});

test('全取消只清除目前顯示的勾選，取消全部後不加入分類提詞且收藏與臨時來源仍保留',async t=>{
  const {page,base}=await fixture(t);
  for(const name of ['我的跪姿一','我的跪姿二','我的坐姿']) assert.equal((await page.request.post(base+'/api/studio/prompts',{data:{field:'pose',name,prompt:`A natural portrait pose: ${name}.`}})).status(),201);
  await page.reload();await page.getByRole('button',{name:'自定義',exact:true}).click();await page.getByRole('button',{name:'設定動作候選',exact:true}).click();
  const picker=page.getByRole('dialog',{name:'選擇動作候選',exact:true});await picker.getByRole('button',{name:'加入臨時提詞',exact:true}).click();
  await picker.getByRole('textbox',{name:'動作臨時提詞名稱',exact:true}).fill('本次坐姿');await picker.getByRole('textbox',{name:'臨時動作提詞',exact:true}).fill('Sit on a low stool.');await picker.getByRole('button',{name:'加入本次候選',exact:true}).click();
  await picker.getByRole('button',{name:'全選',exact:true}).click();await expect(picker.locator('footer')).toContainText('已選 5 個');
  await picker.getByRole('group',{name:'動作分類',exact:true}).getByRole('button',{name:'跪蹲',exact:true}).click();await picker.getByRole('textbox',{name:'搜尋動作選項',exact:true}).fill('一');
  const cancelAll=picker.getByRole('button',{name:'全取消',exact:true});await expect(cancelAll).toBeVisible();await cancelAll.click();
  await picker.getByRole('button',{name:'清除搜尋',exact:true}).click();await picker.getByRole('group',{name:'動作分類',exact:true}).getByRole('button',{name:'全部分類',exact:true}).click();
  await expect(picker.getByRole('checkbox',{name:'我的跪姿一',exact:true})).not.toBeChecked();
  for(const name of ['我的跪姿二','我的坐姿','本次坐姿','側坐回眸']) await expect(picker.getByRole('checkbox',{name,exact:true})).toBeChecked();
  await cancelAll.click();await expect(picker.locator('footer')).toContainText('已選 0 個');
  await picker.getByRole('button',{name:'套用動作候選',exact:true}).click();await expect(page.getByRole('button',{name:'設定動作候選',exact:true})).toContainText('未指定，不加入提詞');
  assert.equal((await (await page.request.get(base+'/api/studio/prompts')).json()).length,3);
  await page.getByRole('button',{name:'設定動作候選',exact:true}).click();await expect(picker.getByRole('checkbox',{name:'本次坐姿',exact:true})).toBeVisible();await expect(picker.getByRole('checkbox',{name:'本次坐姿',exact:true})).not.toBeChecked();
});

test('候選超過一百項仍可完整全選並拍攝，照片張數依按鈕選擇而非候選數量',async t=>{
  const {page,base}=await fixture(t);
  for(let index=1;index<=101;index++) assert.equal((await page.request.post(base+'/api/studio/prompts',{data:{field:'pose',name:`收藏坐姿 ${index}`,prompt:`Sit naturally on a chair, portrait variation ${index}.`}})).status(),201);
  await page.reload();await page.getByRole('button',{name:'自定義',exact:true}).click();await page.getByRole('button',{name:'設定動作候選',exact:true}).click();
  const picker=page.getByRole('dialog',{name:'選擇動作候選',exact:true});await picker.getByRole('button',{name:'全選',exact:true}).click();
  await expect(picker.locator('footer')).toContainText('已選 102 個');await picker.getByRole('button',{name:'套用動作候選',exact:true}).click();
  await page.getByRole('button',{name:'選擇角色 角色',exact:true}).click();await page.getByRole('button',{name:'拍攝 1 張',exact:true}).click();
  const response=page.waitForResponse(row=>new URL(row.url()).pathname==='/api/studio/shoots' && row.request().method()==='POST');
  await page.locator('.pc-shoot-button').click();const result=await response;assert.equal(result.status(),202);
  const jobs=(await result.json()).jobs;assert.equal(jobs.length,1);assert(jobs[0].pose==='側坐回眸' || /^收藏坐姿 (?:[1-9]|[1-9]\d|10[01])$/.test(jobs[0].pose));
});

test('場景可用地點分類與其他分類找到本人提詞，手機也能操作全選和全取消',async t=>{
  const {page,base}=await fixture(t);
  for(const [name,prompt] of [['海邊黃昏','A quiet beach at sunset.'],['室內書店','Inside a cozy bookshop.'],['獨特企劃甲','A softly lit abstract portrait setting.']]) assert.equal((await page.request.post(base+'/api/studio/prompts',{data:{field:'scene',name,prompt}})).status(),201);
  await page.reload();await page.getByRole('button',{name:'自定義',exact:true}).click();await page.getByRole('button',{name:'設定場景候選',exact:true}).click();
  const picker=page.getByRole('dialog',{name:'選擇場景候選',exact:true}),groups=picker.getByRole('group',{name:'場景分類',exact:true});
  await groups.getByRole('button',{name:'海邊湖畔',exact:true}).click();await expect(picker.getByRole('checkbox',{name:'室內書店',exact:true})).toHaveCount(0);await picker.getByRole('button',{name:'全選',exact:true}).click();
  await groups.getByRole('button',{name:'其他',exact:true}).click();await picker.getByRole('button',{name:'全選',exact:true}).click();await expect(picker.getByRole('checkbox',{name:'獨特企劃甲',exact:true})).toBeChecked();
  fs.mkdirSync('test-results',{recursive:true});await picker.screenshot({path:'test-results/customer-candidate-filters-desktop.png'});
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await expect(picker.getByRole('button',{name:'全取消',exact:true})).toBeVisible();await picker.getByRole('button',{name:'全取消',exact:true}).click();
  await groups.getByRole('button',{name:'全部分類',exact:true}).click();await expect(picker.getByRole('checkbox',{name:'海邊黃昏',exact:true})).toBeChecked();await expect(picker.getByRole('checkbox',{name:'獨特企劃甲',exact:true})).not.toBeChecked();
  await page.screenshot({path:'test-results/customer-candidate-filters-mobile.png'});
  await picker.getByRole('button',{name:'套用場景候選',exact:true}).click();await expect(page.getByRole('button',{name:'設定場景候選',exact:true})).toContainText('已選 1 個');
});

test('分類與來源交集沒有結果時提示調整篩選，切回全部仍能找到既有候選',async t=>{
  const {page,base}=await fixture(t);
  assert.equal((await page.request.post(base+'/api/studio/prompts',{data:{field:'pose',name:'我的跪姿',prompt:'Kneel beside a low chair.'}})).status(),201);
  await page.reload();await page.getByRole('button',{name:'自定義',exact:true}).click();await page.getByRole('button',{name:'設定動作候選',exact:true}).click();
  const picker=page.getByRole('dialog',{name:'選擇動作候選',exact:true}),sources=picker.getByRole('group',{name:'動作來源',exact:true}),groups=picker.getByRole('group',{name:'動作分類',exact:true});
  await sources.getByRole('button',{name:'官方選項',exact:true}).click();await groups.getByRole('button',{name:'跪蹲',exact:true}).click();
  await expect(picker).toContainText('沒有符合目前篩選的選項。');await expect(picker.getByRole('button',{name:'全選',exact:true})).toBeDisabled();await expect(picker.getByRole('button',{name:'全取消',exact:true})).toBeDisabled();
  await groups.getByRole('button',{name:'全部分類',exact:true}).click();await expect(picker.getByRole('checkbox',{name:'側坐回眸',exact:true})).toBeVisible();
  await sources.getByRole('button',{name:'全部來源',exact:true}).click();await expect(picker.getByRole('checkbox',{name:'我的跪姿',exact:true})).toBeVisible();
});
