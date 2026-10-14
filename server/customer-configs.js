import {randomUUID} from 'node:crypto';
import {createCustomerRecipe} from './customer-recipe.js';

export const DEFAULT_CUSTOMER_CONFIG_ID='default';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});

export function createCustomerConfigs({store,getDefaultRecipe,getDefaultVideoSettings=()=>({prompts:[]})}) {
  const list=()=>{
    const recipe=getDefaultRecipe();
    if(!store.read(state=>state.customerConfigs?.some(row=>row.id===DEFAULT_CUSTOMER_CONFIG_ID) && state.customerConfigs.every(row=>row.characterPromptProfileId))) {
      store.mutate(state=>{
        const rows=state.customerConfigs ||= [],profileId=state.settings.characterPromptProfiles.activeId;
        if(!rows.some(row=>row.id===DEFAULT_CUSTOMER_CONFIG_ID)) rows.unshift({id:DEFAULT_CUSTOMER_CONFIG_ID,name:'一般會員'});
        for(const row of rows) row.characterPromptProfileId ||= profileId;
      });
    }
    return {defaultId:DEFAULT_CUSTOMER_CONFIG_ID,configs:store.read(state=>state.customerConfigs).map(row=>{
      const videoPrompts=row.videoPrompts ?? getDefaultVideoSettings().prompts;
      const selectedRecipe=row.id===DEFAULT_CUSTOMER_CONFIG_ID ? recipe : row.recipe;
      return {...row,recipe:selectedRecipe ? {...selectedRecipe,characterPromptProfileId:row.characterPromptProfileId} : null,videoPrompts,videoPromptIds:videoPrompts.map(prompt=>prompt.id)};
    })};
  };
  const get=id=>{
    const row=list().configs.find(row=>row.id===id);
    if(!row) throw fail('找不到這份參數設定檔。',404);
    return row;
  };
  const save=(body,id)=>{
    if(!body || typeof body!=='object' || Array.isArray(body)) throw fail('參數設定檔格式不正確。');
    const previous=id ? get(id) : null,name=body.name ?? previous?.name;
    if(typeof name!=='string' || !name.trim() || name.trim().length>80) throw fail('設定檔名稱需為 1–80 個字。');
    const characterPromptProfileId=body.characterPromptProfileId===undefined ? previous?.characterPromptProfileId ?? get(DEFAULT_CUSTOMER_CONFIG_ID).characterPromptProfileId : body.characterPromptProfileId;
    if(typeof characterPromptProfileId!=='string' || !store.read(state=>state.settings.characterPromptProfiles.profiles.some(row=>row.id===characterPromptProfileId))) throw fail('請選擇有效的角色提詞設定檔。');
    let recipe=previous?.recipe ?? getDefaultRecipe();
    if(body.draft!==undefined) {
      if(!body.draft || typeof body.draft!=='object' || Array.isArray(body.draft)) throw fail('參數設定格式不正確。');
      try {recipe=createCustomerRecipe(store.read(),{...body.draft,mode:'random'});} catch(error) {throw fail(error.message);}
    }
    let videoPrompts=previous?.videoPrompts ?? getDefaultVideoSettings().prompts;
    if(body.videoPromptIds!==undefined) {
      const ids=body.videoPromptIds,available=store.read(state=>state.presets.filter(row=>row.category==='video'));
      if(!Array.isArray(ids) || ids.some(id=>typeof id!=='string' || !available.some(row=>row.id===id))) throw fail('請選擇有效的動畫提詞。');
      videoPrompts=[...new Set(ids)].map(id=>{const {name,prompt}=available.find(row=>row.id===id);return {id,name,prompt};});
    }
    const row={...previous,id:id || randomUUID(),name:name.trim(),characterPromptProfileId,recipe,videoPrompts,videoPromptIds:videoPrompts.map(prompt=>prompt.id)};
    store.mutate(state=>{
      if(row.id===DEFAULT_CUSTOMER_CONFIG_ID) {
        state.customerRecipe=recipe;
        Object.assign(state.customerConfigs.find(current=>current.id===row.id),{name:row.name,characterPromptProfileId});
        if(body.videoPromptIds!==undefined) state.customerConfigs.find(current=>current.id===row.id).videoPrompts=videoPrompts;
      } else {
        const rows=state.customerConfigs ||= [],index=rows.findIndex(current=>current.id===row.id);
        if(index<0) rows.push(row);else rows[index]=row;
      }
    });
    return row;
  };
  const usePublishedVideos=()=>{
    if(!store.read(state=>state.customerConfigs?.some(row=>row.id===DEFAULT_CUSTOMER_CONFIG_ID && row.videoPrompts!==undefined))) return;
    store.mutate(state=>{const row=state.customerConfigs.find(row=>row.id===DEFAULT_CUSTOMER_CONFIG_ID);delete row.videoPrompts;delete row.videoPromptIds;});
  };
  return {list,get,save,usePublishedVideos,has:id=>id===DEFAULT_CUSTOMER_CONFIG_ID || store.read(state=>state.customerConfigs?.some(row=>row.id===id) || false),videos:id=>({...getDefaultVideoSettings(),prompts:get(id).videoPrompts})};
}
