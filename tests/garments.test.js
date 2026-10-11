import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DRAFT,TEMPLATE,fixtureState} from './fixtures.js';
import {previewFixture,until} from './preset-preview-fixture.js';
import {adminFetch,login} from './auth-client.js';
import {buildShotPlans,REFERENCE_INSTRUCTION} from '../shared/domain.js';
import {garmentFields,textClothingInstruction} from '../shared/garments.js';
import {buildComfyPrompt,referenceKinds} from '../server/workflow.js';
import {relatedGarmentPhotos} from '../server/preset-previews.js';
import {customerRecipeMatches} from '../shared/customer-recipe.js';
import {DEFAULT_PHOTO_CUSTOMIZATION,customPhotoPrompt} from '../shared/photo-customization.js';

const promptGarment={id:'knit-outfit',name:'白色針織套裝',sourceType:'prompt',prompt:'A cream short-sleeved knit top and matching high-waisted long skirt, fine ribbed fabric and a small silver belt buckle.',description:'Library note only.',tags:['針織'],createdAt:'2026-10-12T00:00:00.000Z'};
const draft=garmentIds=>({...DRAFT,garmentIds,poseIds:['pose-standing'],copies:1,cameraEnabled:false});
const encoder=graph=>Object.values(graph).find(node=>node.class_type==='TextEncodeQwenImage21').inputs;
async function fixture(t) {const f=await previewFixture();t.after(()=>f.close());return f;}

test('混合圖片與提詞服裝保存各自快照，實際工作流分別只送角色或角色加服裝圖',()=>{
  const state=fixtureState();state.garments.push({...promptGarment,fileName:'inactive-image.png',image:'/uploads/inactive-image.png'});
  const plans=buildShotPlans(state,draft(['garment-a',promptGarment.id]));
  const text=plans.find(job=>job.garment.id===promptGarment.id),image=plans.find(job=>job.garment.id==='garment-a');
  assert.deepEqual(referenceKinds(text),['character']);assert.deepEqual(referenceKinds(image),['character','garment']);
  const textGraph=buildComfyPrompt(TEMPLATE,text,{character:'person.png'}),imageGraph=buildComfyPrompt(TEMPLATE,image,{character:'person.png',garment:'dress.png'});
  assert.match(encoder(textGraph).prompt,/fine ribbed fabric/);assert.ok(!encoder(textGraph).prompt.includes('<image2>'));assert.ok(!text.prompt.includes(promptGarment.description));
  assert.equal(Object.values(textGraph).filter(node=>node.class_type==='LoadImage').length,1);
  assert.equal(Object.values(imageGraph).filter(node=>node.class_type==='LoadImage').length,2);assert.ok(image.prompt.includes(REFERENCE_INSTRUCTION));assert.ok(!image.prompt.includes(image.garment.description));
  state.garments.at(-1).prompt='Changed library prompt';assert.equal(text.garment.prompt,promptGarment.prompt);assert.ok(text.prompt.includes(promptGarment.prompt));
  for(const input of [{...promptGarment,prompt:''},{...promptGarment,prompt:7},{...promptGarment,prompt:'x'.repeat(20001)},{...promptGarment,sourceType:'unknown'},{...promptGarment,tags:[7]}]) assert.throws(()=>garmentFields(input));
});

test('新增及編輯服裝提詞驗證整筆資料，歷史與顧客已發布版本只在再次套用後更新',async t=>{
  const f=await fixture(t),before=f.store.read();
  for(const input of [{name:'',sourceType:'prompt',prompt:'coat'},{name:'coat',sourceType:'prompt',prompt:''},{name:'coat',sourceType:'image',prompt:'coat'}]) assert.equal((await f.request('/garments',input)).status,400);
  assert.deepEqual(f.store.read().garments,before.garments);
  const created=await f.request('/garments',promptGarment);assert.equal(created.status,201);assert.equal(created.data.fileName,undefined);
  const id=created.data.id,publishedDraft={...draft([id]),mode:'random',randomPoolMode:'selected'};
  assert.equal((await f.request('/customer-recipe',publishedDraft,'PUT')).status,200);
  assert.equal(customerRecipeMatches(f.store.read(),publishedDraft),true);
  const [shot]=buildShotPlans(f.store.read(),publishedDraft);f.store.mutate(state=>state.jobs.push({...shot,status:'draft',images:[],createdAt:new Date().toISOString()}));
  const edited=await f.request(`/assets/garments/${id}`,{name:'新的針織套裝',prompt:'A navy knit cardigan and grey trousers.'},'PATCH');assert.equal(edited.status,200);
  assert.equal(f.store.read().customerRecipe.pools.garment[0].prompt,promptGarment.prompt);assert.equal(f.store.read().jobs[0].garment.prompt,promptGarment.prompt);
  assert.equal(customerRecipeMatches(f.store.read(),publishedDraft),false);
  assert.equal((await f.request(`/assets/garments/${id}`,{sourceType:'image',fileName:'outside.png'},'PATCH')).status,400);
  assert.equal((await f.request(`/assets/garments/${id}`,{prompt:''},'PATCH')).status,400);
  assert.equal((await f.request('/customer-recipe',publishedDraft,'PUT')).status,200);assert.equal(f.store.read().customerRecipe.pools.garment[0].prompt,edited.data.prompt);
  assert.equal((await f.request(`/assets/garments/${id}`,{},'DELETE')).data.customerRecipeUpdated,true);assert.equal(f.store.read().customerRecipe.pools.garment.length,0);assert.equal(f.store.read().jobs[0].garment.prompt,promptGarment.prompt);
});

