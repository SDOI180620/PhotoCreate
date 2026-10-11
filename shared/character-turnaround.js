import {characterProfilePrompt,DEFAULT_TURNAROUND_PROMPT} from './character-profile.js';

export {DEFAULT_TURNAROUND_PROMPT};
export const TURNAROUND_NEGATIVE = 'different characters, inconsistent face, inconsistent hairstyle, mismatched clothing, inconsistent body proportions, different scale between views, missing view, extra fourth view, overlapping figures, cropped head, cropped feet, extreme perspective, action pose, busy background, blurry, low quality, bad anatomy, extra limbs, extra fingers, text, labels, watermark';

export function characterTurnaroundPrompt(profile,settings) {
  const prompt=(settings?.turnaroundPrompt ?? DEFAULT_TURNAROUND_PROMPT).trim();
  return [prompt,characterProfilePrompt(profile,settings)].filter(Boolean).join('\n\n');
}
