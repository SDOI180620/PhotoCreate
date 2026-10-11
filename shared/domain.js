import { cameraPreset, cameraPrompt, normalizeCameraAngle, ORIGINAL_CAMERA, REFINE_STEPS, CAMERA_MAPPING_VERSION } from './camera.js';
import { SINGLE_SUBJECT_PROMPT, withSingleSubjectNegative } from './subject.js';
import {characterProfilePrompt} from './character-profile.js';
import {garmentInstruction} from './garments.js';
import {PORTRAIT_SCENE_PRESETS,PORTRAIT_POSE_PRESETS} from './portrait-scenes.js';
import {PORTRAIT_ACTION_PRESETS} from './portrait-actions.js';
import {BASIC_SCENE_PAIRS} from './scene-presets.js';

export const CATEGORIES = {
  pose: { label: '動作', plural: '動作提詞' },
  expression: { label: '表情', plural: '表情提詞' },
  clothing_state: { label: '服裝狀態', plural: '服裝狀態提詞' },
  interaction: { label: '場景', plural: '場景提詞' },
  camera: { label: '攝影角度', plural: '攝影與構圖' },
  lighting: { label: '光線', plural: '光線設定' },
  color: { label: '色彩', plural: '色彩風格' },
  quality: { label: '畫質', plural: '寫真畫質' },
};

export const OPTIONAL_PRESET_FIELDS = {expression:'expressionId',clothing_state:'clothingStateId',interaction:'interactionId'};
export const PRESET_POOL_FIELDS = {pose:'poseIds',camera:'cameraIds',lighting:'lightingIds',color:'colorIds',quality:'qualityIds'};
export const OPTIONAL_PRESET_POOL_FIELDS = {expression:'expressionIds',clothing_state:'clothingStateIds',interaction:'interactionIds'};
export const PRESET_SELECTION_FIELDS = {...PRESET_POOL_FIELDS,...OPTIONAL_PRESET_POOL_FIELDS};

export function selectedCharacterIds(draft) {
  const values=draft.characterIds ?? (draft.characterId ? [draft.characterId] : []);
  if(!Array.isArray(values) || values.length>10000 || values.some(id=>typeof id!=='string')) throw new Error('角色候選格式不正確。');
  return [...new Set(values)];
}

export function selectedPresetIds(draft,category) {
  const field = PRESET_SELECTION_FIELDS[category],legacyField = OPTIONAL_PRESET_FIELDS[category] || `${category}Id`;
  const values = draft[field] ?? (draft[legacyField] ? [draft[legacyField]] : []);
  if (!Array.isArray(values) || values.length > 10000 || values.some(id => typeof id !== 'string')) throw new Error(`${CATEGORIES[category].label}候選格式不正確。`);
  return [...new Set(values)];
}

// Explicit candidate lists replace the former optional-category enable switches.
// Old drafts keep the candidates they actually used until the user changes them.
export function optionalPresetSelections(state,draft) {
  return Object.fromEntries(Object.entries(OPTIONAL_PRESET_POOL_FIELDS).map(([category,field])=>{
    if(draft[field] !== undefined) {
      if(!Array.isArray(draft[field])) throw new Error(`${CATEGORIES[category].label}候選格式不正確。`);
      return [field,selectedPresetIds(draft,category)];
    }
    if(draft.mode === 'random') {
      const enabled=draft.randomOptional?.[category] ?? false;
      if(typeof enabled !== 'boolean') throw new Error('隨機選填設定無效。');
      if(!enabled) return [field,[]];
      if((draft.randomPoolMode ?? 'all') === 'all') return [field,state.presets.filter(row=>row.category===category).map(row=>row.id)];
    }
    return [field,selectedPresetIds(draft,category)];
  }));
}