for(const sourceType of ['image','prompt']) test(`${sourceType} 服裝可固定未保存版本試拍、查看原圖，關閉後清理且不改正式資料`,async t=>{
  const f=await fixture(t),saved=f.store.read().garments[0],id=randomUUID();
  const opened=await f.request(`/preset-previews/${id}`,{garmentId:sourceType==='image' ? saved.id : null},'PUT');assert.equal(opened.status,200);
  const garment=sourceType==='image' ? {...saved,sourceType,name:'Unsaved image outfit',description:'Must remain a note.'} : {...promptGarment,id:randomUUID()};
  const before=f.store.read(),requestId=randomUUID(),body={garment,requestId,aspectRatio:'1:1'};
  assert.equal((await f.request(`/preset-previews/${id}/shots`,body)).status,202);assert.equal((await f.request(`/preset-previews/${id}/shots`,body)).data.jobs.length,1);
  await until(()=>f.submitted.length===1);
  const graph=f.submitted[0].prompt;
  assert.equal(Object.values(graph).filter(node=>node.class_type==='LoadImage').length,sourceType==='image' ? 2 : 1);
  assert.equal(encoder(graph).prompt.includes('<image2>'),sourceType==='image');assert.equal(encoder(graph).prompt.includes(garment.description),false);
  if(sourceType==='prompt') assert.ok(encoder(graph).prompt.includes(garment.prompt));
  assert.deepEqual(f.store.read(),before);
  f.complete(f.submitted[0].id);await f.presetPreviews.sync();await f.presetPreviews.sync();
  const status=(await f.request(`/preset-previews/${id}`)).data.jobs[0];assert.equal(status.status,'completed');assert.equal(status.garmentId,garment.id);assert.equal(status.garmentSourceType,sourceType);assert.equal(f.submitted.length,1);
  assert.equal((await adminFetch(f.base+status.images[0].src)).status,200);
  await f.request(`/preset-previews/${id}`,{},'DELETE');assert.equal(fs.existsSync(path.join(f.outputDir,'PhotoCreate','_previews',id)),false);assert.equal((await f.request(`/preset-previews/${id}`)).status,410);
  assert.deepEqual(f.store.read(),before);
});

test('服裝試拍從已登記的本人圖庫取圖，拒絕私人服裝、偽造路徑與已移除的綁定',async t=>{
  const f=await fixture(t),saved=f.store.read().garments[0],id=randomUUID();
  f.store.mutate(state=>state.garments.push({...saved,id:'private-outfit',visitorId:'customer'}));
  assert.equal((await f.request(`/preset-previews/${randomUUID()}`,{garmentId:'private-outfit'},'PUT')).status,404);
  await f.request(`/preset-previews/${id}`,{garmentId:null},'PUT');
  for(const garment of [{...saved,id:'private-outfit',sourceType:'image'},{...saved,id:'missing-outfit',sourceType:'image',fileName:'../outside.png'}]) assert.equal((await f.request(`/preset-previews/${id}/shots`,{garment,requestId:randomUUID()})).status,400);
  const bound=randomUUID();await f.request(`/preset-previews/${bound}`,{garmentId:saved.id},'PUT');await f.request(`/assets/garments/${saved.id}`,{},'DELETE');
  assert.equal((await f.request(`/preset-previews/${bound}/shots`,{garment:saved,requestId:randomUUID()})).status,409);assert.equal(f.submitted.length,0);
});

