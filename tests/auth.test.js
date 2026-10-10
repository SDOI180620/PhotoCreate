import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createApp} from '../server/index.js';
import {fixtureState,PNG,TEMPLATE,DRAFT} from './fixtures.js';
import {buildShotPlans} from '../shared/domain.js';
import {login} from './auth-client.js';

async function fixture(t) {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-auth-'));
  const fetchImpl=async url=>new URL(url).pathname==='/view' ? new Response(PNG,{headers:{'content-type':'image/png'}}) : Response.json({});
  let instance,server,base;
  const start=async()=>{
    instance=createApp({dataDir,fetchImpl});
    if(!instance.store.read().characters.length) instance.store.mutate(state=>Object.assign(state,fixtureState(),{workflow:TEMPLATE}));
    for(const row of instance.store.read().characters) if(!fs.existsSync(path.join(dataDir,'uploads',row.fileName))) fs.writeFileSync(path.join(dataDir,'uploads',row.fileName),PNG);
    server=instance.app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base=`http://127.0.0.1:${server.address().port}`;
    await instance.authentication.ready;
  };
  const close=async()=>{await new Promise(resolve=>server.close(resolve));instance.store.close();};
  await start();
  t.after(async()=>{await close();const target=fs.realpathSync(dataDir);assert.equal(path.dirname(target),fs.realpathSync(os.tmpdir()));assert(path.basename(target).startsWith('PhotoCreate-auth-'));fs.rmSync(target,{recursive:true,force:true});});
  const request=async(route,{cookie,body,method=body===undefined ? 'GET' : 'POST',headers={},redirect='follow'}={})=>{
    const form=body instanceof FormData;
    const response=await fetch(base+route,{method,headers:{...(cookie ? {Cookie:cookie} : {}),...(form ? {} : {'content-type':'application/json'}),...headers},redirect,...(body===undefined ? {} : {body:form ? body : JSON.stringify(body)})});
    const type=response.headers.get('content-type') || '';
    return {status:response.status,headers:response.headers,data:type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer())};
  };
  const create=async(username='customer-a',password='customer-secret')=>{
    const admin=await login(base),result=await request('/api/accounts',{cookie:admin.cookie,body:{username,password,name:username}});
    assert.equal(result.status,201);return result.data;
  };
  return {dataDir,request,create,get base(){return base;},get store(){return instance.store;},restart:async()=>{await close();await start();}};
}

test('登入角色分流，未登入與偽造 Cookie 無法讀取任何私人 API',async t=>{
  const f=await fixture(t);
  const session=await f.request('/api/auth/session');assert.equal(session.data.user,null);assert.match(session.headers.get('cache-control'),/no-store/);
  for(const route of ['/api/state','/api/accounts','/api/studio/state','/uploads/character.png']) {
    assert.equal((await f.request(route)).status,401,route);
    assert.equal((await f.request(route,{cookie:`pc_session=${randomBytes(32).toString('hex')}`,headers:{'x-forwarded-for':'127.0.0.1','x-forwarded-host':'localhost'}})).status,401,route);
  }
  const page=await f.request('/admin',{redirect:'manual'});assert.equal(page.status,302);assert.equal(page.headers.get('location'),'/login');
  const wrong=await f.request('/api/auth/login',{body:{username:'admin153',password:'wrong-password'}});assert.equal(wrong.status,401);assert.equal(wrong.headers.get('set-cookie'),null);
  const admin=await login(f.base,'ADMIN153');assert.equal(admin.user.role,'admin');assert.match(admin.headers.get('set-cookie'),/HttpOnly; SameSite=Lax/);
  const adminSession=await f.request('/api/auth/session',{cookie:admin.cookie});assert.equal(adminSession.data.user.username,'admin153');
  for(const field of ['password','password_hash','owner_id','token_hash']) assert.equal(adminSession.data.user[field],undefined);
  assert.equal((await f.request('/api/state',{cookie:admin.cookie})).status,200);
  assert.equal((await f.request('/api/studio/state',{cookie:admin.cookie})).status,403);
});

