import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createEnvironmentManager,environmentPath,validateComfyDirectory,BUNDLE_DIR} from '../server/environment.js';
import {testComfyConnection,publicConnectionTest,normalizeComfyUrl} from '../server/connection.js';
import {createApp} from '../server/index.js';
import {environmentFixture,settleInstall} from './environment-fixtures.js';
import {PNG} from './fixtures.js';

const write=(file,bytes)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);};
const managerFor=fixture=>createEnvironmentManager(fixture);

test('環境套件來源 hash 正確，工作流不攜帶原圖、原始提詞或預覽內容',()=> {
  const manifest=JSON.parse(fs.readFileSync(path.join(BUNDLE_DIR,'manifest.json'),'utf8'));
  assert.equal(manifest.resources.filter(row=>row.kind==='model').length,7);
  for(const resource of manifest.resources) {
    if(resource.kind==='model') {assert.match(resource.url,new RegExp('/resolve/'+resource.revision+'/'));assert.match(resource.sha256,/^[a-f0-9]{64}$/);continue;}
    const bytes=fs.readFileSync(environmentPath(BUNDLE_DIR,resource.source));assert.equal(bytes.length,resource.size);assert.equal(createHash('sha256').update(bytes).digest('hex'),resource.sha256);
    if(resource.kind==='workflow') for(const node of JSON.parse(bytes).nodes) {
      assert.equal(node.imgs,undefined);
      if(node.type==='LoadImage') assert.equal(node.widgets_values[0],'');
      if(node.type.startsWith('TextEncodeQwen')) assert.ok(node.widgets_values.every(value=>typeof value!=='string' || value===''));
      assert.doesNotMatch(JSON.stringify(node.properties || {}),/data:image|base64,/);
    }
  }
});

test('目錄安裝略過已有模型，工作流使用專用目錄，節點更新保留備份',async()=> {
  const fixture=environmentFixture(),manager=managerFor(fixture),modelFile=path.join(fixture.root,fixture.manifest.resources.at(-1).target);
  write(modelFile,fixture.model);
  const originalWorkflow=path.join(fixture.root,'user/default/workflows/manual.json');write(originalWorkflow,'existing user workflow');
  const nodeFile=path.join(fixture.root,'custom_nodes/ComfyUI-qwenmultiangle/nodes.py');write(nodeFile,'previous enhanced node');
  assert.equal(manager.plan(fixture.root).missingModelBytes,0);
  manager.start(fixture.root);const job=await settleInstall(manager);assert.equal(job.status,'completed');assert.equal(job.restartRequired,true);
  assert.equal(fixture.controls.requests.length,0);assert.equal(fs.readFileSync(originalWorkflow,'utf8'),'existing user workflow');
  assert.equal(fs.readFileSync(path.join(fixture.root,'.photocreate-backups',job.id,'custom_nodes/ComfyUI-qwenmultiangle/nodes.py'),'utf8'),'previous enhanced node');
  assert.equal(manager.plan(fixture.root).filesReady,true);assert.equal(manager.plan(fixture.root).modelsReady,true);manager.close();
});

test('模型 Range 续传与 SHA 验证，完整后才替换现有文件',async()=> {
  const fixture=environmentFixture(),resource=fixture.manifest.resources.at(-1),target=path.join(fixture.root,resource.target),offset=9000,requests=[];
  write(target,'old model');write(target+'.photocreate.part',fixture.model.subarray(0,offset));
  const manager=createEnvironmentManager({...fixture,fetchImpl:async(url,options)=>{requests.push(options.headers.Range);return new Response(fixture.model.subarray(offset),{status:206,headers:{'content-range':`bytes ${offset}-${resource.size-1}/${resource.size}`}});}});
  manager.start(fixture.root);const job=await settleInstall(manager);assert.equal(job.status,'completed');assert.deepEqual(requests,[`bytes=${offset}-`]);
  assert.deepEqual(fs.readFileSync(target),fixture.model);assert.equal(fs.existsSync(target+'.photocreate.part'),false);
  assert.equal(fs.readFileSync(path.join(fixture.root,'.photocreate-backups',job.id,resource.target),'utf8'),'old model');manager.close();
});

test('坏下载保留旧模型，清空损坏暫存后可以直接重试',async()=> {
  const fixture=environmentFixture(),resource=fixture.manifest.resources.at(-1),target=path.join(fixture.root,resource.target);write(target,'protected existing model');
  let corrupt=true;const manager=createEnvironmentManager({...fixture,fetchImpl:async()=>new Response(corrupt ? Buffer.alloc(resource.size,0) : fixture.model)});
  manager.start(fixture.root);assert.equal((await settleInstall(manager)).status,'failed');assert.equal(fs.readFileSync(target,'utf8'),'protected existing model');
  assert.equal(fs.statSync(target+'.photocreate.part').size,0);corrupt=false;manager.start(fixture.root);assert.equal((await settleInstall(manager)).status,'completed');assert.deepEqual(fs.readFileSync(target),fixture.model);manager.close();
});

