export const GARMENT_SOURCES_VERSION = 1;
export const isPromptGarment = garment => garment?.sourceType === 'prompt';

export function textClothingInstruction(value) {
  return `Replace the entire outfit shown in <image1> with the requested clothing. Use <image1> for the person's appearance; disregard its clothing when dressing the character. The requested outfit takes priority over the reference outfit.\nThe character should wear: ${value}`;
}

// Existing image descriptions remain library notes. Only an explicit prompt
// source contributes clothing text to new photographs.
export function garmentInstruction(garment, imageInstruction) {
  if (!isPromptGarment(garment)) return imageInstruction;
  const prompt = garment.prompt?.trim();
  if (!prompt) throw new Error('請輸入服裝提詞。');
  return textClothingInstruction(prompt);
}

export function garmentFields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('服裝資料格式不正確。');
  const text = (value,max,label) => {
    if (typeof value !== 'string' || value.length > max) throw new Error(`${label}格式不正確或過長。`);
    return value.trim();
  };
  const name = text(input.name,200,'服裝名稱');
  if (!name) throw new Error('請輸入服裝名稱。');
  const sourceType = input.sourceType ?? 'image';
  if (!['image','prompt'].includes(sourceType)) throw new Error('請選擇圖片版或提詞版服裝。');
  const prompt = text(input.prompt ?? '',20000,'服裝提詞');
  if (sourceType === 'prompt' && !prompt) throw new Error('請輸入服裝提詞。');
  const description = text(input.description ?? '',20000,'服裝備註');
  const tags = input.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 50 || tags.some(tag => typeof tag !== 'string' || tag.length > 100)) throw new Error('標籤格式不正確。');
  return {name,sourceType,prompt,description,tags:tags.map(tag=>tag.trim()).filter(Boolean)};
}
