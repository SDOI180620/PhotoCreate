export const LEGACY_TURNAROUND_PROMPT = 'Create a clean character turnaround sheet from the character shown in <image1>. Show exactly three full-body views of the SAME character, arranged left to right: front view, a strict side profile, and back view. This is one character shown from three directions. Preserve the facial identity, hairstyle, hair color, skin tone, distinctive features, outfit design, accessories, materials and colors from the reference. Apply the supplied height and Cup measurements consistently to all three views. Use a neutral standing pose with relaxed arms slightly separated from the torso. Keep identical body proportions, scale, posture and clothing across the views. Show the complete figure from head to toe in every view, align the feet along a common baseline, and leave even spacing between figures without overlap. Use an eye-level orthographic presentation with minimal perspective, soft even lighting, a plain neutral background and clear details. No captions, view labels, text or watermark.';

export const PREVIOUS_TURNAROUND_PROMPT = 'Create a clean character reference sheet from the character shown in <image1>. Arrange exactly four separate panels in one horizontal row, left to right: (1) a large front-facing head-and-shoulders portrait; (2) a front body view WITHOUT a head; (3) a strict side-profile body view WITHOUT a head; (4) a complete back view WITH the head and hairstyle visible. All four panels depict the SAME character. The far-left portrait is a prominent close-up showing the entire head, face, hairstyle and upper shoulders clearly. In the front and side body panels, omit the entire head, face and hair above the neckline; show the outfit and body from the neckline down to the feet, with a clean garment neckline and no injury detail. Do not place a head above either of these two bodies. The far-right back panel shows the complete figure from head to toe, including the back of the head and the full hairstyle. Preserve the facial identity in the portrait, and preserve hairstyle, hair color, skin tone, distinctive features, outfit design, accessories, materials and colors from the reference wherever visible. Apply the supplied height and Cup measurements consistently to the three body views. Use a neutral standing pose with relaxed arms slightly separated from the torso. Keep identical body proportions, body scale, posture and clothing across the three body views, align their feet along a common baseline, and leave even spacing without overlap. The portrait is larger in scale than the body views. Use an eye-level orthographic presentation with minimal perspective, soft even lighting, a plain neutral background and clear details. No captions, view labels, text or watermark.';

export const DEFAULT_TURNAROUND_PROMPT = 'Create a clean four-panel reference sheet of the SAME character from <image1>, arranged in one horizontal row. Panel 1 at the far left: a large front-facing head-and-shoulders portrait, showing the complete head, face and hairstyle clearly. Panel 2: a FRONT view of a HEADLESS CLOTHING DISPLAY BODY, like a headless garment mannequin matching the character\'s body proportions and skin tone. Panel 3: a strict SIDE view of the same HEADLESS CLOTHING DISPLAY BODY. Panel 4 at the far right: a complete BACK view of the character, including the head and full hairstyle. In panels 2 and 3, show only the shoulders, torso, arms, legs and feet, with the original outfit and accessories. The clothing collar and shoulders are the highest visible parts of these two display bodies. The garment neckline is clean and empty, with no neck stump or injury detail. Replace the entire area where a head, face, scalp, ears, neck or hair would be above each neckline with the same uninterrupted plain background. The space above the shoulders in both middle panels contains BACKGROUND ONLY; no head-shaped silhouette, skin-colored oval, floating head, face, ears or hair. Only panels 1 and 4 contain a head. Preserve facial identity in the left portrait and the reference hairstyle in the portrait and back view. Preserve the outfit design, materials, colors and accessories, with consistent body proportions and body scale across the three body views. Apply the supplied height and Cup measurements consistently to the body views. Keep the display bodies upright with relaxed arms slightly separated from the torso; align all body-view feet along a common baseline with even spacing and no overlap. The portrait is larger in scale than the body views. Use eye-level orthographic presentation, minimal perspective, soft even lighting and a plain neutral background. No captions, labels, text or watermark. Final layout requirement: large portrait, headless front display body, headless side display body, complete back view; the front and side neckline areas open directly onto empty background.';

export const DEFAULT_TURNAROUND_NEGATIVE = 'head in panel 2, head in panel 3, face in the front body panel, face in the side body panel, scalp or ears above the front or side neckline, hair above the front or side shoulders, neck stump, head-shaped silhouette above either middle body, skin-colored oval above the collar, floating head, different characters, inconsistent face, inconsistent hairstyle, mismatched clothing, inconsistent body proportions, different body scale between the three body views, missing portrait panel, missing body view, extra portrait panel, extra body view, incorrect panel order, overlapping panels, missing head in the back view, cropped face or head in the portrait panel, cropped feet, gore, blood, wounds, extreme perspective, action pose, busy background, blurry, low quality, deformed torso, malformed hands, extra limbs, extra fingers, text, labels, watermark';

export const CUP_SIZES = Array.from({length:26},(_,index)=>String.fromCharCode(65+index));

const CUP_DESCRIPTIONS = [
  {cups:'A',label:'微小胸部',prompt:'very small bust'},
  {cups:'B',label:'小胸部',prompt:'small bust'},
  {cups:'C',label:'中等胸部',prompt:'medium bust'},
  {cups:'DEF',label:'大胸部',prompt:'large bust'},
  {cups:'GHIJKLMNOPQRSTUVWXYZ',label:'巨大胸部',prompt:'huge bust'},
];

