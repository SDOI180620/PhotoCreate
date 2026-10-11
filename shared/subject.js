const LEGACY_SINGLE_SUBJECT_PROMPT = 'A single-person photograph: exactly one person, solo, one subject appearing once in one camera view. The references may show different views of the same person; use them only for identity and clothing. Produce one photograph of one person, with no additional people, duplicate figures, reference sheet, collage, or split panels.';
const PREVIOUS_SINGLE_SUBJECT_PROMPT = 'A single-person photograph: exactly one person, solo, one subject appearing once in one camera view. The result is a single photograph, with the subject visible only once.';
const REMOVED_REFERENCE_PROMPT = 'Extract the identity and clothing from the reference, then photograph that person once in the requested scene. Use the reference only for appearance and clothing, never copy its page layout.';
const REMOVED_COMPOSITION_PROMPT = 'Compose one continuous photographic scene, one uninterrupted frame, one viewpoint and one pose.';
const REMOVED_APPEARANCE_PROMPT = "Use <image1> as the sole reference for the character's identity and anatomy. Preserve the same face and facial structure, hairstyle, body shape and build, body proportions, and breast size shown in <image1>. Changes to clothing, pose, camera viewpoint or rendering style must not redesign the face or physique, or increase or reduce breast size.";
const REMOVED_BREAST_SIZE_PROMPT = 'Keep the breast size the same as in <image1>.';
export const SINGLE_SUBJECT_PROMPT = `Create a photorealistic photograph featuring exactly ONE person.

Use <image1> solely as a reference for the person's identity and appearance. If <image1> contains multiple views, they all depict the SAME person from different angles. Combine the visual information from these views into one consistent person.

Preserve the same identity, facial features, hairstyle, and body proportions.

Show the person only ONCE in a single scene. Do not recreate the reference image's multi-view arrangement, panel layout, or repeated figures. Use the composition, pose, and camera angle specified in the new request.`;
export const SINGLE_SUBJECT_NEGATIVE = 'multiple people, more than one person, two people, three people, group shot, crowd, extra person, duplicate person, cloned person, multiple bodies, multiple faces, repeated subject, multiple views, multi-view sheet, three-view, three views, three-view sheet, front side back, front and side and back views, turnaround, character turnaround, orthographic views, character sheet, model sheet, reference sheet, pose sheet, multiple poses, repeated body, side by side figures, contact sheet, collage, diptych, triptych, split screen, multiple panels';

export function withSingleSubjectPrompt(prompt = '') {
  let text=typeof prompt === 'string' ? prompt.replaceAll(LEGACY_SINGLE_SUBJECT_PROMPT,'') : '';
  for(const removed of [REMOVED_REFERENCE_PROMPT,REMOVED_COMPOSITION_PROMPT,REMOVED_APPEARANCE_PROMPT,REMOVED_BREAST_SIZE_PROMPT]) text=text.replaceAll(removed+' ','').replaceAll(removed,'');
  text=text.replaceAll(PREVIOUS_SINGLE_SUBJECT_PROMPT,'');
  text=text.replace(/^\s*(?:a\s+girl|1\s*girl)\s*(?:\r?\n|$)/i,'');
  text=text.replace(/\n{3,}/g,'\n\n').trim();
  return text.includes(SINGLE_SUBJECT_PROMPT) ? text : [text,SINGLE_SUBJECT_PROMPT].filter(Boolean).join('\n\n');
}

export function withSingleSubjectNegative(prompt = '') {
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  const existing = new Set(text.split(',').map(term=>term.trim().toLowerCase()));
  return [text,...SINGLE_SUBJECT_NEGATIVE.split(', ').filter(term=>!existing.has(term))].filter(Boolean).join(', ');
}
