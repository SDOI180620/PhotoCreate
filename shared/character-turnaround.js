import {characterProfilePrompt,DEFAULT_TURNAROUND_PROMPT,DEFAULT_TURNAROUND_NEGATIVE} from './character-profile.js';

export {DEFAULT_TURNAROUND_PROMPT};
export const TURNAROUND_MIN_CFG = 3;
export const TURNAROUND_NEGATIVE = DEFAULT_TURNAROUND_NEGATIVE;

export function characterTurnaroundPrompt(profile,settings) {
  const prompt=(settings?.turnaroundPrompt ?? DEFAULT_TURNAROUND_PROMPT).trim();
  return [prompt,characterProfilePrompt(profile,settings)].filter(Boolean).join('\n\n');
}

export function characterTurnaroundNegative(settings) {
  return (settings?.turnaroundNegative ?? TURNAROUND_NEGATIVE).trim();
}
