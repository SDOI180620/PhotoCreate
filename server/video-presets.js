import {randomUUID} from 'node:crypto';
import {defaultVideoSettings,normalizeVideoSettings,DEFAULT_VIDEO_PROMPT,LEGACY_VIDEO_PROMPT} from '../shared/photo-video.js';

export const videoPromptRows=state=>(state.presets || []).filter(row=>row.category==='video').map(({id,name,prompt})=>({id,name,prompt}));
export function videoSettingsFromLibrary(state) {
  const preferences=state.settings.photoVideo || defaultVideoSettings(),prompts=videoPromptRows(state),ids=new Set(prompts.map(row=>row.id));
  return normalizeVideoSettings({...preferences,prompts,selectedPromptIds:(preferences.selectedPromptIds || []).filter(id=>ids.has(id))});
}
export function storeVideoSettings(state,config,{replacePrompts=false}={}) {
  const {prompts,...preferences}=config;
  if(replacePrompts) {
    for(const row of prompts) if(state.presets.some(item=>item.id===row.id && item.category!=='video')) throw Object.assign(new Error('影片提詞 ID 已用於其他分類。'),{status:409});
    const previous=new Map(state.presets.filter(row=>row.category==='video').map(row=>[row.id,row]));
    state.presets=[...state.presets.filter(row=>row.category!=='video'),...prompts.map(row=>({...previous.get(row.id),...row,category:'video',tags:previous.get(row.id)?.tags || []}))];
  }
  state.settings.photoVideo=preferences;
}
export function migrateVideoPromptLibrary(state) {
  if(state.videoPromptLibraryVersion===1) return;
  state.presets ||= [];
  const legacy=structuredClone(state.settings.photoVideo || defaultVideoSettings()),mapping=new Map();
  for(const row of legacy.prompts) {
    if(row.id==='natural' && row.prompt===LEGACY_VIDEO_PROMPT) row.prompt=DEFAULT_VIDEO_PROMPT;
    const conflict=state.presets.find(item=>item.id===row.id);
    const id=conflict && conflict.category!=='video' ? 'video-'+randomUUID() : row.id;
    mapping.set(row.id,id);
    if(!state.presets.some(item=>item.id===id)) state.presets.push({...row,id,category:'video',tags:[]});
  }
  const config=normalizeVideoSettings({...legacy,selectedPromptIds:legacy.selectedPromptIds ?? legacy.prompts.map(row=>row.id)});
  storeVideoSettings(state,{...config,selectedPromptIds:config.selectedPromptIds.map(id=>mapping.get(id))});
  state.settings.photoVideoPublished ||= {prompts:config.prompts.filter(row=>config.selectedPromptIds.includes(row.id)),publishedAt:new Date().toISOString()};
  state.settings.photoVideoPublished.prompts=state.settings.photoVideoPublished.prompts.map(row=>({...row,id:mapping.get(row.id) || row.id,...(row.id==='natural' && row.prompt===LEGACY_VIDEO_PROMPT ? {prompt:DEFAULT_VIDEO_PROMPT} : {})}));
  state.videoPromptLibraryVersion=1;
}
