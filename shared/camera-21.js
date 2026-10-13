// This dependency-free module is also shipped with the ComfyUI camera widget.
const DIRECTIONS = ['front view','front-right view','front-right quarter view','right side view','back-right quarter view','back-right view','back view','back-left view','back-left quarter view','left side view','front-left quarter view','front-left view'];
const FRAMINGS = [
  'Distant environmental framing. Move the camera far away. Show the entire person from head to feet, small within the frame, with generous surroundings visible.',
  'Full-body framing. Show the entire person from head to feet, filling most of the frame, with a little space around the person.',
  'Normal-distance framing. Show the person in a natural medium photograph, with the torso and immediate surroundings visible. Keep a balanced composition.',
  'Half-body framing. Move the camera closer. Frame the person from the top of the head to the waist. The head and upper body fill the frame, with the lower body outside the frame.',
  'Extreme close-up. Move the camera right up to the part of the person and clothing at the center of the reference photograph. Fill the entire frame with this small local detail, showing fine skin and fabric texture. The whole head, whole body and most of the room are outside the frame. Photograph the corresponding area from the requested viewing direction.',
];

export function cameraPrompt21({horizontalAngle,verticalAngle,zoom}) {
  const index = Math.floor(((horizontalAngle % 360) + 15) / 30) % 12;
  const direction = DIRECTIONS[index];
  // Negative elevations use the nearest trained tag plus explicit low-angle
  // instructions. These instructions extend the UI, not the LoRA's training.
  const height = verticalAngle < 15 ? 'eye-level shot' : verticalAngle < 45 ? 'elevated shot' : 'high-angle shot';
  const framing = Math.max(0,Math.ceil(zoom / 2) - 1);
  const local = framing === 4;
  let prompt = `<mva> ${direction}, ${height}${framing >= 3 ? ' close-up' : ''}\n${FRAMINGS[framing]}`;
  if(verticalAngle < 0) prompt += '\nLow-angle shot. Place the camera below the subject, looking upward. The requested negative elevation overrides the eye-level tag.';
  if(index === 3 || index === 9) {
    const side = index === 3 ? 'right' : 'left';
    const target = local ? 'the corresponding local detail' : 'the head and upper body';
    const position = verticalAngle > 0 ? `above ${target}, looking downward at ${verticalAngle} degrees` : verticalAngle < 0 ? `below ${target}, looking upward at ${Math.abs(verticalAngle)} degrees` : `level with ${target}`;
    prompt += `\nPlace the camera at the person's ${side} side and ${position}. Show the ${side}-facing surfaces from the requested elevation. Keep both the side direction and the requested elevation in the same view.`;
  }
  if(verticalAngle < -75) prompt += `\nWorm's-eye view, camera underneath the subject, ${verticalAngle === -90 ? 'looking vertically straight up' : 'looking steeply upward'}. Show the underside from below with strong upward foreshortening.`;
  else if(verticalAngle < -45) prompt += `\nExtreme low-angle view, ${local ? 'camera immediately below the same small local clothing detail' : 'camera far below the subject'}, looking steeply upward. Strong upward perspective and foreshortening.`;
  const target = local ? 'the level of the same small local detail' : 'eye level';
  const elevation = verticalAngle === 0 ? `at ${target}` : `${Math.abs(verticalAngle)} degrees ${verticalAngle > 0 ? 'above' : 'below'} ${target}`;
  prompt += `\nRequested camera azimuth: ${horizontalAngle} degrees, ${direction}. Requested camera elevation: ${verticalAngle} degrees, ${elevation}. Keep the same person, pose, clothing and environment. Keep the person stationary, facing the original direction. Move only the camera around the person and change its distance. Keep the camera upright with no roll.`;
  if(local) prompt += '\nKeep the center of that local detail at the center of the frame as the camera moves. The small clothing detail still fills all four edges of the frame at the requested angle.';
  return prompt;
}
