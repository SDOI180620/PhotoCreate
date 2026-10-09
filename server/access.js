import {hostname,networkInterfaces} from 'node:os';

const normalizeHost=value=>value.toLowerCase().replace(/^\[|\]$/g,'').replace(/^::ffff:/,'');
const forbidden=message=>Object.assign(new Error(message),{status:403});

export function workbenchAccess() {
  const computerName=hostname().toLowerCase();
  const names=new Set(['localhost','127.0.0.1','::1','0.0.0.0',computerName,computerName.split('.')[0]]);
  return (req,res,next)=> {
    const host=normalizeHost(req.hostname || '');
    const addresses=Object.values(networkInterfaces()).flat().filter(Boolean).map(row=>normalizeHost(row.address));
    if(!names.has(host) && !addresses.includes(host) && host!==normalizeHost(req.socket.localAddress || '')) return next(forbidden('請使用此電腦的網址連線工作檯。'));
    if(req.headers.origin) {
      try {
        const origin=new URL(req.headers.origin);
        const expected=new URL(`${req.protocol}://${req.get('host')}`);
        if(origin.origin!==expected.origin || origin.username || origin.password) throw new Error();
      } catch {return next(forbidden('無法接受此來源的請求。'));}
    }
    if(req.headers['sec-fetch-site']==='cross-site') return next(forbidden('無法接受跨網站請求。'));
    next();
  };
}