export function getShotRecipe(state,draft,{includeDisabledCamera=false,includeCharacters=true}={}) {
  if(draft.cameraEnabled !== undefined && typeof draft.cameraEnabled !== 'boolean') throw new Error('鏡頭開關須為勾選或取消勾選。');
  const mode = draft.mode ?? 'combinations';
  if (!['combinations','random'].includes(mode)) throw new Error('請選擇有效的拍攝模式。');
  const all = mode === 'random' && (draft.randomPoolMode ?? 'all') === 'all';
  if (mode === 'random' && !['all','selected'].includes(draft.randomPoolMode ?? 'all')) throw new Error('隨機候選範圍無效。');
  const selectedRows = (rows,ids,label) => {
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error(`${label}候選格式不正確。`);
    return [...new Set(ids)].map(id => {
      const row = rows.find(item => item.id === id);
      if (!row) throw new Error(`請選擇有效的${label}提詞或圖片。`);
      return row;
    });
  };
  const pools = {...(includeCharacters ? {character:selectedRows(state.characters,selectedCharacterIds(draft),'角色')} : {}),garment:all && !draft.garmentIds?.length ? state.garments : selectedRows(state.garments,draft.garmentIds ?? [],'服裝')};
  for (const category of Object.keys(PRESET_POOL_FIELDS)) {
    if(category === 'camera' && draft.cameraEnabled === false && !includeDisabledCamera) {pools.camera = [ORIGINAL_CAMERA];continue;}
    const rows = state.presets.filter(row => row.category === category);
    pools[category] = all ? rows : selectedRows(rows,selectedPresetIds(draft,category),CATEGORIES[category].label);
  }
  const optionalSelections = optionalPresetSelections(state,draft);
  for (const [category,field] of Object.entries(OPTIONAL_PRESET_POOL_FIELDS)) {
    const key = category === 'clothing_state' ? 'clothingState' : category;
    const rows = state.presets.filter(row => row.category === category);
    const ids = optionalSelections[field];
    pools[key] = ids.length ? selectedRows(rows,ids,CATEGORIES[category].label) : [null];
  }
  const copies = Number(draft.copies ?? 1);
  const combinationCount = Object.values(pools).reduce((total,pool) => total * BigInt(pool.length),1n);
  const count = mode === 'random' ? Number(draft.randomCount ?? 30) : Number(combinationCount) * copies;
  return {mode,pools,copies,count,combinationCount};
}

export const OUTPUT_RATIOS = {
  reference: {label:'跟隨人物參考圖',ratio:null},
  '16:9': {label:'橫式 16:9',ratio:[16,9]},
  '9:16': {label:'直式 9:16',ratio:[9,16]},
  '1:1': {label:'正方形 1:1',ratio:[1,1]},
};

export function getOutputSize(aspectRatio = 'reference',resolution = 1536) {
  if (!Object.hasOwn(OUTPUT_RATIOS,aspectRatio)) throw new Error('請選擇有效的輸出比例。');
  const ratio = OUTPUT_RATIOS[aspectRatio].ratio;
  if (!ratio) return null;
  if (![1024,1536,2048].includes(resolution)) throw new Error('參考解析度須為 1024、1536 或 2048。');
  const unit = Math.max(32,Math.round(resolution / Math.sqrt(ratio[0] * ratio[1]) / 32) * 32);
  return {width:ratio[0] * unit,height:ratio[1] * unit};
}

