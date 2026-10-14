import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {characterTurnaroundPrompt,DEFAULT_TURNAROUND_PROMPT,TURNAROUND_NEGATIVE} from '../shared/character-turnaround.js';
import {defaultCharacterPromptSettings,normalizeCharacterPromptSettings} from '../shared/character-profile.js';
import {buildComfyPrompt,referenceKinds} from '../server/workflow.js';
import {SINGLE_SUBJECT_PROMPT} from '../shared/subject.js';
import {removeTurnaroundDirectory} from '../server/character-turnarounds.js';
import {previewFixture,until} from './preset-preview-fixture.js';
import {adminFetch,login} from './auth-client.js';
import {PNG,TEMPLATE} from './fixtures.js';

const form=(profile={},buffer=PNG)=>{const data=new FormData();data.append('image',new Blob([buffer],{type:'image/png'}),'role.png');data.append('profile',JSON.stringify(profile));return data;};
const start=async(f,id=randomUUID(),profile={},buffer=PNG)=>{const response=await adminFetch(`${f.base}/api/character-turnarounds/${id}`,{method:'PUT',body:form(profile,buffer)});return {id,status:response.status,data:await response.json()};};

test('三視圖正提詞合併尺寸設定，只有角色一張參考；一般寫真仍限制單一鏡位',()=>{
  const settings=defaultCharacterPromptSettings();settings.turnaroundPrompt='Show the same character from front, side and back.';settings.heightPrompts['140to150']='custom short stature';settings.cupPrompts.B='custom small bust';
  const prompt=characterTurnaroundPrompt({heightCm:145,cupSize:'B'},settings);
  assert(prompt.startsWith(settings.turnaroundPrompt));assert(prompt.includes('height 145 cm'));assert(prompt.includes('custom short stature'));assert(prompt.includes('B cup (custom small bust)'));
  const shot={id:randomUUID(),jobKind:'character-turnaround',prompt,negative:TURNAROUND_NEGATIVE,resolution:1024,steps:30,seed:100,aspectRatio:'16:9'};
  const graph=buildComfyPrompt(TEMPLATE,shot,{character:'role.png'}),text=Object.values(graph).find(row=>row.class_type==='TextEncodeQwenImage21').inputs;
  assert.deepEqual(referenceKinds(shot),['character']);assert.deepEqual(Object.keys(text).filter(key=>key.startsWith('images.')),['images.image_1']);
  assert.equal(text.prompt,prompt);assert.equal(text.negative_prompt,TURNAROUND_NEGATIVE);assert(!text.prompt.includes(SINGLE_SUBJECT_PROMPT));assert(!text.negative_prompt.includes('turnaround'));
  const regular=buildComfyPrompt(TEMPLATE,{...shot,jobKind:undefined},{character:'role.png',garment:'outfit.png'}),regularText=Object.values(regular).find(row=>row.class_type==='TextEncodeQwenImage21').inputs;
  assert(regularText.prompt.includes(SINGLE_SUBJECT_PROMPT));assert(regularText.negative_prompt.includes('character turnaround'));
  for(const value of [null,42,'','  ','x'.repeat(4001)]) assert.throws(()=>normalizeCharacterPromptSettings({...settings,turnaroundPrompt:value}));
  const legacy={...settings};delete legacy.turnaroundPrompt;assert.equal(normalizeCharacterPromptSettings(legacy).turnaroundPrompt,DEFAULT_TURNAROUND_PROMPT);
});

