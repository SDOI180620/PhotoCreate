import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createApp} from '../server/index.js';

// http.request preserves the explicit Host header, unlike this Node fetch implementation.
const request=(url,{method='GET',headers={},body}={})=>new Promise((resolve,reject)=> {
  const req=http.request(url,{method,headers},res=>{res.resume();res.once('end',()=>resolve({status:res.statusCode}));});
  req.on('error',reject);req.end(body);
});

test('all-interface listener accepts local, computer-name and LAN hosts with matching origins',async t=> {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'photocreate-access-'));
  const {app,store}=createApp({dataDir,fetchImpl:async()=>{throw Error('No upstream requests expected');}});
  const server=app.listen(0,'0.0.0.0');await new Promise(resolve=>server.once('listening',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));store.close();assert.equal(path.dirname(fs.realpathSync(dataDir)),fs.realpathSync(os.tmpdir()));fs.rmSync(dataDir,{recursive:true,force:true});});
  assert.equal(server.address().address,'0.0.0.0');
  const port=server.address().port,url=`http://127.0.0.1:${port}`;
  const lan=Object.values(os.networkInterfaces()).flat().filter(row=>row && !row.internal && row.family==='IPv4').map(row=>row.address);
  for(const host of ['127.0.0.1','localhost','0.0.0.0',os.hostname(),...lan]) {
    const authority=`${host}:${port}`;
    const health=await request(url+'/api/health',{headers:{Host:authority}});assert.equal(health.status,200,host);
    const save=await request(url+'/api/draft',{method:'PUT',headers:{Host:authority,Origin:`http://${authority}`,'sec-fetch-site':'same-origin','content-type':'application/json'},body:JSON.stringify({steps:33})});assert.equal(save.status,200,host);
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
