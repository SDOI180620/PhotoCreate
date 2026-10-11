import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {chromium,expect} from '@playwright/test';
import {createApp} from '../server/index.js';
import {buildShotPlans,getOutputSize} from '../shared/domain.js';
import {withSingleSubjectPrompt} from '../shared/subject.js';
import {cameraPrompt,cameraAngleLabel,cameraZoomLevel} from '../shared/camera.js';
import {DRAFT,TEMPLATE,PNG,fixtureState} from './fixtures.js';
import {CAMERA_TEMPLATE} from './camera-fixtures.js';
import {loginBrowser} from './auth-client.js';

const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-camera-angle-ui-'));
const submitted=[];
const fetchImpl=async(url,options={})=>{
  const route=new URL(url).pathname;
  if(route==='/view') return new Response(PNG,{headers:{'content-type':'image/png'}});
  if(route==='/upload/image') return Response.json({name:options.body.get('image').name,subfolder:'PhotoCreate'});
  if(route==='/prompt') {const body=JSON.parse(options.body);submitted.push(body);return Response.json({prompt_id:body.prompt_id});}
  if(route==='/queue') return Response.json({queue_running:[],queue_pending:submitted.map(body=>[0,body.prompt_id])});
  if(route==='/userdata') return Response.json([]);
  return Response.json({devices:[{name:'Test GPU'}]});
};
const {app,store,authentication}=createApp({dataDir,fetchImpl});
const customer=await authentication.createCustomer({username:'angle-customer',password:'angle-test-password'});
const accounts=new DatabaseSync(path.join(dataDir,'accounts.sqlite'),{readOnly:true});
const ownerId=accounts.prepare('SELECT owner_id FROM accounts WHERE id=?').get(customer.id).owner_id;accounts.close();
const preset={id:'camera-ui-exact',category:'camera',name:'自訂角度測試',tags:[],prompt:'',angle:{horizontalAngle:225,verticalAngle:31,zoom:7}};
const legacyPreset={id:'camera-ui-legacy-low',category:'camera',name:'舊版仰拍測試',tags:[],prompt:'',angle:{horizontalAngle:90,verticalAngle:-90,zoom:8}};
const cases=[
  {name:'numbers',angle:{horizontalAngle:0,verticalAngle:-9,zoom:10}},
  {name:'preset-then-manual',angle:{horizontalAngle:137,verticalAngle:31,zoom:7}},
  {name:'drag',angle:{horizontalAngle:90,verticalAngle:7,zoom:6.9}},
  {name:'legacy-low-preset',angle:{horizontalAngle:90,verticalAngle:-70,zoom:8}},
];
const fixture=fixtureState();fixture.presets.push(preset,legacyPreset);
const jobs=[];
for(const surface of ['admin','customer']) for(const scenario of cases) {
  const [job]=buildShotPlans(fixture,{...DRAFT,cameraMode:'multiangle',cameraEnabled:false,garmentIds:['garment-a'],poseIds:['pose-standing'],clothingStateIds:['clothing-state-neat'],copies:1});
  Object.assign(job,{id:`${surface}-${scenario.name}`,createdAt:new Date().toISOString(),status:'completed',batchId:'angle-browser',images:[{filename:`${surface}-${scenario.name}.png`,subfolder:'PhotoCreate',type:'output'}],apiPrompt:TEMPLATE,workflowSnapshot:TEMPLATE,cameraWorkflowSnapshot:CAMERA_TEMPLATE,...(surface==='customer' ? {visitorId:ownerId,rootJobId:`${surface}-${scenario.name}`,version:0} : {})});
  jobs.push(job);
}
store.mutate(state=>Object.assign(state,fixture,{workflow:TEMPLATE,cameraWorkflow:CAMERA_TEMPLATE,jobs,batches:[{id:'angle-browser',name:'角度送出測試',createdAt:new Date().toISOString()}]}));
for(const row of [...fixture.characters,...fixture.garments]) fs.writeFileSync(path.join(dataDir,'uploads',row.fileName),process.env.PHOTOCREATE_UI_REFERENCE_IMAGE && fixture.characters.includes(row) ? fs.readFileSync(process.env.PHOTOCREATE_UI_REFERENCE_IMAGE) : PNG);
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const httpHost=process.env.PHOTOCREATE_UI_HTTP==='1' ? os.hostname().toLowerCase() : '';
const base=`http://${httpHost || '127.0.0.1'}:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.PHOTOCREATE_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,...(httpHost ? {args:[`--host-resolver-rules=MAP ${httpHost} 127.0.0.1`,'--no-proxy-server']} : {})});
const fetchRoute=async route=>{
  // Playwright's Node request client does not use Chrome's host resolver rules.
  try {return await route.fetch(httpHost ? {url:route.request().url().replace(httpHost,'127.0.0.1')} : {});}
  catch(error) {throw new Error(error.message.split('Call log:')[0]);}
};
const errors=[];
try {
  for(const surface of ['admin','customer']) {
    const context=await browser.newContext({viewport:{width:1440,height:1080}}),page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    const requests=[],customRequests=[];page.on('request',request=>{if(request.method()!=='POST')return;const pathname=new URL(request.url()).pathname;if(/\/jobs\/[^/]+\/angle$/.test(pathname)) requests.push(request.postDataJSON());if(/\/jobs\/[^/]+\/custom$/.test(pathname)) customRequests.push(request.postDataJSON());});
    await loginBrowser(page,base,...(surface==='customer' ? ['angle-customer','angle-test-password'] : []));
    if(httpHost) assert.equal(await page.evaluate(()=>window.isSecureContext),false,'Camera and custom dialogs must also work over ordinary HTTP');
    if(surface==='admin') await page.getByRole('button',{name:'成果畫廊',exact:true}).click();
    for(let index=0;index<cases.length;index++) {
      const scenario=cases[index];
      if(surface==='admin') await page.locator(`[data-job-id="admin-${scenario.name}"] .gallery-angle`).click();
      else {
        await page.locator('#photos').getByRole('button',{name:'資料夾 全部照片',exact:true}).click();
        await page.locator(`.pc-photo-card:has(img[src*="/jobs/customer-${scenario.name}/image"])`).click();
        await page.getByRole('button',{name:/^不同角度拍攝/}).click();
      }
      const dialog=page.getByRole('dialog',{name:'不同角度拍攝',exact:true});
      await expect(dialog.getByRole('spinbutton',{name:'Zoom',exact:true})).toHaveValue('5');
      await expect(dialog.getByRole('spinbutton',{name:'俯仰角度',exact:true})).toHaveAttribute('min','-70');
      await expect(dialog.getByRole('slider',{name:'俯仰角度滑桿',exact:true})).toHaveAttribute('min','-70');
      await expect(dialog.getByRole('slider',{name:'拖球調俯仰角度',exact:true})).toHaveAttribute('aria-valuemin','-70');
      await dialog.locator('.camera-orbit').evaluate(async element=>{await Promise.all(element.getAnimations({subtree:true}).filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})));});
      await page.locator(surface==='admin' ? '.modal-backdrop' : '.pc-dialog-backdrop').evaluate(async element=>{await Promise.all(element.getAnimations({subtree:true}).filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})));});
      if(scenario.name==='legacy-low-preset') {
        await dialog.getByRole('combobox',{name:'套用已存角度',exact:true}).selectOption(legacyPreset.id);
      } else if(scenario.name==='preset-then-manual') {
        await dialog.getByRole('combobox',{name:'套用已存角度',exact:true}).selectOption(preset.id);
        await dialog.getByRole('spinbutton',{name:'水平角度',exact:true}).fill(String(scenario.angle.horizontalAngle));
      } else if(scenario.name==='drag') {
        const ball=await dialog.getByRole('slider',{name:'拖球調水平角度',exact:true}).boundingBox();
        const target=await dialog.locator('.camera-orbit').evaluate(svg=>{const rx=2.1*Math.cos(28*Math.PI/180),rz=-2.1*Math.sin(28*Math.PI/180);const point=new DOMPoint(240+rx*56,160-(-0.8*Math.cos(25*Math.PI/180)-rz*Math.sin(25*Math.PI/180))*56).matrixTransform(svg.getScreenCTM());return {x:point.x,y:point.y};});
        await page.mouse.move(ball.x+ball.width/2,ball.y+ball.height/2);await page.mouse.down();await page.mouse.move(target.x,target.y,{steps:8});await page.mouse.up();
        await dialog.getByRole('spinbutton',{name:'俯仰角度',exact:true}).fill(String(scenario.angle.verticalAngle));
        await dialog.getByRole('spinbutton',{name:'Zoom',exact:true}).fill(String(scenario.angle.zoom));
      } else {
        for(const [label,key] of [['水平角度','horizontalAngle'],['俯仰角度','verticalAngle'],['Zoom','zoom']]) await dialog.getByRole('spinbutton',{name:label,exact:true}).fill(String(scenario.angle[key]));
      }
      await expect(dialog.getByRole('combobox',{name:'套用已存角度',exact:true})).toHaveValue(scenario.name==='legacy-low-preset' ? legacyPreset.id : '');
      for(const [label,key] of [['水平角度','horizontalAngle'],['俯仰角度','verticalAngle'],['Zoom','zoom']]) await expect(dialog.getByRole('spinbutton',{name:label,exact:true})).toHaveValue(String(scenario.angle[key]));
      await expect(dialog.getByRole('status')).toContainText(cameraAngleLabel(scenario.angle));
      await expect(dialog.getByRole('combobox',{name:'Zoom快捷選擇',exact:true})).toHaveValue(String(cameraZoomLevel(scenario.angle).value));
      await expect(dialog.locator('.camera-framing-label')).toContainText(cameraZoomLevel(scenario.angle).label);
      await expect(dialog.locator('.camera-zoom-note')).toHaveCount(0);
      if(surface==='admin') await dialog.getByRole('checkbox',{name:'完成後刪除被替換的舊成果',exact:true}).uncheck();
      await dialog.getByRole('button',{name:'拍攝這個角度',exact:true}).click();
      await expect.poll(()=>store.read().jobs.filter(job=>job.jobKind==='angle-edit' && job.sourceJobId===`${surface}-${scenario.name}`).length).toBe(1);
      assert.deepEqual(requests.at(-1).angle,scenario.angle,`${surface}/${scenario.name}: browser request angle`);
      const saved=store.read().jobs.find(job=>job.jobKind==='angle-edit' && job.sourceJobId===`${surface}-${scenario.name}`);
      assert.deepEqual(saved.camera.angle,scenario.angle,`${surface}/${scenario.name}: saved camera angle`);
      await expect.poll(()=>submitted.some(body=>Object.values(body.prompt).some(node=>node._meta?.cameraAngle?.horizontalAngle===scenario.angle.horizontalAngle))).toBe(true);
      const prompt=submitted.findLast(body=>Object.values(body.prompt).some(node=>node._meta?.cameraAngle?.horizontalAngle===scenario.angle.horizontalAngle))?.prompt;
      const encoder=Object.values(prompt).find(node=>node._meta?.cameraAngle);
      assert.deepEqual(encoder._meta.cameraAngle,scenario.angle,`${surface}/${scenario.name}: ComfyUI camera angle`);
      assert.equal(encoder.inputs.prompt,withSingleSubjectPrompt(cameraPrompt(scenario.angle)),`${surface}/${scenario.name}: ComfyUI conditioning`);
      assert.equal(Object.values(prompt).some(node=>node.class_type==='ImageCrop'),false,'Camera output was cropped');
      console.log(`${surface}/${scenario.name}: UI → request → saved job → ComfyUI = ${JSON.stringify(scenario.angle)}`);
      store.mutate(state=>{state.jobs=state.jobs.filter(job=>job.id!==saved.id);state.pipelineRuns=[];});submitted.length=0;
      await page.reload();
      if(surface==='admin') await page.getByRole('button',{name:'成果畫廊',exact:true}).click();
    }
    store.mutate(state=>{
      state.customerRecipe.pools.garment=state.customerRecipe.pools.garment.filter(row=>row.id==='garment-b');
      for(const [key,id] of [['pose','pose-sitting'],['expression','expression-calm'],['clothingState','clothing-state-breeze'],['interaction','interaction-window'],['lighting','light-golden'],['color','color-film'],['quality','quality-candid']]) state.customerRecipe.pools[key]=[structuredClone(state.presets.find(row=>row.id===id))];
    });
    await page.reload();
    if(surface==='admin') await page.getByRole('button',{name:'成果畫廊',exact:true}).click();
    for(const kind of ['original','text','reference','pose','clothing-reference','clothing-state','maid-text']) {
      const usesTextClothing=['text','maid-text'].includes(kind);
      if(surface==='admin') await page.locator('[data-job-id="admin-numbers"] .gallery-custom').click();
      else {
        await page.locator('#photos').getByRole('button',{name:'資料夾 全部照片',exact:true}).click();
        await page.locator('.pc-photo-card:has(img[src*="/jobs/customer-numbers/image"])').click();
        if(kind==='original') {
          const settings=page.getByRole('region',{name:'本張使用的提詞',exact:true});
          await expect(settings).toContainText('白色洋裝');await expect(settings).toContainText('整齊穿著');await expect(settings).toContainText('柔和窗光');
        }
        await page.getByRole('button',{name:/^自訂拍攝/}).click();
      }
      const dialog=page.getByRole('dialog',{name:'自訂拍攝',exact:true});
      await expect(dialog.getByRole('img',{name:'拍攝時選取的角色參考圖',exact:true})).toHaveAttribute('src',`/api/${surface==='customer' ? 'studio/' : ''}jobs/${surface}-numbers/character-reference`);
      const originals=['動作','服裝','服裝狀態','場景','表情','光線','色彩','畫質'].map(label=>dialog.getByRole('checkbox',{name:`${label}沿用原設定`,exact:true}));
      for(const checkbox of originals) await expect(checkbox).toBeChecked();
      await expect(dialog.locator('.photo-change-option').nth(1)).toContainText('白色洋裝');
      await expect(dialog.locator('.photo-change-option').nth(2)).toContainText('整齊穿著');
      await expect(dialog.locator('.photo-change-option').nth(5)).toContainText('柔和窗光');
      await expect(dialog.getByRole('region',{name:'其他沿用提詞',exact:true})).toContainText('角色');
      await expect(dialog.getByRole('button',{name:'沿用上一張',exact:true})).toHaveAttribute('aria-pressed','true');
      await expect(dialog.locator('.camera-control')).toHaveCount(0);
      await expect(dialog.getByRole('textbox',{name:'自訂動作',exact:true})).toHaveCount(0);
      for(const checkbox of originals) await checkbox.uncheck();
      for(const [label,value] of [['自訂動作','雙手扶腰'],['自訂場景','夕陽下的海邊'],['自訂表情','微笑'],['自訂服裝','紅色長袖洋裝'],['自訂服裝狀態','衣物整齊穿著，袖口捲起'],['自訂光線','柔和日落光'],['自訂色彩','低飽和暖色調'],['自訂畫質','清晰布料細節']]) await dialog.getByRole('textbox',{name:label,exact:true}).fill(value);
      if(kind==='maid-text') {
        for(const [index,checkbox] of originals.entries()) if(index!==1) await checkbox.check();
        const clothing=dialog.getByRole('textbox',{name:'自訂服裝',exact:true});
        await clothing.fill('穿一件女僕裝');
        await expect(dialog.locator('.photo-resolved-clothing')).toContainText('黑色長袖');
        await dialog.getByRole('button',{name:'編輯這段服裝描述',exact:true}).click();
        await expect(clothing).toHaveValue(/黑色長袖/);
        await clothing.fill('藍色長袖女僕裝與米白色圍裙');
        await expect(dialog.locator('.photo-resolved-clothing')).toHaveCount(0);
        await clothing.fill('穿一件女僕裝');
        await dialog.screenshot({path:path.resolve(`test-results/custom-photo-${surface}-maid-text.png`)});
      }
      if(kind==='reference' || kind==='clothing-reference') {
        await dialog.getByRole('button',{name:'選擇服裝圖',exact:true}).click();
        await expect(dialog.locator('.photo-garment-picker button')).toHaveCount(surface==='admin' ? 2 : 1);
        await expect(dialog.getByRole('button',{name:'開始自訂拍攝',exact:true})).toBeDisabled();
        await dialog.getByRole('button',{name:'選擇服裝 黑色外套',exact:true}).click();
        if(kind==='clothing-reference') for(const [index,checkbox] of originals.entries()) if(index!==1) await checkbox.check();
      } else if(kind==='original' || kind==='pose' || kind==='clothing-state') {
        for(const [index,checkbox] of originals.entries()) if(kind==='original' || index!==(kind==='pose' ? 0 : 2)) await checkbox.check();
        await expect(dialog.getByRole('textbox',{name:'自訂服裝',exact:true})).toHaveCount(0);
        if(kind==='pose') {
          await expect(dialog.getByRole('textbox',{name:'自訂動作',exact:true})).toBeVisible();
          await dialog.screenshot({path:path.resolve(`test-results/custom-photo-${surface}-pose-only.png`)});
        }
        if(kind==='clothing-state') {
          await expect(dialog.getByRole('textbox',{name:'自訂服裝狀態',exact:true})).toBeVisible();
          await expect(dialog.getByRole('textbox',{name:'自訂動作',exact:true})).toHaveCount(0);
          await dialog.screenshot({path:path.resolve(`test-results/custom-photo-${surface}-clothing-state.png`)});
        }
      }
      if(kind==='text') {
        await page.setViewportSize({width:390,height:844});
        await dialog.getByRole('button',{name:'開始自訂拍攝',exact:true}).scrollIntoViewIfNeeded();
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        await dialog.screenshot({path:path.resolve(`test-results/custom-photo-${surface}-mobile.png`)});
        await page.setViewportSize({width:1440,height:1080});
        await dialog.screenshot({path:path.resolve(`test-results/custom-photo-${surface}-desktop.png`)});
      }
      await dialog.getByRole('button',{name:'開始自訂拍攝',exact:true}).click();
      await expect.poll(()=>store.read().jobs.some(job=>job.jobKind==='photo-edit' && job.sourceJobId===`${surface}-numbers`)).toBe(true);
      const saved=store.read().jobs.find(job=>job.jobKind==='photo-edit' && job.sourceJobId===`${surface}-numbers`);
      await expect.poll(()=>submitted.some(body=>Object.values(body.prompt).some(node=>node.class_type==='TextEncodeQwenImage21'))).toBe(true);
      const prompt=submitted.at(-1).prompt,encoder=Object.values(prompt).find(node=>node.class_type==='TextEncodeQwenImage21');
      assert.equal(saved.photoCustomization.preserveOriginal,kind==='original');assert.equal(saved.cameraEnabled,false);assert.equal(saved.deleteSourceOnComplete,false);
      assert.equal(Object.values(prompt).filter(node=>node.class_type==='LoadImage').length,usesTextClothing ? 1 : 2);
      assert.match(prompt[encoder.inputs['images.image_1'][0]].inputs.image,/character\.png$/);
      assert.equal(Object.values(prompt).some(node=>node._meta?.cameraAngle),false);
      if(kind==='text') {assert.match(encoder.inputs.prompt,/wear: 紅色長袖洋裝/);assert.match(encoder.inputs.prompt,/Replace the entire outfit shown in <image1>/);assert.ok(!encoder.inputs.prompt.includes('<image2>'));assert.match(encoder.inputs.prompt,/Lighting: 柔和日落光/);assert.match(encoder.inputs.prompt,/Color treatment: 低飽和暖色調/);assert.match(encoder.inputs.prompt,/Photographic quality: 清晰布料細節/);}
      if(kind==='maid-text') {
        assert.deepEqual(saved.photoCustomization.changes,{clothing:'穿一件女僕裝'});
        assert.equal(saved.garment.input,'穿一件女僕裝');assert.match(saved.garment.description,/黑色長袖、及膝的女僕洋裝/);
        assert.ok(encoder.inputs.prompt.includes(saved.garment.description));assert.ok(!encoder.inputs.prompt.includes('<image2>'));
        const original=store.read().jobs.find(job=>job.id===`${surface}-numbers`);
        for(const key of ['pose','clothingState','interaction','expression']) assert.deepEqual(saved[key],original[key]);
      }
      if(kind==='reference' || kind==='clothing-reference') {assert.match(prompt[encoder.inputs['images.image_2'][0]].inputs.image,/garment-b\.png$/);assert.ok(!encoder.inputs.prompt.includes('紅色長袖洋裝'));}
      if(kind==='clothing-reference') {
        const original=store.read().jobs.find(job=>job.id===`${surface}-numbers`);
        assert.equal(saved.prompt,original.prompt,'Only garment image2 changes; the entire saved prompt is resent');
        assert.deepEqual(saved.photoCustomization.changes,{});
        for(const key of ['pose','clothingState','interaction','expression']) assert.deepEqual(saved[key],original[key]);
      }
      if(kind==='original') {assert.ok(!encoder.inputs.prompt.includes('雙手扶腰'));assert.ok(!encoder.inputs.prompt.includes('紅色長袖洋裝'));assert.ok(!encoder.inputs.prompt.includes('衣物整齊穿著，袖口捲起'));}
      if(kind==='pose') {
        assert.deepEqual(saved.photoCustomization.changes,{pose:'雙手扶腰'});
        assert.match(encoder.inputs.prompt,/Pose and action: 雙手扶腰/);
        for(const text of ['紅色長袖洋裝','夕陽下的海邊','Facial expression: 微笑','衣物整齊穿著，袖口捲起']) assert.ok(!encoder.inputs.prompt.includes(text));
        const original=store.read().jobs.find(job=>job.id===`${surface}-numbers`);
        for(const key of ['garment','clothingState','interaction','expression']) assert.deepEqual(saved[key],original[key]);
      }
      if(kind==='clothing-state') {
        const original=store.read().jobs.find(job=>job.id===`${surface}-numbers`);
        assert.deepEqual(saved.photoCustomization.changes,{clothingState:'衣物整齊穿著，袖口捲起'});
        assert.equal(saved.prompt,original.prompt.replace(`Clothing state: ${original.clothingState.prompt}`,'Clothing state: 衣物整齊穿著，袖口捲起'));
        for(const key of ['garment','pose','interaction','expression']) assert.deepEqual(saved[key],original[key]);
      }
      store.mutate(state=>{state.jobs=state.jobs.filter(job=>job.id!==saved.id);state.pipelineRuns=[];});submitted.length=0;
      await page.reload();if(surface==='admin') await page.getByRole('button',{name:'成果畫廊',exact:true}).click();
      console.log(`${surface}/custom-${kind}: separate dialog → saved settings → role image1, ${usesTextClothing ? 'wear text without image2' : 'garment image2'}, original photo retained`);
    }
    const officialFields=[['動作','pose','pose-sitting'],['服裝狀態','clothingState','clothing-state-breeze'],['場景','scene','interaction-window'],['表情','expression','expression-calm'],['光線','lighting','light-golden'],['色彩','color','color-film'],['畫質','quality','quality-candid']];
    for(const [name,aspectRatio,official] of [['official-portrait','9:16',true],['square','1:1',false],['landscape','16:9',false]]) {
      if(surface==='admin') await page.locator('[data-job-id="admin-numbers"] .gallery-custom').click();
      else {await page.locator('#photos').getByRole('button',{name:'資料夾 全部照片',exact:true}).click();await page.locator('.pc-photo-card:has(img[src*="/jobs/customer-numbers/image"])').click();await page.getByRole('button',{name:/^自訂拍攝/}).click();}
      const dialog=page.getByRole('dialog',{name:'自訂拍攝',exact:true}),original=store.read().jobs.find(job=>job.id===`${surface}-numbers`);
      if(official) {
        for(const [label,,id] of officialFields) {
          await dialog.getByRole('checkbox',{name:`${label}沿用原設定`,exact:true}).uncheck();
          await dialog.getByRole('group',{name:`${label}設定方式`,exact:true}).getByRole('button',{name:'官方選項',exact:true}).click();
          const select=dialog.getByRole('combobox',{name:`${label}官方選項`,exact:true});
          await expect(dialog.getByRole('button',{name:'開始自訂拍攝',exact:true})).toBeDisabled();
          if(surface==='customer') await expect(select.locator('option')).toHaveCount(2);
          await select.selectOption(id);
          await expect(dialog.getByRole('textbox',{name:`自訂${label}`,exact:true})).toHaveCount(0);
        }
        if(surface==='customer') {
          await page.route('**/api/studio/state',async route=>{const response=await fetchRoute(route),body=await response.json();body.presets=body.presets.filter(row=>row.id!=='expression-calm');await route.fulfill({response,json:body});});
          await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
          const expression=dialog.getByRole('combobox',{name:'表情官方選項',exact:true});
          await expect(expression).toHaveValue('');await expect(expression).toBeDisabled();
          await expect(dialog.getByRole('button',{name:'開始自訂拍攝',exact:true})).toBeDisabled();
          await page.unroute('**/api/studio/state');await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
          await expect(expression).toBeEnabled();await expect(expression).toHaveValue('');
          await expression.selectOption('expression-calm');
        }
      }
      await dialog.getByRole('button',{name:{'9:16':'直式 9:16','1:1':'方形 1:1','16:9':'橫式 16:9'}[aspectRatio],exact:true}).click();
      if(official) {
        await dialog.locator('.photo-ratio-choice').scrollIntoViewIfNeeded();
        await dialog.screenshot({path:path.resolve(`test-results/custom-photo-${surface}-official-desktop.png`)});
        await page.setViewportSize({width:390,height:844});await dialog.locator('.photo-ratio-choice').scrollIntoViewIfNeeded();
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
        await dialog.screenshot({path:path.resolve(`test-results/custom-photo-${surface}-official-mobile.png`)});
        await page.setViewportSize({width:1440,height:1080});
      }
      await dialog.getByRole('button',{name:'開始自訂拍攝',exact:true}).click();
      await expect.poll(()=>store.read().jobs.some(job=>job.jobKind==='photo-edit' && job.sourceJobId===original.id)).toBe(true);
      const saved=store.read().jobs.find(job=>job.jobKind==='photo-edit' && job.sourceJobId===original.id),size=getOutputSize(aspectRatio,original.resolution);
      await expect.poll(()=>submitted.some(body=>Object.values(body.prompt).some(node=>node.class_type==='TextEncodeQwenImage21'))).toBe(true);
      const graph=submitted.at(-1).prompt,encoder=Object.values(graph).find(node=>node.class_type==='TextEncodeQwenImage21'),latent=Object.values(graph).find(node=>node.class_type==='LatentUpscale');
      assert.equal(saved.aspectRatio,aspectRatio);assert.equal(saved.outputWidth,size.width);assert.equal(saved.outputHeight,size.height);
      assert.equal(latent.inputs.width,size.width/2);assert.equal(latent.inputs.height,size.height/2);
      assert.equal(saved.photoCustomization.preserveOriginal,!official);assert.deepEqual(saved.photoCustomization.changes,{});
      assert.equal(encoder.inputs.prompt,saved.prompt);assert.match(graph[encoder.inputs['images.image_1'][0]].inputs.image,/character\.png$/);
      assert.match(graph[encoder.inputs['images.image_2'][0]].inputs.image,/garment-a\.png$/);
      assert.deepEqual(saved.garment,original.garment);assert.equal(Object.values(graph).some(node=>node._meta?.cameraAngle),false);
      if(official) for(const [,key,id] of officialFields) {
        const row=store.read().presets.find(row=>row.id===id);
        assert.deepEqual(saved[key==='scene' ? 'interaction' : key],row);assert.ok(saved.prompt.includes(row.prompt));
      } else assert.equal(saved.prompt,original.prompt);
      store.mutate(state=>{state.jobs=state.jobs.filter(job=>job.id!==saved.id);state.pipelineRuns=[];});submitted.length=0;
      await page.reload();if(surface==='admin') await page.getByRole('button',{name:'成果畫廊',exact:true}).click();
      console.log(`${surface}/custom-${name}: published presets → complete saved prompt → original role image1; output ${size.width} × ${size.height}`);
    }
    assert.equal(customRequests.length,10);
    const stateRoute=surface==='admin' ? '**/api/state' : '**/api/studio/state';
    await page.route(stateRoute,async route=>{
      const response=await fetchRoute(route),body=await response.json();
      if(surface==='admin') {body.features.cameraFraming=true;body.features.photoCustomization=3;}
      else {body.cameraFraming=true;body.photoCustomization=3;}
      await route.fulfill({response,json:body});
    });
    await page.reload();
    if(surface==='admin') {
      await page.getByRole('button',{name:'成果畫廊',exact:true}).click();
      await page.locator('[data-job-id="admin-numbers"] .gallery-angle').click();
    } else {
      await page.locator('#photos').getByRole('button',{name:'資料夾 全部照片',exact:true}).click();
      await page.locator('.pc-photo-card:has(img[src*="/jobs/customer-numbers/image"])').click();
      await page.getByRole('button',{name:/^不同角度拍攝/}).click();
    }
    const outdatedDialog=page.getByRole('dialog',{name:'不同角度拍攝',exact:true});
    await expect(outdatedDialog.getByRole('alert')).toContainText('重新啟動 PhotoCreate');
    await expect(outdatedDialog.getByRole('button',{name:'拍攝這個角度',exact:true})).toBeDisabled();
    assert.equal(requests.length,cases.length,'Outdated backend accepted another camera request');
    if(surface==='admin') {
      await page.keyboard.press('Escape');
      await page.locator('[data-job-id="admin-numbers"] .gallery-custom').click();
    } else {
      await outdatedDialog.getByRole('button',{name:'返回照片',exact:true}).click();
      await page.getByRole('button',{name:/^自訂拍攝/}).click();
    }
    const outdatedCustom=page.getByRole('dialog',{name:'自訂拍攝',exact:true});
    await expect(outdatedCustom.getByRole('alert')).toContainText('重新啟動 PhotoCreate');
    await expect(outdatedCustom.getByRole('button',{name:'開始自訂拍攝',exact:true})).toBeDisabled();
    assert.equal(customRequests.length,10,'Outdated backend accepted preset or aspect-ratio customization');
    await page.unroute(stateRoute);await page.reload();
    console.log(`${surface}: old backend requires restart before submitting new camera settings`);
    if(surface==='customer') {
      store.mutate(state=>{
        state.jobs=state.jobs.filter(job=>job.id!=='customer-legacy-low-preset');
        state.photoFolders=[{id:'trash-folder',name:'回收區分類測試',ownerId,createdAt:new Date().toISOString()}];
        for(const job of state.jobs.filter(job=>job.visitorId===ownerId)) {job.visitorDeletedAt=new Date().toISOString();job.folderId=job.id==='customer-drag' ? '' : 'trash-folder';}
        const original=state.jobs.find(job=>job.id==='customer-numbers');
        state.jobs.push({...structuredClone(original),id:'customer-numbers-version',rootJobId:original.id,sourceJobId:original.id,remakeVersion:1});
      });
      await page.reload();await page.getByRole('button',{name:'回收區',exact:true}).click();
      await page.locator('#photos').getByRole('button',{name:'資料夾 全部照片',exact:true}).click();
      await expect(page.locator('.pc-trash-card')).toHaveCount(3);
      await page.getByRole('button',{name:'全選回收區照片',exact:true}).click();
      await expect(page.locator('.pc-trash-card input:checked')).toHaveCount(3);
      await page.getByRole('button',{name:'永久刪除所選',exact:true}).click();
      await expect(page.getByRole('dialog')).toContainText('永久刪除 3 張照片？');
      await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
      await page.getByRole('button',{name:'取消全選回收區照片',exact:true}).click();
      await expect(page.locator('.pc-trash-card input:checked')).toHaveCount(0);
      await page.getByRole('button',{name:/回收區分類測試/}).click();
      await expect(page.locator('.pc-trash-card')).toHaveCount(2);
      await page.getByRole('button',{name:'全選回收區照片',exact:true}).click();
      await expect(page.locator('.pc-trash-card input:checked')).toHaveCount(2);
      await expect(page.locator('.photo-folder-move')).toContainText('已選 2 張');
      await page.setViewportSize({width:390,height:844});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Mobile trash selection overflows');
      fs.mkdirSync(path.resolve('test-results'),{recursive:true});
      await page.locator('.pc-photos').screenshot({path:path.resolve('test-results/trash-select-all-mobile.png'),animations:'disabled'});
      assert.equal(store.read().jobs.filter(job=>job.visitorId===ownerId).length,4,'Selection or cancelling deleted a photo');
      console.log('trash: select all and cancel, version grouping, confirmation count, folder filtering, mobile layout, no deletion');
    }
    await page.unrouteAll({behavior:'wait'});await context.close();
  }
  assert.deepEqual(errors,[]);
} finally {
  await browser.close();await new Promise(resolve=>server.close(resolve));store.close();
  if(path.dirname(fs.realpathSync(dataDir))!==fs.realpathSync(os.tmpdir())) throw new Error('Unexpected temporary directory');
  fs.rmSync(dataDir,{recursive:true,force:true});
}
