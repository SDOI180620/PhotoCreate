import {DEFAULT_DRAFT} from '../shared/draft.js';
import {buildShotPlans,OPTIONAL_PRESET_POOL_FIELDS} from '../shared/domain.js';
import {customerRecipeCandidate} from '../shared/customer-recipe.js';

// Publish the selected rows as well as their settings. Library edits and new
// candidates stay in the workbench until the operator applies them again.
export function createCustomerRecipe(state,input) {
  const {draft,recipe}=customerRecipeCandidate(state,input);
  const character={id:'recipe-validation',name:'Recipe validation',description:''};
  const validationState={...state,characters:[character]};
  buildShotPlans(validationState,{...draft,characterId:character.id,characterIds:[character.id]});
  return {updatedAt:new Date().toISOString(),...recipe};
}

export function customerCharacters(state,recipe,visitorId) {
  const allowed=recipe?.characterIds===undefined ? null : new Set(recipe.characterIds);
  return state.characters.filter(row=>row.visitorId ? row.visitorId===visitorId : !allowed || allowed.has(row.id));
}

export function customerProductionState(state,recipe) {
  return {...state,garments:recipe.pools.garment,presets:Object.entries(recipe.pools).filter(([key])=>key!=='garment').flatMap(([,rows])=>rows)};
}

export function customerDraft(recipe,{characterId,count,aspectRatio,batchName,cameraEnabled=false}) {
  const selections=Object.fromEntries(Object.entries(OPTIONAL_PRESET_POOL_FIELDS).map(([category,field])=>[field,
    recipe.pools[category === 'clothing_state' ? 'clothingState' : category].filter(Boolean).map(row=>row.id)]));
  return {...structuredClone(DEFAULT_DRAFT),...structuredClone(recipe.settings),mode:'random',randomPoolMode:'all',garmentIds:[],
    ...selections,seed:-1,randomCount:count,characterId,aspectRatio,batchName,cameraEnabled};
}

export function customerRecipeSummary(recipe) {
  return recipe ? {updatedAt:recipe.updatedAt,counts:Object.fromEntries(Object.entries(recipe.pools).map(([key,rows])=>[key,rows.length])),
    ...(recipe.characterIds===undefined ? {} : {characterCount:recipe.characterIds.length}),steps:Number(recipe.settings.steps),resolution:Number(recipe.settings.resolution)} : null;
}
