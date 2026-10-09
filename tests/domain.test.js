import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildShotPlans, normalizePresetImport } from '../shared/domain.js';
import { buildComfyPrompt, convertWorkflow } from '../server/workflow.js';
import { DRAFT, TEMPLATE, fixtureState } from './fixtures.js';

test('服裝 × 動作 × 張數產生独立快照與可重現的 Seed',() => {
  const state = fixtureState();
  const shots = buildShotPlans(state,DRAFT);
  assert.equal(shots.length,8);
  assert.deepEqual(shots.map(row => row.seed),[100,101,102,103,104,105,106,107]);
  assert.equal(new Set(shots.map(row => row.id)).size,8);
  assert.match(shots[0].prompt,/<image1>.*<image2>/);
  assert.doesNotMatch(shots[0].prompt,/Picture 3|Environment:|Scene interaction:|Facial expression:|Clothing state:/);
  assert.doesNotMatch(shots[0].prompt,/白色洋裝的描述|Clothing:|Picture 1|Picture 2/);
  assert.match(shots[0].prompt,/保持刺繡/);
  state.garments[0].name = 'changed';state.presets[0].prompt = 'changed';
  assert.equal(shots[0].garment.name,'白色洋裝');
  assert.notEqual(shots[0].pose.prompt,'changed');
});

test('角色使用圖庫提詞，服裝備註只保留快照，忽略已移除的首頁草稿覆寫',() => {
  const state = fixtureState();
  const before = structuredClone(state);
  const shots = buildShotPlans(state,{...DRAFT,referencePrompts:{character:'Hidden old character text','garment-a':'Hidden old garment text','garment-b':''}});
  for(const shot of shots) {
    const garment = state.garments.find(row => row.id === shot.garment.id);
    assert.equal(shot.character.description,state.characters[0].description);
    assert.equal(shot.garment.description,garment.description);
    assert.ok(shot.prompt.includes(`Character details: ${state.characters[0].description}`));
    assert.ok(!shot.prompt.includes(garment.description));
    assert.match(shot.prompt,/<image1>.*<image2>/);
    assert.doesNotMatch(shot.prompt,/Hidden old/);
    assert.ok(shot.prompt.startsWith('1 girl\n\n'));
  }
  assert.deepEqual(state,before);
});

test('角色提詞修改套用到新拍攝，服裝備註改動保存在快照且不加入提詞',() => {
  const state = fixtureState();
  const original = buildShotPlans(state,DRAFT)[0];
  state.characters[0].description = 'Preserve the same freckles and hairstyle.';
  state.garments[0].description = 'White linen with embroidered trim.';
  const edited = buildShotPlans(state,DRAFT)[0];
  assert.match(edited.prompt,/Character details: Preserve the same freckles and hairstyle\./);
  assert.doesNotMatch(edited.prompt,/Clothing:|White linen with embroidered trim/);
  assert.notEqual(original.character.description,edited.character.description);
  assert.notEqual(original.garment.description,edited.garment.description);
  assert.equal(original.garment.description,'白色洋裝的描述');
  assert.doesNotMatch(original.prompt,/白色洋裝的描述/);
  state.characters[0].description = '';state.garments[0].description = '  ';
  const cleared = buildShotPlans(state,DRAFT)[0];
  assert.doesNotMatch(cleared.prompt,/Character details:|Clothing:/);
  assert.equal(edited.garment.description,'White linen with embroidered trim.');
});

test('表情與服裝狀態預設無，各自選用後保存快照，清除後不加入提詞',() => {
  const state = fixtureState();
  const original = buildShotPlans(state,DRAFT)[0];
  assert.equal(original.expression,null);assert.equal(original.clothingState,null);
  const expression = state.presets.find(row => row.id === 'expression-smile');
  const clothingState = state.presets.find(row => row.id === 'clothing-state-folds');
  const selected = buildShotPlans(state,{...DRAFT,expressionId:expression.id,clothingStateId:clothingState.id})[0];
  assert.deepEqual(selected.expression,expression);assert.deepEqual(selected.clothingState,clothingState);
  assert.ok(selected.prompt.includes(`Facial expression: ${expression.prompt}`));
  assert.ok(selected.prompt.includes(`Clothing state: ${clothingState.prompt}`));
  assert.doesNotMatch(selected.prompt,/Pose and expression:|Scene interaction:|Picture 3/);
  const expressionOnly = buildShotPlans(state,{...DRAFT,expressionId:expression.id,clothingStateId:''})[0];
  assert.match(expressionOnly.prompt,/Facial expression:/);assert.doesNotMatch(expressionOnly.prompt,/Clothing state:/);
  const clothingOnly = buildShotPlans(state,{...DRAFT,expressionId:'',clothingStateId:clothingState.id})[0];
  assert.match(clothingOnly.prompt,/Clothing state:/);assert.doesNotMatch(clothingOnly.prompt,/Facial expression:/);
  const cleared = buildShotPlans(state,{...DRAFT,expressionId:'',clothingStateId:''})[0];
  assert.equal(cleared.prompt,original.prompt);
  expression.prompt = 'Edited expression';clothingState.prompt = 'Edited clothing state';
  assert.notEqual(selected.expression.prompt,expression.prompt);assert.notEqual(selected.clothingState.prompt,clothingState.prompt);
  assert.throws(() => buildShotPlans(state,{...DRAFT,expressionId:'camera-full'}),/表情/);
  assert.throws(() => buildShotPlans(state,{...DRAFT,expressionId:'missing'}),/表情/);
  assert.throws(() => buildShotPlans(state,{...DRAFT,clothingStateId:'expression-smile'}),/服裝狀態/);
  assert.throws(() => buildShotPlans(state,{...DRAFT,clothingStateId:'missing'}),/服裝狀態/);
});

