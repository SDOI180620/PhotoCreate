import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {CHARACTER_HEIGHT_RANGES,CHARACTER_PROMPT_MAX_LENGTH,CUP_SIZES,characterHeightRange,characterProfilePrompt,defaultCharacterPromptSettings,normalizeCharacterPromptSettings} from '../shared/character-profile.js';
import {buildShotPlans,composePrompt} from '../shared/domain.js';
import {customPhotoPrompt} from '../shared/photo-customization.js';
import {buildRemakePlans} from '../shared/remakes.js';
import {createStore} from '../server/store.js';
import {previewFixture,until} from './preset-preview-fixture.js';
import {login} from './auth-client.js';
import {DRAFT,fixtureState,PNG} from './fixtures.js';

test('身高區間完整、不重疊，邊界與小數選擇正確的提詞',()=>{
  const settings=defaultCharacterPromptSettings();
  for(const [height,id] of [[0.1,'below140'],[139.9,'below140'],[140,'140to150'],[149.9,'140to150'],[150,'150to160'],[159.9,'150to160'],[160,'160to170'],[169.9,'160to170'],[170,'170plus'],[1000,'170plus']]) {
    assert.equal(characterHeightRange(height)?.id,id);
    assert.equal(CHARACTER_HEIGHT_RANGES.filter(row=>height>=row.min && height<row.max).length,1);
    const prompt=characterProfilePrompt({heightCm:height},settings);
    assert.match(prompt,new RegExp(`height ${height} cm`));
    assert(prompt.endsWith(`Height appearance: ${settings.heightPrompts[id]}`));
  }
  for(const height of [undefined,'160',0,-1,1001,NaN,Infinity]) assert.equal(characterHeightRange(height),undefined);
});

test('Cup A–Z 可獨立修改與留白，未填寫的角色資料不加入描述',()=>{
  const settings=defaultCharacterPromptSettings();
  for(const cup of CUP_SIZES) settings.cupPrompts[cup]=`description for ${cup}`;
  for(const cup of CUP_SIZES) assert.equal(characterProfilePrompt({cupSize:cup},settings),`Character measurements: breast size ${cup} cup (description for ${cup}).`);
  settings.cupPrompts.B='';settings.heightPrompts['160to170']='';
  assert.equal(characterProfilePrompt({cupSize:'B',heightCm:165},settings),'Character measurements: height 165 cm; breast size B cup.');
  assert.equal(characterProfilePrompt({},settings),'');
  assert.doesNotMatch(characterProfilePrompt({heightCm:150},settings),/breast size/);
  assert.doesNotMatch(characterProfilePrompt({cupSize:'A'},settings),/height|stature/i);
  settings.heightPrompts.below140='very short proportions';settings.heightPrompts['140to150']='short proportions';
  assert(characterProfilePrompt({heightCm:130},settings).includes('very short proportions'));
  assert(!characterProfilePrompt({heightCm:130},settings).includes('Height appearance: short proportions'));
});

test('設定須完整且長度有效，保存時清理空白並隔離物件',()=>{
  const input=defaultCharacterPromptSettings();input.heightPrompts.below140='  short proportions\n ';input.cupPrompts.A='  ';
  const normalized=normalizeCharacterPromptSettings(input);
  assert.equal(normalized.heightPrompts.below140,'short proportions');assert.equal(normalized.cupPrompts.A,'');
  normalized.cupPrompts.B='changed';assert.notEqual(normalized.cupPrompts.B,input.cupPrompts.B);
  for(const invalid of [null,[],{}, {...input,heightPrompts:[]},{...input,cupPrompts:{...input.cupPrompts,A:42}},{...input,cupPrompts:{...input.cupPrompts,Z:'x'.repeat(CHARACTER_PROMPT_MAX_LENGTH+1)}}]) assert.throws(()=>normalizeCharacterPromptSettings(invalid));
  const missing=structuredClone(input);delete missing.heightPrompts['160to170'];assert.throws(()=>normalizeCharacterPromptSettings(missing));
});

test('新拍攝及工作檯預覽使用設定，重製與角度後自訂保留當時提詞',()=>{
  const state=fixtureState(),settings=defaultCharacterPromptSettings();
  settings.heightPrompts['160to170']='custom height proportions';settings.cupPrompts.F='custom cup proportions';
  state.settings={characterPrompts:settings};Object.assign(state.characters[0],{heightCm:168,cupSize:'F'});
  const shot=buildShotPlans(state,DRAFT)[0];
  assert(shot.prompt.includes('Height appearance: custom height proportions'));assert(shot.prompt.includes('F cup (custom cup proportions)'));
  assert.equal(composePrompt({...shot,characterMeasurementsPrompt:undefined,characterPromptSettings:settings,extra:DRAFT.extra}),shot.prompt);
  settings.heightPrompts['160to170']='new height description';settings.cupPrompts.F='new cup description';
  const next=buildShotPlans(state,DRAFT)[0];assert(next.prompt.includes('new height description'));assert(next.prompt.includes('new cup description'));
  Object.assign(shot,{status:'completed',images:[{filename:'result.png',subfolder:'',type:'output'}]});state.jobs=[shot];
  const remake=buildRemakePlans(state,[shot.id],{requestId:randomUUID()})[0];
  assert.equal(remake.characterMeasurementsPrompt,shot.characterMeasurementsPrompt);
  for(const source of [shot,{...remake,jobKind:'angle-edit',prompt:'camera instructions'}]) {
    const customized=customPhotoPrompt({useOriginal:{pose:false},changes:{pose:'Standing by a tree.'}},source);
    assert(customized.includes('custom height proportions'));assert(customized.includes('custom cup proportions'));assert(!customized.includes('new height description'));assert(!customized.includes('new cup description'));
  }
});

