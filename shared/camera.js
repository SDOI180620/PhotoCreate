export const DEFAULT_CAMERA_ANGLE = {horizontalAngle:0,verticalAngle:0,zoom:5};
export const CAMERA_HORIZONTAL = [[0,'正面'],[45,'右前方'],[90,'右側'],[135,'右後方'],[180,'背面'],[225,'左後方'],[270,'左側'],[315,'左前方']];
export const CAMERA_VERTICAL = [[-90,'正下方仰拍（試驗）'],[-60,'強烈仰拍（試驗）'],[-30,'仰拍'],[0,'平視'],[30,'高角度'],[60,'俯拍']];
export const CAMERA_ZOOM = [[0,'遠景'],[1,'全身'],[5,'中景'],[8,'特寫'],[9,'超特寫（試驗）'],[10,'極近細節（試驗）']];
export const REFINE_PROMPT = 'Restore only sharpness and fine photographic detail in <image1>. Preserve exactly the same person, face, hairstyle, expression, pose, clothing, clothing state, objects, environment, camera viewpoint, framing, lighting and colors. Do not add, remove, replace or redesign anything. Do not change the composition.';
export const REFINE_NEGATIVE = 'added objects, changed identity, changed pose, changed clothing, changed background, changed composition, text, watermark';

export function normalizeCameraAngle(value) {
  if(!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('相機角度格式不正確。');
  const {horizontalAngle,verticalAngle,zoom} = value;
  if(!Number.isInteger(horizontalAngle) || horizontalAngle < 0 || horizontalAngle > 360) throw new Error('水平角度須為 0–360 的整數。');
  if(!Number.isInteger(verticalAngle) || verticalAngle < -90 || verticalAngle > 60) throw new Error('俯仰角度須為 -90–60 的整數。');
  if(typeof zoom !== 'number' || !Number.isFinite(zoom) || zoom < 0 || zoom > 10) throw new Error('Zoom 須為 0–10。');
  return {horizontalAngle,verticalAngle,zoom:Math.round(zoom * 10) / 10};
}

export function cameraAngleLabel(angle) {
  const value = normalizeCameraAngle(angle);
  return `水平 ${value.horizontalAngle}° · 俯仰 ${value.verticalAngle}° · Zoom ${value.zoom.toFixed(1)}`;
}

export function cameraPrompt(angle) {
  const {horizontalAngle,verticalAngle,zoom} = normalizeCameraAngle(angle);
  const directions = ['front view','front-right quarter view','right side view','back-right quarter view','back view','back-left quarter view','left side view','front-left quarter view'];
  const direction = directions[Math.floor(((horizontalAngle % 360) + 22.5) / 45) % 8];
  const height = verticalAngle < -15 ? 'low-angle shot' : verticalAngle < 15 ? 'eye-level shot' : verticalAngle < 45 ? 'elevated shot' : 'high-angle shot';
  const distance = zoom < 2 ? 'wide shot' : zoom < 6 ? 'medium shot' : 'close-up';
  let prompt = `<sks> ${direction} ${height} ${distance}`;
  // Match the extensions in this installation's QwenMultiangleCameraNode.
  if(verticalAngle < -75) prompt += ". Worm's-eye view, camera directly underneath the subject, looking vertically straight up. Camera elevation -90 degrees. Show the underside from below with strong upward foreshortening.";
  else if(verticalAngle < -45) prompt += '. Extreme low-angle view, camera far below the subject, looking steeply upward. Camera elevation -60 degrees. Strong upward perspective and foreshortening.';
  if(zoom >= 9.5) prompt += "\nMacro close-up: camera extremely close to the subject's main focal detail. Fill the entire frame with a small part of the subject, showing fine surface details and texture. The full subject is outside the frame.";
  else if(zoom >= 9) prompt += '\nExtreme close-up: tightly frame the face or main focal detail of the subject. The subject fills nearly the entire frame, with most of the surrounding background outside the frame.';
  return prompt;
}

export function inferLegacyCameraAngle(preset) {
  const name = `${preset.id || ''} ${preset.name || ''}`;
  let horizontalAngle = /three-quarter-back|side-breast|側後|側乳/.test(name) ? 135 : /back|背|臀|屁股|回眸/.test(name) ? 180 : /side|側|龐|旁/.test(name) ? 90 : 0;
  if(/shoulder-closeup|回眸/.test(name)) horizontalAngle = 135;
  const verticalAngle = /overhead|俯視全身/.test(name) ? 60 : /high-angle|neckline|collarbone-down|俯視|高角度|往下/.test(name) ? 45 : /由屁股往上/.test(name) ? -60 : /low|upskirt|underbust|waterline|仰|下往上|往上/.test(name) ? -30 : 0;
  const zoom = /macro|貼胸微距|nipple-closeup/.test(name) ? 10 : /extreme|大特寫|lips-closeup|armpit|ankle|hair-strand/.test(name) ? 9 : /closeup|breast|chest|bust|neckline|collarbone|thigh-root|curve|waist|underbust|特寫|胸部去看/.test(name) ? 8 : /wide|full|全身/.test(name) ? 1 : 5;
  const mappingNote = /mirror|backlit|dutch|鏡|逆光|斜/.test(name)
    ? '此名稱含鏡面、光線或畫面傾斜效果，三個角度參數無法完整表達，請確認鏡位。'
    : /胸|乳|腿|腳|踝|臀|腋|頸|腰|鎖骨|髮絲|唇|床尾|屁股|hip|thigh|ankle|armpit|neck|waist|bust|breast|chest|lips|hair/.test(name)
      ? '已換成接近的方向與距離；特定身體部位的取景中心仍由模型判斷，可拖球調整。'
      : '';
  return {angle:{horizontalAngle,verticalAngle,zoom},mappingNote};
}

const DESIGNED_ANGLES = {
  'camera-full':[12,10,1], 'camera-portrait':[15,15,5], 'camera-low':[18,-35,5],
  'camera-overhead':[12,60,1], 'camera-high-angle':[18,48,5],
  'camera-side-half':[90,0,5], 'camera-shoulder-closeup':[133,31,10],
  'camera-chest-closeup':[12,32,9], 'camera-upskirt':[18,-60,5],
  'camera-back-curve':[180,15,8], 'camera-recline-side':[95,8,5],
  'camera-thigh-closeup':[25,35,9], 'camera-face-closeup':[15,12,9],
  'camera-foot-of-bed':[12,-18,5], 'camera-mirror':[35,10,5],
  'camera-backlit':[165,12,5], 'camera-waterline':[20,-35,5],
  'camera-neckline':[12,48,9], 'camera-three-quarter-back':[135,18,5],
  'camera-low-side':[90,-40,5], 'camera-pov':[10,35,5],
  'camera-half-body-front':[0,0,5], 'camera-full-side':[90,0,1],
  'camera-nipple-closeup':[15,35,10], 'camera-half-chest':[18,30,9],
  'camera-cleavage-closeup':[12,38,10], 'camera-collarbone-closeup':[18,40,9],
  'camera-side-breast':[70,28,9], 'camera-underbust':[18,-45,9],
  'camera-shoulder-neck':[40,28,9], 'camera-lips-closeup':[20,12,10],
  'camera-side-neck':[80,22,9], 'camera-armpit':[65,-35,9],
  'camera-side-waist':[75,18,8], 'camera-hip-curve':[180,22,9],
  'camera-thigh-root':[28,38,9], 'camera-ankle':[30,-20,9],
  'camera-hair-strand':[55,28,10], 'camera-upper-breast':[15,42,9],
  'camera-three-quarter-breast':[55,30,9], 'camera-macro-chest':[12,35,10],
  'camera-low-hug-chest':[15,-55,9], 'camera-collarbone-down':[18,50,9],
  'camera-half-crop':[15,12,5], 'camera-extreme-closeup':[20,25,9],
  'camera-dutch-angle':[25,35,10], 'camera-wide-full':[15,10,1],
  'camera-bust-line':[18,35,9],
};
export function inferCameraAngle(preset) {
  const legacy = inferLegacyCameraAngle(preset);
  const name = preset.name || '';
  let numbers = DESIGNED_ANGLES[preset.id];
  if(/肩後|肩膀後|回眸/.test(name)) numbers = [133,31,10];
  else if(/正背|正後|背後|背面/.test(name)) numbers = [180,18,legacy.angle.zoom];
  else if(/由屁股往上/.test(name)) numbers = [180,-60,8];
  else if(/正面從下往上/.test(name)) numbers = [12,-50,5];
  else if(/龐往胸|旁往胸/.test(name)) numbers = [70,32,9];
  if(!numbers) {
    const angle = legacy.angle;
    if(/胸|乳|鎖骨/.test(name)) numbers = [angle.horizontalAngle === 0 ? 15 : angle.horizontalAngle,angle.verticalAngle < 0 ? -45 : 35,Math.max(9,angle.zoom)];
    else if(/特寫|微距/.test(name)) numbers = [angle.horizontalAngle === 0 ? 20 : angle.horizontalAngle,angle.verticalAngle === 0 ? 22 : angle.verticalAngle,angle.zoom];
    else numbers = [angle.horizontalAngle,angle.verticalAngle,angle.zoom];
  }
  return {...legacy,angle:{horizontalAngle:numbers[0],verticalAngle:numbers[1],zoom:numbers[2]}};
}
export function upgradeCameraMapping(preset) {
  if(preset.mappingVersion === 2) return cameraPreset(preset);
  const legacy = inferLegacyCameraAngle(preset);
  const wasAutomatic = !preset.angle || JSON.stringify(normalizeCameraAngle(preset.angle)) === JSON.stringify(legacy.angle);
  return wasAutomatic ? {...preset,...inferCameraAngle(preset),mappingVersion:2,mappingSource:'automatic'} : {...preset,angle:normalizeCameraAngle(preset.angle),mappingVersion:2,mappingSource:'manual'};
}
export function cameraPreset(preset) {
  return preset.angle ? {...preset,angle:normalizeCameraAngle(preset.angle)} : {...preset,...inferCameraAngle(preset)};
}