test('下载可暂停，重启后仍保留进度并从实际暫存大小续传',async()=> {
  const fixture=environmentFixture(),ranges=[];
  const slowFetch=async(url,options)=>{
    const offset=Number(options.headers.Range?.match(/bytes=(\d+)-/)?.[1] || 0);ranges.push(offset);let cursor=offset,cancelled=false;
    return new Response(new ReadableStream({async pull(controller) {await new Promise(resolve=>setTimeout(resolve,7));if(cancelled) return;if(cursor>=fixture.model.length) return controller.close();controller.enqueue(fixture.model.subarray(cursor,cursor+8192));cursor+=8192;},cancel(){cancelled=true;}}),{status:offset ? 206 : 200,headers:offset ? {'content-range':`bytes ${offset}-${fixture.model.length-1}/${fixture.model.length}`} : {}});
  };
  let manager=createEnvironmentManager({...fixture,fetchImpl:slowFetch});manager.start(fixture.root);
  for(let i=0;i<100 && (manager.status().currentBytes || 0)<20000;i++) await new Promise(resolve=>setTimeout(resolve,10));
  manager.pause();assert.equal((await settleInstall(manager)).status,'paused');manager.close();
  const partial=path.join(fixture.root,fixture.manifest.resources.at(-1).target+'.photocreate.part'),size=fs.statSync(partial).size;assert.ok(size>0 && size<fixture.model.length);
  manager=createEnvironmentManager({...fixture,fetchImpl:slowFetch});assert.equal(manager.status().status,'paused');manager.start(fixture.root);
  assert.equal((await settleInstall(manager)).status,'completed');assert.deepEqual(ranges,[0,size]);manager.close();
});

test('檔案替換受阻時恢復旧模型，保留已驗證的下載以供重試',async()=> {
  const fixture=environmentFixture(),resource=fixture.manifest.resources.at(-1),target=path.join(fixture.root,resource.target);write(target,'old protected model');
  const manager=managerFor(fixture),rename=fs.renameSync;
  try {
    fs.renameSync=(source,destination)=>{if(source===target+'.photocreate.part') throw new Error('fixture rename blocked');return rename(source,destination);};
    manager.start(fixture.root);assert.equal((await settleInstall(manager)).status,'failed');assert.equal(fs.readFileSync(target,'utf8'),'old protected model');assert.deepEqual(fs.readFileSync(target+'.photocreate.part'),fixture.model);
  } finally {fs.renameSync=rename;}
  manager.start(fixture.root);assert.equal((await settleInstall(manager)).status,'completed');assert.deepEqual(fs.readFileSync(target),fixture.model);manager.close();
});

test('目錄與 junction 邊界檢查拒絕越界寫入',()=> {
  const fixture=environmentFixture();assert.equal(validateComfyDirectory(fixture.root),fs.realpathSync(fixture.root));
  assert.throws(()=>validateComfyDirectory(fixture.bundleDir),/main.py/);assert.throws(()=>validateComfyDirectory('relative/path'),/完整目錄/);
  for(const relative of ['../outside','models/../outside','C:/outside','models\\outside']) assert.throws(()=>environmentPath(fixture.root,relative));
  const outside=path.join(fixture.temporary,'outside');fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(fixture.root,'models'),process.platform==='win32' ? 'junction' : 'dir');
  assert.throws(()=>managerFor(fixture).plan(fixture.root),/目錄連結超出/);assert.deepEqual(fs.readdirSync(outside),[]);
});

test('網址測試使用三個階段實際 API 圖，缺模型或舊相機參數會阻擋綁定',async()=> {
  const fixture=environmentFixture(),comfyJson=async(endpoint,options,url)=>(await fixture.fetchImpl(url+endpoint,options)).json();
  const candidate={comfyUrl:'http://other-comfy.test:8188'};
  let result=await testComfyConnection(candidate,comfyJson,fixture);assert.equal(result.ready,true);assert.equal(result.stages.length,3);assert.equal(publicConnectionTest(result).base,undefined);
  fixture.controls.missingModel=true;result=await testComfyConnection(candidate,comfyJson,fixture);assert.equal(result.ready,false);assert.ok(result.stages.some(stage=>stage.errors.some(error=>error.includes('unet_name'))));
  fixture.controls.missingModel=false;fixture.controls.legacyCamera=true;result=await testComfyConnection(candidate,comfyJson,fixture);assert.equal(result.ready,false);assert.ok(result.stages[1].errors.some(error=>error.includes('-90')));
  assert.ok(fixture.controls.requests.every(request=>request.method==='GET'));assert.throws(()=>normalizeComfyUrl('file:///C:/ComfyUI'));assert.throws(()=>normalizeComfyUrl('http://example.test/workflow'));
});

