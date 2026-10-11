import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {previewFixture} from './preset-preview-fixture.js';
import {loginBrowser} from './auth-client.js';
import {defaultCharacterPromptSettings} from '../shared/character-profile.js';

const f=await previewFixture();
const original=defaultCharacterPromptSettings();original.heightPrompts.below140='';original.heightPrompts['160to170']='preserved original height';original.cupPrompts.B='preserved original cup';original.turnaroundPrompt='Preserve original three-view instructions.';
await f.request('/character-prompt-settings',original,'PUT');
const browser=await chromium.launch({executablePath:process.env.PHOTOCREATE_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1080}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
const tabs=()=>page.getByRole('tablist',{name:'設定檔分頁',exact:true}),select=name=>tabs().getByRole('tab',{name,exact:true}).click();
const save=()=>page.getByRole('button',{name:'保存設定',exact:true}),category=name=>page.getByRole('tab',{name,exact:true}).click();
const field=name=>page.getByRole('textbox',{name,exact:true}),activeId=()=>f.store.read().settings.characterPromptProfiles.activeId;
const create=async name=>{await page.getByRole('button',{name:'新增設定檔',exact:true}).click();await field('新設定檔名稱').fill(name);await page.getByRole('button',{name:'建立設定檔',exact:true}).click();await expect(tabs().getByRole('tab',{name,exact:true})).toHaveAttribute('aria-selected','true');};
try {
  fs.mkdirSync('test-results',{recursive:true});await loginBrowser(page,f.base);await page.getByRole('button',{name:'角色提詞設定',exact:true}).click();
  await expect(tabs().getByRole('tab',{name:'目前設定',exact:true})).toHaveAttribute('aria-selected','true');await expect(field('140 cm 以下提詞')).toHaveValue('');await expect(field('160–170 cm提詞')).toHaveValue('preserved original height');
  const firstId=activeId();await create('棚拍角色');assert.equal(activeId(),firstId);await expect(field('160–170 cm提詞')).toHaveValue(original.heightPrompts['160to170']);
  await field('160–170 cm提詞').fill('studio height description');await category('Cup 提詞 A–Z');await field('B Cup 提詞').fill('studio cup description');await category('三視圖提詞 圖轉圖');await field('轉成三視圖的提詞').fill('Studio front, side and back views.');await save().click();await expect(save()).toBeDisabled();
  assert.deepEqual(f.store.read().settings.characterPrompts,original);const secondId=f.store.read().settings.characterPromptProfiles.profiles.find(row=>row.name==='棚拍角色').id;
  await select('目前設定');await category('身高提詞 5 個區間');await field('140 cm 以下提詞').fill('unsaved original profile edit');
  await select('棚拍角色');await expect(field('160–170 cm提詞')).toHaveValue('studio height description');await select('目前設定');await expect(field('140 cm 以下提詞')).toHaveValue('unsaved original profile edit');
  await select('棚拍角色');await page.getByRole('button',{name:'套用設定檔',exact:true}).click();await expect(page.getByText('目前產圖使用這份設定檔',{exact:true})).toBeVisible();assert.equal(activeId(),secondId);assert.equal(f.store.read().settings.characterPrompts.heightPrompts['160to170'],'studio height description');
  await select('目前設定');await expect(field('140 cm 以下提詞')).toHaveValue('unsaved original profile edit');await select('棚拍角色');
  await field('設定檔名稱').fill('目前設定');await save().click();await expect(page.locator('.character-prompt-notice[role=alert]')).toContainText('已有相同名稱');await expect(field('設定檔名稱')).toHaveValue('目前設定');assert.equal(activeId(),secondId);
  await field('設定檔名稱').fill('寫真棚拍');await save().click();await expect(save()).toBeDisabled();await expect(tabs().getByRole('tab',{name:'寫真棚拍',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.getByRole('button',{name:'刪除設定檔',exact:true})).toBeDisabled();
  await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'test-results/character-configs-desktop.png'});

  await select('目前設定');await page.getByRole('button',{name:'刪除設定檔',exact:true}).click();await page.getByRole('button',{name:'保留設定檔',exact:true}).click();await expect(tabs().getByRole('tab')).toHaveCount(2);
  await page.getByRole('button',{name:'刪除設定檔',exact:true}).click();await page.getByRole('button',{name:'確定刪除',exact:true}).click();await expect(tabs().getByRole('tab')).toHaveCount(1);assert.equal(activeId(),secondId);
  await create('森林外拍');await category('三視圖提詞 圖轉圖');await field('轉成三視圖的提詞').fill('Forest front, side and back views.');
  await page.route('**/api/character-prompt-profiles/*',route=>route.request().method()==='PUT' ? route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'測試設定檔保存失敗。'})}) : route.continue());
  await save().click();await expect(page.locator('.character-prompt-notice[role=alert]')).toHaveText('測試設定檔保存失敗。');await expect(field('轉成三視圖的提詞')).toHaveValue('Forest front, side and back views.');assert.equal(f.store.read().settings.characterPrompts.turnaroundPrompt,'Studio front, side and back views.');
  await page.unroute('**/api/character-prompt-profiles/*');await page.getByRole('button',{name:'保存並套用設定檔',exact:true}).click();await expect(save()).toBeDisabled();assert.equal(f.store.read().settings.characterPrompts.turnaroundPrompt,'Forest front, side and back views.');
  const forestId=activeId();await create('湖畔寫真');assert.equal(activeId(),forestId);await select('森林外拍');
  await tabs().getByRole('tab',{name:'森林外拍',exact:true}).focus();await page.keyboard.press('Home');await expect(tabs().getByRole('tab',{name:'寫真棚拍',exact:true})).toBeFocused();await page.keyboard.press('End');await expect(tabs().getByRole('tab',{name:'湖畔寫真',exact:true})).toBeFocused();await page.keyboard.press('ArrowLeft');await expect(tabs().getByRole('tab',{name:'森林外拍',exact:true})).toBeFocused();
  await page.goto(f.base+'/admin?page=character-prompts');await expect(tabs().getByRole('tab',{name:'森林外拍',exact:true})).toHaveAttribute('aria-selected','true');await expect(field('設定檔名稱')).toHaveValue('森林外拍');await category('三視圖提詞 圖轉圖');await expect(field('轉成三視圖的提詞')).toHaveValue('Forest front, side and back views.');
  await select('寫真棚拍');await expect(field('轉成三視圖的提詞')).toHaveValue('Studio front, side and back views.');await select('森林外拍');
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>window.scrollTo(0,0));assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Profile settings fit the mobile viewport');await page.screenshot({path:'test-results/character-configs-mobile.png',fullPage:true});
  await select('湖畔寫真');await expect(field('設定檔名稱')).toHaveValue('湖畔寫真');assert.equal(activeId(),forestId);assert.deepEqual(errors,[]);
  console.log('Character prompt profiles UI passed: copied settings, independent save, retained drafts, explicit application, duplicate-name recovery, rename, delete protection/confirmation, save failure/retry, keyboard tabs, reload, and mobile layout.');
} finally {await browser.close();await f.close();}