export const DEFAULT_PRESETS = [
  { id: 'pose-standing', category: 'pose', name: '自然站姿', prompt: 'Standing naturally with weight on one leg, relaxed shoulders, hands resting gently by the sides, looking into the camera.', tags: ['站姿', '自然'] },
  { id: 'pose-sitting', category: 'pose', name: '側坐回眸', prompt: 'Sitting sideways on a chair with an upright relaxed posture, turning the head toward the camera, one hand resting on the knee.', tags: ['坐姿', '回眸'] },
  { id: 'pose-walking', category: 'pose', name: '漫步瞬間', prompt: 'Walking slowly toward the camera, a natural mid-step pose, subtle movement in the clothing, relaxed candid expression.', tags: ['走路', '動態'] },
  { id: 'pose-leaning', category: 'pose', name: '倚牆凝視', prompt: 'Leaning lightly against a wall with one shoulder, arms relaxed, chin slightly raised, a calm gaze toward the camera.', tags: ['倚靠', '時尚'] },
  { id: 'pose-profile', category: 'pose', name: '側身整理髮絲', prompt: 'Three-quarter profile, gently brushing hair behind one ear, soft expression, relaxed natural hands.', tags: ['側身', '日常'] },
  { id: 'pose-over-shoulder', category: 'pose', name: '背身回頭', prompt: 'Standing with the back turned slightly to the camera, looking over one shoulder, relaxed posture, showing the back details of the garment.', tags: ['背身', '回眸'] },
  BASIC_SCENE_PAIRS.find(row=>row.scene.id==='interaction-bed').scene,
  { id: 'expression-smile', category: 'expression', name: '微笑', prompt: 'A gentle natural smile, relaxed lips and warm eyes.', tags: ['微笑', '自然'] },
  { id: 'expression-calm', category: 'expression', name: '沉穩神情', prompt: 'A composed facial expression, relaxed eyebrows and lips, a steady calm gaze.', tags: ['沉穩', '平靜'] },
  { id: 'expression-laugh', category: 'expression', name: '開懷笑容', prompt: 'A spontaneous joyful laugh, bright eyes and naturally lifted cheeks.', tags: ['笑容', '開心'] },
  { id: 'clothing-state-neat', category: 'clothing_state', name: '整齊穿著', prompt: 'The garment is worn neatly, with its seams, collar and hem naturally aligned.', tags: ['整齊', '穿著'] },
  { id: 'clothing-state-folds', category: 'clothing_state', name: '自然皺褶', prompt: 'Natural fabric folds and slight wrinkles follow the body posture, preserving the garment design and material.', tags: ['皺褶', '布料'] },
  { id: 'clothing-state-breeze', category: 'clothing_state', name: '衣襬隨風', prompt: 'A gentle breeze subtly lifts the garment hem, with realistic fabric movement and the original garment design preserved.', tags: ['微風', '動態'] },
  BASIC_SCENE_PAIRS.find(row=>row.scene.id==='interaction-window').scene,
  BASIC_SCENE_PAIRS.find(row=>row.scene.id==='interaction-railing').scene,
  { id: 'camera-portrait', category: 'camera', name: '85mm 人像', prompt: 'Eye-level portrait, 85mm lens, medium shot from the waist up, natural perspective, softly blurred background.', tags: ['半身', '85mm'] },
  { id: 'camera-full', category: 'camera', name: '50mm 全身', prompt: 'Full-body photograph, 50mm lens, eye-level camera, complete outfit visible from head to toe, balanced composition.', tags: ['全身', '50mm'] },
  { id: 'camera-low', category: 'camera', name: '低角度時尚', prompt: 'Slightly low camera angle, 50mm lens, three-quarter body framing, clean editorial composition, realistic proportions.', tags: ['低角度', '時尚'] },
  { id: 'camera-close', category: 'camera', name: '特寫細節', prompt: 'Close-up portrait with an 85mm lens, focus on the eyes and garment neckline, shallow depth of field, detailed fabric and skin.', tags: ['特寫', '細節'] },
  { id: 'light-window', category: 'lighting', name: '柔和窗光', prompt: 'Soft diffused daylight from a large window, gentle shadows, subtle catchlights, coherent lighting on the subject and environment.', tags: ['自然光', '柔和'] },
  { id: 'light-studio', category: 'lighting', name: '棚拍柔光', prompt: 'Large softbox key light, gentle fill light and a subtle rim light, carefully controlled studio lighting with soft shadows.', tags: ['棚拍', '柔光'] },
  { id: 'light-golden', category: 'lighting', name: '日落金色光', prompt: 'Warm golden-hour sunlight, a soft luminous rim on hair and fabric, natural ambient fill, realistic shadow direction.', tags: ['日落', '暖光'] },
  { id: 'light-overcast', category: 'lighting', name: '陰天漫射光', prompt: 'Overcast daylight, soft even illumination, low-contrast shadows, natural and consistent exposure.', tags: ['戶外', '漫射'] },
  { id: 'color-natural', category: 'color', name: '自然原色', prompt: 'True-to-life colors, accurate garment colors, natural skin tones, restrained saturation, balanced white balance.', tags: ['自然', '原色'] },
  { id: 'color-film', category: 'color', name: '暖調底片', prompt: 'Subtle warm film color grading, creamy highlights, muted greens, fine film grain, faithful garment color and natural skin tones.', tags: ['底片', '暖調'] },
  { id: 'color-cool', category: 'color', name: '冷調雜誌', prompt: 'Refined cool editorial color grading, clean whites, soft desaturated background, realistic warm skin tones.', tags: ['冷調', '雜誌'] },
  { id: 'color-mono', category: 'color', name: '黑白寫真', prompt: 'Elegant black-and-white photographic rendering, rich tonal transitions, controlled contrast, distinct fabric textures.', tags: ['黑白', '經典'] },
  { id: 'quality-editorial', category: 'quality', name: '高清寫真', prompt: 'High-resolution professional editorial photograph, photorealistic face, natural skin texture and fine fabric detail, anatomically coherent hands, crisp eyes, coherent perspective, polished photographic finish, no text or watermark.', tags: ['高清', '寫真'] },
  { id: 'quality-candid', category: 'quality', name: '生活感紀實', prompt: 'High-quality candid lifestyle photograph, natural expression, realistic skin pores, authentic clothing texture, subtle imperfections, lifelike lighting, no text or watermark.', tags: ['自然', '紀實'] },
  ...PORTRAIT_SCENE_PRESETS,
  ...PORTRAIT_POSE_PRESETS,
  ...BASIC_SCENE_PAIRS.flatMap(row=>row.pose ? [row.pose] : []),
  ...PORTRAIT_ACTION_PRESETS,
];

