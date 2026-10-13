import {withSingleSubjectPrompt} from './subject.js';
import {referenceOnlyPrompt,REFERENCE_INSTRUCTION,withNaturalScenePrompt} from './domain.js';
import {characterProfilePrompt} from './character-profile.js';
import {isPromptGarment,textClothingInstruction} from './garments.js';
import {NATURAL_GAZE_PROMPT} from './gaze.js';

export const PHOTO_CHANGE_FIELDS = {pose:'動作',clothing:'服裝',clothingState:'服裝狀態',scene:'場景',expression:'表情',gaze:'視線',lighting:'光線',color:'色彩',quality:'畫質'};
export const PHOTO_PRESET_CATEGORIES = {pose:'pose',clothingState:'clothing_state',scene:'interaction',expression:'expression',gaze:'gaze',lighting:'lighting',color:'color',quality:'quality'};
export const PHOTO_CUSTOMIZATION_VERSION = 5;
export const DEFAULT_PHOTO_CUSTOMIZATION = {
  preserveOriginal:true,useOriginal:Object.fromEntries(Object.keys(PHOTO_CHANGE_FIELDS).map(key=>[key,true])),
  clothingMode:'text',garmentId:'',aspectRatio:'original',
  fieldModes:Object.fromEntries(Object.keys(PHOTO_PRESET_CATEGORIES).map(key=>[key,'text'])),presetIds:{},
  changes:Object.fromEntries(Object.keys(PHOTO_CHANGE_FIELDS).map(key=>[key,''])),
};
export const PHOTO_CHANGE_MAX_LENGTH = 2000;
const CHARACTER_INSTRUCTION='Photograph the character from <image1>. Preserve the same identity, face, hairstyle and body proportions.';

export function clothingDescription(value='') {
  const text=value.trim(),shortName=text.replace(/[。.!！]/g,'').replace(/\s+/g,'');
  if(/^(?:請|请)?(?:換成|换成|換個|换个|換|换|穿上|穿著|穿着|穿)?(?:一件|一套|件|套|個|个)?(?:女[僕仆](?:服[裝装]?|[裝装])|a?maid(?:outfit|uniform|dress))$/i.test(shortName)) return `${text}\n黑色長袖、及膝的女僕洋裝，白色圍裙、白色蕾絲領口、白色袖口與黑色平底鞋。`;
  return text;
}

export function photoSettings(shot) {
  const fields=[['character','character','角色'],['pose','pose','動作'],['clothing','garment','服裝'],['clothingState','clothingState','服裝狀態'],['scene','interaction','場景'],['expression','expression','表情'],['gaze','gaze','視線'],['camera','camera','鏡位'],['lighting','lighting','光線'],['color','color','色彩'],['quality','quality','畫質']];
  const settings=fields.flatMap(([key,field,label])=>{
    if(key==='camera' && shot.cameraMode==='multiangle' && shot.cameraEnabled===false) return [];
    const row=shot[field],custom=!row?.category && !row?.fileName && row?.id?.startsWith(`custom-${key}-`);
    const value=typeof row==='string' ? row : custom ? row.input || row.prompt || row.description : row?.name;
    const description=key==='clothing' && custom && row.description!==value ? row.description : undefined;
    return value ? [{key,label,value,source:custom ? 'custom' : 'preset',...(description ? {description} : {})}] : [];
  });
  if(shot.sceneInteraction?.trim()) settings.push({key:'sceneInteraction',label:'場景補充',value:shot.sceneInteraction.trim(),source:'custom'});
  return settings;
}

