import {hostname,networkInterfaces} from 'node:os';

const normalizeHost=value=>value.toLowerCase().replace(/^\[|\]$/g,'').replace(/^::ffff:/,'');
const forbidden=message=>Object.assign(new Error(message),{status:403});

function publicAddress(value) {
  if(value==null) return null;
  try {
    const text=value.trim();if(!text) return null;
    const address=new URL(text);
    if(!['http:','https:'].includes(address.protocol) || address.username || address.password || address.pathname!=='/' || address.search || address.hash) throw new Error();
    return address;
  } catch {throw new Error('PHOTOCREATE_PUBLIC_URL 必須是沒有帳密、路徑或查詢參數的 HTTP/HTTPS 網址。');}
}

function matchesPublicAddress(authority,address) {
  if(typeof authority!=='string' || /[/\\@?#\s]/.test(authority)) return false;
  try {
    const request=new URL(`${address.protocol}//${authority}`);
    return request.origin===address.origin && request.pathname==='/' && !request.username && !request.password && !request.search && !request.hash;
  } catch {return false;}
}

export function workbenchAccess({publicUrl=process.env.PHOTOCREATE_PUBLIC_URL}={}) {
  const publicUrlAddress=publicAddress(publicUrl);
  const computerName=hostname().toLowerCase();
  const names=new Set(['localhost','127.0.0.1','::1','0.0.0.0',computerName,computerName.split('.')[0]]);
  return (req,res,next)=> {
    const host=normalizeHost(req.hostname || '');
    const addresses=Object.values(networkInterfaces()).flat().filter(Boolean).map(row=>normalizeHost(row.address));
    const publicHost=publicUrlAddress && host===normalizeHost(publicUrlAddress.hostname) && matchesPublicAddress(req.get('host'),publicUrlAddress);
    if(!publicHost && !names.has(host) && !addresses.includes(host) && host!==normalizeHost(req.socket.localAddress || '')) return next(forbidden('請使用此電腦的網址連線工作檯。'));
    if(req.headers.origin) {
      try {
        const origin=new URL(req.headers.origin);
        const expected=publicHost ? publicUrlAddress : new URL(`${req.protocol}://${req.get('host')}`);
        if(origin.origin!==expected.origin || origin.username || origin.password) throw new Error();
      } catch {return next(forbidden('無法接受此來源的請求。'));}
    }
    if(req.headers['sec-fetch-site']==='cross-site') return next(forbidden('無法接受跨網站請求。'));
    next();
  };
}

export function localWorkbenchOnly(req,res,next) {
  const peer=normalizeHost(req.socket.remoteAddress || '');
  const host=normalizeHost(req.hostname || '');
  if(!['127.0.0.1','::1'].includes(peer) || !['localhost','127.0.0.1','::1','0.0.0.0'].includes(host)) return next(forbidden('管理功能請在此電腦使用 localhost 網址開啟。'));
  next();
}
