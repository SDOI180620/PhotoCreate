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
  const recipe = state.customerRecipe;
  if(!recipe) return;
  if(recipe.settings) delete recipe.settings.renderStyle;
  if(recipe.characterIds) recipe.characterIds = recipe.characterIds.filter(id=>state.characters.some(row=>row.id===id && !row.visitorId));
  for(const [key,rows] of Object.entries(recipe.pools || {})) {
    const category = key==='clothingState' ? 'clothing_state' : key;
    const available = new Set((key==='garment' ? state.garments : state.presets.filter(row=>row.category===category)).map(row=>row.id));
    recipe.pools[key] = rows.filter(row=>available.has(row?.id) || key==='camera' && row?.id==='camera-original');
  }
}
