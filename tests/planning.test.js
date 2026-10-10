import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildShotPlans} from '../shared/domain.js';
import {buildRemakePlans} from '../shared/remakes.js';
import {DRAFT,fixtureState} from './fixtures.js';

const signature = shot => ['garment','pose','camera','lighting','color','quality','expression','clothingState','interaction'].map(key => shot[key]?.id || '').join('|');
const randomDraft = {...DRAFT,mode:'random',randomCount:30,randomPoolMode:'all',garmentIds:[],poseIds:[],cameraId:'',lightingId:'',colorId:'',qualityId:''};

test('角色複選展開組合，隨機總張數不變，每張保存單一角色快照',()=>{
  const state=fixtureState();state.characters.push({...state.characters[0],id:'second-character',name:'第二位角色',description:'Second character details.'});
  const draft={...DRAFT,characterIds:['character','second-character','character'],garmentIds:['garment-a'],poseIds:['pose-standing'],copies:1};
  const shots=buildShotPlans(state,draft);assert.equal(shots.length,2);
  assert.deepEqual(shots.map(shot=>shot.character.id),['character','second-character']);
  const random=buildShotPlans(state,{...draft,mode:'random',randomPoolMode:'selected',randomCount:8});assert.equal(random.length,8);
  for(let index=0;index<8;index+=2) assert.equal(new Set(random.slice(index,index+2).map(shot=>shot.character.id)).size,2);
  assert.equal(buildShotPlans(state,{...draft,copies:2}).length,4);
  assert.throws(()=>buildShotPlans(state,{...draft,characterIds:[]}),/角色/);
  assert.throws(()=>buildShotPlans(state,{...draft,characterIds:['missing']}),/角色/);
  assert.throws(()=>buildShotPlans(state,{...draft,characterIds:'character'}),/角色/);
  state.characters[1].description='Changed later';assert.equal(shots[1].character.description,'Second character details.');
});

test('四類攝影複選產生所有組合，每張只取各類一項，不混合互斥提詞',() => {
  const state = fixtureState();
  const draft = {...DRAFT,garmentIds:['garment-a'],poseIds:['pose-standing'],copies:1};
  for(const category of ['camera','lighting','color','quality']) draft[`${category}Ids`] = state.presets.filter(row=>row.category===category).slice(0,2).map(row=>row.id);
  const shots = buildShotPlans(state,draft);
  assert.equal(shots.length,16);assert.equal(new Set(shots.map(signature)).size,16);
  for(const shot of shots) for(const category of ['camera','lighting','color','quality']) {
    assert(draft[`${category}Ids`].includes(shot[category].id));
    const other = state.presets.find(row=>row.id!==shot[category].id && draft[`${category}Ids`].includes(row.id));
    assert(shot.prompt.includes(shot[category].prompt));assert(!shot.prompt.includes(other.prompt));
  }
  state.presets.find(row=>row.id===shots[0].camera.id).prompt = 'changed';
  assert.notEqual(shots[0].camera.prompt,'changed');
});

test('候選去重、驗證分類與數量上限，空候選不可建立',() => {
  const state = fixtureState();
  assert.equal(buildShotPlans(state,{...DRAFT,garmentIds:Array(30).fill('garment-a')}).length,4);
  assert.throws(()=>buildShotPlans(state,{...DRAFT,cameraIds:[]}),/攝影角度/);
  assert.throws(()=>buildShotPlans(state,{...DRAFT,cameraIds:['light-window']}),/攝影角度/);
  assert.throws(()=>buildShotPlans(state,{...DRAFT,lightingIds:'light-window'}),/候選格式/);
  const broad = {...DRAFT,cameraIds:state.presets.filter(row=>row.category==='camera').map(row=>row.id),lightingIds:state.presets.filter(row=>row.category==='lighting').map(row=>row.id),colorIds:state.presets.filter(row=>row.category==='color').map(row=>row.id)};
  assert.throws(()=>buildShotPlans(state,broad),/100/);
});

test('取消鏡頭不增加角度組合，無候選也可產圖；勾選後恢復所選角度',() => {
  const state=fixtureState(),draft={...DRAFT,cameraMode:'multiangle',cameraEnabled:false,garmentIds:['garment-a'],poseIds:['pose-standing'],copies:1,cameraIds:state.presets.filter(row=>row.category==='camera').slice(0,2).map(row=>row.id)};
  const [shot]=buildShotPlans(state,draft);
  assert.equal(buildShotPlans(state,draft).length,1);assert.equal(shot.cameraEnabled,false);
  assert.deepEqual(shot.camera.angle,{horizontalAngle:0,verticalAngle:0,zoom:5});
  assert.equal(buildShotPlans(state,{...draft,cameraIds:[]}).length,1);
  assert.equal(buildShotPlans(state,{...draft,cameraEnabled:true}).length,2);
  assert.throws(()=>buildShotPlans(state,{...draft,cameraEnabled:'false'}),/鏡頭開關/);
});