test('三視圖從 CFG 1 啟用負面引導，保留較高 CFG、一般拍攝與原工作流',()=>{
  const shot={id:randomUUID(),jobKind:'character-turnaround',prompt:DEFAULT_TURNAROUND_PROMPT,negative:TURNAROUND_NEGATIVE,resolution:1024,steps:30,seed:100,aspectRatio:'16:9'};
  for(const cfg of [1,2,4]) {
    const template=structuredClone(TEMPLATE);template['7'].inputs.cfg=cfg;const before=structuredClone(template);
    const turnaround=buildComfyPrompt(template,shot,{character:'role.png'}),regular=buildComfyPrompt(template,{...shot,jobKind:undefined},{character:'role.png'});
    assert.equal(turnaround['7'].inputs.cfg,Math.max(3,cfg));
    assert.equal(regular['7'].inputs.cfg,cfg);assert.deepEqual(template,before);
  }
});

test('三視圖先產圖與私人預覽，確認前不新增角色或正式拍攝，保存的提詞設定參與生成',async t=>{
  const f=await previewFixture();t.after(()=>f.close());
  const settings=defaultCharacterPromptSettings();settings.turnaroundPrompt='Three views of the same character, front, profile, back.';settings.cupPrompts.C='custom C shape';settings.heightPrompts['160to170']='custom medium height';
  assert.equal((await f.request('/character-prompt-settings',settings,'PUT')).status,200);
  const before=f.store.read(),result=await start(f,randomUUID(),{cupSize:'C',heightCm:166});assert.equal(result.status,202);
  await until(()=>f.submitted.length===1);
  const text=Object.values(f.submitted[0].prompt).find(row=>row.class_type==='TextEncodeQwenImage21').inputs;
  assert.equal(Object.values(f.submitted[0].prompt).find(row=>row.class_type==='KSampler').inputs.cfg,3);
  assert(text.prompt.includes(settings.turnaroundPrompt));assert(text.prompt.includes('custom C shape'));assert(text.prompt.includes('custom medium height'));assert(!text.prompt.includes(SINGLE_SUBJECT_PROMPT));
  assert.equal((await start(f,result.id,{cupSize:'C',heightCm:166})).status,202);assert.equal(f.submitted.length,1);
  assert.equal((await start(f,result.id,{heightCm:167})).status,409);
  f.complete(f.submitted[0].id);const status=await f.request(`/character-turnarounds/${result.id}`);assert.equal(status.data.status,'completed');assert.equal(status.data.profile.heightCm,166);
  const image=await adminFetch(f.base+status.data.image);assert.equal(image.status,200);assert.deepEqual(Buffer.from(await image.arrayBuffer()),PNG);
  assert.equal(f.store.read().characters.length,before.characters.length);assert.equal(f.store.read().jobs.length,before.jobs.length);
  assert.deepEqual(f.calls.filter(route=>['/free','/interrupt'].includes(route)),[]);
  await f.request(`/character-turnarounds/${result.id}`,undefined,'DELETE');await f.characterTurnarounds.tick();
  assert.equal((await f.request(`/character-turnarounds/${result.id}`)).status,410);assert(!fs.existsSync(path.join(f.dataDir,'character-turnarounds',result.id)));assert(!fs.existsSync(path.join(f.outputDir,'PhotoCreate','_character_turnarounds',result.id)));
});

test('三視圖保存的自訂或空白負面提詞原樣送入編碼器，已送出轉圖保留快照',async t=>{
  for(const negative of ['custom floating head exclusion\ncustom hairstyle exclusion','']) await t.test(negative ? '自訂負面提詞' : '空白負面提詞',async t=>{
    const f=await previewFixture();t.after(()=>f.close());
    const settings=defaultCharacterPromptSettings();settings.turnaroundNegative=negative;
    assert.equal((await f.request('/character-prompt-settings',settings,'PUT')).status,200);
    const result=await start(f);assert.equal(result.data.negative,negative);await until(()=>f.submitted.length===1);
    const text=Object.values(f.submitted[0].prompt).find(row=>row.class_type==='TextEncodeQwenImage21').inputs;
    assert.equal(text.negative_prompt,negative);
    settings.turnaroundNegative='later exclusions';await f.request('/character-prompt-settings',settings,'PUT');
    assert.equal((await f.request(`/character-turnarounds/${result.id}`)).data.negative,negative);
    assert.equal(text.negative_prompt,negative);
  });
});