test('API 測試不改設定，綁定重新驗證；本機安裝與載入、忙碌保護、輸出位置保存',async t=> {
  const fixture=environmentFixture(),instance=createApp({...fixture,environmentOptions:fixture,directoryPicker:async()=>fixture.root}),{app,store,environment,stageRunner}=instance;
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>{environment.close();server.close();store.close();});
  const request=async(endpoint,body,method='POST')=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api`+endpoint,{method,headers:{'Content-Type':'application/json'},body:body===undefined ? undefined : JSON.stringify(body)});return {status:response.status,data:await response.json()};};
  const oldSettings=store.read().settings,candidate={comfyUrl:'http://other-comfy.test:8188'};
  assert.equal((await request('/environment/connection/test',candidate)).data.ready,true);assert.deepEqual(store.read().settings,oldSettings);
  fixture.controls.missingModel=true;assert.equal((await request('/environment/connection/bind',candidate)).status,400);assert.deepEqual(store.read().settings,oldSettings);
  fixture.controls.missingModel=false;assert.equal((await request('/environment/connection/bind',candidate)).status,200);assert.equal(store.read().settings.connectionMode,'url');assert.equal(store.read().settings.comfyDirectory,undefined);assert.ok(store.read().cameraWorkflow);
  assert.equal((await request('/environment/directory/pick')).data.directory,fixture.root);
  assert.equal((await request('/environment/settings',{comfyUrl:'http://127.0.0.1:8188',comfyDirectory:fixture.root},'PUT')).status,200);
  assert.equal(store.read().settings.comfyUrl,candidate.comfyUrl);assert.equal(store.read().settings.comfyDirectory,undefined);assert.equal(store.read().settings.environmentDraft.comfyDirectory,fixture.root);
  fixture.controls.foreignQueue=true;assert.equal((await request('/environment/install',{directory:fixture.root})).status,409);assert.equal(environment.status(),null);
  fixture.controls.foreignQueue=false;fixture.controls.queueError=true;assert.equal((await request('/environment/install',{directory:fixture.root})).status,502);assert.equal(environment.status(),null);
  fixture.controls.queueError=false;fixture.controls.queueOffline=true;assert.equal((await request('/environment/install',{directory:fixture.root})).status,202);assert.equal((await settleInstall(environment)).status,'completed');fixture.controls.queueOffline=false;
  fixture.controls.legacyCamera=true;const workflowBefore=store.read().workflow;assert.equal((await request('/environment/activate')).status,400);assert.deepEqual(store.read().workflow,workflowBefore);
  fixture.controls.legacyCamera=false;assert.equal((await request('/environment/activate')).status,200);assert.equal(store.read().settings.connectionMode,'directory');
  const picture=path.join(fixture.root,'output/PhotoCreate/old.png');write(picture,PNG);
  store.mutate(state=>state.jobs.push({id:'old-photo',status:'completed',createdAt:new Date().toISOString(),comfyUrl:state.settings.comfyUrl,images:[{filename:'old.png',subfolder:'PhotoCreate',type:'output'}]}));
  const other=path.join(fixture.temporary,'other-comfy');fs.mkdirSync(path.join(other,'comfy'),{recursive:true});fs.writeFileSync(path.join(other,'main.py'),'');
  const otherPicture=path.join(other,'output/PhotoCreate/old.png');write(otherPicture,'unrelated file');
  assert.equal((await request('/settings',{comfyUrl:'http://127.0.0.1:8188',comfyDirectory:other},'PUT')).status,200);
  assert.equal((await request('/jobs/outputs/delete',{ids:['old-photo']})).status,200);assert.equal(fs.existsSync(picture),false);assert.equal(fs.readFileSync(otherPicture,'utf8'),'unrelated file');
  store.mutate(state=>state.jobs.push({id:'active',status:'running',createdAt:new Date().toISOString()}));
  assert.equal((await request('/environment/connection/bind',candidate)).status,409);assert.equal((await request('/settings',{comfyUrl:candidate.comfyUrl},'PUT')).status,409);
  assert.ok(!fixture.controls.requests.some(request=>request.method!=='GET' && new URL(request.url).hostname!=='models.test'));
});