test('表情與服裝狀態支援 JSON 匯入，素材與提詞名稱不代替提詞內容',() => {
  const state = fixtureState();
  state.presets.push(...normalizePresetImport({version:1,presets:[
    {id:'custom-expression',category:'expression',name:'expression-file-name',prompt:'  A subtle smile.  ',tags:['微笑']},
    {id:'custom-clothing-state',category:'clothing_state',name:'clothing-file-name',prompt:'  Sleeves are neatly rolled to the elbows.  ',tags:['袖子']},
  ]}));
  const shot = buildShotPlans(state,{...DRAFT,expressionId:'custom-expression',clothingStateId:'custom-clothing-state'})[0];
  assert.match(shot.prompt,/Facial expression: A subtle smile\./);
  assert.match(shot.prompt,/Clothing state: Sleeves are neatly rolled to the elbows\./);
  assert.doesNotMatch(shot.prompt,/expression-file-name|clothing-file-name/);
});
test('無效參考、錯誤分類與過量組合皆阻止建立',() => {
  const state = fixtureState();
  assert.throws(() => buildShotPlans(state,{...DRAFT,characterId:'missing'}),/角色/);
  assert.throws(() => buildShotPlans(state,{...DRAFT,poseIds:['camera-full']}),/動作/);
  assert.throws(() => buildShotPlans(state,{...DRAFT,copies:0}),/張數/);
  assert.throws(() => buildShotPlans(state,{...DRAFT,resolution:600}),/解析度/);
  const many = {...state,garments:Array.from({length:30},(_,i) => ({...state.garments[0],id:`garment-${i}`}))};
  assert.throws(() => buildShotPlans(many,{...DRAFT,garmentIds:many.garments.map(row => row.id)}),/100/);
  assert.throws(() => buildShotPlans(state,{...DRAFT,sceneInteraction:123}),/場景互動/);
  assert.throws(() => buildShotPlans(state,{...DRAFT,aspectRatio:'unsupported'}),/輸出比例/);
});

test('橫式、直式與方形生成尺寸保持精確比例並保存到拍攝快照',() => {
  const state = fixtureState();
  for(const resolution of [1024,1536,2048]) for(const aspectRatio of ['16:9','9:16','1:1']) {
    const [shot] = buildShotPlans(state,{...DRAFT,resolution,aspectRatio});
    const [w,h] = aspectRatio.split(':').map(Number);
    assert.equal(shot.aspectRatio,aspectRatio);
    assert.equal(shot.outputWidth * h,shot.outputHeight * w);
    assert.equal(shot.outputWidth % 32,0);assert.equal(shot.outputHeight % 32,0);
  }
  const portrait = buildShotPlans(state,{...DRAFT,aspectRatio:'9:16'})[0];
  assert.equal(portrait.outputWidth,1152);assert.equal(portrait.outputHeight,2048);
  const original = buildShotPlans(state,DRAFT)[0];
  assert.equal(original.aspectRatio,'reference');assert.equal(original.outputWidth,undefined);assert.equal(original.outputHeight,undefined);
});

