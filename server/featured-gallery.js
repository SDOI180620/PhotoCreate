import {randomUUID} from 'node:crypto';

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const folderDto=row=>({id:row.id,name:row.name,createdAt:row.createdAt});
const folderName=value=>{
  if(typeof value!=='string' || !value.trim() || value.trim().length>60) throw fail('資料夾名稱需為 1–60 個字。');
  return value.trim();
};

// A selection pins one completed output, rather than following a family's
// latest remake. Album folders and generated-photo folders are independent.
export function createFeaturedGallery(store) {
  const folders=ownerId=>store.read(state=>(state.galleryFolders || []).filter(row=>row.ownerId===ownerId).map(folderDto));
  const requireFolder=(ownerId,id)=>{
    if(id==='' || id===undefined) return '';
    if(typeof id!=='string') throw fail('資料夾格式不正確。');
    if(!folders(ownerId).some(row=>row.id===id)) throw fail('找不到你的畫廊資料夾。',404);
    return id;
  };
  const uniqueName=(ownerId,name,exceptId='')=>{
    if(folders(ownerId).some(row=>row.id!==exceptId && row.name.toLocaleLowerCase()===name.toLocaleLowerCase())) throw fail('已有同名資料夾，請換個名稱。',409);
  };
  const publicEntry=(entry,job)=>({id:entry.id,jobId:job.id,imageIndex:entry.imageIndex,rootId:job.rootJobId || job.id,
    folderId:entry.folderId || '',addedAt:entry.addedAt,createdAt:job.createdAt,version:job.remakeVersion || 0,
    garment:job.garment?.name || '',pose:job.pose?.name || '',batchId:job.batchId,
    image:`/api/studio/jobs/${job.id}/image/${entry.imageIndex}`});
  const list=ownerId=>store.read(state=>{
    const jobs=new Map(state.jobs.filter(job=>job.visitorId===ownerId && !job.visitorDeletedAt && !job.outputsDeletedAt && job.status==='completed').map(job=>[job.id,job]));
    return (state.galleryEntries || []).filter(row=>row.ownerId===ownerId && jobs.get(row.jobId)?.images?.[row.imageIndex]).map(row=>publicEntry(row,jobs.get(row.jobId)));
  });
  const selected=(ownerId,ids)=>{
    if(!Array.isArray(ids) || !ids.length || ids.length>100 || ids.some(id=>typeof id!=='string')) throw fail('請選擇 1–100 張精選照片。');
    const entries=store.read().galleryEntries || [],rows=[...new Set(ids)].map(id=>entries.find(row=>row.id===id && row.ownerId===ownerId));
    if(rows.some(row=>!row)) throw fail('找不到你的精選照片。',404);
    return rows;
  };
  return {
    folders,list,
    createFolder(ownerId,input) {
      const name=folderName(input);uniqueName(ownerId,name);
      if(folders(ownerId).length>=100) throw fail('每個帳號最多建立 100 個畫廊資料夾。');
      const folder={id:randomUUID(),ownerId,name,createdAt:new Date().toISOString()};
      store.mutate(state=>{state.galleryFolders ||= [];state.galleryFolders.push(folder);});
      return folderDto(folder);
    },
    renameFolder(ownerId,id,input) {
      requireFolder(ownerId,id);const name=folderName(input);uniqueName(ownerId,name,id);
      store.mutate(state=>{state.galleryFolders.find(row=>row.id===id && row.ownerId===ownerId).name=name;});
      return folders(ownerId).find(row=>row.id===id);
    },
    removeFolder(ownerId,id) {
      requireFolder(ownerId,id);
      store.mutate(state=>{
        state.galleryFolders=state.galleryFolders.filter(row=>row.id!==id || row.ownerId!==ownerId);
        for(const entry of state.galleryEntries || []) if(entry.ownerId===ownerId && entry.folderId===id) delete entry.folderId;
      });
      return {ok:true};
    },
    add(ownerId,{jobId,imageIndex=0,folderId}={}) {
      const destination=requireFolder(ownerId,folderId),state=store.read();
      const job=state.jobs.find(row=>row.id===jobId && row.visitorId===ownerId && !row.visitorDeletedAt);
      if(!job) throw fail('找不到你的照片。',404);
      if(!Number.isInteger(imageIndex) || imageIndex<0 || imageIndex>99 || job.status!=='completed' || job.outputsDeletedAt || !job.images?.[imageIndex]) throw fail('請選擇已完成的照片放入畫廊。',409);
      const existing=(state.galleryEntries || []).find(row=>row.ownerId===ownerId && row.jobId===jobId && row.imageIndex===imageIndex);
      if(existing) return {entry:publicEntry(existing,job),created:false};
      const entry={id:randomUUID(),ownerId,jobId,imageIndex,folderId:destination,addedAt:new Date().toISOString()};
      store.mutate(current=>{current.galleryEntries ||= [];current.galleryEntries.unshift(entry);});
      return {entry:publicEntry(entry,job),created:true};
    },
    move(ownerId,ids,folderId) {
      const destination=requireFolder(ownerId,folderId),chosen=new Set(selected(ownerId,ids).map(row=>row.id));
      store.mutate(state=>{for(const row of state.galleryEntries) if(row.ownerId===ownerId && chosen.has(row.id)) row.folderId=destination;});
      return {ok:true,count:chosen.size};
    },
    remove(ownerId,ids) {
      const chosen=new Set(selected(ownerId,ids).map(row=>row.id));
      store.mutate(state=>{state.galleryEntries=state.galleryEntries.filter(row=>row.ownerId!==ownerId || !chosen.has(row.id));});
      return {ok:true,count:chosen.size};
    },
  };
}