export function normalizePresetImport(input) {
  if (!Array.isArray(input) && input?.version !== undefined && input.version !== 1) throw new Error('目前只支援 version: 1 的提詞庫。');
  const rows = Array.isArray(input) ? input : input?.presets;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('JSON 必須是提詞陣列，或包含 presets 陣列。');
  if (rows.length > 10000) throw new Error('每次最多匯入 10,000 個提詞。');
  const ids = new Set();
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object' || !Object.hasOwn(CATEGORIES, row.category)) throw new Error(`第 ${index + 1} 筆的 category 必須是 ${Object.keys(CATEGORIES).join('、')}。`);
    if (typeof row.name !== 'string' || !row.name.trim() || (row.category !== 'camera' && (typeof row.prompt !== 'string' || !row.prompt.trim()))) throw new Error(`第 ${index + 1} 筆必須有 name 與 prompt。`);
    if(row.category === 'camera' && row.angle) normalizeCameraAngle(row.angle);
    if(row.category === 'camera' && row.prompt !== undefined && typeof row.prompt !== 'string') throw new Error(`第 ${index + 1} 筆的 prompt 須為文字。`);
    if(row.category === 'camera' && row.prompt === undefined) row = {...row,prompt:cameraPrompt(row.angle || cameraPreset(row).angle)};
    if (row.name.length > 200 || row.prompt.length > 20000) throw new Error(`第 ${index + 1} 筆內容過長。`);
    if (row.tags !== undefined && (!Array.isArray(row.tags) || row.tags.some(tag => typeof tag !== 'string'))) throw new Error(`第 ${index + 1} 筆的 tags 必須是文字陣列。`);
    if (row.reviewed !== undefined && typeof row.reviewed !== 'boolean') throw new Error(`第 ${index + 1} 筆的 reviewed 必須是勾選或取消勾選。`);
    if (row.id !== undefined && (typeof row.id !== 'string' || !/^[\w-]{1,120}$/.test(row.id))) throw new Error(`第 ${index + 1} 筆 id 請使用英數字、底線或連字號。`);
    const id = row.id || `import-${row.category}-${globalThis.crypto.randomUUID()}`;
    if (ids.has(id)) throw new Error(`匯入資料有重複 id：${id}`);
    ids.add(id);
    const preset = { id, category: row.category, name: row.name.trim(), prompt: row.prompt.trim(), tags: row.tags || [],...(row.reviewed===undefined ? {} : {reviewed:row.reviewed}) };
    return row.category === 'camera' ? cameraPreset({...preset,mappingVersion:CAMERA_MAPPING_VERSION,mappingSource:row.angle ? 'manual' : 'automatic',...(row.angle ? {angle:row.angle,mappingNote:''} : {})}) : preset;
  });
}

const LEGACY_REFERENCE_INSTRUCTION = 'Picture 1 is the character identity reference: preserve the same face, hairstyle and distinctive appearance. Picture 2 is the clothing reference: dress the character in this garment, preserving its cut, material, colors and fine design details.';
export const REFERENCE_INSTRUCTION = 'Dress the character from <image1> in the clothing from <image2>. Preserve the same face, hairstyle and distinctive appearance from <image1>, and the clothing\'s cut, material, colors and fine design details from <image2>.';

