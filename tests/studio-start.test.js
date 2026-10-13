import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {stopExistingStudio} from '../scripts/stop-existing-studio.mjs';

const server={pid:987654,name:'node.exe',commandLine:'"C:\\Program Files\\nodejs\\node.exe" --env-file-if-exists=.env.local server/index.js'};
const healthy=async()=>({ok:true,json:async()=>({ok:true,app:'PhotoCreate'})});

test('啟動檔先成功建置再停止舊服務，不再直接開舊服務網頁後退出',()=>{
  const command=fs.readFileSync(new URL('../Start-PhotoCreate.cmd',import.meta.url),'utf8');
  const build=command.indexOf('call npm run build'),stop=command.indexOf('scripts/stop-existing-studio.mjs'),start=command.indexOf('call npm start');
  assert.ok(build>=0 && stop>build && start>stop);
  assert.doesNotMatch(command,/start "" "http:\/\/127\.0\.0\.1:8764"/);
});

test('辨認舊 PhotoCreate 後只停止其 PID，等待連接埠釋放',async()=>{
  const listeners=[server,server,server,null],stopped=[];
  const result=await stopExistingStudio({port:8764,inspectListener:async()=>listeners.shift(),fetchImpl:healthy,stopProcess:pid=>stopped.push(pid),log:()=>{},wait:async()=>{}});
  assert.deepEqual(stopped,[server.pid]);assert.deepEqual(result,{stopped:true,pid:server.pid,port:8764});assert.equal(listeners.length,0);
});

test('沒有舊服務時可直接啟動；其他程式、錯誤健康回應與 PID 變更均不停止',async()=>{
  const stopped=[],defaults={port:8764,fetchImpl:healthy,stopProcess:pid=>stopped.push(pid),log:()=>{}};
  assert.deepEqual(await stopExistingStudio({...defaults,inspectListener:async()=>null}),{stopped:false,port:8764});
  for(const other of [{...server,name:'python.exe'},{...server,commandLine:'node another-project.js'}]) await assert.rejects(stopExistingStudio({...defaults,inspectListener:async()=>other}),/another application/);
  await assert.rejects(stopExistingStudio({...defaults,inspectListener:async()=>server,fetchImpl:async()=>({ok:true,json:async()=>({ok:true,app:'OtherApp'})})}),/another application/);
  await assert.rejects(stopExistingStudio({...defaults,inspectListener:async()=>server,fetchImpl:async()=>({ok:false})}),/Cannot verify/);
  const changed=[server,{...server,pid:server.pid+1}];
  await assert.rejects(stopExistingStudio({...defaults,inspectListener:async()=>changed.shift()}),/listener changed/);
  assert.deepEqual(stopped,[]);
});

test('連接埠沒有釋放時不啟動第二個服務，無效連接埠不查詢或停止程式',async()=>{
  const stopped=[];
  await assert.rejects(stopExistingStudio({port:8764,inspectListener:async()=>server,fetchImpl:healthy,stopProcess:pid=>stopped.push(pid),log:()=>{},timeoutMs:0}),/did not release/);
  assert.deepEqual(stopped,[server.pid]);
  for(const port of [0,65536,1.5,NaN]) await assert.rejects(stopExistingStudio({port,inspectListener:async()=>{throw new Error('Must not inspect.');}}),/port must be an integer/);
});