export function normalizePhotoCustomization(input = {}) {
  if(!input || typeof input!=='object' || Array.isArray(input)) throw new Error('自訂拍攝設定格式不正確。');
  const requestedOriginal = input.preserveOriginal ?? true;
  if(typeof requestedOriginal!=='boolean') throw new Error('沿用原設定須為勾選或取消勾選。');
  if(input.useOriginal!==undefined && (!input.useOriginal || typeof input.useOriginal!=='object' || Array.isArray(input.useOriginal))) throw new Error('各項沿用原設定格式不正確。');
  const useOriginal=Object.fromEntries(Object.keys(PHOTO_CHANGE_FIELDS).map(key=>[key,input.useOriginal ? input.useOriginal[key] ?? true : requestedOriginal]));
  if(Object.values(useOriginal).some(value=>typeof value!=='boolean')) throw new Error('各項沿用原設定須為勾選或取消勾選。');
  const aspectRatio=input.aspectRatio ?? 'original';
  if(!['original','9:16','1:1','16:9'].includes(aspectRatio)) throw new Error('請選擇沿用、直式、方形或橫式照片比例。');
  const preserveOriginal=Object.values(useOriginal).every(Boolean);
  if(preserveOriginal) return {preserveOriginal:true,clothingMode:'original',garmentId:'',aspectRatio,fieldModes:{},presetIds:{},changes:{}};
  const clothingMode = useOriginal.clothing ? 'original' : input.clothingMode ?? 'text',changes=input.changes ?? {};
  if(!['text','reference','original'].includes(clothingMode) || !changes || typeof changes!=='object' || Array.isArray(changes)) throw new Error('自訂服裝或提詞格式不正確。');
  const modes=input.fieldModes ?? {},ids=input.presetIds ?? {};
  if(!modes || typeof modes!=='object' || Array.isArray(modes) || !ids || typeof ids!=='object' || Array.isArray(ids)) throw new Error('官方提詞選擇格式不正確。');
  const values = {},fieldModes={},presetIds={};
  for(const [key,label] of Object.entries(PHOTO_CHANGE_FIELDS)) {
    if(useOriginal[key] || key==='clothing' && clothingMode!=='text') continue;
    if(key!=='clothing') {
      const mode=modes[key] ?? 'text';
      if(!['text','preset'].includes(mode)) throw new Error(`${label}請選擇官方選項或自行輸入。`);
      if(mode==='preset') {
        const id=ids[key];
        if(typeof id!=='string' || !/^[\w-]{1,120}$/.test(id)) throw new Error(`請選擇一個${label}官方選項。`);
        fieldModes[key]='preset';presetIds[key]=id;continue;
      }
    }
    const value = changes[key] ?? '';
    if(typeof value!=='string' || value.length>PHOTO_CHANGE_MAX_LENGTH) throw new Error(`${label}提詞最多 ${PHOTO_CHANGE_MAX_LENGTH} 字。`);
    if(value.trim() && (key!=='clothing' || clothingMode==='text')) values[key]=value.trim();
  }
  const garmentId = clothingMode==='reference' ? input.garmentId : '';
  if(typeof garmentId!=='string' || garmentId.length>120 || clothingMode==='reference' && !garmentId) throw new Error('請選擇一套服裝。');
  return {preserveOriginal:false,useOriginal,clothingMode,garmentId,aspectRatio,fieldModes,presetIds,changes:values};
}

export function photoCustomizationError(value,{garments=[],presets=[]}={}) {
  try {
    const customization=normalizePhotoCustomization(value);
    if(customization.clothingMode==='reference' && !garments.some(row=>row.id===customization.garmentId)) return '請選擇一套可用的服裝，或改用文字描述。';
    for(const [key,id] of Object.entries(customization.presetIds)) if(!presets.some(row=>row.id===id && row.category===PHOTO_PRESET_CATEGORIES[key])) return `請選擇一個已開放的${PHOTO_CHANGE_FIELDS[key]}官方選項，或改用自行輸入。`;
    return '';
  } catch(error) {return error.message;}
}

