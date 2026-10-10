import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {buildShotPlans} from '../shared/domain.js';
import {DRAFT} from './fixtures.js';
import {loginBrowser} from './auth-client.js';
import {previewFixture} from './preset-preview-fixture.js';

const f=await previewFixture();
f.store.mutate(state=>{
  const draft={...DRAFT,copies:1,garmentIds:['garment-a'],poseIds:['pose-standing'],
    expressionIds:['expression-smile'],clothingStateIds:['clothing-state-breeze'],interactionIds:['interaction-window']};
  for(const preset of state.presets) preset.reviewed=true;
  const plan=buildShotPlans(state,draft)[0];
  const base={...plan,batchId:'layout-batch',status:'completed',createdAt:'2026-10-11T00:00:00Z',images:[{filename:'layout.png',subfolder:'PhotoCreate',type:'output'}]};
  const longColor={...base.color,name:'VeryLongUnbrokenPresetNameToCheckWrappingAndReviewMark'};
  state.presets.find(row=>row.id===longColor.id).name=longColor.name;
  state.jobs=[
    {...base,id:'layout-portrait',name:'直式測試',outputWidth:900,outputHeight:1600},
    {...base,id:'layout-landscape',name:'橫式測試',outputWidth:1600,outputHeight:900},
    {...base,id:'layout-long',name:'長名稱測試',outputWidth:900,outputHeight:1600,color:longColor,
      garment:{...base.garment,name:'和服造型（完整穿著・紫色花卉與腰帶細節）'}},
  ];
  state.batches=[{id:'layout-batch',name:'照片卡排版驗證',createdAt:base.createdAt}];
});
const browser=await chromium.launch({executablePath:process.env.PHOTOCREATE_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',error=>errors.push(error.message));
fs.mkdirSync('test-results',{recursive:true});
// A vector placeholder makes both original aspect ratios visible without generating or changing photographs.
await page.route('**/api/jobs/*/image/*',async route=>{
  const landscape=route.request().url().includes('layout-landscape'),width=landscape ? 1600 : 900,height=landscape ? 900 : 1600;
  const body=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 900 1600" preserveAspectRatio="xMidYMid slice"><rect width="900" height="1600" fill="#ddd6c8"/><rect x="60" y="80" width="780" height="880" rx="8" fill="#eeebe3"/><path d="M450 80V960M60 520H840" stroke="#c7c1b5" stroke-width="18"/><path d="M0 1100H900V1600H0Z" fill="#c8bdac"/><ellipse cx="450" cy="1480" rx="200" ry="35" fill="#b8ae9e"/><circle cx="450" cy="510" r="95" fill="#bfae9a"/><path d="M355 490Q350 370 455 380Q560 390 550 510L510 460L400 450Z" fill="#4b493e"/><path d="M355 630L545 630L640 1050L580 1430H320L260 1050Z" fill="#797f6b"/><path d="M355 660L450 940L545 660M450 940V1420" fill="none" stroke="#b4b9a4" stroke-width="12"/><path d="M295 1000H605V1090H295Z" fill="#b9ac88"/><text x="450" y="1520" text-anchor="middle" fill="#696c5f" font-family="sans-serif" font-size="25">LAYOUT PREVIEW</text></svg>`;
  await route.fulfill({status:200,contentType:'image/svg+xml',body});
});
const photo=id=>page.locator(`.gallery-card[data-job-id="${id}"]`);
const closeDialog=async()=>{await page.getByRole('dialog').last().getByRole('button',{name:'關閉視窗',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);};
try {
  await loginBrowser(page,f.base);
  await page.getByRole('button',{name:'成果畫廊',exact:true}).click();
  await expect(page.locator('.gallery-card')).toHaveCount(3);
  for(const width of [1440,1024,768,423,390,320]) {
    await page.setViewportSize({width,height:1000});
    for(const id of ['layout-portrait','layout-landscape','layout-long']) {
      const card=photo(id);await card.scrollIntoViewIfNeeded();
      await expect(card.locator('img')).toBeVisible();
      await expect.poll(()=>card.locator('img').evaluate(img=>img.complete && img.naturalWidth>0)).toBe(true);
      await expect(card.locator('.shot-tag-link')).toHaveCount(8);
      await expect(card.getByRole('img',{name:'已確認',exact:true})).toHaveCount(8);
      const measurements=await card.evaluate(element=>{
        const bounds=element.getBoundingClientRect(),img=element.querySelector('.gallery-photo img'),image=img.getBoundingClientRect();
        return {left:bounds.left,right:bounds.right,width:bounds.width,overflow:element.scrollWidth>element.clientWidth,
          imageRatio:image.width/image.height,sourceRatio:img.naturalWidth/img.naturalHeight,
          buttons:[...element.querySelectorAll('.gallery-shoot-actions .button')].map(button=>({text:button.textContent,rect:button.getBoundingClientRect().toJSON(),scroll:button.scrollWidth,client:button.clientWidth,overflow:button.scrollWidth>button.clientWidth})),
          tags:[...element.querySelectorAll('.shot-tag')].map(tag=>tag.scrollWidth>tag.clientWidth)};
      });
      assert.ok(!measurements.overflow && measurements.left>=0 && measurements.right<=width,`${width}px: card stays inside the viewport`);
      assert.ok(measurements.buttons.every(button=>!button.overflow),`${width}px: both shooting labels fit ${JSON.stringify(measurements)}`);
      assert.ok(measurements.tags.every(overflow=>!overflow),`${width}px: long preset labels and review marks fit`);
      assert.ok(Math.abs(measurements.imageRatio-measurements.sourceRatio)<0.002,`${width}px: the complete original aspect ratio is preserved`);
      const [angle,custom]=measurements.buttons;
      assert.ok(angle.rect.right<=custom.rect.left || angle.rect.bottom<=custom.rect.top,`${width}px: shooting buttons do not overlap`);
    }
    const cards=await page.locator('.gallery-card').evaluateAll(elements=>elements.map(element=>element.getBoundingClientRect().toJSON()));
    if(width<=423) assert.ok(cards.every(card=>Math.abs(card.left-cards[0].left)<1),`${width}px: mobile uses a single column`);
    if(width>=1024) assert.ok(cards.some(card=>card.left>cards[0].left+100),`${width}px: wider screens use multiple columns`);
    const overflow=await page.evaluate(()=>({width:document.documentElement.scrollWidth,elements:[...document.querySelectorAll('body *')].filter(element=>{const rect=element.getBoundingClientRect();return rect.width && rect.right>innerWidth+1;}).slice(0,12).map(element=>({tag:element.tagName,className:typeof element.className==='string' ? element.className : '',right:element.getBoundingClientRect().right,text:element.textContent.slice(0,80)}))}));
    assert.ok(overflow.width<=width,`${width}px: page has no horizontal overflow ${JSON.stringify(overflow)}`);
    if(width===1440 || width===390) {
      await page.setViewportSize({width,height:1600});
      await page.evaluate(()=>scrollTo(0,0));
      await photo('layout-portrait').scrollIntoViewIfNeeded();
      await photo('layout-portrait').screenshot({path:path.resolve(`test-results/gallery-card-${width}.png`)});
    }
  }
  await page.setViewportSize({width:1440,height:1600});
  await page.evaluate(()=>scrollTo(0,0));
  await page.locator('.gallery-grid').screenshot({path:path.resolve('test-results/gallery-layout-desktop.png')});
  await photo('layout-portrait').locator('.gallery-angle').click();
  await expect(page.getByRole('dialog',{name:'不同角度拍攝',exact:true})).toBeVisible();await closeDialog();
  await photo('layout-portrait').locator('.gallery-custom').click();
  await expect(page.getByRole('dialog',{name:'自訂拍攝',exact:true})).toBeVisible();await closeDialog();
  await photo('layout-portrait').getByRole('button',{name:'詳細',exact:true}).click();
  await expect(page.getByRole('dialog').locator('.shot-options')).toBeVisible();await closeDialog();
  await photo('layout-portrait').getByRole('button',{name:/^開啟動作提詞 /}).click();
  await expect(page.getByRole('dialog',{name:'編輯提詞',exact:true})).toBeVisible();await closeDialog();
  await expect(photo('layout-portrait').getByRole('link',{name:/^下載成果 /})).toHaveAttribute('href','/api/jobs/layout-portrait/image/0?download=1');
  await photo('layout-portrait').getByRole('checkbox').check();await expect(photo('layout-portrait')).toHaveClass(/selected/);
  assert.deepEqual(errors,[]);
  console.log('Gallery UI passed: desktop/tablet/phone layout, complete portrait/landscape images, eight clickable reviewed tags, long labels, selection, angle/custom dialogs, details and download.');
} finally {await browser.close();await f.close();}
