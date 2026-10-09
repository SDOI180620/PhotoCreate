import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deleteOutputFiles } from '../server/outputs.js';
import { PNG } from './fixtures.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-test-outputs-'));
  fs.mkdirSync(path.join(dir,'PhotoCreate','test'),{recursive:true});
  const file = path.join(dir,'PhotoCreate','test','result.png');
  fs.writeFileSync(file,PNG);
  return {dir,file,image:{filename:'result.png',subfolder:'PhotoCreate/test',type:'output'}};
}

test('刪除自己的成果實體檔，重複與已不存在檔案可安全處理',() => {
  const {dir,file,image} = fixture();
  assert.equal(deleteOutputFiles(dir,[image,image]),1);assert.equal(fs.existsSync(file),false);
  assert.equal(deleteOutputFiles(dir,[image]),0);
});

test('整批刪除先驗證，拒絕路徑穿越、輸入圖與其他目錄',() => {
  const {dir,file,image} = fixture();
  for(const unsafe of [{...image,filename:'../result.png'},{...image,filename:'result.png:stream'},{...image,subfolder:'PhotoCreate/../elsewhere'},{...image,subfolder:'/PhotoCreate/test'},{...image,subfolder:'Other/test'},{...image,type:'input'}]) {
    assert.throws(() => deleteOutputFiles(dir,[image,unsafe]));assert.equal(fs.existsSync(file),true);
  }
});

test('目錄連結不能讓成果刪除超出指定的 ComfyUI 輸出資料夾',() => {
  const {dir,image} = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(),'PhotoCreate-test-outside-'));
  const file = path.join(outside,'result.png');fs.writeFileSync(file,PNG);
  fs.symlinkSync(outside,path.join(dir,'PhotoCreate','linked'),process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => deleteOutputFiles(dir,[{...image,subfolder:'PhotoCreate/linked'}]),/以外/);
  assert.equal(fs.existsSync(file),true);
});