test('服裝關聯成果依 ID 查找並保留版本，排除顧客、刪除與未完成照片',()=>{
  const state=fixtureState(),[plan]=buildShotPlans(state,draft(['garment-a']));
  state.jobs=Array.from({length:7},(_,i)=>({...plan,id:`history-${i}`,status:'completed',images:[{filename:`photo-${i}.png`}],createdAt:'2026-10-12',remakeVersion:i}));
  state.jobs.push({...state.jobs[0],id:'private',visitorId:'customer'},{...state.jobs[0],id:'deleted',outputsDeletedAt:'today'},{...state.jobs[0],id:'running',status:'running'});
  const sample=relatedGarmentPhotos(state,'garment-a',{sample:true});assert.equal(sample.total,7);assert.equal(sample.items.length,5);assert.equal(new Set(sample.items.map(row=>row.id)).size,5);
  state.garments[0].name='Renamed';assert.equal(relatedGarmentPhotos(state,'garment-a',{offset:5,limit:2}).items.length,2);assert.throws(()=>relatedGarmentPhotos(state,'missing'),/找不到服裝/);
});

test('顧客可使用已發布提詞服裝拍攝及官方換裝，完整服裝提詞留在後端，不能存取管理 API',async t=>{
  const f=await fixture(t),created=(await f.request('/garments',promptGarment)).data,id=created.id;
  assert.equal((await f.request('/customer-recipe',{...draft([id]),mode:'random',randomPoolMode:'selected'},'PUT')).status,200);
  await f.authentication.createCustomer({username:'wardrobe-customer',password:'customer-pass'});const session=await login(f.base,'wardrobe-customer','customer-pass');
  const request=async(route,body)=>{
    const response=await fetch(f.base+'/api'+route,{method:body ? 'POST' : 'GET',headers:{cookie:session.cookie,'content-type':'application/json'},...(body ? {body:JSON.stringify(body)} : {})});
    return {status:response.status,data:await response.json()};
  };
  const state=(await request('/studio/state')).data;assert.deepEqual(state.garments,[{id,name:promptGarment.name,sourceType:'prompt'}]);assert.equal(JSON.stringify(state).includes(promptGarment.prompt),false);
  assert.equal((await request('/garments',promptGarment)).status,403);assert.equal((await request(`/garments/${id}/photos`)).status,403);
  const result=await request('/studio/shoots',{characterId:state.characters[0].id,count:1,requestId:randomUUID(),cameraEnabled:false});assert.equal(result.status,202);
  await until(()=>f.submitted.length===1);const job=f.store.read().jobs.find(row=>row.id===result.data.jobs[0].id);assert.equal(job.garment.id,id);assert.ok(job.prompt.includes(promptGarment.prompt));assert.equal(Object.values(f.submitted[0].prompt).filter(node=>node.class_type==='LoadImage').length,1);
  // Replacing an image outfit with an official text outfit removes the image2
  // instruction. Switching back to an image removes the previous text outfit.
  const [imageShot]=buildShotPlans(fixtureState(),draft(['garment-a'])),options={...structuredClone(DEFAULT_PHOTO_CUSTOMIZATION),preserveOriginal:false,useOriginal:{...DEFAULT_PHOTO_CUSTOMIZATION.useOriginal,clothing:false},clothingMode:'reference',garmentId:id};
  const text=customPhotoPrompt(options,imageShot,{},created);assert.ok(text.includes(promptGarment.prompt));assert.ok(!text.includes('<image2>'));
  const switched=customPhotoPrompt({...options,garmentId:imageShot.garment.id},{...imageShot,garment:created,prompt:text},{},imageShot.garment);assert.ok(switched.includes(REFERENCE_INSTRUCTION));assert.ok(!switched.includes(textClothingInstruction(promptGarment.prompt)));
});

test('資料 ZIP 搬移提詞服裝無需圖片，保留提詞與候選並正確略過重複內容',async t=>{
  const source=await fixture(t),target=await fixture(t);
  source.store.mutate(state=>{state.scenes=[];state.garments.push(promptGarment);state.draft=draft([promptGarment.id]);});
  const transfer=async()=>{const archive=source.transfer.download((await source.transfer.exportZip()).token),file=path.join(target.transfer.uploadDir,`${randomUUID()}.zip`);fs.copyFileSync(archive.path,file);archive.cleanup();return target.transfer.prepare(file);};
  const files=fs.readdirSync(path.join(target.dataDir,'uploads')),preview=await transfer();assert.equal(preview.added.garments,1);
  await target.transfer.commit(preview.token,{applyDraft:true});const stored=target.store.read().garments.find(row=>row.id===promptGarment.id);
  assert.equal(stored.prompt,promptGarment.prompt);assert.equal(stored.sourceType,'prompt');assert.equal(stored.fileName,undefined);assert.deepEqual(target.store.read().draft.garmentIds,[stored.id]);assert.deepEqual(fs.readdirSync(path.join(target.dataDir,'uploads')),files);
  const repeat=await transfer();assert.equal(repeat.added.garments,0);assert.equal(repeat.duplicates.garments,3);await target.transfer.commit(repeat.token);assert.equal(target.store.read().garments.filter(row=>row.id===stored.id).length,1);
});
