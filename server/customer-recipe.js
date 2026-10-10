import {DEFAULT_DRAFT} from '../shared/draft.js';
import {getShotRecipe,buildShotPlans,optionalPresetSelections,OPTIONAL_PRESET_POOL_FIELDS,selectedCharacterIds} from '../shared/domain.js';
import {ORIGINAL_CAMERA} from '../shared/camera.js';

const SETTINGS=['cameraMode','cameraEnabled','steps','resolution','angleSteps','refineDenoise','negative','extra','sceneInteraction','randomOptional'];

// Publish the selected rows as well as their settings. Library edits and new
// candidates stay in the workbench until the operator applies them again.
export function createCustomerRecipe(state,input) {
  const draft={...structuredClone(DEFAULT_DRAFT),...input,...optionalPresetSelections(state,{...input,mode:'random'}),mode:'random',randomCount:1,seed:0,aspectRatio:'reference'};
  const character={id:'recipe-validation',name:'Recipe validation',description:''};
  const validationState={...state,characters:[character]};
  buildShotPlans(validationState,{...draft,characterId:character.id,characterIds:[character.id]});
  const {pools}=getShotRecipe(state,draft,{includeDisabledCamera:true,includeCharacters:false});
  const characterIds=input.characterIds===undefined ? undefined : selectedCharacterIds(input);
  if(characterIds?.some(id=>!state.characters.some(row=>row.id===id && !row.visitorId))) throw new Error('請選擇有效的預設角色。');
  if(!pools.camera.length) pools.camera=[ORIGINAL_CAMERA];
  return {updatedAt:new Date().toISOString(),...(characterIds===undefined ? {} : {characterIds}),settings:Object.fromEntries(SETTINGS.map(key=>[key,structuredClone(draft[key])])),
    pools:Object.fromEntries(Object.entries(pools).map(([key,rows])=>[key,structuredClone(rows.filter(Boolean))]))};
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
