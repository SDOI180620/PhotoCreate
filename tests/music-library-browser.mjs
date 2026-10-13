import fs from 'node:fs';
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {videoFixture} from './photo-video-fixture.js';
import {loginBrowser} from './auth-client.js';

const f=await videoFixture(),browser=await chromium.launch({executablePath:process.env.PHOTOCREATE_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
try {
  // Public HTTP pages lack randomUUID while retaining getRandomValues.
  // Minimise that browser capability difference without depending on LAN DNS.
  await page.addInitScript(()=>Object.defineProperty(globalThis.crypto,'randomUUID',{value:undefined}));
  await loginBrowser(page,f.base);assert.equal(await page.evaluate(()=>typeof crypto.randomUUID),'undefined');
  await page.getByRole('button',{name:'播放音樂',exact:true}).click();
  try {await expect(page.getByRole('heading',{name:'產生鋼琴音樂',exact:true})).toBeVisible({timeout:2500});}
  catch(e) {throw new Error('Music screen did not render on HTTP: '+JSON.stringify(errors),{cause:e});}
  await expect(page.getByRole('textbox',{name:'音樂名稱',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'匯入音樂',exact:true})).toBeVisible();
  await expect(page.getByText('ComfyUI 尚未安裝 MiniMax Music3 產生與 MP3 儲存節點。',{exact:true})).toBeVisible();
  assert.deepEqual(errors,[]);fs.mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/music-library-http.png'});
  console.log('Music screen works on a non-secure HTTP host with visible controls and missing-node guidance.');
} finally {await browser.close();await f.close();}