export function customPhotoPrompt(options,shot,selectedPresets={},selectedGarment=null) {
  const {changes:customChanges,presetIds,clothingMode,preserveOriginal} = normalizePhotoCustomization(options);
  const changes={...customChanges};
  for(const [key,id] of Object.entries(presetIds)) {
    const row=selectedPresets[key];
    if(!row || row.id!==id || row.category!==PHOTO_PRESET_CATEGORIES[key]) throw new Error(`請選擇有效的${PHOTO_CHANGE_FIELDS[key]}官方選項。`);
    changes[key]=row.prompt;
  }
  const scene=changes.scene || [shot.interaction?.prompt,shot.sceneInteraction,shot.scene?.description].filter(Boolean).join(' ');
  if(shot.jobKind!=='angle-edit' && shot.prompt) {
    let prompt=referenceOnlyPrompt(shot);
    if(preserveOriginal) return withSingleSubjectPrompt(withNaturalScenePrompt(prompt,scene));
    const replaceDirection=(labels,oldValues,newValue)=>{
      if(!newValue) return;
      for(const label of labels) for(const oldValue of oldValues) {
        const previous=`${label}: ${oldValue}`;
        if(oldValue && prompt.includes(previous)) {prompt=prompt.replace(previous,`${labels[0]}: ${newValue}`);return;}
      }
      prompt+=`\n\n${labels[0]}: ${newValue}`;
    };
    replaceDirection(['Pose and action','Pose'],[shot.pose?.prompt],changes.pose);
    replaceDirection(['Scene','Scene interaction'],[
      [shot.interaction?.prompt?.trim(),shot.sceneInteraction?.trim(),shot.scene?.description].filter(Boolean).join(' '),
      [shot.interaction?.prompt?.trim(),shot.sceneInteraction?.trim()].filter(Boolean).join(' '),
    ],changes.scene);
    replaceDirection(['Facial expression'],[shot.expression?.prompt?.trim()],changes.expression);
    replaceDirection(['Gaze direction'],[shot.gaze?.prompt?.trim(),NATURAL_GAZE_PROMPT],changes.gaze);
    replaceDirection(['Clothing state'],[shot.clothingState?.prompt?.trim()],changes.clothingState);
    for(const [key,label] of [['lighting','Lighting'],['color','Color treatment'],['quality','Photographic quality']]) replaceDirection([label,key],[shot[key]?.prompt],changes[key]);
    if(changes.clothing || clothingMode==='reference') {
      const requestedClothing=changes.clothing ? clothingDescription(changes.clothing) : isPromptGarment(selectedGarment) ? selectedGarment.prompt : null;
      const replacement=requestedClothing ? [!prompt.includes(CHARACTER_INSTRUCTION) && CHARACTER_INSTRUCTION,textClothingInstruction(requestedClothing)].filter(Boolean).join('\n') : REFERENCE_INSTRUCTION;
      const oldClothing=isPromptGarment(shot.garment) ? shot.garment.prompt : shot.garment?.description;
      const previous=[REFERENCE_INSTRUCTION,oldClothing && textClothingInstruction(oldClothing),oldClothing && `The character should wear: ${oldClothing}`].find(value=>value && prompt.includes(value));
      if(previous && (requestedClothing || previous!==REFERENCE_INSTRUCTION)) prompt=prompt.replace(previous,replacement);
      else if(!previous) prompt+=`\n\n${replacement}`;
      if(requestedClothing) while(prompt.includes(`${CHARACTER_INSTRUCTION}\n${CHARACTER_INSTRUCTION}`)) prompt=prompt.replaceAll(`${CHARACTER_INSTRUCTION}\n${CHARACTER_INSTRUCTION}`,CHARACTER_INSTRUCTION);
    }
    return withSingleSubjectPrompt(withNaturalScenePrompt(prompt,scene));
  }
  const garment=selectedGarment || shot.garment;
  const useClothingImage=clothingMode==='reference' ? !isPromptGarment(garment) : !changes.clothing && !isPromptGarment(garment) && Boolean(garment?.fileName);
  const clothing=changes.clothing ? clothingDescription(changes.clothing) : isPromptGarment(garment) ? garment.prompt : garment?.description;
  return withSingleSubjectPrompt(withNaturalScenePrompt([
    CHARACTER_INSTRUCTION,
    shot.character?.description && `Character details: ${shot.character.description}`,
    shot.characterMeasurementsPrompt ?? characterProfilePrompt(shot.character),
    useClothingImage ? REFERENCE_INSTRUCTION : textClothingInstruction(clothing || 'the requested outfit'),
    (changes.pose || shot.pose?.prompt) && `Pose and action: ${changes.pose || shot.pose.prompt}`,
    scene && `Scene: ${scene}`,
    (changes.expression || shot.expression?.prompt) && `Facial expression: ${changes.expression || shot.expression.prompt}`,
    `Gaze direction: ${changes.gaze || shot.gaze?.prompt || NATURAL_GAZE_PROMPT}`,
    (changes.clothingState || shot.clothingState?.prompt) && `Clothing state: ${changes.clothingState || shot.clothingState.prompt}`,
    ...[['lighting','Lighting'],['color','Color treatment'],['quality','Photographic quality']].map(([key,label])=>(changes[key] || shot[key]?.prompt) && `${label}: ${changes[key] || shot[key].prompt}`),
  ].filter(Boolean).join('\n'),scene));
}
