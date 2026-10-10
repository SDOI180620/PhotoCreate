const LEGACY_SINGLE_SUBJECT_PROMPT = 'A single-person photograph: exactly one person, solo, one subject appearing once in one camera view. The references may show different views of the same person; use them only for identity and clothing. Produce one photograph of one person, with no additional people, duplicate figures, reference sheet, collage, or split panels.';
export const SINGLE_SUBJECT_PROMPT = 'A single-person photograph: exactly one person, solo, one subject appearing once in one camera view. Compose one continuous photographic scene, one uninterrupted frame, one viewpoint and one pose. Extract the identity and clothing from the reference, then photograph that person once in the requested scene. Use the reference only for appearance and clothing, never copy its page layout. The result is a single photograph, with the subject visible only once.';
export const SINGLE_SUBJECT_NEGATIVE = 'multiple people, more than one person, two people, three people, group shot, crowd, extra person, duplicate person, cloned person, multiple bodies, multiple faces, repeated subject, multiple views, multi-view sheet, three-view, three views, three-view sheet, front side back, front and side and back views, turnaround, character turnaround, orthographic views, character sheet, model sheet, reference sheet, pose sheet, multiple poses, repeated body, side by side figures, contact sheet, collage, diptych, triptych, split screen, multiple panels';

export function withSingleSubjectPrompt(prompt = '') {
  const text = typeof prompt === 'string' ? prompt.replaceAll(LEGACY_SINGLE_SUBJECT_PROMPT,'').replace(/\n{3,}/g,'\n\n').trim() : '';
  return text.includes(SINGLE_SUBJECT_PROMPT) ? text : [text,SINGLE_SUBJECT_PROMPT].filter(Boolean).join('\n\n');
}

export function withSingleSubjectNegative(prompt = '') {
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  const existing = new Set(text.split(',').map(term=>term.trim().toLowerCase()));
  return [text,...SINGLE_SUBJECT_NEGATIVE.split(', ').filter(term=>!existing.has(term))].filter(Boolean).join(', ');
}
