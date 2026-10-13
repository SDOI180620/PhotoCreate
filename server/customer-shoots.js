import {randomUUID} from 'node:crypto';
import {PHOTO_CHANGE_FIELDS,PHOTO_PRESET_CATEGORIES,PHOTO_CHANGE_MAX_LENGTH} from '../shared/photo-customization.js';
import {CUSTOMER_MAX_SHOOT_CANDIDATES} from '../shared/customer-recipe.js';

const fail=message=>Object.assign(new Error(message),{status:400});
const poolKey=field=>field==='clothing' ? 'garment' : field==='scene' ? 'interaction' : field;

// Only the assigned snapshot supplies official candidates. Custom shooting uses
// explicit selections; unselected categories contribute no candidates.
export function customerShootRecipe(recipe,selections={},prompts=[],garments=[]) {
  if(!selections || typeof selections!=='object' || Array.isArray(selections)) throw fail('自定義候選格式不正確。');
  const pools=Object.fromEntries(Object.keys(recipe.pools).map(key=>[key,key==='camera' ? recipe.pools.camera : []]));
  for(const [field,items] of Object.entries(selections)) {
    if(!Object.hasOwn(PHOTO_CHANGE_FIELDS,field)) throw fail('請選擇有效的拍攝分類。');
    const label=PHOTO_CHANGE_FIELDS[field],key=poolKey(field);
    if(!Array.isArray(items) || items.length>CUSTOMER_MAX_SHOOT_CANDIDATES) throw fail(`${label}最多選擇 ${CUSTOMER_MAX_SHOOT_CANDIDATES} 個候選。`);
    if(!items.length) continue;
    pools[key]=items.map(item=>{
      if(!item || typeof item!=='object' || Array.isArray(item)) throw fail(`${label}候選格式不正確。`);
      if(item.source==='temporary') {
        if(typeof item.prompt!=='string' || !item.prompt.trim() || item.prompt.length>PHOTO_CHANGE_MAX_LENGTH) throw fail(`請輸入 1–${PHOTO_CHANGE_MAX_LENGTH} 字的${label}提詞。`);
        const name=item.name ?? item.prompt.trim().slice(0,32);
        if(typeof name!=='string' || !name.trim() || name.trim().length>80) throw fail('提詞名稱需為 1–80 個字。');
        return {id:`temporary-${randomUUID()}`,name:name.trim(),prompt:item.prompt.trim(),...(field==='clothing' ? {sourceType:'prompt'} : {category:PHOTO_PRESET_CATEGORIES[field]})};
      }
      if(typeof item.id!=='string') throw fail(`${label}候選格式不正確。`);
      if(item.source==='wardrobe' && field==='clothing') {
        const row=garments.find(row=>row.id===item.id);
        if(!row) throw fail('請選擇自己的服裝收藏。');
        return row;
      }
      if(item.source==='saved') {
        const prompt=prompts.find(row=>row.id===item.id && row.field===field);
        if(!prompt) throw fail(`請選擇自己的${label}提詞。`);
        return {id:`saved-${prompt.id}`,name:prompt.name,prompt:prompt.prompt,...(field==='clothing' ? {sourceType:'prompt'} : {category:PHOTO_PRESET_CATEGORIES[field]})};
      }
      if(item.source!=='official') throw fail(`${label}候選格式不正確。`);
      const row=recipe.pools[key]?.find(row=>row.id===item.id && (field==='clothing' || row.category===PHOTO_PRESET_CATEGORIES[field]));
      if(!row) throw fail(`請選擇已開放的${label}選項。`);
      return row;
    });
  }
  return {...recipe,pools,settings:{...recipe.settings,extra:'',sceneInteraction:''},custom:true};
}