test('固定輸出比例調整 Qwen 的空白 latent，保留兩張參考與採樣設定，重製不重複尺寸節點',() => {
  const state = fixtureState();
  const images = {character:'character.png',garment:'garment.png'};
  for(const aspectRatio of ['16:9','9:16','1:1']) {
    const shot = buildShotPlans(state,{...DRAFT,aspectRatio})[0];
    const graph = buildComfyPrompt(TEMPLATE,shot,images);
    const sized = graph[graph['7'].inputs.latent_image[0]];
    assert.equal(sized.class_type,'LatentUpscale');assert.deepEqual(sized.inputs.samples,['12',2]);
    assert.equal(sized.inputs.width / 8 * 16,shot.outputWidth);assert.equal(sized.inputs.height / 8 * 16,shot.outputHeight);
    assert.equal(sized.inputs.upscale_method,'nearest-exact');assert.equal(sized.inputs.crop,'disabled');
    assert.deepEqual(graph['7'].inputs.positive,TEMPLATE['7'].inputs.positive);assert.deepEqual(graph['7'].inputs.negative,TEMPLATE['7'].inputs.negative);
    assert.equal(graph['7'].inputs.cfg,1);assert.equal(graph['7'].inputs.denoise,1);
    assert.equal(Object.values(graph).filter(node => node.class_type === 'LoadImage').length,2);
    assert.equal(graph['12'].inputs.resolution,shot.resolution);
    const rebuilt = buildComfyPrompt(graph,shot,images);
    assert.equal(Object.values(rebuilt).filter(node => node.class_type === 'LatentUpscale').length,1);
    const reference = buildComfyPrompt(graph,buildShotPlans(state,DRAFT)[0],images);
    assert.deepEqual(reference['7'].inputs.latent_image,['12',2]);
    assert.equal(Object.values(reference).filter(node => node.class_type === 'LatentUpscale').length,0);
  }
  const shot = buildShotPlans(state,{...DRAFT,aspectRatio:'16:9'})[0];
  assert.throws(() => buildComfyPrompt(TEMPLATE,{...shot,outputWidth:2049},images),/輸出寬高/);
  assert.deepEqual(TEMPLATE['7'].inputs.latent_image,['12',2]);
});

test('新拍攝忽略舊場景選擇與素材名稱，只在填寫時加入場景互動',() => {
  const state = fixtureState();
  state.scenes = [];
  state.garments[0].name = 'Qwen_Image_2.1_Uncensored_T2I_00011_';
  state.garments[0].description = '';
  const draft = {...DRAFT,sceneId:'old-scene',garmentIds:['garment-a'],sceneInteraction:'  '};
  const shot = buildShotPlans(state,draft)[0];
  assert.equal(shot.scene,undefined);
  assert.equal(shot.sceneInteraction,'');
  assert.equal(shot.garment.name,state.garments[0].name);
  assert.doesNotMatch(shot.prompt,/Qwen_Image|Picture 3|Environment:|Clothing:|Scene interaction:/);
  const interaction = buildShotPlans(state,{...draft,sceneInteraction:'  Sitting on a bed near a window.  '})[0];
  assert.match(interaction.prompt,/Scene interaction: Sitting on a bed near a window\./);
  const graph = buildComfyPrompt(TEMPLATE,interaction,{character:'character.png',garment:'garment.png'});
  assert.equal(Object.values(graph).filter(node => node.class_type === 'LoadImage').length,2);
});

test('場景互動提詞可選用與補充，任務保存內容快照並驗證分類',() => {
  const state = fixtureState();
  const preset = state.presets.find(row => row.id === 'interaction-window');
  const shot = buildShotPlans(state,{...DRAFT,interactionId:preset.id,sceneInteraction:'Looking toward the camera.'})[0];
  assert.equal(shot.interaction.id,preset.id);
  assert.match(shot.prompt,/Scene interaction: Beside a window,.*Looking toward the camera\./);
  assert.equal(shot.prompt.split('Scene interaction:').length,2);
  assert.equal(shot.scene,undefined);
  const originalPrompt = preset.prompt;
  preset.prompt = 'Changed after creation';
  assert.equal(shot.interaction.prompt,originalPrompt);
  assert.throws(() => buildShotPlans(state,{...DRAFT,interactionId:'camera-full'}),/場景互動/);
  assert.throws(() => buildShotPlans(state,{...DRAFT,interactionId:'missing'}),/場景互動/);
  assert.equal(buildShotPlans(state,DRAFT)[0].interaction,null);
  const imported = normalizePresetImport([{id:'import-window',category:'interaction',name:'窗邊',prompt:'Beside a window.',tags:['窗戶']}]);
  assert.equal(imported[0].category,'interaction');
});
test('JSON 匯入一次驗證整批，拒絕重複 id 與無效欄位',() => {
  const row = {id:'sample',category:'pose',name:'回眸',prompt:'Turning toward camera.',tags:['自然']};
  assert.equal(normalizePresetImport({version:1,presets:[row]})[0].name,'回眸');
  assert.throws(() => normalizePresetImport([row,row]),/重複/);
  assert.throws(() => normalizePresetImport([{...row,category:'unknown'}]),/category/);
  assert.throws(() => normalizePresetImport([{...row,tags:'自然'}]),/tags/);
  assert.throws(() => normalizePresetImport({version:2,presets:[row]}),/version/);
});
test('角色與服裝映射至 Qwen Autogrow，保留原模型與採樣設定',() => {
  const shot = buildShotPlans(fixtureState(),DRAFT)[0];
  const graph = buildComfyPrompt(TEMPLATE,shot,{character:'PhotoCreate/character.png',garment:'PhotoCreate/garment.png'});
  const images = Object.keys(graph['12'].inputs).filter(key => key.startsWith('images.'));
  assert.deepEqual(images,['images.image_1','images.image_2']);
  for(const [index,kind] of ['character','garment'].entries()) assert.equal(graph[graph['12'].inputs[images[index]][0]].inputs.image,`PhotoCreate/${kind}.png`);
  assert.equal(graph['7'].inputs.cfg,1);assert.equal(graph['7'].inputs.denoise,1);assert.equal(graph['7'].inputs.seed,100);
  assert.equal(graph['1'].inputs.unet_name,TEMPLATE['1'].inputs.unet_name);
  assert.equal(graph['12'].inputs.prompt,shot.prompt);
  assert.equal(graph['11'],undefined);
  assert.equal(TEMPLATE['12'].inputs.prompt,'source prompt');
});

