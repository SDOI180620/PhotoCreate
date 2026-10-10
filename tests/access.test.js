import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createApp} from '../server/index.js';
import {workbenchAccess} from '../server/access.js';
import {login} from './auth-client.js';

// http.request preserves the explicit Host header, unlike this Node fetch implementation.
const request=(url,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=> {
  const req=http.request(url,{method,headers},res=>{res.resume();res.once('end',()=>resolve({status:res.statusCode}));});
  req.on('error',reject);req.end(body);
});

test('本機與區網都需管理員登入，合法管理員可透過同源網址使用後台',async t=> {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'photocreate-access-'));
  const {app,store}=createApp({dataDir,fetchImpl:async()=>{throw Error('No upstream requests expected');}});
  const server=app.listen(0,'0.0.0.0');await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();assert.equal(path.dirname(fs.realpathSync(dataDir)),fs.realpathSync(os.tmpdir()));fs.rmSync(dataDir,{recursive:true,force:true});});
  assert.equal(server.address().address,'0.0.0.0');
  const port=server.address().port,url=`http://127.0.0.1:${port}`;
  const admin=await login(url);
  const lan=Object.values(os.networkInterfaces()).flat().filter(row=>row && !row.internal && row.family==='IPv4').map(row=>row.address);
  for(const host of ['127.0.0.1','localhost','0.0.0.0',os.hostname(),...lan]) {
    const authority=`${host}:${port}`;
    const health=await request(url+'/api/health',{headers:{Host:authority}});assert.equal(health.status,200,host);
    const headers={Host:authority,Origin:`http://${authority}`,'sec-fetch-site':'same-origin','content-type':'application/json'};
    assert.equal((await request(url+'/api/draft',{method:'PUT',headers,body:JSON.stringify({steps:99})})).status,401,host);
    const save=await request(url+'/api/draft',{method:'PUT',headers:{...headers,Cookie:admin.cookie},body:JSON.stringify({steps:33})});assert.equal(save.status,200,host);
  }
  assert.equal(store.read().draft.steps,33);
});

test('LAN access retains rejection of foreign hosts, origins, alternate-port origins and cross-site requests',async t=> {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'photocreate-access-'));
  const {app,store}=createApp({dataDir});const server=app.listen(0,'0.0.0.0');await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();assert.equal(path.dirname(fs.realpathSync(dataDir)),fs.realpathSync(os.tmpdir()));fs.rmSync(dataDir,{recursive:true,force:true});});
  const port=server.address().port,url=`http://127.0.0.1:${port}`;
  const before=store.read();
  for(const headers of [
    {Host:`attacker.example:${port}`},
    {Host:`localhost:${port}`,Origin:'https://attacker.example'},
    {Host:`localhost:${port}`,Origin:`http://localhost:${port+1}`,'sec-fetch-site':'same-site'},
    {Origin:'null'},
    {Origin:url,'sec-fetch-site':'cross-site'},
    {Host:`attacker.example:${port}`,'x-forwarded-host':`localhost:${port}`},
  ]) {
    const response=await request(url+'/api/draft',{method:'PUT',headers:{...headers,'content-type':'application/json'},body:'{"steps":99}'});assert.equal(response.status,403,JSON.stringify(headers));
  }
  assert.deepEqual(store.read(),before);
});

test('公網與 HTTPS 代理保留來源檢查，未登入拒絕私有資料，管理員登入可管理',async t=> {
  for(const publicUrl of ['http://203.0.113.10:8764','https://studio.example.test']) {
    const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'photocreate-access-'));
    const {app,store}=createApp({dataDir,publicUrl,fetchImpl:async()=>{throw Error('No upstream requests expected');}});
    const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();assert.equal(path.dirname(fs.realpathSync(dataDir)),fs.realpathSync(os.tmpdir()));fs.rmSync(dataDir,{recursive:true,force:true});});
    const url=`http://127.0.0.1:${server.address().port}`,authority=new URL(publicUrl).host;
    assert.equal((await request(url+'/api/health',{headers:{Host:authority}})).status,200,publicUrl);
    const save=await request(url+'/api/draft',{method:'PUT',headers:{Host:authority,Origin:publicUrl,'sec-fetch-site':'same-origin','content-type':'application/json'},body:JSON.stringify({steps:34})});
    assert.equal(save.status,401,publicUrl);assert.equal(store.read().draft.steps,undefined);
    assert.equal((await request(url+'/api/studio/state',{headers:{Host:authority,Origin:publicUrl,'sec-fetch-site':'same-origin'}})).status,401,publicUrl);
    const admin=await login(url);
    assert.equal((await request(url+'/api/draft',{method:'PUT',headers:{Host:authority,Origin:publicUrl,Cookie:admin.cookie,'content-type':'application/json'},body:JSON.stringify({steps:34})})).status,200,publicUrl);
    assert.equal((await request(url+'/api/health')).status,200,'Local access remains available');
    if(publicUrl.startsWith('https:')) assert.equal((await request(url+'/api/health',{headers:{Host:authority+':443'}})).status,200,'Explicit default HTTPS port');
  }
});

test('public URL access rejects other hosts, ports, schemes, origins and spoofed proxy headers',async t=> {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'photocreate-access-'));
  const {app,store}=createApp({dataDir,publicUrl:'https://studio.example.test'});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();assert.equal(path.dirname(fs.realpathSync(dataDir)),fs.realpathSync(os.tmpdir()));fs.rmSync(dataDir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${server.address().port}`,before=store.read();
  for(const headers of [
    {Host:'attacker.example',Origin:'https://attacker.example'},
    {Host:'203.0.113.11:8764'},
    {Host:'studio.example.test:8443',Origin:'https://studio.example.test:8443'},
    {Host:'studio.example.test:443/'},
    {Host:'studio.example.test:443\\'},
    {Host:'studio.example.test',Origin:'http://studio.example.test','x-forwarded-proto':'http'},
    {Host:'studio.example.test',Origin:'https://studio.example.test:8443'},
    {Host:'studio.example.test',Origin:'https://user:password@studio.example.test'},
    {Host:'studio.example.test',Origin:'null'},
    {Host:'studio.example.test',Origin:'https://studio.example.test','sec-fetch-site':'cross-site'},
    {Host:'attacker.example','x-forwarded-host':'studio.example.test','x-forwarded-proto':'https'},
    {Host:`localhost:${server.address().port}`,Origin:'https://studio.example.test'},
  ]) {
    const response=await request(url+'/api/draft',{method:'PUT',headers:{...headers,'content-type':'application/json'},body:'{"steps":99}'});
    assert.equal(response.status,403,JSON.stringify(headers));
  }
  assert.deepEqual(store.read(),before);
});

test('public URL configuration must be an HTTP or HTTPS root address without credentials',()=> {
  for(const publicUrl of ['not a URL','ftp://studio.example.test','https://user:password@studio.example.test','https://studio.example.test/path','https://studio.example.test/?token=example','https://studio.example.test/#fragment']) {
    assert.throws(()=>workbenchAccess({publicUrl}),/PHOTOCREATE_PUBLIC_URL/,publicUrl);
  }
});
