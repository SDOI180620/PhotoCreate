import {randomUUID} from 'node:crypto';

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const dto=folder=>({id:folder.id,name:folder.name,createdAt:folder.createdAt});
const fieldFor=ownerId=>ownerId==='admin' ? 'adminFolderId' : 'folderId';
const belongsTo=(job,ownerId)=>ownerId==='admin' || job.visitorId===ownerId;
const rootId=job=>job.rootJobId || job.id;
const folderName=value=>{
  if(typeof value!=='string' || value.trim().length<1 || value.trim().length>60) throw fail('資料夾名稱需為 1–60 個字。');
  return value.trim();
};

// Folders classify records without moving ComfyUI files. Operator categories
// and each customer's categories remain independent, including on one photo.
export function createPhotoFolders(store) {
  const list=ownerId=>(store.read().photoFolders || []).filter(row=>row.ownerId===ownerId).map(dto);
  const requireFolder=(ownerId,id)=>{
    if(id==='' || id===undefined) return '';
    if(typeof id!=='string') throw fail('資料夾格式不正確。');
    if(!(store.read().photoFolders || []).some(row=>row.id===id && row.ownerId===ownerId)) throw fail('找不到這個資料夾，請重新選擇。',404);
    return id;
  };
  const assertUnique=(ownerId,name,exceptId='')=>{
    if(list(ownerId).some(row=>row.id!==exceptId && row.name.toLocaleLowerCase()===name.toLocaleLowerCase())) throw fail('已有同名資料夾，請換個名稱。',409);
  };
  return {
    list,requireFolder,
    create(ownerId,input) {
      const name=folderName(input);assertUnique(ownerId,name);
      if(list(ownerId).length>=100) throw fail('每個帳號最多建立 100 個資料夾。');
      const folder={id:randomUUID(),name,ownerId,createdAt:new Date().toISOString()};
      store.mutate(state=>{state.photoFolders ||= [];state.photoFolders.push(folder);});
      return dto(folder);
    },
    rename(ownerId,id,input) {
      requireFolder(ownerId,id);const name=folderName(input);assertUnique(ownerId,name,id);
      store.mutate(state=>{state.photoFolders.find(row=>row.id===id && row.ownerId===ownerId).name=name;});
      return list(ownerId).find(row=>row.id===id);
    },
    remove(ownerId,id) {
      requireFolder(ownerId,id);const field=fieldFor(ownerId);
      store.mutate(state=>{
        state.photoFolders=state.photoFolders.filter(row=>row.id!==id || row.ownerId!==ownerId);
        for(const job of state.jobs) if(belongsTo(job,ownerId) && job[field]===id) delete job[field];
      });
      return {ok:true};
    },
    move(ownerId,ids,folderId) {
      const destination=requireFolder(ownerId,folderId);
      if(!Array.isArray(ids) || !ids.length || ids.length>100 || ids.some(id=>typeof id!=='string')) throw fail('請選擇 1–100 張照片。');
      const state=store.read(),sources=[...new Set(ids)].map(id=>state.jobs.find(job=>job.id===id && belongsTo(job,ownerId)));
      if(sources.some(job=>!job)) throw fail('找不到所選照片。',404);
      const roots=new Set(sources.map(rootId)),field=fieldFor(ownerId);
      store.mutate(current=>{
        for(const job of current.jobs) if(belongsTo(job,ownerId) && roots.has(rootId(job))) {
          if(destination) job[field]=destination;else delete job[field];
        }
      });
      return {ok:true,count:roots.size,folderId:destination};
    },
  };
}
