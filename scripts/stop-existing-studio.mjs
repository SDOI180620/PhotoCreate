import {execFile} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const execFileAsync=promisify(execFile);

export async function inspectStudioListener(port) {
  if(!Number.isInteger(port) || port<1 || port>65535) throw new Error('PhotoCreate port must be an integer from 1 to 65535.');
  if(process.platform!=='win32') throw new Error('This launcher requires Windows.');
  const command=`$taskConnections = @(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -in @('0.0.0.0','127.0.0.1','::','::1') })
$taskOwners = @($taskConnections | Select-Object -ExpandProperty OwningProcess -Unique)
if ($taskOwners.Count -eq 0) { 'null'; exit 0 }
if ($taskOwners.Count -ne 1) { throw 'Multiple processes are listening on the studio port.' }
$taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($taskOwners[0])"
if (-not $taskProcess) { 'null'; exit 0 }
[pscustomobject]@{pid=$taskProcess.ProcessId;name=$taskProcess.Name;commandLine=$taskProcess.CommandLine} | ConvertTo-Json -Compress`;
  const {stdout}=await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:5000});
  return JSON.parse(stdout.trim());
}

const isStudioProcess=processInfo=>Number.isInteger(processInfo?.pid) && processInfo.pid>0 && processInfo.pid!==process.pid
  && /^node(?:\.exe)?$/i.test(processInfo.name || '')
  && /(?:^|[\\/\s"'])server[\\/]index\.js(?=$|[\s"'])/i.test(processInfo.commandLine || '');

export async function stopExistingStudio({port=Number(process.env.PHOTOCREATE_PORT || 8764),inspectListener=inspectStudioListener,fetchImpl=fetch,stopProcess=pid=>process.kill(pid),log=console.log,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),timeoutMs=10000}={}) {
  if(!Number.isInteger(port) || port<1 || port>65535) throw new Error('PhotoCreate port must be an integer from 1 to 65535.');
  const listener=await inspectListener(port);
  if(!listener) return {stopped:false,port};
  if(!isStudioProcess(listener)) throw new Error(`Port ${port} is used by another application. Its process was not stopped.`);
  let health;
  try {
    const response=await fetchImpl(`http://127.0.0.1:${port}/api/health`,{signal:AbortSignal.timeout(3000)});
    if(!response.ok) throw new Error('Unhealthy response.');
    health=await response.json();
  } catch {throw new Error(`Cannot verify the service on port ${port} as PhotoCreate. Its process was not stopped.`);}
  if(health.app!=='PhotoCreate' || health.ok!==true) throw new Error(`Port ${port} is used by another application. Its process was not stopped.`);
  const current=await inspectListener(port);
  if(current?.pid!==listener.pid || current?.commandLine!==listener.commandLine || !isStudioProcess(current)) throw new Error('The listener changed during startup. No process was stopped.');
  log(`Stopping the previous PhotoCreate service (PID ${listener.pid}) to load the latest code.`);
  stopProcess(listener.pid);
  const deadline=Date.now()+timeoutMs;
  while(await inspectListener(port)) {
    if(Date.now()>=deadline) throw new Error(`The previous service did not release port ${port}. A second service was not started.`);
    await wait(200);
  }
  return {stopped:true,pid:listener.pid,port};
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  stopExistingStudio().catch(error=>{console.error(error.message);process.exitCode=1;});
}
