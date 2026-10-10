import {adminFetch as fetch} from './auth-client.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server/index.js';
import {PNG,TEMPLATE,DRAFT,fixtureState} from './fixtures.js';

const gate = () => Promise.withResolvers();
const success = {status:{status_str:'success'},outputs:{9:{images:[{filename:'finished.png',type:'output',subfolder:'PhotoCreate/test'}]}}};
const interrupted = {status:{status_str:'error',messages:[['execution_interrupted',{}]]},outputs:{}};
async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-stop-'));
  const pending = new Set(), running = new Set(), history = new Map(), cancellations = [], submitted = [];
  const hooks = {};
  const mockFetch = async (url,options = {}) => {
    const route = new URL(url).pathname;
    if (route === '/upload/image') {
      await hooks.upload?.();
      return Response.json({name:options.body.get('image').name,subfolder:'PhotoCreate'});
    }
    if (route === '/prompt') {
      const body = JSON.parse(options.body);
      submitted.push(body.prompt_id);pending.add(body.prompt_id);
      await hooks.prompt?.(body.prompt_id,submitted.length);
      return Response.json({prompt_id:body.prompt_id});
    }
    if (route.startsWith('/api/jobs/') && route.endsWith('/cancel')) {
      const id = route.split('/')[3];
      cancellations.push(id);
      await hooks.cancel?.(id);
      const cancelled = pending.delete(id) || running.has(id);
      return Response.json({cancelled});
    }
    if (route === '/queue') return Response.json({queue_running:[...running].map(id => [0,id]),queue_pending:[...pending].map(id => [0,id])});
    if (route.startsWith('/history/')) {
      const id = route.split('/').at(-1);
      await hooks.history?.(id);
      return Response.json(history.has(id) ? {[id]:history.get(id)} : {});
    }
    return Response.json({error:'Unexpected mock endpoint'},{status:400});
  };
  const {app,store} = createApp({dataDir,fetchImpl:mockFetch});
  store.mutate(state => Object.assign(state,fixtureState(),{workflow:structuredClone(TEMPLATE)}));
  for (const asset of [...store.read().characters,...store.read().garments]) fs.writeFileSync(path.join(dataDir,'uploads',asset.fileName),PNG);
  const server = app.listen(0,'127.0.0.1');
  await new Promise(resolve => server.once('listening',resolve));
  t.after(() => {server.close();store.close();});
  const request = async (route,body,method = 'POST') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${route}`,{method,headers:{'Content-Type':'application/json'},...(body === undefined ? {} : {body:JSON.stringify(body)})});
    return {status:response.status,data:await response.json()};
  };
  const create = async (copies = 3) => (await request('/jobs',{...DRAFT,garmentIds:['garment-a'],poseIds:['pose-standing'],copies})).data;
  return {store,request,create,pending,running,history,cancellations,submitted,hooks};
}

test('停止本組取消排隊、等待生成中斷，保留成果與其他組；確認後可重新生成',async t => {
  const f = await fixture(t), jobs = await f.create(), other = await f.create(1);
  await f.request('/jobs/submit',{ids:[...jobs,...other].map(job => job.id)});
  const [first,second,finished] = jobs.map(job => f.store.read().jobs.find(row => row.id === job.id));
  f.pending.delete(first.promptId);f.running.add(first.promptId);
  f.pending.delete(finished.promptId);f.history.set(finished.promptId,success);
  f.pending.add('foreign-comfy-prompt');
  f.store.mutate(state => {Object.assign(state.jobs.find(row => row.id === finished.id),{status:'completed',images:success.outputs[9].images});});
  const stop = await f.request('/jobs/stop',{batchId:first.batchId});
  assert.equal(stop.status,200);assert.equal(stop.data.results.length,2);
  assert.equal(f.store.read().jobs.find(row => row.id === first.id).status,'stopping');
  assert.equal(f.store.read().jobs.find(row => row.id === second.id).status,'stopped');
  assert.equal((await f.request(`/jobs/${first.id}`,undefined,'DELETE')).status,400);
  assert.equal((await f.request('/jobs/submit',{ids:[first.id]})).status,400);
  assert.equal(f.pending.has('foreign-comfy-prompt'),true);
  assert.equal(f.store.read().jobs.find(row => row.id === other[0].id).status,'queued');
  assert.deepEqual(f.store.read().jobs.find(row => row.id === finished.id).images,success.outputs[9].images);
  assert.deepEqual(new Set(f.cancellations),new Set([first.promptId,second.promptId]));
  f.running.delete(first.promptId);f.history.set(first.promptId,interrupted);
  await f.request('/jobs/sync');
  assert.equal(f.store.read().jobs.find(row => row.id === first.id).status,'stopped');
  assert.equal((await f.request('/jobs/submit',{ids:[first.id]})).status,200);
  const retry = f.store.read().jobs.find(row => row.id === first.id);
  assert.equal(retry.status,'queued');assert.notEqual(retry.promptId,first.promptId);
  assert.equal(retry.stopRequestedAt,undefined);assert.equal(retry.stopDispatchedAt,undefined);
});

test('停止全部在參考圖上傳途中阻止目前與後續任務送出',async t => {
  const f = await fixture(t), jobs = await f.create(), reached = gate(), release = gate();
  f.hooks.upload = async () => {reached.resolve();await release.promise;};
  const sending = f.request('/jobs/submit',{ids:jobs.map(job => job.id)});
  await reached.promise;
  const stop = await f.request('/jobs/stop',{all:true});
  assert.equal(stop.data.results.length,3);
  assert(f.store.read().jobs.every(job => job.status === 'stopped'));
  assert.equal((await f.request(`/batches/${jobs[0].batchId}`,undefined,'DELETE')).status,400);
  release.resolve();
  const submitted = await sending;
  assert(submitted.data.results.every(row => row.stopped));
  assert.equal(f.submitted.length,0);assert.equal(f.cancellations.length,0);
});

test('送出回應未到時停止，收到 prompt ID 後取消，後續草稿不再送出',async t => {
  const f = await fixture(t), jobs = await f.create(), reached = gate(), release = gate();
  f.hooks.prompt = async () => {reached.resolve();await release.promise;};
  const sending = f.request('/jobs/submit',{ids:jobs.map(job => job.id)});
  await reached.promise;
  const stop = await f.request('/jobs/stop',{batchId:jobs[0].batchId});
  assert.equal(stop.data.results[0].status,'stopping');assert.equal(f.cancellations.length,0);
  release.resolve();await sending;
  assert.equal(f.submitted.length,1);assert.equal(f.pending.size,0);
  assert(f.store.read().jobs.every(job => job.status === 'stopped'));
  const again = await f.request('/jobs/stop',{all:true});
  assert.equal(again.data.results.length,0);assert.equal(f.cancellations.length,1);
});

test('停止全部同時取消先前已排隊與送出途中的任務',async t => {
  const f = await fixture(t), jobs = await f.create(), reached = gate(), release = gate();
  f.hooks.prompt = async (id,index) => {if(index === 2) {reached.resolve();await release.promise;}};
  const sending = f.request('/jobs/submit',{ids:jobs.map(job => job.id)});
  await reached.promise;
  await f.request('/jobs/stop',{all:true});
  assert.equal(f.pending.has(f.submitted[0]),false);
  assert.equal(f.pending.has(f.submitted[1]),true);
  release.resolve();await sending;
  assert.equal(f.submitted.length,2);assert.equal(f.pending.size,0);
  assert(f.store.read().jobs.every(job => job.status === 'stopped'));
});

test('停止途中送出回應遺失，保留穩定 prompt ID 以確認取消且不重送',async t => {
  const f = await fixture(t), jobs = await f.create(), reached = gate(), release = gate();
  f.hooks.prompt = async () => {reached.resolve();await release.promise;throw new Error('Prompt reply lost');};
  const sending = f.request('/jobs/submit',{ids:jobs.map(job => job.id)});
  await reached.promise;
  await f.request('/jobs/stop',{all:true});
  release.resolve();await sending;
  assert.equal(f.store.read().jobs.find(job => job.id === jobs[0].id).status,'uncertain');
  assert.equal((await f.request('/jobs/submit',{ids:[jobs[0].id]})).status,400);
  await f.request('/jobs/sync');
  assert(f.store.read().jobs.every(job => job.status === 'stopped'));
  assert.deepEqual(f.cancellations,[f.submitted[0]]);assert.equal(f.submitted.length,1);
});

test('停止與完成同時發生時保留完成成果，不中斷另一個 ComfyUI 任務',async t => {
  const f = await fixture(t), [job] = await f.create(1);
  await f.request('/jobs/submit',{ids:[job.id]});
  const promptId = f.submitted[0];
  f.hooks.cancel = () => {f.pending.delete(promptId);f.history.set(promptId,success);f.running.add('other-application');};
  const stop = await f.request('/jobs/stop',{ids:[job.id]});
  assert.equal(stop.data.results[0].status,'completed');
  assert.equal(f.running.has('other-application'),true);
  const finished = f.store.read().jobs.find(row => row.id === job.id);
  assert.equal(finished.status,'completed');assert.deepEqual(finished.images,success.outputs[9].images);
  assert.deepEqual(f.cancellations,[promptId]);
});

test('停止回應遺失或任務不明時保持待確認，禁止重送並能再次查詢停止',async t => {
  const f = await fixture(t), [job] = await f.create(1);
  await f.request('/jobs/submit',{ids:[job.id]});
  f.hooks.cancel = () => {throw new Error('Connection lost');};
  const stop = await f.request('/jobs/stop',{ids:[job.id]});
  assert.equal(stop.data.results[0].ok,false);
  assert.equal(f.store.read().jobs[0].status,'uncertain');
  assert.equal((await f.request('/jobs/submit',{ids:[job.id]})).status,400);
  delete f.hooks.cancel;
  await f.request('/jobs/sync');
  assert.equal(f.store.read().jobs[0].status,'stopped');
  await f.request('/jobs/submit',{ids:[job.id]});
  f.pending.clear();
  const unknown = await f.request('/jobs/stop',{ids:[job.id]});
  assert.equal(unknown.data.results[0].ok,false);
  assert.equal(f.store.read().jobs[0].status,'uncertain');
});

test('停止前開始的狀態同步不得覆蓋已確認停止',async t => {
  const f = await fixture(t), [job] = await f.create(1), reached = gate(), release = gate();
  await f.request('/jobs/submit',{ids:[job.id]});
  let first = true;
  f.hooks.history = async () => {if(first) {first = false;reached.resolve();await release.promise;}};
  const syncing = f.request('/jobs/sync');
  await reached.promise;
  await f.request('/jobs/stop',{ids:[job.id]});
  assert.equal(f.store.read().jobs[0].status,'stopped');
  release.resolve();await syncing;
  assert.equal(f.store.read().jobs[0].status,'stopped');
});

test('完整驗證停止範圍，拒絕混合範圍與未知任務而不取消有效任務',async t => {
  const f = await fixture(t), [job] = await f.create(1);
  await f.request('/jobs/submit',{ids:[job.id]});
  for (const body of [{},{all:false},{all:true,ids:[job.id]},{ids:[]},{ids:[123]}]) assert.equal((await f.request('/jobs/stop',body)).status,400);
  assert.equal((await f.request('/jobs/stop',{ids:[job.id,'unknown']})).status,404);
  assert.equal((await f.request('/jobs/stop',{batchId:'unknown'})).status,404);
  assert.equal(f.cancellations.length,0);assert.equal(f.pending.has(f.submitted[0]),true);
});
