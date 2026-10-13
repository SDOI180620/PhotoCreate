import {DEFAULT_DRAFT} from './draft.js';
import {getShotRecipe,optionalPresetSelections,selectedCharacterIds} from './domain.js';
import {ORIGINAL_CAMERA} from './camera.js';

export const CUSTOMER_MAX_SHOOT_COUNT=12;
export const CUSTOMER_SHOOT_COUNTS=[1,2,4,8,12];

const SETTINGS=['cameraMode','cameraEnabled','steps','resolution','angleSteps','refineDenoise','negative','extra','sceneInteraction','randomOptional'];

// Use the same candidate snapshot for publishing and for the workbench's dirty state.
// This path does not create jobs, so it also works in browsers without secure-context crypto.
export function customerRecipeCandidate(state,input) {
  const draft={...structuredClone(DEFAULT_DRAFT),...input,...optionalPresetSelections(state,{...input,mode:'random'}),mode:'random',randomCount:1,seed:0,aspectRatio:'reference'};
  const {pools}=getShotRecipe(state,draft,{includeDisabledCamera:true,includeCharacters:false});
  const characterIds=input.characterIds===undefined ? undefined : selectedCharacterIds(input);
  if(characterIds?.some(id=>!state.characters.some(row=>row.id===id && !row.visitorId))) throw new Error('請選擇有效的預設角色。');
  if(!pools.camera.length) pools.camera=[ORIGINAL_CAMERA];
  const recipe={...(characterIds===undefined ? {} : {characterIds}),settings:Object.fromEntries(SETTINGS.map(key=>[key,structuredClone(draft[key])])),
    pools:Object.fromEntries(Object.entries(pools).map(([key,rows])=>[key,structuredClone(rows.filter(Boolean))]))};
  return {draft,recipe};
}

const sorted=value=>Array.isArray(value) ? value.map(sorted) : value && typeof value==='object'
  ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])])) : value;
const pick=(row,keys)=>Object.fromEntries(keys.filter(key=>row[key]!==undefined).map(key=>[key,row[key]]));

function comparableRecipe(state,recipe) {
  const settings={...DEFAULT_DRAFT,...recipe.settings};
  // Optional-category switches are legacy metadata; the published pools determine usage.
  const effectiveSettings=Object.fromEntries(SETTINGS.filter(key=>key!=='randomOptional').map(key=>[key,
    ['steps','resolution','angleSteps','refineDenoise'].includes(key) ? Number(settings[key])
      : ['negative','extra','sceneInteraction'].includes(key) ? settings[key].trim() : settings[key]]));
  const characters=recipe.characterIds ?? state.characters.filter(row=>!row.visitorId).map(row=>row.id);
  const pools=Object.fromEntries(Object.entries({gaze:[],...recipe.pools}).map(([key,rows])=>[key,rows.filter(Boolean).map(row=>pick(row,key==='garment'
    ? ['id','name','sourceType','prompt','description','tags','fileName','image','mime']
    : ['id','category','name','prompt','tags','angle'])).sort((a,b)=>a.id.localeCompare(b.id))]));
  // Review marks and camera-mapping notes are operator bookkeeping, not customer changes.
  return JSON.stringify(sorted({characterIds:[...new Set(characters)].sort(),settings:effectiveSettings,pools}));
}

export function customerRecipeMatches(state,input) {
  if(!state.customerRecipe) return false;
  try {
    return comparableRecipe(state,state.customerRecipe)===comparableRecipe(state,customerRecipeCandidate(state,input).recipe);
  } catch {return false;}
}
