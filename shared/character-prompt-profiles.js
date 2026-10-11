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
