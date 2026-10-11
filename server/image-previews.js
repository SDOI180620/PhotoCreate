import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import sharp from 'sharp';

const sizes={'1':640,small:160};
const fail=(message,status=400)=>Object.assign(new Error(message),{status});

// Derived images stay in a bounded memory cache: no duplicate photo files are
// left on disk. Callers must authorize the current source before every send.
export function createImagePreviews({maxBytes=32*1024*1024,maxEntries=256,ttlMs=5*60*1000,concurrency=2}={}) {
  const cache=new Map(),pending=new Map(),waiting=[];
  let bytes=0,active=0;
  const remove=key=>{bytes-=cache.get(key)?.buffer.length || 0;cache.delete(key);};
  const run=async work=>{
    if(active>=concurrency) await new Promise(resolve=>waiting.push(resolve));
    else active++;
    try {return await work();}
    finally {const next=waiting.shift();if(next) next();else active--;}
  };
  const preview=async({key,file,load,size='1'})=>{
    if(typeof size!=='string' || !Object.hasOwn(sizes,size)) throw fail('圖片預覽尺寸無效。');
    const stat=file ? await fs.stat(file) : null;
    const cacheKey=JSON.stringify([key,size,file,stat?.mtimeMs,stat?.size]);
    const existing=cache.get(cacheKey);
    if(existing && Date.now()-existing.createdAt<ttlMs) {
      cache.delete(cacheKey);cache.set(cacheKey,existing);return existing;
    }
    if(existing) remove(cacheKey);
    if(pending.has(cacheKey)) return pending.get(cacheKey);
    const task=run(async()=>{
      const input=file ? await fs.readFile(file) : await load();
      const buffer=await sharp(input,{limitInputPixels:64*1024*1024}).rotate()
        .resize(sizes[size],sizes[size],{fit:'inside',withoutEnlargement:true})
        .webp({quality:78,effort:3}).toBuffer();
      const result={buffer,etag:`"${createHash('sha256').update(buffer).digest('hex')}"`,createdAt:Date.now()};
      if(buffer.length<=maxBytes) {
        while(cache.size && (bytes+buffer.length>maxBytes || cache.size>=maxEntries)) remove(cache.keys().next().value);
        cache.set(cacheKey,result);bytes+=buffer.length;
      }
      return result;
    });
    pending.set(cacheKey,task);
    try {return await task;}
    finally {pending.delete(cacheKey);}
  };
  return {
    async send(res,source) {
      const result=await preview(source);
      // Revalidation preserves login, owner and deletion checks even when the
      // browser already has a thumbnail, including a forced revalidation.
      res.set({'Cache-Control':'private, no-cache','X-Content-Type-Options':'nosniff','ETag':result.etag});
      const etags=res.req.get('If-None-Match');
      if(etags?.split(',').some(tag=>tag.trim()==='*' || tag.trim().replace(/^W\//,'')===result.etag)) return res.status(304).end();
      res.type('image/webp').send(result.buffer);
    },
    clear() {cache.clear();bytes=0;},
  };
}
