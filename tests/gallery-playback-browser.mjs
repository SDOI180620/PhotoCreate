import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {chromium,expect} from '@playwright/test';
import {createApp} from '../server/index.js';
import {createFeaturedGallery} from '../server/featured-gallery.js';
import {buildShotPlans} from '../shared/domain.js';
import {fixtureState,DRAFT,TEMPLATE,PNG} from './fixtures.js';
import {testWav} from './gallery-music-fixture.js';
import {loginBrowser} from './auth-client.js';

const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-playback-ui-')),pending=new Set(),history=new Map(),prompts=[];
const art=index=>`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="${['#9aa88c','#d5c7a6','#8b9cab','#c3b299'][index%4]}"/><stop offset="1" stop-color="#f2e6cb"/></linearGradient></defs><rect width="1200" height="800" fill="url(#sky)"/><circle cx="890" cy="190" r="95" fill="#fff6dc" opacity=".65"/><path d="M0 620Q380 460 700 570T1200 440V800H0" fill="#657b61"/><path d="M0 720Q450 560 800 690T1200 580V800H0" fill="#3e5548"/><path d="M90 0L120 800M200 0L240 800M1100 0L1080 800" stroke="#233d36" stroke-width="55"/><path d="M520 800Q560 480 600 470Q650 520 740 800Z" fill="#d9bf98"/><ellipse cx="620" cy="410" rx="38" ry="48" fill="#eed4b9"/><path d="M578 415Q550 340 620 345Q685 350 662 420L645 368L593 377Z" fill="#34302c"/></svg>`;
const fetchImpl=async(url,options={})=>{
  const route=new URL(url).pathname;
  if(route==='/object_info') return Response.json({MiniMaxMusic3Generate:{},SaveAudioMP3:{}});
  if(route==='/queue') return Response.json({queue_running:[],queue_pending:[...pending].map(id=>[0,id])});
  if(route==='/prompt') {const receipt=JSON.parse(options.body);prompts.push(receipt);pending.add(receipt.prompt_id);return Response.json({prompt_id:receipt.prompt_id});}
  if(route.startsWith('/history/')) {const id=route.split('/').at(-1);return Response.json(history.has(id) ? {[id]:history.get(id)} : {});}
  if(route==='/view') {const file=new URL(url).searchParams.get('filename');return file.endsWith('.wav') ? new Response(testWav()) : new Response(art(Number(file.split('-')[1]?.split('.')[0]) || 0),{headers:{'content-type':'image/svg+xml'}});}
  if(['/free','/interrupt','/upload/image'].includes(route)) throw new Error('Playback must not alter the photo engine');
  return Response.json({devices:[]});
};
const instance=createApp({dataDir,fetchImpl}),{store,authentication,galleryMusic}=instance;
const account=await authentication.createCustomer({username:'playback-customer',password:'playback-password'});
const accountDb=new DatabaseSync(path.join(dataDir,'accounts.sqlite'),{readOnly:true});const owner=accountDb.prepare('SELECT owner_id FROM accounts WHERE id=?').get(account.id).owner_id;accountDb.close();
const fixture=fixtureState(),plan=buildShotPlans(fixture,{...DRAFT,cameraEnabled:false,copies:1,garmentIds:['garment-a'],poseIds:['pose-standing']})[0];
const jobs=Array.from({length:4},(_,i)=>({...plan,id:`slide-${i}`,visitorId:owner,createdAt:new Date().toISOString(),status:'completed',images:[{filename:`slide-${i}.png`,subfolder:'PhotoCreate',type:'output'}],garment:{...plan.garment,name:`寫真 ${i+1}`}}));
store.mutate(state=>Object.assign(state,fixture,{workflow:TEMPLATE,jobs,draft:{...DRAFT,cameraEnabled:false}}));
for(const row of [...fixture.characters,...fixture.garments]) fs.writeFileSync(path.join(dataDir,'uploads',row.fileName),PNG);
const gallery=createFeaturedGallery(store),folder=gallery.createFolder(owner,'公園寫真');
for(const [i,job] of jobs.entries()) gallery.add(owner,{jobId:job.id,imageIndex:0,folderId:i<2 ? folder.id : ''});
const piano=galleryMusic.upload({buffer:testWav()},{name:'測試鋼琴',kind:'piano'}),rain=galleryMusic.upload({buffer:testWav()},{name:'測試雨聲',kind:'rain'}),hidden=galleryMusic.upload({buffer:testWav()},{name:'未公開小提琴',kind:'violin'});galleryMusic.update(hidden.id,{enabled:false});
const server=instance.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.PHOTOCREATE_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.emulateMedia({reducedMotion:'reduce'});
fs.mkdirSync('test-results',{recursive:true});
try {
  await loginBrowser(page,base);await page.getByRole('button',{name:'播放音樂',exact:true}).click();
  await expect(page.getByRole('heading',{name:/^播放音樂/}).first()).toBeVisible();
  await expect(page.getByRole('button',{name:'產生鋼琴曲',exact:true})).toBeEnabled();
  await page.getByRole('textbox',{name:'音樂名稱',exact:true}).fill('新鋼琴曲');await page.getByRole('button',{name:'產生鋼琴曲',exact:true}).click();
  await expect.poll(()=>prompts.length).toBe(1);const generated=prompts[0].prompt_id;
  assert.equal(prompts[0].prompt['1'].inputs.lyrics,'[Intro]\n[Instrumental]\n[Solo]\n[Instrumental]\n[Outro]');
  pending.delete(generated);history.set(generated,{status:{completed:true,status_str:'success'},outputs:{'2':{audio:[{filename:'generated.wav',subfolder:`PhotoCreate/_gallery_music/${generated}`,type:'output'}]}}});await galleryMusic.sync();
  await expect(page.locator('.music-track').filter({hasText:'新鋼琴曲'}).locator('audio')).toBeVisible();
  await page.locator('.music-track').filter({hasText:'新鋼琴曲'}).getByRole('checkbox',{name:'開放給顧客選擇',exact:true}).check();
  await page.screenshot({path:'test-results/gallery-music-library.png',fullPage:true});
  await page.context().clearCookies();await loginBrowser(page,base,'playback-customer','playback-password');
  const launch=page.getByRole('button',{name:'播放精選',exact:true});await expect(launch).toBeDisabled();
  await page.locator('#gallery').getByRole('button',{name:'資料夾 全部照片',exact:true}).click();await expect(launch).toBeEnabled();await launch.click();
  let player=page.getByRole('dialog',{name:'精選全螢幕播放',exact:true});await expect(player).toBeVisible();
  await player.getByRole('button',{name:'暫停精選輪播',exact:true}).click();
  const position=player.getByRole('status',{name:'目前播放照片',exact:true});await expect(position).toHaveText('1 / 4');
  await player.getByRole('button',{name:'下一張精選',exact:true}).click();await expect(position).toHaveText('2 / 4');await page.keyboard.press('ArrowLeft');await expect(position).toHaveText('1 / 4');
  await player.getByRole('button',{name:'上一張精選',exact:true}).click();await expect(position).toHaveText('4 / 4');
  await player.getByRole('button',{name:'照片填滿畫面',exact:true}).click();await expect(player.locator('.pc-player-photo')).toHaveClass(/fill/);
  await player.getByRole('button',{name:'播放第 1 張精選',exact:true}).click();await player.getByRole('button',{name:'改為隨機順序',exact:true}).click();
  const seen=[await position.textContent()];for(let i=0;i<3;i++) {await player.getByRole('button',{name:'下一張精選',exact:true}).click();seen.push(await position.textContent());}assert.equal(new Set(seen).size,4,'Shuffle visits every photo without repeating');
  const second=[];for(let i=0;i<4;i++) {await player.getByRole('button',{name:'下一張精選',exact:true}).click();second.push(await position.textContent());}assert.notEqual(second[0],seen[3]);assert.equal(new Set(second).size,4,'Every following shuffle cycle includes every photo');
  await player.getByRole('button',{name:'上一張精選',exact:true}).click();await expect(position).toHaveText(second[2]);
  const music=player.getByRole('combobox',{name:'播放音樂',exact:true});await expect(music.locator('option')).toHaveCount(4);await expect(music.locator('option')).not.toContainText(['未公開小提琴']);
  await music.selectOption(piano.id);await player.getByRole('combobox',{name:'輪播秒數',exact:true}).selectOption('3');await player.getByRole('button',{name:'播放精選輪播',exact:true}).click();
  await expect.poll(()=>player.locator('audio').evaluate(node=>node.paused)).toBe(false);await expect.poll(()=>player.locator('audio').evaluate(node=>node.loop)).toBe(true);
  await player.getByRole('slider',{name:'播放音量',exact:true}).fill('0.55');await expect.poll(()=>player.locator('audio').evaluate(node=>node.volume)).toBe(.55);
  const before=await position.textContent();await expect(position).not.toHaveText(before,{timeout:6500});await player.getByRole('button',{name:'暫停精選輪播',exact:true}).click();const paused=await position.textContent();await page.waitForTimeout(3200);await expect(position).toHaveText(paused);await expect.poll(()=>player.locator('audio').evaluate(node=>node.paused)).toBe(true);
  await page.screenshot({path:'test-results/gallery-playback-desktop.png'});
  const retained=await player.locator('audio').elementHandle();await player.getByRole('button',{name:'關閉精選播放',exact:true}).click();await expect(player).not.toBeVisible();assert.equal(await retained.evaluate(node=>node.paused),true);
  await launch.click();player=page.getByRole('dialog',{name:'精選全螢幕播放',exact:true});await expect(player.getByRole('button',{name:'改為固定順序',exact:true})).toBeVisible();await expect(player.getByRole('combobox',{name:'播放音樂',exact:true})).toHaveValue(piano.id);await expect(player.getByRole('slider',{name:'播放音量',exact:true})).toHaveValue('0.55');await expect(player.getByRole('combobox',{name:'輪播秒數',exact:true})).toHaveValue('3');
  await player.getByRole('combobox',{name:'播放音樂',exact:true}).selectOption(rain.id);await expect.poll(()=>player.locator('audio').evaluate(node=>node.currentSrc)).toContain(rain.id);await player.getByRole('combobox',{name:'播放音樂',exact:true}).selectOption('');await expect.poll(()=>player.locator('audio').evaluate(node=>node.paused)).toBe(true);
  await page.keyboard.press('Escape');await expect(player).not.toBeVisible();
  await page.setViewportSize({width:390,height:844});await launch.click();await expect(player).toBeVisible();await player.getByRole('button',{name:'暫停精選輪播',exact:true}).click();await player.locator('.pc-player-photo').evaluate(node=>node.decode());
  const bounds=await player.evaluate(node=>({viewport:innerWidth,width:node.getBoundingClientRect().width,controls:[...node.querySelectorAll('.pc-player-controls button,.pc-player-controls select,.pc-player-controls input')].map(child=>({left:child.getBoundingClientRect().left,right:child.getBoundingClientRect().right}))}));assert.equal(bounds.width,bounds.viewport);assert.ok(bounds.controls.every(row=>row.left>=0 && row.right<=bounds.viewport),JSON.stringify(bounds));
  await page.screenshot({path:'test-results/gallery-playback-mobile.png'});await player.getByRole('button',{name:'關閉精選播放',exact:true}).click();
  await page.locator('#gallery .photo-folder-tabs').getByRole('button',{name:/公園寫真/}).click();await launch.click();await expect(position).toHaveText('1 / 2');await player.getByRole('button',{name:'關閉精選播放',exact:true}).click();
  assert.deepEqual(errors,[]);console.log('Gallery playback UI passed: fullscreen, fixed/shuffle, timers, folders, music, persistence, cleanup, desktop/mobile; no real GPU jobs.');
} finally {
  await browser.close();await new Promise(resolve=>server.close(resolve));store.close();const target=path.resolve(dataDir);if(path.dirname(target)!==path.resolve(os.tmpdir()) || !path.basename(target).startsWith('PhotoCreate-playback-ui-')) throw new Error('Unsafe fixture cleanup');fs.rmSync(target,{recursive:true,force:true});
}