test('只有管理員能建立顧客，重複帳號、角色提權與無效欄位被拒絕',async t=>{
  const f=await fixture(t),admin=await login(f.base),customer=await f.create();
  const alice=await login(f.base,'customer-a','customer-secret');
  assert.equal((await f.request('/api/accounts',{cookie:alice.cookie})).status,403);
  assert.equal((await f.request('/api/accounts',{cookie:alice.cookie,body:{username:'intruder',password:'secret123',role:'admin'}})).status,403);
  assert.equal((await f.request('/api/accounts',{cookie:admin.cookie,body:{username:'CUSTOMER-A',password:'secret123'}})).status,409);
  for(const body of [{username:'x',password:'secret123'},{username:'space name',password:'secret123'},{username:'valid-name',password:'x'},{username:'valid-name',password:'secret123',role:'admin'}]) assert.equal((await f.request('/api/accounts',{cookie:admin.cookie,body})).status,400);
  assert.equal((await f.request(`/api/accounts/${customer.id}`,{cookie:admin.cookie,method:'PATCH',body:{role:'admin'}})).status,400);
  const list=(await f.request('/api/accounts',{cookie:admin.cookie})).data.accounts;assert.equal(list.length,1);assert.equal(list[0].role,'customer');
  assert.doesNotMatch(JSON.stringify(list),/password_hash|owner_id|customer-secret/);
  assert.equal((await f.request('/admin',{cookie:alice.cookie,redirect:'manual'})).headers.get('location'),'/');
  assert.equal((await f.request('/api/draft',{cookie:alice.cookie,method:'PUT',body:{steps:99}})).status,403);
});

test('同一顧客換裝置與重啟仍看同一組角色與照片，不同顧客互相隔離',async t=>{
  const f=await fixture(t);await f.create('customer-a');await f.create('customer-b');
  const alice=await login(f.base,'customer-a','customer-secret'),bob=await login(f.base,'customer-b','customer-secret');
  const form=new FormData();form.append('image',new Blob([PNG],{type:'image/png'}),'Alice.png');
  const uploaded=await f.request('/api/studio/characters',{cookie:alice.cookie,body:form});assert.equal(uploaded.status,201);
  const character=f.store.read().characters.find(row=>row.id===uploaded.data.id),owner=character.visitorId;
  const [plan]=buildShotPlans(f.store.read(),{...DRAFT,characterId:character.id,garmentIds:['garment-a'],poseIds:['pose-standing'],copies:1,cameraEnabled:false});
  const job={...plan,visitorId:owner,createdAt:new Date().toISOString(),status:'completed',images:[{filename:'neutral-photo.png',type:'output'}]};f.store.mutate(state=>state.jobs.push(job));
  const secondDevice=await login(f.base,'customer-a','customer-secret');assert.notEqual(secondDevice.cookie,alice.cookie);
  const state=(await f.request('/api/studio/state',{cookie:secondDevice.cookie})).data;
  assert(state.characters.some(row=>row.id===character.id && row.owned));assert.equal(state.jobs[0].id,job.id);
  const other=(await f.request('/api/studio/state',{cookie:bob.cookie})).data;assert.equal(other.jobs.length,0);assert(!other.characters.some(row=>row.id===character.id));
  for(const route of [`/api/studio/characters/${character.id}/image`,`/api/studio/jobs/${job.id}/image/0`,`/api/studio/jobs/${job.id}/prompts`]) {
    assert.equal((await f.request(route,{cookie:secondDevice.cookie})).status,200,route);
    assert.equal((await f.request(route,{cookie:bob.cookie})).status,404,route);
  }
  await f.restart();
  assert.equal((await f.request('/api/studio/state',{cookie:secondDevice.cookie})).data.jobs[0].id,job.id);
  assert.equal(f.store.read().characters.find(row=>row.id===character.id).visitorId,owner);
});

test('登出撤銷本裝置，重設密碼與停用則撤銷顧客所有裝置且保留圖片',async t=>{
  const f=await fixture(t),customer=await f.create(),admin=await login(f.base);
  const first=await login(f.base,'customer-a','customer-secret'),second=await login(f.base,'customer-a','customer-secret');
  assert.equal((await f.request('/api/auth/logout',{cookie:first.cookie,body:{}})).status,200);
  assert.equal((await f.request('/api/studio/state',{cookie:first.cookie})).status,401);
  assert.equal((await f.request('/api/studio/state',{cookie:second.cookie})).status,200);
  const count=f.store.read().characters.length;
  assert.equal((await f.request(`/api/accounts/${customer.id}`,{cookie:admin.cookie,method:'PATCH',body:{password:'updated-secret'}})).status,200);
  assert.equal((await f.request('/api/studio/state',{cookie:second.cookie})).status,401);
  assert.equal((await f.request('/api/auth/login',{body:{username:'customer-a',password:'customer-secret'}})).status,401);
  const updated=await login(f.base,'customer-a','updated-secret');
  assert.equal((await f.request(`/api/accounts/${customer.id}`,{cookie:admin.cookie,method:'PATCH',body:{enabled:false}})).status,200);
  assert.equal((await f.request('/api/studio/state',{cookie:updated.cookie})).status,401);
  assert.equal((await f.request('/api/auth/login',{body:{username:'customer-a',password:'updated-secret'}})).status,401);
  assert.equal(f.store.read().characters.length,count);
  await f.request(`/api/accounts/${customer.id}`,{cookie:admin.cookie,method:'PATCH',body:{enabled:true}});
  assert.equal((await f.request('/api/studio/state',{cookie:updated.cookie})).status,401,'Re-enabling must not resurrect revoked sessions');
  assert.equal((await login(f.base,'customer-a','updated-secret')).user.role,'customer');
});

