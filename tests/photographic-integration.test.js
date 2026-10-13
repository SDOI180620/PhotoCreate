import test from 'node:test';
import assert from 'node:assert/strict';
import {buildShotPlans,referenceOnlyPrompt} from '../shared/domain.js';
import {customPhotoPrompt} from '../shared/photo-customization.js';
import {buildRemakePlans} from '../shared/remakes.js';
import {buildComfyPrompt} from '../server/workflow.js';
import {DRAFT,TEMPLATE,fixtureState} from './fixtures.js';
import {cameraPrompt,REFINE_PROMPT,CAMERA_MAPPING_VERSION} from '../shared/camera.js';

const previousReference="Dress the character from <image1> in the clothing from <image2>. Preserve the same face, hairstyle and distinctive appearance from <image1>, and the clothing's cut, material, colors and fine design details from <image2>.";
const scene='A quiet garden terrace with a stone railing and soft afternoon light.';
const plan=()=>buildShotPlans(fixtureState(),{...DRAFT,copies:1,garmentIds:['garment-a'],poseIds:['pose-standing'],cameraMode:'multiangle',cameraEnabled:false,sceneInteraction:scene})[0];
const encoder=graph=>Object.values(graph).find(node=>node.class_type==='TextEncodeQwenImage21').inputs;
const assertGarmentExtraction=prompt=>{
  assert.match(prompt,/If <image2> shows a person wearing the outfit/);
  assert.match(prompt,/extract only the clothing/);
  assert.match(prompt,/wearer's face, body, pose, and background/);
  assert.match(prompt,/character from <image1>/);
};
const assertSceneIntegration=prompt=>{
  assert.match(prompt,/Keep the chosen pose, action and expression/);
  assert.match(prompt,/Add natural contact with nearby scene objects when the pose allows/);
  assert.match(prompt,/contact shadows/);
  assert.match(prompt,/occlusion/);
};

test('服裝圖片只提供服裝設計，模型的第一張圖仍綁定原角色、第二張圖綁定服裝',()=>{
  const shot=plan(),graph=buildComfyPrompt(TEMPLATE,shot,{character:'original-person.png',garment:'outfit-on-another-person.png'}),inputs=encoder(graph);
  assertGarmentExtraction(inputs.prompt);
  assert.equal(graph[inputs['images.image_1'][0]].inputs.image,'original-person.png');
  assert.equal(graph[inputs['images.image_2'][0]].inputs.image,'outfit-on-another-person.png');
  assert.equal(Object.values(graph).filter(node=>node.class_type==='LoadImage').length,2);
});

test('場景互動補充接觸與共同光影，保留所選動作、表情及場景，沒有場景時不擅自新增',()=>{
  const shot=plan();
  assertSceneIntegration(shot.prompt);
  assert.ok(shot.prompt.includes(`Pose: ${shot.pose.prompt}`));
  assert.ok(shot.prompt.includes(`Scene: ${scene}`));
  assert.equal(shot.prompt.split('Scene:').length,2);
  assert.deepEqual(shot.pose,fixtureState().presets.find(row=>row.id==='pose-standing'));
  const withoutScene=buildShotPlans(fixtureState(),{...DRAFT,copies:1,sceneInteraction:''})[0];
  assert.doesNotMatch(withoutScene.prompt,/Keep the chosen pose|Scene:/);
  const changed=customPhotoPrompt({useOriginal:{scene:false},changes:{scene:'A shaded forest path with nearby trees.'}},shot);
  assertSceneIntegration(changed);assert.match(changed,/Scene: A shaded forest path with nearby trees\./);
  assert.ok(changed.includes(shot.pose.prompt));assert.ok(!changed.includes(scene));
});

test('舊照片再自訂時補充服裝擷取與自然互動，切換文字服裝會完整移除第二張圖指令',()=>{
  const shot=plan();shot.prompt=`${previousReference}\n\nPose: ${shot.pose.prompt}\n\nScene: ${scene}\n\nKeep the requested camera framing.`;
  const original=structuredClone(shot),updated=customPhotoPrompt({preserveOriginal:true},shot);
  assertGarmentExtraction(updated);assertSceneIntegration(updated);assert.match(updated,/Keep the requested camera framing/);
  assert.equal(customPhotoPrompt({preserveOriginal:true},{...shot,prompt:updated}),updated);
  const text=customPhotoPrompt({useOriginal:{clothing:false},clothingMode:'text',changes:{clothing:'A blue jacket with silver buttons.'}},{...shot,prompt:updated});
  assert.ok(!text.includes('<image2>'));assert.match(text,/The character should wear: A blue jacket with silver buttons\./);assertSceneIntegration(text);
  assert.deepEqual(shot,original);assert.equal(referenceOnlyPrompt({prompt:referenceOnlyPrompt(shot)}),referenceOnlyPrompt(shot));
});

test('重拍舊原圖會使用新的服裝與環境指令，已完成的來源照片快照保持原樣',()=>{
  const source={...plan(),status:'completed',images:[{filename:'original.png',type:'output'}],createdAt:'2026-10-12T00:00:00Z'};
  source.prompt=`${previousReference}\n\nPose: ${source.pose.prompt}\n\nScene: ${scene}`;
  const snapshot=structuredClone(source),state={...fixtureState(),jobs:[source],workflow:TEMPLATE};
  const [remake]=buildRemakePlans(state,[source.id],{requestId:'natural-remake'});
  assertGarmentExtraction(remake.prompt);assertSceneIntegration(remake.prompt);assert.deepEqual(source,snapshot);
});

test('沒有場景也提供預設姿態與單張取景建議，角色參考圖不提供動作與姿勢',()=>{
  const shot=buildShotPlans(fixtureState(),{...DRAFT,copies:1,cameraMode:'multiangle',cameraEnabled:false,sceneInteraction:''})[0];
  const prompt=encoder(buildComfyPrompt(TEMPLATE,shot,{character:'identity-reference.png',garment:'outfit.png'})).prompt;
  assert.match(prompt,/Use <image1> only for identity and appearance\. Ignore its pose, gestures and framing/);
  assert.match(prompt,/Follow the chosen action and its specified body position/);
  assert.match(prompt,/seated, crouched, kneeling, lying or clearly waist-bent pose with explicit leg placement/);
  assert.match(prompt,/Keep the hips, knees, feet and supporting surfaces consistent/);
  for(const framing of ['full-body','waist-up half-body','head-and-shoulders quarter-body','upper-back close-up','side view','three-quarter view']) assert.ok(prompt.includes(framing));
  assert.match(prompt,/When the view is unspecified, choose one/);assert.match(prompt,/One view per photo/);
  assert.doesNotMatch(prompt,/Add natural contact with nearby scene objects/);
  const repeated=customPhotoPrompt({preserveOriginal:true},shot);
  assert.equal(repeated.split('Ignore its pose, gestures and framing').length,2);
});

test('預設提醒保留指定動作和官方鏡位，換角度與優化仍保留照片原本姿勢',()=>{
  const state=fixtureState(),angle={horizontalAngle:90,verticalAngle:30,zoom:8};
  const camera=state.presets.find(row=>row.id==='camera-full');
  Object.assign(camera,{angle,mappingVersion:CAMERA_MAPPING_VERSION,mappingSource:'manual'});
  state.presets.find(row=>row.id==='pose-standing').prompt='Sitting on a bench with both hands resting on the knees.';
  const shot=buildShotPlans(state,{...DRAFT,copies:1,poseIds:['pose-standing'],cameraMode:'multiangle',cameraEnabled:true})[0];
  assert.deepEqual(shot.camera.angle,angle);
  assert.match(shot.prompt,/Follow explicit pose and camera settings/);
  assert.ok(shot.prompt.includes(`Pose: ${shot.pose.prompt}`));
  const cameraText=cameraPrompt(angle);
  assert.match(cameraText,/Requested camera azimuth: 90 degrees/);
  assert.match(cameraText,/Keep the same person, pose, clothing and environment/);
  assert.doesNotMatch(cameraText,/Ignore its pose, gestures and framing/);
  assert.match(REFINE_PROMPT,/Preserve exactly the same person/);
  assert.doesNotMatch(REFINE_PROMPT,/Ignore its pose, gestures and framing/);
});
