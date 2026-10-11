import {randomUUID} from 'node:crypto';
import {normalizeCharacterPromptSettings} from '../shared/character-profile.js';
import {CHARACTER_PROMPT_PROFILE_LIMIT,normalizeCharacterPromptProfileName} from '../shared/character-prompt-profiles.js';

const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const object=input=>{if(!input || typeof input!=='object' || Array.isArray(input)) throw fail('設定檔資料格式不正確。');return input;};
const profileFor=(library,id)=>{const profile=library.profiles.find(row=>row.id===id);if(!profile) throw fail('找不到這份設定檔，請重新整理。',404);return profile;};
const uniqueName=(library,name,except)=>{if(library.profiles.some(row=>row.id!==except && row.name.toLowerCase()===name.toLowerCase())) throw fail('已有相同名稱的設定檔，請使用另一個名稱。',409);};
const view=(library,selectedId=library.activeId)=>({...structuredClone(library),selectedId});

// characterPrompts remains the active snapshot used by photo and turnaround
// generation. Every profile mutation and active snapshot update is one transaction.
export function createCharacterPromptProfiles(store) {
  const read=()=>view(store.read().settings.characterPromptProfiles);
  function saveActive(input) {
    input=object(input);
    return store.mutate(state=>{
      const settings=normalizeCharacterPromptSettings({...input,turnaroundPrompt:input.turnaroundPrompt===undefined ? state.settings.characterPrompts.turnaroundPrompt : input.turnaroundPrompt});
      const library=state.settings.characterPromptProfiles;
      profileFor(library,library.activeId).settings=structuredClone(settings);
      state.settings.characterPrompts=settings;
      return structuredClone(settings);
    });
  }
  function create(input) {
    input=object(input);const name=normalizeCharacterPromptProfileName(input.name),id=input.id ?? randomUUID();
    if(typeof id!=='string' || !/^[\w-]{1,120}$/.test(id)) throw fail('設定檔識別碼無效。');
    return store.mutate(state=>{
      const library=state.settings.characterPromptProfiles,settings=normalizeCharacterPromptSettings(input.settings===undefined ? state.settings.characterPrompts : input.settings);
      const existing=library.profiles.find(row=>row.id===id);
      if(existing) {if(existing.name!==name || JSON.stringify(existing.settings)!==JSON.stringify(settings)) throw fail('這個設定檔請求已用於另一份內容。',409);return view(library,id);}
      if(library.profiles.length>=CHARACTER_PROMPT_PROFILE_LIMIT) throw fail(`最多保存 ${CHARACTER_PROMPT_PROFILE_LIMIT} 份設定檔。`,409);
      uniqueName(library,name);
      library.profiles.push({id,name,settings});return view(library,id);
    });
  }
  function update(id,input) {
    input=object(input);
    if(input.name===undefined && input.settings===undefined && input.activate===undefined) throw fail('請提供要修改的設定檔資料。');
    if(input.activate!==undefined && typeof input.activate!=='boolean') throw fail('套用設定檔須為勾選或取消勾選。');
    return store.mutate(state=>{
      const library=state.settings.characterPromptProfiles,profile=profileFor(library,id);
      if(input.name!==undefined) {const name=normalizeCharacterPromptProfileName(input.name);uniqueName(library,name,id);profile.name=name;}
      if(input.settings!==undefined) profile.settings=normalizeCharacterPromptSettings(input.settings);
      if(input.activate===true) library.activeId=id;
      if(library.activeId===id) state.settings.characterPrompts=structuredClone(profile.settings);
      return view(library,id);
    });
  }
  function remove(id) {
    return store.mutate(state=>{
      const library=state.settings.characterPromptProfiles;profileFor(library,id);
      if(id===library.activeId) throw fail('使用中的設定檔不能刪除，請先套用另一份設定檔。',409);
      library.profiles=library.profiles.filter(row=>row.id!==id);return view(library);
    });
  }
  return {read,saveActive,create,update,remove};
}