test('已保存的三圖拍攝仍可匯出原場景，新拍攝不繼承模板的第三張圖',() => {
  const state = fixtureState();
  const shot = {...buildShotPlans(state,DRAFT)[0],scene:state.scenes[0],prompt:'saved legacy prompt'};
  const graph = buildComfyPrompt(TEMPLATE,shot,{character:'character.png',garment:'garment.png',scene:'scene.png'});
  assert.equal(graph[graph['12'].inputs['images.image_3'][0]].inputs.image,'scene.png');
  assert.equal(graph['12'].inputs.prompt,'saved legacy prompt');
  assert.throws(() => buildComfyPrompt(TEMPLATE,shot,{character:'character.png',garment:'garment.png'}),/scene/);
  const fresh = buildShotPlans(state,DRAFT)[0];
  const two = buildComfyPrompt(graph,fresh,{character:'character.png',garment:'garment.png'});
  assert.equal(two['12'].inputs['images.image_3'],undefined);
  assert.equal(Object.values(two).filter(node => node.class_type === 'LoadImage').length,2);
});
test('工作流轉換跳過採樣器 seed 控制與 LoadImage 上傳按鈕',() => {
  const required = {model:['MODEL'],seed:['INT',{control_after_generate:true}],steps:['INT'],cfg:['FLOAT'],sampler_name:[['euler']],scheduler:[['simple']],positive:['CONDITIONING'],negative:['CONDITIONING'],latent_image:['LATENT'],denoise:['FLOAT']};
  const info = Object.fromEntries(Object.values(TEMPLATE).map(node => [node.class_type,{input:{required:Object.fromEntries(Object.keys(node.inputs).map(name => [name,[Array.isArray(node.inputs[name]) ? 'IMAGE' : typeof node.inputs[name] === 'number' ? 'INT' : 'STRING',{}]]))}}]));
  info.KSampler = {input:{required},input_order:{required:Object.keys(required)}};
  const ui = {nodes:[],links:[]};let linkId = 1;
  for(const [id,node] of Object.entries(TEMPLATE)) {
    const inputs = [],widgets_values = [];
    for(const name of Object.keys(info[node.class_type].input.required)) {
      const value = node.inputs[name];
      if(Array.isArray(value)) {inputs.push({name,link:linkId});ui.links.push([linkId++,Number(value[0]),value[1],Number(id),inputs.length - 1,'IMAGE']);}
      else {widgets_values.push(value);inputs.push({name,link:null,widget:{name}});if(name === 'seed') widgets_values.push('randomize');}
    }
    if(node.class_type === 'LoadImage') widgets_values.push('image');
    ui.nodes.push({id:Number(id),type:node.class_type,inputs,widgets_values,mode:0});
  }
  ui.nodes.push({id:10,type:'MarkdownNote',widgets_values:['note']});
  const converted = convertWorkflow(ui,info);
  assert.equal(converted['7'].inputs.steps,40);assert.equal(converted['7'].inputs.cfg,1);assert.equal(converted['7'].inputs.sampler_name,'euler');assert.equal(converted['7'].inputs.denoise,1);
  assert.deepEqual(Object.keys(converted['11'].inputs),['image']);assert.equal(converted['10'],undefined);
});
