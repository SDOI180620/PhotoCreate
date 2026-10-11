export const CUP_SIZES = Array.from({length:26},(_,index)=>String.fromCharCode(65+index));

export function characterProfile(input={}) {
  if(!input || typeof input!=='object' || Array.isArray(input)) throw new Error('角色資料格式不正確。');
  const cup=input.cupSize ?? '',height=input.heightCm ?? '';
  if(typeof cup!=='string' || cup && !CUP_SIZES.includes(cup)) throw new Error('胸部尺寸請選擇 A–Z Cup。');
  if(height!=='' && (typeof height!=='number' && typeof height!=='string' || typeof height==='string' && !/^\d+(?:\.\d+)?$/.test(height))) throw new Error('身高請填寫公分數值。');
  const cm=height==='' ? null : Number(height);
  if(cm!==null && (!Number.isFinite(cm) || cm<=0 || cm>1000)) throw new Error('身高須大於 0，且不超過 1000 公分。');
  return {...(cup ? {cupSize:cup} : {}),...(cm===null ? {} : {heightCm:cm})};
}

export function characterProfilePrompt(character) {
  const {cupSize,heightCm}=characterProfile(character || {});
  const values=[heightCm!==undefined && `height ${heightCm} cm`,cupSize && `breast size ${cupSize} cup`].filter(Boolean);
  return values.length ? `Character measurements: ${values.join('; ')}.` : '';
}

export function uploadedCharacterProfiles(raw,count) {
  if(raw===undefined) return Array.from({length:count},()=>({}));
  if(typeof raw!=='string' || raw.length>20000) throw new Error('角色上傳資料格式不正確。');
  let rows;try {rows=JSON.parse(raw);} catch {throw new Error('角色上傳資料格式不正確。');}
  if(!Array.isArray(rows) || rows.length!==count) throw new Error('每張角色圖片須對應一份資料。');
  return rows.map(characterProfile);
}
