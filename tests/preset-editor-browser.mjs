import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {createApp} from '../server/index.js';
import {fixtureState,TEMPLATE,PNG} from './fixtures.js';
import {loginBrowser} from './auth-client.js';
import {CATEGORIES,PRESET_SELECTION_FIELDS} from '../shared/domain.js';

const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-preset-editor-ui-'));
const errors=[];
const fetchImpl=async(url)=>{
  const route=new URL(url).pathname;
  if(route==='/prompt') throw new Error('Preset editing must not submit a generation request.');
  if(route==='/userdata') return Response.json([]);
  return Response.json({devices:[{name:'Test GPU'}]});
};
const {app,store}=createApp({dataDir,fetchImpl});
const fixture=fixtureState();
store.mutate(state=>Object.assign(state,fixture,{workflow:TEMPLATE}));
for(const row of [...fixture.characters,...fixture.garments]) fs.writeFileSync(path.join(dataDir,'uploads',row.fileName),PNG);
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const httpHost=os.hostname().toLowerCase();
const browser=await chromium.launch({executablePath:process.env.PHOTOCREATE_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:[`--host-resolver-rules=MAP ${httpHost} 127.0.0.1`,'--no-proxy-server']});
const page=await browser.newPage({viewport:{width:1440,height:1080}});
page.on('pageerror',error=>errors.push(error.message));
fs.mkdirSync('test-results',{recursive:true});
try {
  await loginBrowser(page,base);
  await page.getByRole('button',{name:'提詞資料庫',exact:true}).click();
  await page.getByRole('button',{name:'新增提詞',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'新增提詞',exact:true});
  await expect.poll(async()=>errors.length ? 'crashed: '+errors[0] : await dialog.isVisible() ? 'visible' : 'waiting',{timeout:3000,message:'Clicking 新增提詞 must open the editor and keep the application visible.'}).toBe('visible');
  for(const category of ['pose','expression','clothing_state','interaction','camera','lighting','color','quality']) {
    await page.getByRole('dialog').locator('select').first().selectOption(category);
    await expect.poll(async()=>errors.length ? 'crashed: '+errors[0] : await page.getByRole('dialog').isVisible() ? 'visible' : 'waiting',{timeout:3000,message:`Switching the new preset editor to ${category} must keep the form visible.`}).toBe('visible');
  }
  assert.deepEqual(errors,[]);
  await page.getByRole('dialog').screenshot({path:path.resolve('test-results/preset-editor-desktop.png')});
  await page.keyboard.press('Escape');
  await loginBrowser(page,base.replace('127.0.0.1',httpHost));
  assert.equal(await page.evaluate(()=>window.isSecureContext),false,'Exercise ordinary HTTP access used from other devices.');
  await page.getByRole('button',{name:'提詞資料庫',exact:true}).click();
  await page.getByRole('button',{name:'新增提詞',exact:true}).click();
  await expect.poll(async()=>errors.length ? 'crashed: '+errors[0] : await page.getByRole('dialog',{name:'新增提詞',exact:true}).isVisible() ? 'visible' : 'waiting',{timeout:3000,message:'新增提詞 must work over ordinary HTTP and keep the page visible.'}).toBe('visible');
  const savedIds=new Set();
  const savePreset=async(category,name)=>{
    const editor=page.getByRole('dialog');
    await editor.getByRole('textbox',{name:category==='camera' ? '角度名稱' : '提詞名稱',exact:true}).fill(name);
    await editor.getByRole('textbox',{name:'標籤',exact:true}).fill('HTTP, 驗證');
    if(category==='camera') {
      await editor.getByRole('spinbutton',{name:'水平角度',exact:true}).fill('135');
      await editor.getByRole('spinbutton',{name:'俯仰角度',exact:true}).fill('-70');
      await editor.getByRole('spinbutton',{name:'Zoom',exact:true}).fill('8');
    } else await editor.getByRole('textbox',{name:'提詞內容',exact:true}).fill(`${name}的內容`);
    const responsePromise=page.waitForResponse(response=>response.request().method()==='POST' && new URL(response.url()).pathname==='/api/presets');
    await editor.getByRole('button',{name:category==='camera' ? '保存角度' : '保存提詞',exact:true}).click();
    const response=await responsePromise;assert.equal(response.ok(),true);
    await expect(editor).toBeHidden();
    const row=store.read().presets.find(preset=>preset.name===name);
    assert.ok(row,`Saved preset missing: ${name}`);assert.equal(row.category,category);
    assert.match(row.id,/^preset-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(row.tags,['HTTP','驗證']);
    if(category==='camera') assert.deepEqual(row.angle,{horizontalAngle:135,verticalAngle:-70,zoom:8});
    else assert.equal(row.prompt,`${name}的內容`);
    return row;
  };
  for(const [category,{label}] of Object.entries(CATEGORIES)) {
    if(category!=='pose') await page.getByRole('button',{name:'新增提詞',exact:true}).click();
    await page.getByRole('dialog').getByRole('combobox',{name:'分類',exact:true}).selectOption(category);
    const name=`HTTP ${label}測試`;
    const row=await savePreset(category,name);
    assert.equal(savedIds.has(row.id),false,'New presets must have distinct IDs');savedIds.add(row.id);
    await page.locator('.preset-library .filter-tabs').getByRole('button',{name:new RegExp(`^${label}`)}).click();
    await page.locator('.preset-card').filter({has:page.getByRole('heading',{name,exact:true})}).click();
    const updated=await savePreset(category,`${name}（更新）`);
    assert.equal(updated.id,row.id,'Editing must preserve the preset ID');
  }
  await page.getByRole('button',{name:'拍攝工作檯',exact:true}).click();
  await page.getByRole('button',{name:'隨機寫真',exact:true}).click();
  await page.getByRole('combobox',{name:'隨機候選範圍',exact:true}).selectOption('selected');
  for(const [category,{plural}] of Object.entries(CATEGORIES)) {
    if(category==='camera') await page.locator('.camera-presets-settings > summary').click();
    const group=page.getByRole('group',{name:plural,exact:true});
    await group.getByRole('button',{name:category==='camera' ? '新增角度' : '新增提詞',exact:true}).click();
    await expect(page.getByRole('dialog').getByRole('combobox',{name:'分類',exact:true})).toHaveValue(category);
    const row=await savePreset(category,`工作檯 ${category}測試`);
    await expect(group).toContainText(row.name);
    await expect.poll(()=>store.read().draft[PRESET_SELECTION_FIELDS[category]]?.includes(row.id)).toBe(true);
  }
  const poseGroup=page.getByRole('group',{name:CATEGORIES.pose.plural,exact:true});
  await poseGroup.getByRole('button',{name:'選擇動作提詞',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'新增提詞',exact:true}).click();
  const poolRow=await savePreset('pose','候選視窗新增測試');
  await expect.poll(()=>store.read().draft.poseIds?.includes(poolRow.id)).toBe(true);
  await page.getByRole('textbox',{name:'場景互動',exact:true}).fill('站在窗邊調整窗簾');
  await page.getByRole('button',{name:'存為互動提詞',exact:true}).click();
  await expect(page.getByRole('dialog').getByRole('textbox',{name:'提詞內容',exact:true})).toHaveValue('站在窗邊調整窗簾');
  await savePreset('interaction','補充存為提詞測試');
  await expect(page.getByRole('textbox',{name:'場景互動',exact:true})).toHaveValue('');
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('group',{name:CATEGORIES.expression.plural,exact:true}).getByRole('button',{name:'新增提詞',exact:true}).click();
  await page.getByRole('dialog').getByRole('textbox',{name:'提詞名稱',exact:true}).fill('手機也能新增表情');
  await page.getByRole('dialog').getByRole('textbox',{name:'提詞內容',exact:true}).fill('自然微笑，眼神放鬆。');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Preset editor overflows on mobile');
  await page.getByRole('dialog').screenshot({path:path.resolve('test-results/preset-editor-mobile.png')});
  assert.deepEqual(errors,[]);
  console.log('新增提詞：localhost and ordinary HTTP; all 8 categories created and edited; workbench, candidate picker, interaction prefill, mobile; no runtime error');
} catch(error) {
  await page.screenshot({path:path.resolve('test-results/preset-editor-failure.png'),fullPage:true});
  console.error('Preset editor browser errors:',JSON.stringify(errors));
  throw error;
} finally {
  await browser.close();await new Promise(resolve=>server.close(resolve));store.close();
  assert.equal(path.dirname(path.resolve(dataDir)),path.resolve(os.tmpdir()));
  assert.ok(path.basename(dataDir).startsWith('PhotoCreate-preset-editor-ui-'));
  fs.rmSync(dataDir,{recursive:true,force:true});
}