test('三視圖 API 隔離顧客、管理員與未登入者，顧客可轉圖和讀取自己的預覽',async t=>{
  const f=await previewFixture();t.after(()=>f.close());
  await f.authentication.createCustomer({username:'turnaround-alice',password:'turnaround-password'});await f.authentication.createCustomer({username:'turnaround-bob',password:'turnaround-password'});
  const alice=await login(f.base,'turnaround-alice','turnaround-password'),bob=await login(f.base,'turnaround-bob','turnaround-password'),id=randomUUID();
  const call=(session,route,method='GET',body)=>fetch(f.base+'/api/studio'+route,{method,headers:{Cookie:session.cookie},...(body && {body})});
  assert.equal((await call(alice,`/character-turnarounds/${id}`,'PUT',form({cupSize:'D',heightCm:172}))).status,202);await until(()=>f.submitted.length===1);
  for(const method of ['GET','DELETE']) assert.equal((await call(bob,`/character-turnarounds/${id}`,method)).status,404);
  assert.equal((await call(bob,`/character-turnarounds/${id}`,'PUT',form())).status,404);
  assert.equal((await f.request(`/character-turnarounds/${id}`)).status,404);
  assert.equal((await fetch(f.base+`/api/studio/character-turnarounds/${id}`)).status,401);
  f.complete(f.submitted[0].id);const result=await (await call(alice,`/character-turnarounds/${id}`)).json();assert.equal(result.status,'completed');assert(result.image.startsWith('/api/studio/'));
  assert.equal((await call(bob,`/character-turnarounds/${id}/image`)).status,404);assert.equal((await call(alice,`/character-turnarounds/${id}/image`)).status,200);
  assert(!JSON.stringify(result).includes(f.dataDir));assert(!JSON.stringify(result).includes('127.0.0.1:8188'));
});

test('取消可以先於上傳及送出，穩定 prompt ID 可取消遺失回應的單一轉圖，不影響其他任務',async t=>{
  const f=await previewFixture();t.after(()=>f.close());
  const late=randomUUID();await f.request(`/character-turnarounds/${late}`,undefined,'DELETE');assert.equal((await start(f,late)).status,410);assert.equal(f.submitted.length,0);
  let release;f.control.uploadGate=new Promise(resolve=>{release=resolve;});const upload=await start(f);assert.equal(upload.status,202);
  await until(()=>f.calls.includes('/upload/image'));await f.request(`/character-turnarounds/${upload.id}`,undefined,'DELETE');release();f.control.uploadGate=null;
  await until(()=>!f.characterTurnarounds.hasWork());assert.equal(f.submitted.length,0);
  f.control.loseReply=true;const lost=await start(f);await until(()=>f.submitted.length===1);const promptId=f.submitted[0].id;
  await f.request(`/character-turnarounds/${lost.id}`,undefined,'DELETE');await f.characterTurnarounds.tick();await until(()=>f.cancelled.includes(promptId));
  assert(!f.pending.has(promptId));assert(!f.calls.includes('/interrupt'));assert(!f.calls.includes('/free'));
});

