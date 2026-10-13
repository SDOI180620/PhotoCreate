import {randomUUID} from 'node:crypto';
import {PHOTO_CHANGE_FIELDS,PHOTO_CHANGE_MAX_LENGTH} from '../shared/photo-customization.js';
const fieldsAllowed={...PHOTO_CHANGE_FIELDS,video:'影片'};

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const publicPrompt=({id,field,name,prompt,createdAt,updatedAt})=>({id,field,name,prompt,createdAt,updatedAt});

export function createCustomerPrompts(store) {
  const fields=body=>{
    if(!body || typeof body!=='object' || Array.isArray(body) || !Object.hasOwn(fieldsAllowed,body.field)) throw fail('請選擇有效的提詞分類。');
    if(typeof body.name!=='string' || !body.name.trim() || body.name.trim().length>80) throw fail('提詞名稱需為 1–80 個字。');
    const limit=body.field==='video' ? 16000 : PHOTO_CHANGE_MAX_LENGTH;
    if(typeof body.prompt!=='string' || !body.prompt.trim() || body.prompt.length>limit) throw fail(`請輸入 1–${limit} 字的提詞。`);
    return {field:body.field,name:body.name.trim(),prompt:body.prompt.trim()};
  };
  return {
    list:ownerId=>store.read(state=>(state.customerPrompts || []).filter(row=>row.ownerId===ownerId).map(publicPrompt)),
    save:(ownerId,body,id)=>{
      const values=fields(body);
      return store.mutate(state=>{
        const rows=state.customerPrompts ||= [];
        if(id) {
          const row=rows.find(row=>row.id===id && row.ownerId===ownerId);
          if(!row) throw fail('找不到你的提詞。',404);
          Object.assign(row,values,{updatedAt:new Date().toISOString()});
          return {prompt:publicPrompt(row),created:false};
        }
        const existing=rows.find(row=>row.ownerId===ownerId && row.field===values.field && row.name===values.name && row.prompt===values.prompt);
        if(existing) return {prompt:publicPrompt(existing),created:false};
        if(rows.filter(row=>row.ownerId===ownerId).length>=500) throw fail('我的提詞最多保存 500 筆，請先刪除不再使用的提詞。');
        const now=new Date().toISOString(),row={id:randomUUID(),ownerId,...values,createdAt:now,updatedAt:now};
        rows.unshift(row);
        return {prompt:publicPrompt(row),created:true};
      });
    },
    remove:(ownerId,id)=>store.mutate(state=>{
      if(!(state.customerPrompts || []).some(row=>row.id===id && row.ownerId===ownerId)) throw fail('找不到你的提詞。',404);
      state.customerPrompts=state.customerPrompts.filter(row=>row.id!==id || row.ownerId!==ownerId);
      return {ok:true};
    }),
  };
}