// Update only the previous generated reference instruction and its garment note.
// Other saved directions, including intentional free-form instructions, stay intact.
export function referenceOnlyPrompt(shot) {
  if (typeof shot.prompt !== 'string' || !shot.prompt.includes(LEGACY_REFERENCE_INSTRUCTION)) return shot.prompt;
  let prompt = shot.prompt.replace(LEGACY_REFERENCE_INSTRUCTION,REFERENCE_INSTRUCTION);
  const note = typeof shot.garment?.description === 'string' ? shot.garment.description.trim() : '';
  if (note) prompt = prompt.replace(`\n\nClothing: ${note}`,'');
  return prompt;
}

export function composePrompt({ character, garment, characterPromptSettings, characterMeasurementsPrompt, pose, expression, clothingState, interaction, camera, lighting, color, quality, sceneInteraction = '', extra = '', cameraMode }) {
  const interactionPrompt = [interaction?.prompt?.trim(),sceneInteraction.trim()].filter(Boolean).join(' ');
  const paragraphs = [
    SINGLE_SUBJECT_PROMPT,
    garmentInstruction(garment,REFERENCE_INSTRUCTION),
    character?.description?.trim() && `Character details: ${character.description.trim()}`,
    characterMeasurementsPrompt ?? characterProfilePrompt(character,characterPromptSettings),
    interactionPrompt && `Scene: ${interactionPrompt}`,
    pose?.prompt && `Pose: ${pose.prompt}`,
    expression?.prompt?.trim() && `Facial expression: ${expression.prompt.trim()}`,
    clothingState?.prompt?.trim() && `Clothing state: ${clothingState.prompt.trim()}`,
    cameraMode !== 'multiangle' && camera?.prompt && `Camera and composition: ${camera.prompt}`,
    lighting?.prompt && `Lighting: ${lighting.prompt}`,
    color?.prompt && `Color treatment: ${color.prompt}`,
    quality?.prompt && `Photographic quality: ${quality.prompt}`,
    extra?.trim(),
  ];
  return paragraphs.filter(Boolean).join('\n\n');
}

