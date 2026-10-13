"""Qwen Image 2.1 grammar with PhotoCreate's existing angle and framing controls."""
import math

DIRECTIONS = ['front view', 'front-right view', 'front-right quarter view', 'right side view', 'back-right quarter view', 'back-right view', 'back view', 'back-left view', 'back-left quarter view', 'left side view', 'front-left quarter view', 'front-left view']
FRAMINGS = [
    'Distant environmental framing. Move the camera far away. Show the entire person from head to feet, small within the frame, with generous surroundings visible.',
    'Full-body framing. Show the entire person from head to feet, filling most of the frame, with a little space around the person.',
    'Normal-distance framing. Show the person in a natural medium photograph, with the torso and immediate surroundings visible. Keep a balanced composition.',
    'Half-body framing. Move the camera closer. Frame the person from the top of the head to the waist. The head and upper body fill the frame, with the lower body outside the frame.',
    'Extreme close-up. Move the camera right up to the part of the person and clothing at the center of the reference photograph. Fill the entire frame with this small local detail, showing fine skin and fabric texture. The whole head, whole body and most of the room are outside the frame. Photograph the corresponding area from the requested viewing direction.',
]


def camera_prompt_21(horizontal_angle, vertical_angle, zoom):
    index = int(((horizontal_angle % 360) + 15) // 30) % 12
    direction = DIRECTIONS[index]
    height = 'eye-level shot' if vertical_angle < 15 else 'elevated shot' if vertical_angle < 45 else 'high-angle shot'
    framing = max(0, math.ceil(zoom / 2) - 1)
    local = framing == 4
    prompt = f"<mva> {direction}, {height}" + (' close-up' if framing >= 3 else '') + '\n' + FRAMINGS[framing]
    if vertical_angle < 0:
        prompt += '\nLow-angle shot. Place the camera below the subject, looking upward. The requested negative elevation overrides the eye-level tag.'
    if index in (3, 9):
        side = 'right' if index == 3 else 'left'
        target = 'the corresponding local detail' if local else 'the head and upper body'
        position = f'above {target}, looking downward at {vertical_angle} degrees' if vertical_angle > 0 else f'below {target}, looking upward at {abs(vertical_angle)} degrees' if vertical_angle < 0 else f'level with {target}'
        prompt += f"\nPlace the camera at the person's {side} side and {position}. Show the {side}-facing surfaces from the requested elevation. Keep both the side direction and the requested elevation in the same view."
    if vertical_angle < -75:
        looking = 'looking vertically straight up' if vertical_angle == -90 else 'looking steeply upward'
        prompt += f"\nWorm's-eye view, camera underneath the subject, {looking}. Show the underside from below with strong upward foreshortening."
    elif vertical_angle < -45:
        position = 'camera immediately below the same small local clothing detail' if local else 'camera far below the subject'
        prompt += f'\nExtreme low-angle view, {position}, looking steeply upward. Strong upward perspective and foreshortening.'
    target = 'the level of the same small local detail' if local else 'eye level'
    position = 'above' if vertical_angle > 0 else 'below'
    elevation = f'at {target}' if vertical_angle == 0 else f'{abs(vertical_angle)} degrees {position} {target}'
    prompt += f'\nRequested camera azimuth: {horizontal_angle} degrees, {direction}. Requested camera elevation: {vertical_angle} degrees, {elevation}. Keep the same person, pose, clothing and environment. Keep the person stationary, facing the original direction. Move only the camera around the person and change its distance. Keep the camera upright with no roll.'
    if local:
        prompt += '\nKeep the center of that local detail at the center of the frame as the camera moves. The small clothing detail still fills all four edges of the frame at the requested angle.'
    return prompt