test('設定 API 保存至 SQLite、拒絕錯誤更新且顧客不能修改',async t=>{
  const f=await previewFixture();t.after(()=>f.close());
  const state=await f.request('/state');assert.equal(state.data.features.characterPromptSettings,1);assert.deepEqual(state.data.settings.characterPrompts,defaultCharacterPromptSettings());
  const settings=defaultCharacterPromptSettings();settings.turnaroundPrompt='Custom three-view instruction.';settings.heightPrompts['170plus']='  tall custom proportions  ';settings.cupPrompts.Z='unique Z description';
  const saved=await f.request('/character-prompt-settings',settings,'PUT');assert.equal(saved.status,200);assert.equal(saved.data.heightPrompts['170plus'],'tall custom proportions');
  const legacy=structuredClone(saved.data);delete legacy.turnaroundPrompt;assert.equal((await f.request('/character-prompt-settings',legacy,'PUT')).data.turnaroundPrompt,settings.turnaroundPrompt);
  assert.equal((await f.request('/character-prompt-settings',{heightPrompts:[]},'PUT')).status,400);assert.deepEqual(f.store.read().settings.characterPrompts,saved.data);
  const reopened=createStore(f.dataDir);try {assert.deepEqual(reopened.read().settings.characterPrompts,saved.data);} finally {reopened.close();}
  await f.authentication.createCustomer({username:'prompt-settings-customer',password:'profile-password'});
  const session=await login(f.base,'prompt-settings-customer','profile-password');
  const response=await fetch(f.base+'/api/character-prompt-settings',{method:'PUT',headers:{Cookie:session.cookie,'content-type':'application/json'},body:JSON.stringify(defaultCharacterPromptSettings())});
  assert.equal(response.status,403);assert.deepEqual(f.store.read().settings.characterPrompts,saved.data);
});

test('舊安裝缺少提詞設定時補上預設值',async t=>{
  const f=await previewFixture();t.after(()=>f.close());f.store.mutate(state=>{delete state.settings.characterPrompts;});
  const reopened=createStore(f.dataDir);try {assert.deepEqual(reopened.read().settings.characterPrompts,defaultCharacterPromptSettings());} finally {reopened.close();}
});

test('舊 Cup 與身高設定補上三視圖提詞時保留自訂內容',async t=>{
  const f=await previewFixture();t.after(()=>f.close());
  const legacy=defaultCharacterPromptSettings();delete legacy.turnaroundPrompt;legacy.cupPrompts.B='My small bust prompt';legacy.heightPrompts.below140='My very short height prompt';
  f.store.mutate(state=>{state.settings.characterPrompts=legacy;});
  const reopened=createStore(f.dataDir);try {
    assert.deepEqual(reopened.read().settings.characterPrompts,{...legacy,turnaroundPrompt:defaultCharacterPromptSettings().turnaroundPrompt});
  } finally {reopened.close();}
});

test('管理員與顧客的新拍攝套用最新保存的設定，不依賴重新發布候選',async t=>{
  const f=await previewFixture();t.after(()=>f.close());
  f.store.mutate(state=>{Object.assign(state.characters[0],{cupSize:'B',heightCm:145});});
  const first=defaultCharacterPromptSettings();first.heightPrompts['140to150']='first height setting';first.cupPrompts.B='first cup setting';
  assert.equal((await f.request('/character-prompt-settings',first,'PUT')).status,200);
  const adminShots=await f.request('/jobs',DRAFT);assert.equal(adminShots.status,201);assert(adminShots.data[0].prompt.includes('first height setting'));assert(adminShots.data[0].prompt.includes('first cup setting'));
  await f.request('/state');
  const latest=defaultCharacterPromptSettings();latest.heightPrompts['170plus']='latest tall setting';latest.cupPrompts.D='latest cup setting';
  assert.equal((await f.request('/character-prompt-settings',latest,'PUT')).status,200);
  assert(f.store.read().jobs.find(row=>row.id===adminShots.data[0].id).prompt.includes('first height setting'));
  await f.authentication.createCustomer({username:'prompt-settings-shoot',password:'profile-password'});
  const session=await login(f.base,'prompt-settings-shoot','profile-password');
  const call=async(route,body)=>fetch(f.base+'/api/studio'+route,{method:'POST',headers:{Cookie:session.cookie,...(body instanceof FormData ? {} : {'content-type':'application/json'})},body:body instanceof FormData ? body : JSON.stringify(body)});
  const upload=new FormData();upload.append('image',new Blob([PNG],{type:'image/png'}),'configured.png');upload.append('profiles',JSON.stringify([{cupSize:'D',heightCm:172}]));
  const characterResponse=await call('/characters',upload);assert.equal(characterResponse.status,201);const character=await characterResponse.json();
  const shoot=await call('/shoots',{characterId:character.id,count:1,aspectRatio:'9:16',requestId:randomUUID()});assert.equal(shoot.status,202);
  await until(()=>f.submitted.length>0);const prompt=Object.values(f.submitted[0].prompt).find(row=>row.class_type==='TextEncodeQwenImage21').inputs.prompt;
  assert(prompt.includes('latest tall setting'));assert(prompt.includes('D cup (latest cup setting)'));
});
