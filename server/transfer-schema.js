import {OPTIONAL_PRESET_FIELDS,PRESET_POOL_FIELDS,OUTPUT_RATIOS,normalizePresetImport,selectedPresetIds} from '../shared/domain.js';
import {cameraPreset} from '../shared/camera.js';
import {DEFAULT_DRAFT} from '../shared/draft.js';

export const ASSET_KINDS = ['garments','characters','scenes'];
export const LIMITS = {archive:2*1024**3,total:2*1024**3,image:25*1024**2,manifest:10*1024**2,assets:10000,presets:10000};
export const transferError = (message,status=400) => Object.assign(new Error(message),{status});
export function textField(value,max,label,required=false) {
  if(typeof value!=='string' || value.length>max || required && !value.trim()) throw transferError(`${label}格式不正確。`);
  return value.trim();
}
export function tagsField(value) {
  if(!Array.isArray(value) || value.length>50) throw transferError('標籤格式不正確。');
  return value.map(tag=>textField(tag,100,'標籤')).filter(Boolean);
}
export function idField(id) {
  if(typeof id!=='string' || !/^[\w-]{1,120}$/.test(id)) throw transferError('資料 ID 格式不正確。');
  return id;
}
export function imageType(buffer) {
  if(buffer.length>=24 && buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return {ext:'.png',mime:'image/png'};
  if(buffer.length>=12 && buffer[0]===255 && buffer[1]===216 && buffer[2]===255) return {ext:'.jpg',mime:'image/jpeg'};
  if(buffer.length>=12 && buffer.toString('ascii',0,4)==='RIFF' && buffer.toString('ascii',8,12)==='WEBP') return {ext:'.webp',mime:'image/webp'};
  throw transferError('資料包中的圖片不是有效的 PNG、JPG 或 WebP。');
}
export function portablePresets(rows) {
  if(!Array.isArray(rows) || rows.length>LIMITS.presets) throw transferError('提詞數量超過 10,000 筆。');
  if(!rows.length) return [];
  const input=rows.map(row=>({id:idField(row.id),category:row.category,name:row.name,prompt:row.prompt,tags:tagsField(row.tags ?? []),...(row.category==='camera' ? {angle:cameraPreset(row).angle} : {})}));
  return normalizePresetImport(input).map((row,index)=>row.category==='camera' ? {...row,mappingSource:rows[index].mappingSource==='automatic' ? 'automatic' : 'manual',mappingNote:textField(rows[index].mappingNote ?? '',2000,'角度備註')} : row);
}
export function portableDraft(input,assets,presets) {
  if(!input || typeof input!=='object' || Array.isArray(input)) throw transferError('拍攝設定格式不正確。');
  const result=structuredClone(DEFAULT_DRAFT);
  for(const [key,options] of Object.entries({cameraMode:['multiangle','prompt'],mode:['random','combinations'],randomPoolMode:['all','selected'],aspectRatio:Object.keys(OUTPUT_RATIOS)})) {
    if(input[key]!==undefined) {if(!options.includes(input[key])) throw transferError(`拍攝設定 ${key} 無效。`);result[key]=input[key];}
  }
  for(const [key,[min,max,integer]] of Object.entries({steps:[1,100,true],angleSteps:[1,100,true],refineDenoise:[0.05,0.4,false],randomCount:[1,100,true],copies:[1,10,true],seed:[-1,2**48-100,true]})) {
    if(input[key]===undefined || input[key]==='') continue;
    if(!['number','string'].includes(typeof input[key])) throw transferError(`拍攝設定 ${key} 無效。`);
    const value=Number(input[key]);
    if(!Number.isFinite(value) || value<min || value>max || integer && !Number.isSafeInteger(value)) throw transferError(`拍攝設定 ${key} 超出範圍。`);
    result[key]=value;
  }
  if(input.resolution!==undefined) {const value=Number(input.resolution);if(![1024,1536,2048].includes(value)) throw transferError('拍攝解析度無效。');result.resolution=value;}
  for(const key of ['batchName','extra','negative','sceneInteraction']) if(input[key]!==undefined) result[key]=textField(input[key],key==='batchName' ? 200 : 20000,'拍攝提詞');
  if(input.randomOptional!==undefined) {
    if(!input.randomOptional || typeof input.randomOptional!=='object' || Array.isArray(input.randomOptional)) throw transferError('隨機選項格式不正確。');
    for(const category of Object.keys(OPTIONAL_PRESET_FIELDS)) if(input.randomOptional[category]!==undefined) {
      if(typeof input.randomOptional[category]!=='boolean') throw transferError('隨機選項須為開啟或關閉。');
      result.randomOptional[category]=input.randomOptional[category];
    }
  }
  const selected=(values,available) => {
    if(!Array.isArray(values) || values.length>10000) throw transferError('拍攝候選格式不正確。');
    const ids=new Set(available.map(row=>row.id));return [...new Set(values.map(idField))].filter(id=>ids.has(id));
  };
  result.characterId=input.characterId ? selected([input.characterId],assets.characters)[0] || '' : '';
  result.garmentIds=selected(input.garmentIds ?? [],assets.garments);
  for(const [category,field] of Object.entries(PRESET_POOL_FIELDS)) {
    result[field]=selected(selectedPresetIds({...result,...input},category),presets.filter(row=>row.category===category));
    if(category!=='pose') result[`${category}Id`]=result[field][0] || '';
  }
  for(const [category,field] of Object.entries(OPTIONAL_PRESET_FIELDS)) result[field]=input[field] ? selected([input[field]],presets.filter(row=>row.category===category))[0] || '' : '';
  return result;
}
export function validateManifest(value) {
  if(!value || value.format!=='PhotoCreate-library' || value.version!==1) throw transferError('請選擇 PhotoCreate 匯出的資料 ZIP（version 1）。');
  const createdAt=textField(value.createdAt,40,'匯出日期',true);
  if(!Number.isFinite(Date.parse(createdAt))) throw transferError('匯出日期無效。');
  const ids=new Set(),assets={};let count=0;
  for(const kind of ASSET_KINDS) {
    const rows=value.assets?.[kind];
    if(!Array.isArray(rows) || (count+=rows.length)>LIMITS.assets) throw transferError('圖片資料格式不正確或超過 10,000 張。');
    assets[kind]=rows.map(row=> {
      if(!row || typeof row!=='object') throw transferError('圖片資料格式不正確。');
      const id=idField(row.id);if(ids.has(id)) throw transferError('圖片 ID 重複。');ids.add(id);
      if(!Number.isSafeInteger(row.size) || row.size<12 || row.size>LIMITS.image || typeof row.sha256!=='string' || !/^[a-f0-9]{64}$/.test(row.sha256)) throw transferError('圖片大小或校驗值無效。');
      const ext={'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp'}[row.mime];
      if(!ext || row.imageFile!==`images/${row.sha256}${ext}`) throw transferError('圖片檔案路徑或格式無效。');
      return {id,name:textField(row.name,200,'圖片名稱',true),description:textField(row.description ?? '',20000,'圖片提詞'),tags:tagsField(row.tags ?? []),createdAt:textField(row.createdAt ?? createdAt,40,'圖片日期'),mime:row.mime,imageFile:row.imageFile,sha256:row.sha256,size:row.size};
    });
  }
  const presets=portablePresets(value.presets);
  return {format:value.format,version:1,createdAt,assets,presets,draft:portableDraft(value.draft,assets,presets)};
}
export function remapDraft(draft,assetMap,presetMap) {
  const result=structuredClone(draft);
  result.characterId=assetMap.get(result.characterId) || '';
  result.garmentIds=result.garmentIds.map(id=>assetMap.get(id)).filter(Boolean);
  for(const field of Object.values(PRESET_POOL_FIELDS)) result[field]=result[field].map(id=>presetMap.get(id)).filter(Boolean);
  for(const category of ['camera','lighting','color','quality']) result[`${category}Id`]=result[`${category}Ids`][0] || '';
  for(const field of Object.values(OPTIONAL_PRESET_FIELDS)) result[field]=presetMap.get(result[field]) || '';
  return result;
}
