import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {previewFixture,until} from './preset-preview-fixture.js';
import {loginBrowser} from './auth-client.js';
import {defaultCharacterPromptSettings} from '../shared/character-profile.js';

const f=await previewFixture();
const browser=await chromium.launch({executablePath:process.env.PHOTOCREATE_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
const open=()=>page.getByRole('button',{name:'角色提詞設定',exact:true}).click();
const save=()=>page.getByRole('button',{name:'保存設定',exact:true});
const preview=()=>page.getByLabel('產生的角色提詞',{exact:true});
try {
  await loginBrowser(page,f.base);await open();
  await expect(page.getByRole('heading',{name:'角色提詞設定.'})).toBeVisible();
  await expect(page.getByRole('textbox',{name:/cm.*提詞/})).toHaveCount(5);
  await expect(save()).toBeDisabled();
  await page.getByRole('textbox',{name:'140 cm 以下提詞',exact:true}).fill('Very short stature with balanced proportions.');
  await expect(preview()).toContainText('Very short stature with balanced proportions.');
  await page.getByRole('spinbutton',{name:'身高（公分）',exact:true}).fill('139.9');await expect(preview()).toContainText('Very short stature with balanced proportions.');
  await page.getByRole('spinbutton',{name:'身高（公分）',exact:true}).fill('140');await expect(preview()).toContainText('Height appearance: short stature');await expect(preview()).not.toContainText('Very short stature');
  await page.getByRole('textbox',{name:'170 cm 以上提詞',exact:true}).fill('Tall stature with balanced proportions.');
  await save().click();await expect(save()).toBeDisabled();
  await until(()=>f.store.read().settings.characterPrompts.heightPrompts['170plus']==='Tall stature with balanced proportions.');

  await page.getByRole('tab',{name:'Cup 提詞 A–Z',exact:true}).click();
  await expect(page.getByRole('textbox',{name:/^[A-Z] Cup 提詞$/})).toHaveCount(26);
  await page.getByRole('textbox',{name:'B Cup 提詞',exact:true}).fill('small bust with natural proportions');await expect(preview()).toContainText('B cup (small bust with natural proportions)');
  await page.getByRole('textbox',{name:'Z Cup 提詞',exact:true}).fill('');await expect(preview()).toContainText('breast size Z cup.');await expect(preview()).not.toContainText('huge bust');
  await save().click();await expect(save()).toBeDisabled();
  await page.goto(f.base+'/admin?page=character-prompts');await page.getByRole('tab',{name:'Cup 提詞 A–Z',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'B Cup 提詞',exact:true})).toHaveValue('small bust with natural proportions');await expect(page.getByRole('textbox',{name:'Z Cup 提詞',exact:true})).toHaveValue('');

  await page.getByRole('tab',{name:'三視圖提詞 圖轉圖',exact:true}).click();
  await page.getByRole('textbox',{name:'轉成三視圖的提詞',exact:true}).fill('Show the same character in front, side and back views. Keep consistent face and clothing.');
  await expect(preview()).toContainText('front, side and back');await expect(preview()).toContainText('B cup (small bust with natural proportions)');
  await save().click();await expect(save()).toBeDisabled();
  await page.goto(f.base+'/admin?page=character-prompts');await page.getByRole('tab',{name:'三視圖提詞 圖轉圖',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'轉成三視圖的提詞',exact:true})).toHaveValue('Show the same character in front, side and back views. Keep consistent face and clothing.');
  await page.getByRole('tab',{name:'Cup 提詞 A–Z',exact:true}).click();

  await page.route('**/api/character-prompt-settings',route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'測試保存失敗，請重試。'})}));
  await page.getByRole('textbox',{name:'B Cup 提詞',exact:true}).fill('small bust');await save().click();
  await expect(page.locator('.character-prompt-notice[role=alert]')).toHaveText('測試保存失敗，請重試。');await expect(page.getByRole('textbox',{name:'B Cup 提詞',exact:true})).toHaveValue('small bust');
  assert.equal(f.store.read().settings.characterPrompts.cupPrompts.B,'small bust with natural proportions');
  await page.unroute('**/api/character-prompt-settings');await save().click();await expect(save()).toBeDisabled();
  await page.getByRole('button',{name:'還原預設提詞',exact:true}).click();await expect(save()).toBeEnabled();await save().click();await expect(save()).toBeDisabled();
  assert.deepEqual(f.store.read().settings.characterPrompts,defaultCharacterPromptSettings());

  fs.mkdirSync('test-results',{recursive:true});
  await page.getByRole('combobox',{name:'胸部尺寸',exact:true}).selectOption('B');await page.getByRole('spinbutton',{name:'身高（公分）',exact:true}).fill('165');
  await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'test-results/character-prompts-cup-desktop.png'});
  await page.getByRole('tab',{name:'身高提詞 5 個區間',exact:true}).click();await page.screenshot({path:'test-results/character-prompts-height-desktop.png'});
  await page.getByRole('tab',{name:'三視圖提詞 圖轉圖',exact:true}).click();await page.screenshot({path:'test-results/character-prompts-turnaround-desktop.png'});await page.getByRole('tab',{name:'身高提詞 5 個區間',exact:true}).click();
  await page.getByRole('tab',{name:'身高提詞 5 個區間',exact:true}).focus();await page.keyboard.press('ArrowRight');await expect(page.getByRole('tab',{name:'Cup 提詞 A–Z',exact:true})).toBeFocused();await page.keyboard.press('Home');
  await expect(page.getByRole('tab',{name:'身高提詞 5 個區間',exact:true})).toHaveAttribute('aria-selected','true');
  await page.keyboard.press('End');await expect(page.getByRole('tab',{name:'三視圖提詞 圖轉圖',exact:true})).toBeFocused();await page.keyboard.press('Home');
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Settings page fits the mobile viewport');
  await page.screenshot({path:'test-results/character-prompts-height-mobile.png',fullPage:true});
  await page.getByRole('tab',{name:'Cup 提詞 A–Z',exact:true}).click();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Cup fields fit the mobile viewport');
  await page.getByRole('textbox',{name:'A Cup 提詞',exact:true}).fill('very small bust with natural shape');await expect(preview()).toContainText('A cup (very small bust with natural shape)');
  await page.getByRole('tab',{name:'三視圖提詞 圖轉圖',exact:true}).click();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Turnaround settings fit the mobile viewport');
  await expect(preview()).toContainText('very small bust with natural shape');await page.screenshot({path:'test-results/character-prompts-turnaround-mobile.png',fullPage:true});await page.getByRole('tab',{name:'Cup 提詞 A–Z',exact:true}).click();
  await page.getByRole('spinbutton',{name:'身高（公分）',exact:true}).fill('');await page.getByRole('combobox',{name:'胸部尺寸',exact:true}).selectOption('');await expect(preview()).toContainText('未填寫身高與 Cup');
  assert.deepEqual(errors,[]);
  console.log('Character prompt settings UI passed: height boundaries, A–Z Cup and turnaround editing, combined live preview, save/reload, blank rules, save failure/retry, defaults, keyboard tabs, and mobile layout.');
} finally {await browser.close();await f.close();}
