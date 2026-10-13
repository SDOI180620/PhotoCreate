import {DEFAULT_DRAFT} from './draft.js';
import {PRESET_SELECTION_FIELDS} from './domain.js';

export function customerConfigDraft(config,state) {
  const recipe=config.recipe;
  if(!recipe) return {...structuredClone(DEFAULT_DRAFT),mode:'random',randomPoolMode:'selected',characterIds:state.characters.map(row=>row.id)};
  const characterIds=recipe.characterIds ?? state.characters.map(row=>row.id);
  return {...structuredClone(DEFAULT_DRAFT),...structuredClone(recipe.settings),mode:'random',randomPoolMode:'selected',
    characterIds:[...characterIds],characterId:characterIds[0] || '',garmentIds:recipe.pools.garment.map(row=>row.id),
    ...Object.fromEntries(Object.entries(PRESET_SELECTION_FIELDS).map(([category,field])=>[field,
      (recipe.pools[category==='clothing_state' ? 'clothingState' : category] || []).filter(row=>row.id!=='camera-original').map(row=>row.id)]))};
}

export function applyCustomerConfig(draft,config,state) {
  if(!config) return {...draft,customerConfigId:''};
  return {...draft,...customerConfigDraft(config,state),customerConfigId:config.id,
    randomCount:draft.randomCount,aspectRatio:draft.aspectRatio,batchName:draft.batchName,folderId:draft.folderId,seed:draft.seed};
}
