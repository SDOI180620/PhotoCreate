import {chromium,expect} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {createApp} from '../server/index.js';
import {PNG,TEMPLATE,fixtureState} from './fixtures.js';
import {CAMERA_TEMPLATE} from './camera-fixtures.js';

const errors=[],dirs=[],servers=[],instances=[];
const mockFetch=async url=>new URL(url).pathname==='/userdata' ? Response.json([]) : Response.json({devices:[{name:'Test GPU'}]});
function makeStudio(seed=false) {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'photocreate-transfer-browser-'));dirs.push(dataDir);
  const instance=createApp({dataDir,fetchImpl:mockFetch});instances.push(instance);
  instance.store.mutate(state=> {
    state.workflow=structuredClone(TEMPLATE);state.cameraWorkflow=structuredClone(CAMERA_TEMPLATE);
    if(seed) {
      Object.assign(state,fixtureState());state.scenes=[];
      state.presets.push({id:'angle-enhanced',category:'camera',name:'肩後細節',prompt:'camera',tags:['測試'],angle:{horizontalAngle:133,verticalAngle:-90,zoom:10},mappingVersion:2,mappingSource:'manual'});
      state.draft={characterId:'character',garmentIds:['garment-a'],poseIds:['pose-standing'],cameraIds:['angle-enhanced'],steps:47,angleSteps:22,refineDenoise:0.25,resolution:2048,aspectRatio:'16:9'};
      for(const row of [...state.characters,...state.garments]) fs.writeFileSync(path.join(dataDir,'uploads',row.fileName),PNG);
    }
  });
  const server=instance.app.listen(0,'127.0.0.1');servers.push(server);return {instance,server};
}
const source=makeStudio(true),target=makeStudio();
await Promise.all(servers.map(server=>new Promise(resolve=>server.once('listening',resolve))));
const browser=await chromium.launch({executablePath:process.env.PHOTOCREATE_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--disable-gpu']});
const page=await browser.newPage({viewport:{width:1440,height:1080},acceptDownloads:true});page.on('pageerror',error=>errors.push(error.message));
fs.mkdirSync('test-results',{recursive:true});
try {
  await page.goto(`http://127.0.0.1:${source.server.address().port}`);
  await page.getByRole('spinbutton',{name:'採樣步數',exact:true}).fill('53');
  await page.getByRole('button',{name:'工作流與連線設定',exact:true}).click();
  await page.getByRole('tab',{name:'資料搬移',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await expect(dialog.getByRole('button',{name:'匯出 ZIP',exact:true})).toBeVisible();
  const downloadPromise=page.waitForEvent('download');await dialog.getByRole('button',{name:'匯出 ZIP',exact:true}).click();
  const download=await downloadPromise,file=path.resolve('test-results/transfer-browser.zip');await download.saveAs(file);
  assert.match(download.suggestedFilename(),/^PhotoCreate-data-.*\.zip$/);
  const url=`http://127.0.0.1:${target.server.address().port}`;
  await page.goto(url);await page.getByRole('button',{name:'工作流與連線設定',exact:true}).click();await page.getByRole('tab',{name:'資料搬移',exact:true}).click();
  await dialog.getByLabel('資料 ZIP',{exact:true}).setInputFiles({name:'bad.zip',mimeType:'application/zip',buffer:Buffer.from('invalid')});
  await expect(dialog.getByRole('alert')).toContainText('無法匯入 ZIP');
  await dialog.getByLabel('資料 ZIP',{exact:true}).setInputFiles(file);
  await expect(dialog.getByText('匯入預覽',{exact:true})).toBeVisible();
  await expect(dialog.getByRole('checkbox',{name:'套用 ZIP 內的拍攝設定',exact:true})).toBeChecked();
  await expect(dialog.getByText(/53 步 · 2048 px/)).toBeVisible();
  assert.equal(target.instance.store.read().characters.length,0);
  await page.screenshot({path:'test-results/transfer-import-preview.png',fullPage:false});
  await dialog.getByRole('button',{name:'匯入資料',exact:true}).click();
  await expect(dialog.getByRole('status')).toContainText('匯入完成');
  await expect.poll(()=>target.instance.store.read().characters.length).toBe(1);
  assert.equal(target.instance.store.read().draft.steps,53);assert.deepEqual(target.instance.store.read().presets.find(row=>row.id==='angle-enhanced').angle,{horizontalAngle:133,verticalAngle:-90,zoom:10});
  await dialog.getByRole('button',{name:'完成',exact:true}).click();
  await page.reload();await expect(page.getByRole('spinbutton',{name:'採樣步數',exact:true})).toHaveValue('53');
  await page.getByRole('button',{name:'工作流與連線設定',exact:true}).click();await page.getByRole('tab',{name:'資料搬移',exact:true}).click();
  await dialog.getByLabel('資料 ZIP',{exact:true}).setInputFiles(file);await expect(dialog.getByText('匯入預覽',{exact:true})).toBeVisible();
  const poseRow=dialog.getByRole('row').filter({has:page.getByRole('rowheader',{name:'提詞與角度',exact:true})});
  await expect(poseRow.getByRole('cell').nth(1)).toHaveText('0');
  await dialog.getByRole('checkbox',{name:'套用 ZIP 內的拍攝設定',exact:true}).uncheck();
  const before=target.instance.store.read();await dialog.getByRole('button',{name:'匯入資料',exact:true}).click();
  await expect(dialog.getByRole('status')).toContainText('已保留目前拍攝設定');
  assert.deepEqual(target.instance.store.read().draft,before.draft);assert.deepEqual(target.instance.store.read().garments,before.garments);
  // Switching tabs keeps the preview state; closing the dialog cancels it.
  await dialog.getByLabel('資料 ZIP',{exact:true}).setInputFiles(file);await expect(dialog.getByText('匯入預覽',{exact:true})).toBeVisible();
  await page.getByRole('tab',{name:'環境與工作流',exact:true}).click();await expect(dialog.getByRole('button',{name:'匯入資料',exact:true})).toBeHidden();
  await page.getByRole('tab',{name:'資料搬移',exact:true}).click();await expect(dialog.getByText('匯入預覽',{exact:true})).toBeVisible();
  await dialog.getByRole('button',{name:'完成',exact:true}).click();
  await expect.poll(()=>fs.readdirSync(target.instance.transfer.uploadDir).length).toBe(0);
  assert.deepEqual(errors,[]);
  console.log('Data transfer PC UI passed: download, corrupt ZIP feedback, preview, enhanced camera parameters, imported draft, repeat merge, tab switching and cancellation.');
} finally {
  await browser.close();for(const server of servers) await new Promise(resolve=>server.close(resolve));
  for(const instance of instances) instance.store.close();
  for(const dir of dirs) {assert.equal(path.dirname(fs.realpathSync(dir)),fs.realpathSync(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true});}
}
