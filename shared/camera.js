import {withSingleSubjectPrompt,withSingleSubjectNegative} from './subject.js';

export const DEFAULT_CAMERA_ANGLE = {horizontalAngle:0,verticalAngle:0,zoom:5};
export const CAMERA_FRAMING_VERSION = 3;
export const CAMERA_MAPPING_VERSION = 3;
export const CAMERA_MIN_VERTICAL = -70;
export const REFINE_STEPS = 20;
export const ORIGINAL_CAMERA = {id:'camera-original',category:'camera',name:'保留原圖鏡頭',angle:DEFAULT_CAMERA_ANGLE,prompt:'',tags:[]};
export const CAMERA_HORIZONTAL = [[0,'正面'],[45,'右前方'],[90,'右側'],[135,'右後方'],[180,'背面'],[225,'左後方'],[270,'左側'],[315,'左前方']];
export const CAMERA_VERTICAL = [[CAMERA_MIN_VERTICAL,'極低角度仰拍（試驗）'],[-60,'強烈仰拍（試驗）'],[-30,'仰拍'],[0,'平視'],[30,'高角度'],[60,'俯拍']];
const ZOOM_LEVELS = [
  {max:2,value:1,label:'遠景（1–2）',tag:'wide shot',prompt:'Distant environmental framing. Move the camera far away. Show the entire person from head to feet, small within the frame, with generous surroundings visible.'},
  {max:4,value:3,label:'全身（3–4）',tag:'wide shot',prompt:'Full-body framing. Show the entire person from head to feet, filling most of the frame, with a little space around the person.'},
  {max:6,value:5,label:'正常取景（5–6）',tag:'medium shot',prompt:'Normal-distance framing. Show the person in a natural medium photograph, with the torso and immediate surroundings visible. Keep a balanced composition.'},
  {max:8,value:7,label:'半身（7–8）',tag:'close-up',prompt:'Half-body framing. Move the camera closer. Frame the person from the top of the head to the waist. The head and upper body fill the frame, with the lower body outside the frame.'},
  {max:10,value:9,label:'局部大特寫（9–10）',tag:'close-up',prompt:'Extreme close-up. Move the camera right up to the part of the person and clothing at the center of the reference photograph. Fill the entire frame with this small local detail, showing fine skin and fabric texture. The whole head, whole body and most of the room are outside the frame. Photograph the corresponding area from the requested viewing direction.'},
];
export const CAMERA_ZOOM = ZOOM_LEVELS.map(({value,label})=>[value,label]);
export const REFINE_PROMPT = withSingleSubjectPrompt('Restore only sharpness and fine photographic detail in <image1>. Preserve exactly the same person, face, hairstyle, expression, pose, clothing, clothing state, objects, environment, camera viewpoint, framing, lighting and colors. Do not add, remove, replace or redesign anything. Do not change the composition.');
export const REFINE_NEGATIVE = withSingleSubjectNegative('added objects, changed identity, changed pose, changed clothing, changed background, changed composition, text, watermark');