test('修改管理員密碼會撤銷其他裝置，重開服務不會恢復預設密碼',async t=>{
  const f=await fixture(t),admin=await login(f.base),other=await login(f.base);
  assert.equal((await f.request('/api/auth/password',{cookie:admin.cookie,body:{currentPassword:'wrong-password',password:'new-admin-secret'}})).status,400);
  const changed=await f.request('/api/auth/password',{cookie:admin.cookie,body:{currentPassword:'admin153',password:'new-admin-secret'}});assert.equal(changed.status,200);
  const cookie=changed.headers.get('set-cookie').split(';')[0];assert.notEqual(cookie,admin.cookie);
  assert.equal((await f.request('/api/state',{cookie:other.cookie})).status,401);
  assert.equal((await f.request('/api/state',{cookie})).status,200);
  await f.restart();
  assert.equal((await f.request('/api/auth/login',{body:{username:'admin153',password:'admin153'}})).status,401);
  assert.equal((await login(f.base,'admin153','new-admin-secret')).user.role,'admin');
});

test('舊瀏覽器攝影棚只在持有原 Cookie 的顧客登入時歸入該帳號',async t=>{
  const f=await fixture(t);await f.create();
  const token=randomBytes(32).toString('hex'),legacy=createHash('sha256').update(token).digest('hex');
  const original=f.store.read().characters[0];
  const createdAt=new Date().toISOString();
  f.store.mutate(state=>{state.characters.push({...original,id:'legacy-private',visitorId:legacy});state.jobs.push({id:'legacy-job',visitorId:legacy,createdAt,status:'completed',images:[]});state.batches.push({id:'legacy-batch',name:'Legacy studio',createdAt,visitorId:legacy});});
  const admin=await login(f.base,'admin153','admin153',`pc_session=${token}`);assert.equal(admin.user.role,'admin');assert.equal(f.store.read().jobs[0].visitorId,legacy);
  const alice=await login(f.base,'customer-a','customer-secret',`pc_session=${token}`),state=(await f.request('/api/studio/state',{cookie:alice.cookie})).data;
  assert(state.characters.some(row=>row.id==='legacy-private' && row.owned));assert.equal(state.jobs[0].id,'legacy-job');
  const owner=f.store.read().jobs[0].visitorId;assert.notEqual(owner,legacy);assert.equal(f.store.read().batches[0].visitorId,owner);
  assert.equal((await f.request('/api/studio/state',{cookie:`pc_session=${token}`})).status,401);
});

test('密碼與 session token 以雜湊保存，過期與跨來源請求不接受',async t=>{
  const f=await fixture(t),admin=await login(f.base);
  const db=new DatabaseSync(path.join(f.dataDir,'accounts.sqlite'));
  try {
    const password=db.prepare("SELECT password_hash FROM accounts WHERE username='admin153'").get().password_hash;
    assert.match(password,/^scrypt:/);assert(!password.includes('admin153'));
    const token=admin.cookie.split('=')[1],stored=db.prepare('SELECT token_hash FROM sessions').all();
    assert(stored.every(row=>row.token_hash!==token));assert(stored.some(row=>row.token_hash===createHash('sha256').update(token).digest('hex')));
    const blocked=await f.request('/api/accounts',{cookie:admin.cookie,headers:{Origin:'https://attacker.example'},body:{username:'evil-account',password:'secret123'}});assert.equal(blocked.status,403);
    db.prepare('UPDATE sessions SET expires_at=0').run();
    assert.equal((await f.request('/api/state',{cookie:admin.cookie})).status,401);
    assert.equal((await f.request('/api/auth/session',{cookie:admin.cookie})).data.user,null);
  } finally {db.close();}
});

test('重複錯誤登入受到限制，偽造轉送 IP 不會繞過限制',async t=>{
  const f=await fixture(t);
  for(let index=0;index<8;index++) assert.equal((await f.request('/api/auth/login',{body:{username:'admin153',password:'wrong-password'},headers:{'x-forwarded-for':`203.0.113.${index+1}`}})).status,401);
  const blocked=await f.request('/api/auth/login',{body:{username:'admin153',password:'admin153'},headers:{'x-forwarded-for':'127.0.0.1'}});assert.equal(blocked.status,429);
});
