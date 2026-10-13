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

// Published selections keep their membership while selected library entries
// stay current. Completed jobs retain their own prompt and reference snapshots.
export function reconcileLibrarySelections(state) {
  if(state.draft) state.draft = reconcileDraftCandidates(state,state.draft);
  if(state.workbenchDrafts) state.workbenchDrafts = Object.fromEntries(Object.entries(state.workbenchDrafts).map(([mode,draft])=>[mode,reconcileDraftCandidates(state,draft)]));
  const availableVideos=new Map(state.presets.filter(row=>row.category==='video').map(({id,name,prompt})=>[id,{id,name,prompt}]));
  const currentVideos=rows=>rows.flatMap(row=>availableVideos.has(row.id) ? [structuredClone(availableVideos.get(row.id))] : []);
  let videoPublishedChanged=false;
  if(state.videoPromptLibraryVersion===1) {
    const settings=state.settings.photoVideo,published=state.settings.photoVideoPublished;
    if(settings?.selectedPromptIds) settings.selectedPromptIds=settings.selectedPromptIds.filter(id=>availableVideos.has(id));
    if(published) {const remaining=currentVideos(published.prompts);videoPublishedChanged=JSON.stringify(remaining)!==JSON.stringify(published.prompts);published.prompts=remaining;if(videoPublishedChanged) published.publishedAt=new Date().toISOString();}
  }
  for(const config of state.customerConfigs || []) if(config.videoPrompts) {
    const remaining=currentVideos(config.videoPrompts);
    if(JSON.stringify(remaining)!==JSON.stringify(config.videoPrompts)) {
      config.videoPrompts=remaining;
      if(config.videoPromptIds) config.videoPromptIds=remaining.map(row=>row.id);
      videoPublishedChanged=true;
    }
  }
  let publishedChanged=false;
  const recipes=[state.customerRecipe,...(state.customerConfigs || []).map(row=>row.recipe)].filter(Boolean);
  for(const recipe of recipes) {
    let changed=false;
    if(recipe.settings) delete recipe.settings.renderStyle;
    if(recipe.characterIds) {
      const remaining=recipe.characterIds.filter(id=>state.characters.some(row=>row.id===id && !row.visitorId));
      changed ||= remaining.length!==recipe.characterIds.length;
      recipe.characterIds=remaining;
    }
    for(const [key,rows] of Object.entries(recipe.pools || {})) {
      const category = key==='clothingState' ? 'clothing_state' : key;
      const available = new Map((key==='garment' ? state.garments : state.presets.filter(row=>row.category===category)).map(row=>[row.id,row]));
      const remaining=rows.flatMap(row=>available.has(row?.id) ? [structuredClone(available.get(row.id))] : key==='camera' && row?.id==='camera-original' ? [row] : []);
      changed ||= JSON.stringify(remaining)!==JSON.stringify(rows);
      recipe.pools[key]=remaining;
    }
    // Changes to selected entries publish immediately; new entries remain closed.
    if(changed) recipe.updatedAt=new Date().toISOString();
    publishedChanged ||= changed;
  }
  return publishedChanged || videoPublishedChanged;
}
