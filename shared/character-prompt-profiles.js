import {defaultCharacterPromptSettings} from './character-profile.js';

export const CHARACTER_PROMPT_PROFILE_LIMIT=30;
export const CHARACTER_PROMPT_PROFILE_NAME_LENGTH=60;
export const CURRENT_CHARACTER_PROMPT_PROFILE_ID='character-prompts-current';

export function initialCharacterPromptProfiles(settings) {
  return {activeId:CURRENT_CHARACTER_PROMPT_PROFILE_ID,profiles:[{id:CURRENT_CHARACTER_PROMPT_PROFILE_ID,name:'目前設定',settings:structuredClone(settings || defaultCharacterPromptSettings())}]};
}

export function normalizeCharacterPromptProfileName(value) {
  if(typeof value!=='string' || !value.trim() || value.trim().length>CHARACTER_PROMPT_PROFILE_NAME_LENGTH) throw new Error(`設定檔名稱須為 1–${CHARACTER_PROMPT_PROFILE_NAME_LENGTH} 字。`);
  return value.trim();
}

export function characterPromptSettingsFor(state,profileId) {
  if(!profileId) return state.settings?.characterPrompts;
  const profile=state.settings?.characterPromptProfiles?.profiles.find(row=>row.id===profileId);
  if(!profile) throw new Error('找不到綁定的角色提詞設定檔，請重新選擇並保存參數設定檔。');
  return profile.id===state.settings.characterPromptProfiles.activeId ? state.settings.characterPrompts : profile.settings;
}
