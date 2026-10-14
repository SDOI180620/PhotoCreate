import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildShotPlans} from '../shared/domain.js';
import {buildRemakePlans} from '../shared/remakes.js';
import {createCustomerRecipe,customerDraft,customerProductionState} from '../server/customer-recipe.js';
import {buildComfyPrompt} from '../server/workflow.js';
import {buildCameraStage} from '../server/camera-workflow.js';
import {SINGLE_SUBJECT_PROMPT,SINGLE_SUBJECT_NEGATIVE,withSingleSubjectPrompt,withSingleSubjectNegative} from '../shared/subject.js';
import {cameraPrompt} from '../shared/camera.js';
import {customPhotoPrompt,DEFAULT_PHOTO_CUSTOMIZATION} from '../shared/photo-customization.js';
import {DRAFT,TEMPLATE,fixtureState} from './fixtures.js';
import {CAMERA_TEMPLATE} from './camera-fixtures.js';

const encoder = graph => Object.values(graph).find(node=>node.class_type==='TextEncodeQwenImage21').inputs;
const previousSingleSubject='A single-person photograph: exactly one person, solo, one subject appearing once in one camera view. The result is a single photograph, with the subject visible only once.';
const removedAppearance="Use <image1> as the sole reference for the character's identity and anatomy. Preserve the same face and facial structure, hairstyle, body shape and build, body proportions, and breast size shown in <image1>. Changes to clothing, pose, camera viewpoint or rendering style must not redesign the face or physique, or increase or reduce breast size.";
const removedBreastSize='Keep the breast size the same as in <image1>.';
const assertSingle = (positive,negative) => {
  assert.match(positive,/Create a photorealistic photograph featuring exactly ONE person\./);
  assert.match(positive,/If <image1> contains multiple views, they all depict the SAME person from different angles\./);
  assert.match(positive,/Show the person only ONCE in a single scene\./);
  assert.match(positive,/Do not recreate the reference image's multi-view arrangement, panel layout, or repeated figures\./);
  assert.doesNotMatch(positive,/(?:^|\n)\s*(?:a\s+girl|1\s*girl)\s*(?:\n|$)/i);
  assert.doesNotMatch(positive,/Compose one continuous photographic scene|Extract the identity and clothing from the reference|Use the reference only for appearance and clothing|never copy its page layout/);
  for(const term of ['multiple people','duplicate person','multiple views','three-view','turnaround','front side back','triptych','split screen']) assert(negative.includes(term),term);
};

test('舊的單人提詞升級後只有一份新限制，負提詞補上三視圖且不重複',()=>{
  const legacy='A single-person photograph: exactly one person, solo, one subject appearing once in one camera view. The references may show different views of the same person; use them only for identity and clothing. Produce one photograph of one person, with no additional people, duplicate figures, reference sheet, collage, or split panels.';
  const removed='Extract the identity and clothing from the reference, then photograph that person once in the requested scene. Use the reference only for appearance and clothing, never copy its page layout.';
  const previous=previousSingleSubject.replace('The result is',removed+' The result is');
  const composition='Compose one continuous photographic scene, one uninterrupted frame, one viewpoint and one pose.';
  const earlier=previousSingleSubject.replace('The result is',composition+' '+removed+' The result is');
  const negative=withSingleSubjectNegative('blurry, three-view');
  for(const oldPrompt of [legacy,previousSingleSubject,previous,earlier,removed,composition,removedAppearance,removedBreastSize,`${SINGLE_SUBJECT_PROMPT}\n\n${removedAppearance}\n\n${removedBreastSize}`]) {
    const positive=withSingleSubjectPrompt(`A studio portrait.\n\n${oldPrompt}`);
    assertSingle(positive,negative);assert.equal(positive,`A studio portrait.\n\n${SINGLE_SUBJECT_PROMPT}`);
    assert(!positive.includes('The references may show different views'));
    assert.equal(withSingleSubjectPrompt(positive),positive);
  }
  assert.equal(withSingleSubjectNegative(negative),negative);
  assert.equal(negative.split(',').filter(term=>term.trim()==='three-view').length,1);
});

test('舊性別前綴在送出、重製與自訂拍攝時移除，原紀錄及手寫內容保留',()=>{
  const directions='Editorial portrait of a person in a blue jacket.\n\nPose: Stand beside a window.';
  for(const prefix of ['a girl','A GIRL','1 girl','1girl']) {
    const source={...buildShotPlans(fixtureState(),DRAFT)[0],prompt:`${prefix}\n\n${previousSingleSubject}\n\n${directions}`,status:'completed',images:[{filename:'old.png'}],apiPrompt:structuredClone(TEMPLATE)};
    const before=structuredClone(source),expected=`${directions}\n\n${SINGLE_SUBJECT_PROMPT}`;
    const submitted=encoder(buildComfyPrompt(TEMPLATE,source,{character:'person.png',garment:'outfit.png'}));
    const [remake]=buildRemakePlans({jobs:[source]},[source.id],{requestId:'subject-prefix'});
    assert.equal(submitted.prompt,expected);
    for(const positive of [remake.prompt,customPhotoPrompt(DEFAULT_PHOTO_CUSTOMIZATION,source)]) {
      assertSingle(positive,remake.negative);assert.ok(positive.startsWith(directions));
    }
    assert.equal(withSingleSubjectPrompt(expected),expected);
    assert.deepEqual(source,before);
  }
  const custom='Photograph a girl wearing a blue jacket.';
  assert.equal(withSingleSubjectPrompt(custom),`${custom}\n\n${SINGLE_SUBJECT_PROMPT}`);
});

test('撤回外觀一致性段落後，舊照片重拍不再送入模型，歷史紀錄保留',()=>{
  const source=buildShotPlans(fixtureState(),DRAFT)[0];
  source.prompt+=`\n\n${removedAppearance}\n\n${removedBreastSize}\n\nPreserve the freckles and blue scarf.`;
  const before=structuredClone(source);
  for(const renderStyle of ['realistic','anime_cg']) {
    const input=encoder(buildComfyPrompt(TEMPLATE,{...source,renderStyle},{character:'person.png',garment:'outfit.png'}));
    assert.doesNotMatch(input.prompt,/sole reference for the character's identity and anatomy|breast size shown in <image1>|increase or reduce breast size|Keep the breast size the same/);
    assert.match(input.prompt,/Preserve the freckles and blue scarf\./);
    assert.ok(input.prompt.includes(source.pose.prompt));
    assert.doesNotMatch(input.prompt,/Japanese anime game CG illustration/);
  }
  assert.deepEqual(source,before);
});

test('管理員組合與隨機產圖強調單人單視角，自訂負面提詞不取代人數限制',()=>{
  const state=fixtureState(),before=structuredClone(state);
  for(const mode of ['combinations','random']) for(const negative of ['','blurry, multiple people']) {
    const shots=buildShotPlans(state,{...DRAFT,mode,randomPoolMode:'selected',randomCount:2,negative});
    for(const shot of shots) {
      assertSingle(shot.prompt,shot.negative);
      assert.equal(shot.prompt.split(SINGLE_SUBJECT_PROMPT).length,2);
      assert.equal(shot.negative.split(',').filter(term=>term.trim()==='multiple people').length,1);
      if(negative) assert.match(shot.negative,/^blurry,/);
      const submitted=encoder(buildComfyPrompt(TEMPLATE,shot,{character:'person.png',garment:'outfit.png'}));
      assert.equal(submitted.prompt,withSingleSubjectPrompt(shot.prompt));assert.equal(submitted.negative_prompt,shot.negative);
    }
  }
  assert.deepEqual(state,before);
});

test('顧客既有設定保留服裝與動作候選，新照片仍補齊單人正負提詞',()=>{
  const state=fixtureState(),recipe=createCustomerRecipe(state,{...DRAFT,mode:'random',randomPoolMode:'selected'});
  // Simulate a published setup created before single-person constraints existed.
  recipe.settings.negative='frozen quality exclusions';
  const before=structuredClone(recipe),draft=customerDraft(recipe,{characterId:'character',count:2,aspectRatio:'9:16'});
  const shots=buildShotPlans(customerProductionState(state,recipe),draft);
  assert.equal(shots.length,2);
  for(const shot of shots) {
    assertSingle(shot.prompt,shot.negative);assert.match(shot.negative,/^frozen quality exclusions,/);
    assert(recipe.pools.garment.some(row=>row.id===shot.garment.id));assert(recipe.pools.pose.some(row=>row.id===shot.pose.id));
  }
  assert.deepEqual(recipe,before);
});

test('舊清單送出及舊照片重產會補強單人，原紀錄不變且反覆重產不重複附加',()=>{
  const source={...buildShotPlans(fixtureState(),DRAFT)[0],prompt:'Editorial portrait of a person in a blue jacket.',negative:'blurry',status:'completed',images:[{filename:'old.png'}],apiPrompt:structuredClone(TEMPLATE)};
  const before=structuredClone(source),images={character:'person.png',garment:'outfit.png'};
  const submitted=encoder(buildComfyPrompt(TEMPLATE,source,images));assertSingle(submitted.prompt,submitted.negative_prompt);
  const [remake]=buildRemakePlans({jobs:[source]},[source.id],{requestId:'single-1'});
  assertSingle(remake.prompt,remake.negative);assert(remake.prompt.startsWith(source.prompt));assert(remake.negative.startsWith(source.negative));
  const next={...remake,status:'completed',images:[{filename:'next.png'}]};
  const [again]=buildRemakePlans({jobs:[source,next]},[next.id],{requestId:'single-2'});
  assert.equal(again.prompt,remake.prompt);assert.equal(again.negative,remake.negative);
  assert.deepEqual(source,before);
});

test('原圖、鏡頭正負編碼與細節修復實際使用單人限制，保留工作流已有負面提詞',()=>{
  const shot=buildShotPlans(fixtureState(),{...DRAFT,cameraMode:'multiangle',angleSteps:20,refineDenoise:0.2})[0];
  const cameraTemplate=structuredClone(CAMERA_TEMPLATE);cameraTemplate['11'].inputs.prompt='camera quality exclusions';
  const before=structuredClone(cameraTemplate);
  const base=encoder(buildCameraStage(TEMPLATE,cameraTemplate,shot,'base',{character:'person.png',garment:'outfit.png'}));
  assertSingle(base.prompt,base.negative_prompt);
  const angle=buildCameraStage(TEMPLATE,cameraTemplate,shot,'angle',{source:'base.png'});
  const sampler=Object.values(angle).find(node=>node.class_type==='KSampler');
  const positive=angle[sampler.inputs.positive[0]].inputs.prompt;
  const negative=angle[sampler.inputs.negative[0]].inputs.prompt;
  assertSingle(positive,negative);assert.equal(positive,withSingleSubjectPrompt(cameraPrompt(shot.camera.angle)));
  assert(negative.startsWith('camera quality exclusions, '));assert(negative.endsWith(SINGLE_SUBJECT_NEGATIVE));
  const refine=encoder(buildCameraStage(TEMPLATE,cameraTemplate,shot,'refine',{source:'angle.png'}));
  assertSingle(refine.prompt,refine.negative_prompt);assert.match(refine.prompt,/Do not .*change the composition/i);
  assert.deepEqual(cameraTemplate,before);
});