test('隨機寫真只給角色與張數，即從全庫生成精確30張，選填預設無',() => {
  const state = fixtureState();
  const before = structuredClone(state);
  const shots = buildShotPlans(state,randomDraft);
  assert.equal(shots.length,30);assert.equal(new Set(shots.map(signature)).size,30);
  for(const shot of shots){
    assert.equal(shot.character.id,'character');assert.equal(shot.generationMode,'random');
    assert.equal(shot.expression,null);assert.equal(shot.clothingState,null);assert.equal(shot.interaction,null);
    assert(shot.prompt.startsWith('1 girl\n\n'));assert.doesNotMatch(shot.prompt,/Facial expression:|Clothing state:|Scene interaction:|Picture 3/);
  }
  for(const key of ['garment','pose','camera','lighting','color','quality']) assert(new Set(shots.map(row=>row[key].id)).size>1,key);
  assert.deepEqual(state,before);
  assert.deepEqual(buildShotPlans(state,randomDraft).map(signature),shots.map(signature));
  assert.deepEqual(shots.map(row=>row.seed),Array.from({length:30},(_,i)=>100+i));
});

test('隨機服裝依勾選範圍，可限制整組候選並避免重複直到耗盡',() => {
  const state = fixtureState();
  assert(buildShotPlans(state,{...randomDraft,garmentIds:['garment-b']}).every(row=>row.garment.id==='garment-b'));
  const shots = buildShotPlans(state,{...DRAFT,mode:'random',randomPoolMode:'selected',randomCount:12,copies:0});
  for(let i=0;i<12;i+=4) assert.equal(new Set(shots.slice(i,i+4).map(signature)).size,4);
  assert.equal(new Set(shots.map(row=>row.seed)).size,12);
  for(const row of shots) {assert(DRAFT.garmentIds.includes(row.garment.id));assert(DRAFT.poseIds.includes(row.pose.id));assert.equal(row.camera.id,DRAFT.cameraId);}
});

test('相容舊版隨機啟用設定，保留比例、快照與重製組合',() => {
  const state = fixtureState();
  const shots = buildShotPlans(state,{...randomDraft,aspectRatio:'9:16',randomOptional:{expression:true,clothing_state:true,interaction:true}});
  for(const shot of shots){
    assert(shot.expression && shot.clothingState && shot.interaction);
    assert.match(shot.prompt,/Facial expression:.*\n\nClothing state:/s);assert.match(shot.prompt,/Scene interaction:/);
    assert.equal(shot.outputWidth,1152);assert.equal(shot.outputHeight,2048);
  }
  const source = {...shots[0],batchId:'random-batch',status:'completed',images:[{filename:'test.png'}]};
  const [remake] = buildRemakePlans({...state,jobs:[source]},[source.id],{requestId:'random-remake',deleteSourceOnComplete:false});
  assert.equal(signature(remake),signature(source));assert.equal(remake.prompt,source.prompt);assert.equal(remake.outputWidth,1152);
  assert.notEqual(remake.seed,source.seed);
});

test('隨機模式拒絕無效張數與空服裝圖庫；龐大候選池仍只建立指定張數',() => {
  const state = fixtureState();
  for(const randomCount of [0,101,1.5,'bad']) assert.throws(()=>buildShotPlans(state,{...randomDraft,randomCount}),/1–100/);
  assert.throws(()=>buildShotPlans({...state,garments:[]},randomDraft),/服裝/);
  assert.throws(()=>buildShotPlans(state,{...randomDraft,randomPoolMode:'unknown'}),/候選範圍/);
  assert.throws(()=>buildShotPlans(state,{...randomDraft,randomOptional:{expression:'true'}}),/選填/);
  assert.throws(()=>buildShotPlans(state,{...randomDraft,mode:'unknown'}),/模式/);
  for(const category of ['pose','camera','lighting','color','quality']) state.presets.push(...Array.from({length:1500},(_,i)=>({id:`large-${category}-${i}`,category,name:`${category}-${i}`,prompt:`${category} ${i}`})));
  const shots = buildShotPlans(state,{...randomDraft,randomCount:100});
  assert.equal(shots.length,100);assert.equal(new Set(shots.map(signature)).size,100);
});
