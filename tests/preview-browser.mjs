import {loginBrowser} from './auth-client.js';
import {chromium,expect} from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server/index.js';
import {buildShotPlans} from '../shared/domain.js';
import {DRAFT,TEMPLATE,fixtureState,PNG} from './fixtures.js';
import {CAMERA_TEMPLATE} from './camera-fixtures.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-preview-ui-'));
const fetchImpl = async url => {
  const route = new URL(url).pathname;
  if(route === '/view') {
    const name = new URL(url).searchParams.get('filename');
    return new Response(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="100%" height="100%" fill="#dce1d8"/><text x="50%" y="50%" text-anchor="middle" font-family="sans-serif" font-size="70" fill="#566454">${name}</text></svg>`,{headers:{'Content-Type':'image/svg+xml'}});
  }
  return Response.json({system:{comfyui_version:'preview-test'},devices:[{name:'Test GPU'}],queue_running:[],queue_pending:[]});
};
const {app,store} = createApp({dataDir,fetchImpl});
const state = fixtureState();
const jobs = buildShotPlans(state,{...DRAFT,cameraMode:'multiangle',garmentIds:['garment-a'],poseIds:['pose-standing'],copies:6});
const saved = stage => ({completed:true,comfyUrl:'http://127.0.0.1:8188',images:[{filename:`preview-${stage}.png`,subfolder:'PhotoCreate/preview-test',type:'output'}]});
for(const job of jobs) Object.assign(job,{createdAt:new Date().toISOString(),batchId:'preview-test-batch',executionMode:'staged',stageWaiting:true,stageRunId:'preview-test',pipelineStage:'base',status:'queued',stageResults:{}});
Object.assign(jobs[1],{stageResults:{base:saved('base')}});
Object.assign(jobs[2],{pipelineStage:'angle',status:'running',stageResults:{base:saved('base')}});
Object.assign(jobs[3],{pipelineStage:'refine',stageResults:{base:saved('base'),angle:saved('angle')}});
Object.assign(jobs[4],{pipelineStage:'angle',status:'stopped',stageResults:{base:saved('base')}});
Object.assign(jobs[5],{pipelineStage:'refine',status:'failed',stageResults:{base:saved('base'),angle:saved('angle')}});
store.mutate(current => Object.assign(current,state,{jobs,batches:[{id:jobs[0].batchId,name:'階段預覽測試',createdAt:jobs[0].createdAt}],workflow:TEMPLATE,cameraWorkflow:CAMERA_TEMPLATE}));
for(const asset of [...state.characters,...state.garments]) fs.writeFileSync(path.join(dataDir,'uploads',asset.fileName),PNG);
const server = app.listen(0,'127.0.0.1');await new Promise(resolve => server.once('listening',resolve));
const browser = await chromium.launch({headless:true,executablePath:process.env.PHOTOCREATE_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try {
  const page = await browser.newPage({viewport:{width:1440,height:900}}),errors = [];
  page.on('pageerror',error => errors.push(error.message));
  await loginBrowser(page,`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('button',{name:'拍攝清單',exact:true}).click();
  await expect(page.locator('.batch-cover img')).toHaveAttribute('src',`/api/jobs/${jobs[1].id}/image/0?stage=base`);
  await page.locator('.batch-cover').click();
  const cards = page.locator('.job-card');
  await expect(cards).toHaveCount(6);
  const stages = [null,'base','base','angle','base','angle'];
  for(let index = 0;index < jobs.length;index++) {
    const image = cards.nth(index).locator('.job-photo img');
    await expect(image).toHaveAttribute('src',index === 0 ? jobs[index].garment.image : `/api/jobs/${jobs[index].id}/image/0?stage=${stages[index]}`);
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate(node => node.complete && node.naturalWidth > 0)).toBe(true);
  }
  await cards.nth(2).locator('.job-inspect').click();
  const inspector = page.getByRole('dialog');
  await expect(inspector.locator('.stage-image-preview img')).toHaveAttribute('src',`/api/jobs/${jobs[2].id}/image/0?stage=base`);
  await expect(inspector.locator('.stage-image-preview')).toContainText('目前預覽：原圖');
  store.mutate(current => {const job = current.jobs[2];job.stageResults.angle = saved('angle');job.pipelineStage = 'refine';});
  await expect(inspector.locator('.stage-image-preview img')).toHaveAttribute('src',`/api/jobs/${jobs[2].id}/image/0?stage=angle`,{timeout:10000});
  await expect(inspector.locator('.stage-image-preview')).toContainText('目前預覽：轉角圖');
  await expect(cards.nth(2).locator('.job-photo img')).toHaveAttribute('src',`/api/jobs/${jobs[2].id}/image/0?stage=angle`);
  store.mutate(current => {const job = current.jobs[2];job.images = saved('final').images;job.stageResults.refine = saved('final');job.status = 'completed';});
  await expect(inspector.locator('.result-images img')).toHaveAttribute('src',`/api/jobs/${jobs[2].id}/image/0`,{timeout:10000});
  await expect(cards.nth(2).locator('.status-badge')).toHaveText('已完成');
  await expect(cards.nth(2).locator('.job-photo img')).toHaveAttribute('src',`/api/jobs/${jobs[2].id}/image/0`);
  await page.keyboard.press('Escape');
  for(const size of [{width:1440,height:900},{width:1366,height:768}]) {
    await page.setViewportSize(size);
    if(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('PC preview layout overflows.');
    for(const card of await cards.all()) {
      const layout = await card.locator('.job-photo').evaluate(photo => {
        const frame = photo.getBoundingClientRect(),badge = photo.querySelector('.status-badge').getBoundingClientRect(),checkbox = photo.querySelector('.job-checkbox')?.getBoundingClientRect();
        return {right:frame.right-badge.right,top:badge.top-frame.top,checkboxLeft:checkbox ? checkbox.left-frame.left : null,overlap:checkbox ? checkbox.right >= badge.left : false};
      });
      if(Math.abs(layout.right-12)>1 || Math.abs(layout.top-12)>1 || layout.overlap || layout.checkboxLeft !== null && Math.abs(layout.checkboxLeft-12)>1) throw new Error('Preview status must be top-right; selection must be top-left without overlap: '+JSON.stringify(layout));
    }
  }
  fs.mkdirSync('test-results',{recursive:true});
  await page.locator('.job-grid').screenshot({path:'test-results/stage-previews-pc.png'});
  await page.getByRole('button',{name:'本組成果 (1)',exact:true}).click();
  await expect(page.locator('.gallery-card')).toHaveCount(1);
  if(errors.length) throw new Error(errors.join('; '));
  console.log('PC stage previews passed: original → angle → final updates in place and in open detail; paused/failed images remain visible; status top-right and selection top-left.');
} finally {
  await browser.close();await new Promise(resolve => server.close(resolve));store.close();fs.rmSync(dataDir,{recursive:true,force:true});
}