test('無效圖片或角色資料不產圖；晚到的生成成果與連結目錄不會波及其他檔案',async t=>{
  const f=await previewFixture();t.after(()=>f.close());
  assert.equal((await start(f,randomUUID(),{cupSize:'AA'})).status,400);assert.equal((await start(f,randomUUID(),{},Buffer.from('not a PNG'))).status,400);assert.equal(f.submitted.length,0);
  const result=await start(f);await until(()=>f.submitted.length===1);const owned=path.join(f.outputDir,'PhotoCreate','_character_turnarounds',result.id),other=path.join(f.outputDir,'PhotoCreate','retained');fs.mkdirSync(other,{recursive:true});fs.writeFileSync(path.join(other,'photo.png'),PNG);
  await f.request(`/character-turnarounds/${result.id}`,undefined,'DELETE');f.complete(f.submitted[0].id);
  await until(async()=>{await f.characterTurnarounds.tick();return !fs.existsSync(owned);});assert(fs.existsSync(path.join(other,'photo.png')));
  const linked=randomUUID(),link=path.join(f.outputDir,'PhotoCreate','_character_turnarounds',linked);fs.mkdirSync(path.dirname(link),{recursive:true});fs.symlinkSync(other,link,'junction');
  assert.throws(()=>removeTurnaroundDirectory(f.outputDir,['PhotoCreate','_character_turnarounds',linked]),/連結/);assert(fs.existsSync(path.join(other,'photo.png')));fs.unlinkSync(link);
});

test('服務重開只清理原轉圖的暫存與佇列，不恢復未確認角色或取消其他任務',async t=>{
  const id=randomUUID(),promptId=randomUUID(),foreignId=randomUUID();let cache,output,retained;
  const f=await previewFixture({beforeStart:({dataDir,outputDir,pending})=>{
    cache=path.join(dataDir,'character-turnarounds',id);output=path.join(outputDir,'PhotoCreate','_character_turnarounds',id);retained=path.join(outputDir,'PhotoCreate','retained.png');
    for(const directory of [cache,output]) fs.mkdirSync(directory,{recursive:true});
    fs.writeFileSync(path.join(cache,'result.png'),PNG);fs.writeFileSync(path.join(output,'sheet_00001_.png'),PNG);fs.writeFileSync(retained,PNG);
    fs.writeFileSync(path.join(dataDir,'character-turnarounds.json'),JSON.stringify({version:1,sessions:[{id,owner:'admin',createdAt:Date.now(),comfyUrl:'http://127.0.0.1:8188',outputRoot:outputDir,promptIds:[promptId]}]}));
    pending.add(promptId);pending.add(foreignId);
  }});t.after(()=>f.close());
  await until(()=>f.cancelled.includes(promptId) && !fs.existsSync(cache) && !fs.existsSync(output));
  assert(!f.pending.has(promptId));assert(f.pending.has(foreignId));assert(fs.existsSync(retained));assert.equal(f.submitted.length,0);assert.equal((await f.request(`/character-turnarounds/${id}`)).status,410);
});

test('未操作的預覽逾時會取消；圖轉圖未就緒不建立任務；圖片暫存不能跟隨 junction',async t=>{
  let time=1000;const f=await previewFixture({characterTurnaroundOptions:{clock:()=>time,sessionTtl:100}});t.after(()=>f.close());
  const result=await start(f);await until(()=>f.submitted.length===1);time+=101;await f.characterTurnarounds.tick();
  await until(async()=>{await f.characterTurnarounds.tick();return !f.characterTurnarounds.hasWork();});assert.equal((await f.request(`/character-turnarounds/${result.id}`)).status,410);assert(f.cancelled.includes(f.submitted[0].id));
  const template=f.store.read().workflow;f.store.mutate(state=>{state.workflow=null;});assert.equal((await start(f)).status,503);assert.equal(f.submitted.length,1);f.store.mutate(state=>{state.workflow=template;});
  const second=await start(f);await until(()=>f.submitted.length===2);f.complete(f.submitted[1].id);
  const other=path.join(f.dataDir,'untouched'),link=path.join(f.dataDir,'character-turnarounds');fs.mkdirSync(other);fs.writeFileSync(path.join(other,'retained.png'),PNG);fs.symlinkSync(other,link,'junction');
  try {
    await until(async()=>{const response=await f.request(`/character-turnarounds/${second.id}`);return response.data.status==='failed';});
    assert.deepEqual(fs.readdirSync(other),['retained.png']);assert.equal((await f.request(`/character-turnarounds/${second.id}/image`)).status,400);
  } finally {fs.unlinkSync(link);}
});