export const CHARACTER_HEIGHT_RANGES = [
  {id:'below140',label:'140 cm 以下',bounds:'身高 < 140 cm',min:0,max:140,prompt:'very short stature'},
  {id:'140to150',label:'140–150 cm',bounds:'140 ≤ 身高 < 150 cm',min:140,max:150,prompt:'short stature'},
  {id:'150to160',label:'150–160 cm',bounds:'150 ≤ 身高 < 160 cm',min:150,max:160,prompt:'moderately short stature'},
  {id:'160to170',label:'160–170 cm',bounds:'160 ≤ 身高 < 170 cm',min:160,max:170,prompt:'average height'},
  {id:'170plus',label:'170 cm 以上',bounds:'身高 ≥ 170 cm',min:170,max:Infinity,prompt:'tall stature'},
];

export const CHARACTER_PROMPT_MAX_LENGTH = 4000;

export function defaultCharacterPromptSettings() {
  return {
    turnaroundPrompt:DEFAULT_TURNAROUND_PROMPT,
    turnaroundNegative:DEFAULT_TURNAROUND_NEGATIVE,
    heightPrompts:Object.fromEntries(CHARACTER_HEIGHT_RANGES.map(row=>[row.id,row.prompt])),
    cupPrompts:Object.fromEntries(CUP_SIZES.map(cup=>[cup,cupSizeDescription(cup).prompt])),
  };
}

export function normalizeCharacterPromptSettings(input) {
  if(!input || typeof input!=='object' || Array.isArray(input)) throw new Error('角色提詞設定格式不正確。');
  const normalize=(value,keys,label)=>{
    if(!value || typeof value!=='object' || Array.isArray(value)) throw new Error(`${label}提詞設定格式不正確。`);
    return Object.fromEntries(keys.map(key=>{
      if(!Object.hasOwn(value,key) || typeof value[key]!=='string' || value[key].length>CHARACTER_PROMPT_MAX_LENGTH) throw new Error(`${label} ${key} 的提詞須為文字，最多 ${CHARACTER_PROMPT_MAX_LENGTH} 字。`);
      return [key,value[key].trim()];
    }));
  };
  const turnaroundPrompt=input.turnaroundPrompt===undefined ? DEFAULT_TURNAROUND_PROMPT : input.turnaroundPrompt;
  if(typeof turnaroundPrompt!=='string' || !turnaroundPrompt.trim() || turnaroundPrompt.length>CHARACTER_PROMPT_MAX_LENGTH) throw new Error(`三視圖提詞須為非空白文字，最多 ${CHARACTER_PROMPT_MAX_LENGTH} 字。`);
  const turnaroundNegative=input.turnaroundNegative===undefined ? DEFAULT_TURNAROUND_NEGATIVE : input.turnaroundNegative;
  if(typeof turnaroundNegative!=='string' || turnaroundNegative.length>CHARACTER_PROMPT_MAX_LENGTH) throw new Error(`三視圖負面提詞須為文字，最多 ${CHARACTER_PROMPT_MAX_LENGTH} 字；可留白。`);
  return {turnaroundPrompt:turnaroundPrompt.trim(),turnaroundNegative:turnaroundNegative.trim(),heightPrompts:normalize(input.heightPrompts,CHARACTER_HEIGHT_RANGES.map(row=>row.id),'身高'),cupPrompts:normalize(input.cupPrompts,CUP_SIZES,'Cup')};
}

export function characterHeightRange(heightCm) {
  if(typeof heightCm!=='number' || !Number.isFinite(heightCm) || heightCm<=0 || heightCm>1000) return;
  return CHARACTER_HEIGHT_RANGES.find(row=>heightCm>=row.min && heightCm<row.max);
}

export function cupSizeDescription(cupSize) {
  if(!CUP_SIZES.includes(cupSize)) return;
  const {label,prompt}=CUP_DESCRIPTIONS.find(row=>row.cups.includes(cupSize));
  return {label,prompt};
}

export function characterProfile(input={}) {
  if(!input || typeof input!=='object' || Array.isArray(input)) throw new Error('角色資料格式不正確。');
  const cup=input.cupSize ?? '',height=input.heightCm ?? '';
  if(typeof cup!=='string' || cup && !CUP_SIZES.includes(cup)) throw new Error('胸部尺寸請選擇 A–Z Cup。');
  if(height!=='' && (typeof height!=='number' && typeof height!=='string' || typeof height==='string' && !/^\d+(?:\.\d+)?$/.test(height))) throw new Error('身高請填寫公分數值。');
  const cm=height==='' ? null : Number(height);
  if(cm!==null && (!Number.isFinite(cm) || cm<=0 || cm>1000)) throw new Error('身高須大於 0，且不超過 1000 公分。');
  return {...(cup ? {cupSize:cup} : {}),...(cm===null ? {} : {heightCm:cm})};
}

export function characterProfilePrompt(character,promptSettings) {
  const {cupSize,heightCm}=characterProfile(character || {});
  const cupPrompt=cupSize && (promptSettings?.cupPrompts?.[cupSize] ?? cupSizeDescription(cupSize).prompt).trim();
  const heightRange=characterHeightRange(heightCm),heightPrompt=heightRange && promptSettings?.heightPrompts?.[heightRange.id]?.trim();
  const values=[heightCm!==undefined && `height ${heightCm} cm`,cupSize && `breast size ${cupSize} cup${cupPrompt ? ` (${cupPrompt})` : ''}`].filter(Boolean);
  return [values.length && `Character measurements: ${values.join('; ')}.`,heightPrompt && `Height appearance: ${heightPrompt}`].filter(Boolean).join('\n');
}

export function uploadedCharacterProfiles(raw,count) {
  if(raw===undefined) return Array.from({length:count},()=>({}));
  if(typeof raw!=='string' || raw.length>20000) throw new Error('角色上傳資料格式不正確。');
  let rows;try {rows=JSON.parse(raw);} catch {throw new Error('角色上傳資料格式不正確。');}
  if(!Array.isArray(rows) || rows.length!==count) throw new Error('每張角色圖片須對應一份資料。');
  return rows.map(characterProfile);
}
