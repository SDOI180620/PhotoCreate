import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {restoreBackup} from '../server/backups.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),archive=process.argv[2];
if(!archive) {console.error('請將 PhotoCreate 完整備份 ZIP 拖曳到 Restore-PhotoCreate.cmd。');process.exitCode=1;}
else {
  try {
    const assertOffline=async()=>{
      let running=false;
      try {const response=await fetch(`http://127.0.0.1:${Number(process.env.PHOTOCREATE_PORT || 8764)}/api/health`,{signal:AbortSignal.timeout(1500)});running=(await response.json()).app==='PhotoCreate';} catch {/* The service is offline. */}
      if(running) throw new Error('請先關閉 PhotoCreate，再執行還原；ComfyUI 可以保持開啟。');
    };
    const result=await restoreBackup({archive:path.resolve(archive),dataDir:process.env.PHOTOCREATE_DATA_DIR || path.join(root,'data'),assertOffline});
    console.log(`完整備份已還原（${result.files} 個檔案）。請開啟 Start-PhotoCreate.cmd，使用備份內的帳號登入。`);
    if(result.previousDataDir) console.log(`還原前的資料已保留於：${result.previousDataDir}`);
    if(result.unavailableOriginals) console.log(`這份備份有 ${result.unavailableOriginals} 張歷史照片的原始來源未能取得。`);
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