export function normalizeCameraAngle(value) {
  if(!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('相機角度格式不正確。');
  const {horizontalAngle,verticalAngle,zoom} = value;
  if(!Number.isInteger(horizontalAngle) || horizontalAngle < 0 || horizontalAngle > 360) throw new Error('水平角度須為 0–360 的整數。');
  if(!Number.isInteger(verticalAngle) || verticalAngle < -90 || verticalAngle > 60) throw new Error('俯仰角度須為 -90–60 的整數。');
  if(typeof zoom !== 'number' || !Number.isFinite(zoom) || zoom < 0 || zoom > 10) throw new Error('Zoom 須為 0–10。');
  return {horizontalAngle,verticalAngle,zoom:Math.round(zoom * 10) / 10};
}

// Historical jobs and imported presets may still contain -90°. Clamp only
// when loading a camera into the controls, so the shown and submitted values agree.
export function cameraControlAngle(value) {
  const angle = normalizeCameraAngle(value);
  return {...angle,verticalAngle:Math.max(CAMERA_MIN_VERTICAL,angle.verticalAngle)};
}

export function cameraAngleLabel(angle) {
  const value = normalizeCameraAngle(angle);
  return `水平 ${value.horizontalAngle}° · 俯仰 ${value.verticalAngle}° · Zoom ${value.zoom.toFixed(1)}`;
}

export function cameraZoomLevel(angle) {
  const {zoom}=normalizeCameraAngle(angle);
  return ZOOM_LEVELS.find(level=>zoom<=level.max);
}

export function cameraPrompt(angle) {
  const {horizontalAngle,verticalAngle} = normalizeCameraAngle(angle);
  const directions = ['front view','front-right quarter view','right side view','back-right quarter view','back view','back-left quarter view','left side view','front-left quarter view'];
  const directionIndex = Math.floor(((horizontalAngle % 360) + 22.5) / 45) % 8;
  const direction = directions[directionIndex];
  const height = verticalAngle < -15 ? 'low-angle shot' : verticalAngle < 15 ? 'eye-level shot' : verticalAngle < 45 ? 'elevated shot' : 'high-angle shot';
  const framing = cameraZoomLevel(angle);
  let prompt = `<sks> ${direction} ${height} ${framing.tag}\n${framing.prompt}`;
  if(directionIndex===2 || directionIndex===6) {
    const side=directionIndex===2 ? 'right' : 'left';
    const target=framing.max<10 ? 'the head and upper body' : 'the corresponding local detail';
    const position=verticalAngle>0
      ? `above ${target}, looking downward at ${verticalAngle} degrees. Show the ${side} side from above, with visible top surfaces and downward foreshortening`
      : verticalAngle<0
        ? `below ${target}, looking upward at ${Math.abs(verticalAngle)} degrees. Show the ${side} side from below, with upward perspective and foreshortening`
        : `level with ${target}. Show ${framing.max<10 ? `the ${side} profile and side surfaces` : `only the ${side}-facing surfaces of the same local detail at the center of the reference photograph. Keep the framing on that same body and clothing region`}`;
    prompt += `\nPlace the camera at the person's ${side} side and ${position}. Keep both the side direction and the requested elevation in the same view. The person keeps facing the original direction while the camera moves around them.`;
  }
  // Match the extensions in this installation's QwenMultiangleCameraNode.
  if(verticalAngle < -75) prompt += `. Worm's-eye view, camera underneath the subject, ${verticalAngle===-90 ? 'looking vertically straight up' : 'looking steeply upward'}. Camera elevation ${verticalAngle} degrees. Show the underside from below with strong upward foreshortening.`;
  else if(verticalAngle < -45) prompt += `. Extreme low-angle view, ${framing.max===10 ? 'camera immediately below the same small local clothing detail' : 'camera far below the subject'}, looking steeply upward. Camera elevation ${verticalAngle} degrees. Strong upward perspective and foreshortening.`;
  // The native LoRA tags group angles into broad bins. Include the requested
  // coordinates in the text encoder too; metadata alone cannot guide the model.
  const elevationTarget=framing.max===10 ? 'the level of the same small local detail' : 'eye level';
  const elevation=verticalAngle===0 ? `at ${elevationTarget}` : `${Math.abs(verticalAngle)} degrees ${verticalAngle>0 ? 'above' : 'below'} ${elevationTarget}`;
  const coordinates=`${prompt}\nRequested camera azimuth: ${horizontalAngle} degrees, ${direction}. Requested camera elevation: ${verticalAngle} degrees, ${elevation}. Keep the same person, pose, clothing and environment. Keep the person stationary, facing the original direction. Move only the camera around the person and change its distance. Keep the camera upright with no roll.`;
  return framing.max===10 ? `${withSingleSubjectPrompt(coordinates)}\nKeep the center of that local detail at the center of the frame as the camera moves. The small clothing detail still fills all four edges of the frame at the requested angle.` : coordinates;
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
function mappedZoom(preset,zoom) {
  const name = `${preset.id || ''} ${preset.name || ''}`;
  if(/大特寫|微距|extreme-closeup|macro|nipple-closeup/.test(name)) return Math.max(9,zoom);
  if(/半身|half-body|half-crop|side-half/.test(name)) return 8;
  if(/全身|camera-full/.test(name) && !/遠景|wide/.test(name)) return 3;
  return zoom >= 9 ? 8 : zoom;
}
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
  return {...legacy,angle:{horizontalAngle:numbers[0],verticalAngle:numbers[1],zoom:mappedZoom(preset,numbers[2])}};
}
export function upgradeCameraMapping(preset) {
  if(preset.mappingVersion >= CAMERA_MAPPING_VERSION) return cameraPreset(preset);
  if(preset.mappingVersion === 2 && preset.angle) {
    const angle = normalizeCameraAngle(preset.angle);
    const automatic = preset.mappingSource === 'automatic';
    return {...preset,angle:{...angle,zoom:automatic ? mappedZoom(preset,angle.zoom) : angle.zoom},mappingVersion:CAMERA_MAPPING_VERSION,mappingSource:automatic ? 'automatic' : 'manual'};
  }
  const legacy = inferLegacyCameraAngle(preset);
  const wasAutomatic = preset.mappingSource !== 'manual' && (!preset.angle || JSON.stringify(normalizeCameraAngle(preset.angle)) === JSON.stringify(legacy.angle));
  return wasAutomatic ? {...preset,...inferCameraAngle(preset),mappingVersion:CAMERA_MAPPING_VERSION,mappingSource:'automatic'} : {...preset,angle:normalizeCameraAngle(preset.angle),mappingVersion:CAMERA_MAPPING_VERSION,mappingSource:'manual'};
}
export function cameraPreset(preset) {
  return preset.angle ? {...preset,angle:normalizeCameraAngle(preset.angle)} : {...preset,...inferCameraAngle(preset)};
}