export function buildShotPlans(state, draft) {
  const {mode,pools,copies,count,combinationCount} = getShotRecipe(state,draft);
  if (mode === 'combinations' && (!Number.isInteger(copies) || copies < 1 || copies > 10)) throw new Error('每組張數須為 1–10。');
  if (mode === 'random' && (!Number.isInteger(count) || count < 1 || count > 100)) throw new Error('隨機張數須為 1–100。');
  if (count > 100) throw new Error('每批最多 100 張，請減少候選組合，或改用隨機寫真指定張數。');
  const labels = {character:'角色',garment:'服裝',pose:'動作',camera:'攝影角度',lighting:'光線',color:'色彩',quality:'畫質',expression:'表情',clothingState:'服裝狀態',interaction:'場景'};
  for (const [key,pool] of Object.entries(pools)) if (!pool.length) throw new Error(`請至少選擇一個${labels[key]}候選，或在隨機模式使用全部圖庫與提詞。`);
  const resolution = Number(draft.resolution ?? 1536);
  const steps = Number(draft.steps ?? 40);
  const seed = Number(draft.seed ?? -1);
  if (![1024,1536,2048].includes(resolution)) throw new Error('參考解析度須為 1024、1536 或 2048。');
  const aspectRatio = draft.aspectRatio ?? 'reference';
  const outputSize = getOutputSize(aspectRatio,resolution);
  if (!Number.isInteger(steps) || steps < 1 || steps > 100) throw new Error('採樣步數須為 1–100。');
  if (!Number.isSafeInteger(seed) || seed < -1 || seed > 2 ** 48 - 100) throw new Error('Seed 須為 -1 或有效的正整數。');
  if (draft.extra !== undefined && (typeof draft.extra !== 'string' || draft.extra.length > 20000)) throw new Error('補充描述最多 20,000 字。');
  if (draft.sceneInteraction !== undefined && (typeof draft.sceneInteraction !== 'string' || draft.sceneInteraction.length > 20000)) throw new Error('場景補充最多 20,000 字。');
  if (draft.negative !== undefined && (typeof draft.negative !== 'string' || draft.negative.length > 20000)) throw new Error('負面提詞最多 20,000 字。');
  const plans = [];
  const cameraMode = draft.cameraMode ?? 'prompt';
  if(!['prompt','multiangle'].includes(cameraMode)) throw new Error('相機模式無效。');
  const angleSteps = Number(draft.angleSteps ?? 20),refineDenoise = Number(draft.refineDenoise ?? 0.2);
  if(cameraMode === 'multiangle' && draft.cameraEnabled !== false && (!Number.isInteger(angleSteps) || angleSteps < 1 || angleSteps > 100 || !Number.isFinite(refineDenoise) || refineDenoise < 0.05 || refineDenoise > 0.4)) throw new Error('換角度步數須為 1–100，高清修正強度須為 0.05–0.4。');
  const entries = Object.entries(pools);
  const append = index => {
    const selection = {};
    // Decode a mixed-radix index; large candidate libraries are never expanded.
    for (let i = entries.length - 1; i >= 0; i--) {
      const [key,pool] = entries[i],length = BigInt(pool.length);
      selection[key] = pool[Number(index % length)];index /= length;
    }
    const details = [selection.expression,selection.clothingState,selection.interaction].filter(Boolean);
    const variedStyles = ['camera','lighting','color','quality'].filter(key => pools[key].length > 1).map(key => selection[key]);
    const characterMeasurementsPrompt=characterProfilePrompt(selection.character,state.settings?.characterPrompts);
    plans.push({
      id:globalThis.crypto.randomUUID(),name:[...(pools.character.length>1 ? [selection.character.name] : []),selection.garment.name,selection.pose.name,...details.map(row => row.name),...variedStyles.map(row => row.name),...(mode === 'random' ? [`${plans.length + 1}`] : copies > 1 ? [plans.length % copies + 1] : [])].join(' · '),
      ...structuredClone(selection),
      characterMeasurementsPrompt,
      prompt:composePrompt({...selection,characterMeasurementsPrompt,sceneInteraction:draft.sceneInteraction,extra:draft.extra,cameraMode}),
      ...(cameraMode === 'multiangle' ? {cameraMode,cameraEnabled:draft.cameraEnabled !== false,executionMode:'staged',angleSteps,refineSteps:REFINE_STEPS,refineDenoise,camera:cameraPreset(structuredClone(selection.camera))} : {}),
      sceneInteraction:draft.sceneInteraction?.trim() || '',negative:withSingleSubjectNegative(draft.negative),resolution,steps,
      seed:seed === -1 ? Math.floor(Math.random() * 2 ** 48) : seed + plans.length,aspectRatio,
      ...(mode === 'random' ? {generationMode:'random'} : {}),
      ...(outputSize ? {outputWidth:outputSize.width,outputHeight:outputSize.height} : {}),
    });
  };
  if (mode === 'combinations') {
    for (let index = 0n; index < combinationCount; index++) for (let copy = 0; copy < copies; copy++) append(index);
  } else {
    let rngState = seed === -1 ? Math.floor(Math.random() * 2 ** 32) : (seed % 2 ** 32) ^ Math.floor(seed / 2 ** 32);
    const randomWord = () => {
      rngState = (rngState + 0x6D2B79F5) | 0;
      let value = Math.imul(rngState ^ rngState >>> 15,rngState | 1);
      value ^= value + Math.imul(value ^ value >>> 7,value | 61);
      return (value ^ value >>> 14) >>> 0;
    };
    const below = limit => {
      const bits = limit.toString(2).length,words = Math.ceil(bits / 32),mask = (1n << BigInt(bits)) - 1n;
      let value;
      do {value = 0n;for(let i = 0; i < words; i++) value = (value << 32n) | BigInt(randomWord());value &= mask;} while(value >= limit);
      return value;
    };
    // Sparse Fisher-Yates: one unique combination per draw until the pool is exhausted.
    let remaining = combinationCount;
    const swaps = new Map();
    for (let i = 0; i < count; i++) {
      if (!remaining) {remaining = combinationCount;swaps.clear();}
      const position = below(remaining),index = swaps.get(position) ?? position,last = remaining - 1n;
      if(position !== last) swaps.set(position,swaps.get(last) ?? last);
      swaps.delete(last);remaining--;append(index);
    }
  }
  return plans;
}
