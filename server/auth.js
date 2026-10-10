import express from 'express';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomBytes,randomUUID,scrypt,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';

const derive=promisify(scrypt);
const SCRYPT={N:32768,r:8,p:3,maxmem:64*1024*1024};
const SESSION_MS=30*24*60*60*1000;
const LOGIN_WINDOW=15*60*1000;
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const digest=value=>createHash('sha256').update(value).digest('hex');
const cookieToken=req=>String(req.headers.cookie || '').split(';').map(part=>part.trim()).find(part=>part.startsWith('pc_session='))?.slice(11);
const tokenHash=req=>/^[a-f0-9]{64}$/.test(cookieToken(req) || '') ? digest(cookieToken(req)) : null;
const usernameField=value=>{
  if(typeof value!=='string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,39}$/.test(value.trim())) throw fail('帳號須為 3–40 個英文字母、數字、底線、點或短橫線。');
  return value.trim().toLowerCase();
};
const passwordField=value=>{
  if(typeof value!=='string' || value.length<6 || value.length>128) throw fail('密碼須為 6–128 個字元。');
  return value;
};
const nameField=(value,username)=>{
  if(value===undefined) return username;
  if(typeof value!=='string' || value.length>80) throw fail('顧客名稱最多 80 個字元。');
  return value.trim() || username;
};
const publicAccount=row=>({id:row.id,username:row.username,name:row.name,role:row.role,enabled:Boolean(row.enabled),createdAt:row.created_at,lastLoginAt:row.last_login_at});
async function hashPassword(password) {
  const salt=randomBytes(16).toString('hex'),key=await derive(password,salt,64,SCRYPT);
  return `scrypt:${salt}:${key.toString('hex')}`;
}
async function passwordMatches(password,encoded) {
  const [algorithm,salt,hash]=encoded.split(':');
  if(algorithm!=='scrypt' || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(hash)) return false;
  const actual=await derive(password,salt,64,SCRYPT);
  return timingSafeEqual(actual,Buffer.from(hash,'hex'));
}

// Credentials and sessions live outside the portable library and state DTO.
// A stable owner ID ties private photos to the account across devices.
export function createAuthentication({dataDir,publicUrl,claimLegacyStudio=()=>{},now=Date.now}) {
  const db=new DatabaseSync(path.join(dataDir,'accounts.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,username TEXT NOT NULL COLLATE NOCASE UNIQUE,name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','customer')),password_hash TEXT NOT NULL,
      owner_id TEXT NOT NULL UNIQUE,enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      created_at TEXT NOT NULL,last_login_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id);`);
  let closed=false;
  const ready=(async()=>{
    if(db.prepare("SELECT id FROM accounts WHERE role='admin' LIMIT 1").get()) return;
    const hash=await hashPassword('admin153');
    if(!closed) db.prepare('INSERT OR IGNORE INTO accounts(id,username,name,role,password_hash,owner_id,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(randomUUID(),'admin153','管理員','admin',hash,randomBytes(32).toString('hex'),new Date(now()).toISOString());
  })();
  const byId=id=>db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
  const sessionFor=hash=>hash ? db.prepare('SELECT accounts.* FROM sessions JOIN accounts ON accounts.id=sessions.account_id WHERE token_hash=? AND expires_at>? AND enabled=1').get(hash,now()) : undefined;
  const cookie=(req,res,token)=>{
    const secure=req.secure || publicUrl?.startsWith('https:') && !['localhost','127.0.0.1','::1'].includes(req.hostname);
    res.append('Set-Cookie',`pc_session=${token || ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? SESSION_MS/1000 : 0}${secure ? '; Secure' : ''}`);
  };
  const issueSession=(req,account)=>{
    const token=randomBytes(32).toString('hex'),at=now();
    db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(at);
    if(req.sessionHash) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.sessionHash);
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(digest(token),account.id,at+SESSION_MS,at);
    db.prepare('DELETE FROM sessions WHERE account_id=? AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE account_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20)').run(account.id,account.id);
    return token;
  };
  const requireRole=role=>(req,res,next)=>{
    if(!req.account) return res.status(401).json({error:'請先登入 PhotoCreate。',code:'AUTH_REQUIRED'});
    if(role && req.account.role!==role) return res.status(403).json({error:'此帳號無法使用管理功能。'});
    next();
  };
  const attempts=new Map();
  const recordAttempt=(req,username)=>{
    const at=now();
    for(const [key,value] of attempts) if(value.until<=at) attempts.delete(key);
    if(attempts.size>10000) throw fail('登入暫時繁忙，請稍後再試。',429);
    const keys=[`ip:${req.socket.remoteAddress}`,`account:${username}`];
    if(keys.some(key=>(attempts.get(key)?.count || 0)>= (key.startsWith('ip:') ? 40 : 8))) throw fail('登入嘗試過多，請 15 分鐘後再試。',429);
    for(const key of keys) {const row=attempts.get(key) || {count:0,until:at+LOGIN_WINDOW};row.count++;attempts.set(key,row);}
    return keys;
  };
  const createCustomer=async input=>{
    await ready;
    const username=usernameField(input.username),password=passwordField(input.password),name=nameField(input.name,username);
    if(input.role!==undefined && input.role!=='customer') throw fail('只能建立顧客帳號。');
    if(db.prepare('SELECT id FROM accounts WHERE username=?').get(username)) throw fail('此帳號已存在，請使用其他帳號。',409);
    const hash=await hashPassword(password),id=randomUUID();
    try {db.prepare('INSERT INTO accounts(id,username,name,role,password_hash,owner_id,created_at) VALUES(?,?,?,?,?,?,?)').run(id,username,name,'customer',hash,randomBytes(32).toString('hex'),new Date(now()).toISOString());}
    catch(error) {if(error.code?.startsWith('ERR_SQLITE') && db.prepare('SELECT id FROM accounts WHERE username=?').get(username)) throw fail('此帳號已存在，請使用其他帳號。',409);throw error;}
    return publicAccount(byId(id));
  };
  const router=express.Router();
  router.get('/session',(req,res)=>res.json({user:req.account ? publicAccount(req.account) : null}));
  router.post('/login',async(req,res)=>{
    const username=typeof req.body?.username==='string' ? req.body.username.trim().toLowerCase().slice(0,80) : '';
    const keys=recordAttempt(req,username);
    const validUsername=/^[a-z0-9][a-z0-9_.-]{2,39}$/.test(username),password=req.body?.password;
    if(!validUsername || typeof password!=='string' || password.length>128) throw fail('帳號或密碼不正確。',401);
    const account=db.prepare('SELECT * FROM accounts WHERE username=?').get(username);
    const dummy=db.prepare("SELECT password_hash FROM accounts WHERE role='admin' LIMIT 1").get().password_hash;
    const valid=await passwordMatches(password,account?.password_hash || dummy),current=account && byId(account.id);
    if(!valid || !current?.enabled || current.password_hash!==account.password_hash) throw fail('帳號或密碼不正確。',401);
    if(current.role==='customer' && !req.account && req.sessionHash) claimLegacyStudio(req.sessionHash,current.owner_id);
    let token;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE accounts SET last_login_at=? WHERE id=?').run(new Date(now()).toISOString(),current.id);
      token=issueSession(req,current);db.exec('COMMIT');
    } catch(error) {db.exec('ROLLBACK');throw error;}
    cookie(req,res,token);
    for(const key of keys) attempts.delete(key);
    res.json({user:publicAccount(byId(current.id)),redirect:current.role==='admin' ? '/admin' : '/'});
  });
  router.post('/logout',(req,res)=>{if(req.sessionHash) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.sessionHash);cookie(req,res,null);res.json({ok:true});});
  router.post('/password',requireRole(),async(req,res)=>{
    const password=passwordField(req.body?.password),old=req.body?.currentPassword;
    if(typeof old!=='string' || old.length>128 || !await passwordMatches(old,req.account.password_hash)) throw fail('目前密碼不正確。',400);
    const hash=await hashPassword(password);
    if(byId(req.account.id)?.password_hash!==req.account.password_hash) throw fail('帳號設定已更新，請重新登入。',409);
    let token;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE accounts SET password_hash=? WHERE id=?').run(hash,req.account.id);
      db.prepare('DELETE FROM sessions WHERE account_id=?').run(req.account.id);
      token=issueSession(req,req.account);db.exec('COMMIT');
    } catch(error) {db.exec('ROLLBACK');throw error;}
    cookie(req,res,token);res.json({ok:true});
  });
  router.use((req,res)=>res.status(404).json({error:'找不到這個登入功能。'}));
  const accountsRouter=express.Router();
  accountsRouter.use(requireRole('admin'));
  accountsRouter.get('/',(req,res)=>res.json({accounts:db.prepare("SELECT * FROM accounts WHERE role='customer' ORDER BY created_at DESC,rowid DESC").all().map(publicAccount)}));
  accountsRouter.post('/',async(req,res)=>res.status(201).json(await createCustomer(req.body || {})));
  accountsRouter.patch('/:id',async(req,res)=>{
    const row=byId(req.params.id);if(!row || row.role!=='customer') throw fail('找不到顧客帳號。',404);
    const body=req.body || {},name=nameField(body.name ?? row.name,row.username);
    if(body.enabled!==undefined && typeof body.enabled!=='boolean') throw fail('帳號狀態格式不正確。');
    if(body.role!==undefined && body.role!=='customer' || body.username!==undefined && body.username!==row.username) throw fail('帳號與權限無法變更。');
    const password=body.password===undefined ? null : await hashPassword(passwordField(body.password));
    const current=byId(row.id);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE accounts SET name=?,enabled=?,password_hash=? WHERE id=?').run(name,body.enabled===undefined ? current.enabled : Number(body.enabled),password || current.password_hash,row.id);
      if(password || body.enabled===false) db.prepare('DELETE FROM sessions WHERE account_id=?').run(row.id);
      db.exec('COMMIT');
    } catch(error) {db.exec('ROLLBACK');throw error;}
    res.json(publicAccount(byId(row.id)));
  });
  return {ready,router,accountsRouter,createCustomer,
    attach:async(req,res,next)=>{try {await ready;req.sessionHash=tokenHash(req);req.account=sessionFor(req.sessionHash);if(req.path.startsWith('/api/') || req.path==='/login' || req.path.startsWith('/admin') || req.path.startsWith('/uploads/')) res.set('Cache-Control','private, no-store');next();} catch(error) {next(error);}},
    requireAdmin:requireRole('admin'),requireCustomer:requireRole('customer'),
    page:(req,res,next)=>{if(!req.account) return res.redirect('/login');if(req.account.role!=='admin') return res.redirect('/');next();},
    close:()=>{if(!closed) {closed=true;attempts.clear();db.close();}},
  };
}
