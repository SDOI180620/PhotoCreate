export const NATURAL_GAZE_PROMPT = "Follow the action's gaze target; otherwise look naturally at a held object or an off-camera scene detail. Preserve head orientation and facial expression.";

const gaze=(slug,name,prompt,tags)=>({id:`gaze-${slug}`,category:'gaze',name,prompt,tags:['視線',...tags]});
const direction='This selected eye direction takes priority over incidental gaze cues in the pose or expression. Preserve the body pose, gesture and facial expression; use only a small, natural head adjustment if needed.';

export const GAZE_PRESETS=[
  gaze('natural','視線自然配合動作',NATURAL_GAZE_PROMPT,['自然','動作']),
  gaze('camera','看向鏡頭',`Direct the eyes toward the camera lens with natural eye alignment. ${direction}`,['鏡頭']),
  gaze('left','看向畫面左側',`Direct the eyes toward an off-camera point on the left side of the picture. ${direction}`,['側方','左側']),
  gaze('right','看向畫面右側',`Direct the eyes toward an off-camera point on the right side of the picture. ${direction}`,['側方','右側']),
  gaze('distant','望向遠方',`Direct the eyes toward a distant point in the surroundings, away from the camera lens, consistent with the head orientation. ${direction}`,['遠方']),
  gaze('down','微微垂眼',`Lower the eyes gently toward a nearby point below eye level, keeping the head comfortably aligned with the selected pose. ${direction}`,['垂眼','下方']),
  gaze('object','看向手中物件',`Direct the eyes toward the object already held or handled in the selected action. If there is no such object, attend to a nearby detail already present in the scene; keep the chosen gesture and existing props. ${direction}`,['物件','道具']),
];
