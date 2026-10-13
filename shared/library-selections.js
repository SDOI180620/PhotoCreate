import {PRESET_SELECTION_FIELDS,OPTIONAL_PRESET_FIELDS} from './domain.js';

export function reconcileDraftCandidates(state,input) {
  const draft = {...input};
  // Remove the withdrawn style setting when loading or saving older drafts.
  delete draft.renderStyle;
  const selections = {garment:['garmentIds','garmentId',state.garments],character:['characterIds','characterId',state.characters],
    ...Object.fromEntries(Object.entries(PRESET_SELECTION_FIELDS).map(([category,field])=>[category,[field,OPTIONAL_PRESET_FIELDS[category] || `${category}Id`,state.presets.filter(row=>row.category===category)]]))};
  for(const [field,legacyField,rows] of Object.values(selections)) {
    const available = new Set(rows.map(row=>row.id));
    if(Array.isArray(draft[field])) draft[field] = draft[field].filter(id=>available.has(id));
    if(draft[legacyField] && !available.has(draft[legacyField])) draft[legacyField] = '';
  }
  return draft;
}

// A removed library choice must disappear from every editable and published
// selection. Completed jobs retain their own prompt and reference snapshots.
export function reconcileLibrarySelections(state) {
  if(state.draft) state.draft = reconcileDraftCandidates(state,state.draft);
  if(state.workbenchDrafts) state.workbenchDrafts = Object.fromEntries(Object.entries(state.workbenchDrafts).map(([mode,draft])=>[mode,reconcileDraftCandidates(state,draft)]));
  let videoPublishedChanged=false;
  if(state.videoPromptLibraryVersion===1) {
    const available=new Set(state.presets.filter(row=>row.category==='video').map(row=>row.id)),settings=state.settings.photoVideo,published=state.settings.photoVideoPublished;
    if(settings?.selectedPromptIds) settings.selectedPromptIds=settings.selectedPromptIds.filter(id=>available.has(id));
    if(published) {const remaining=published.prompts.filter(row=>available.has(row.id));videoPublishedChanged=remaining.length!==published.prompts.length;published.prompts=remaining;if(videoPublishedChanged) published.publishedAt=new Date().toISOString();}
  }
  const recipe = state.customerRecipe;
  if(!recipe) return videoPublishedChanged;
  let publishedChanged=false;
  if(recipe.settings) delete recipe.settings.renderStyle;
  if(recipe.characterIds) {
    const remaining=recipe.characterIds.filter(id=>state.characters.some(row=>row.id===id && !row.visitorId));
    publishedChanged ||= remaining.length!==recipe.characterIds.length;
    recipe.characterIds=remaining;
  }
  for(const [key,rows] of Object.entries(recipe.pools || {})) {
    const category = key==='clothingState' ? 'clothing_state' : key;
    const available = new Set((key==='garment' ? state.garments : state.presets.filter(row=>row.category===category)).map(row=>row.id));
    const remaining=rows.filter(row=>available.has(row?.id) || key==='camera' && row?.id==='camera-original');
    publishedChanged ||= remaining.length!==rows.length;
    recipe.pools[key]=remaining;
  }
  // Withdrawals publish immediately, without publishing unrelated library edits.
  if(publishedChanged) recipe.updatedAt=new Date().toISOString();
  return publishedChanged || videoPublishedChanged;
}
