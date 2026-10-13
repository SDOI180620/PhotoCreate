export const BODY_POSING_VERSION = 2;

const BODY_POSITION = /\b(?:sit(?:s|ting)?|seated|squat(?:s|ting)?|crouch(?:es|ing)?|kneel(?:s|ing)?|lie(?:s)?|lying|reclin(?:es|ing|ed)?|lunge|lunges|lunging)\b|\bbend(?:ing|s)? (?:forward|down|at the waist|from the hips)|\b(?:torso|body) (?:is )?bent (?:forward|down)|坐著|坐姿|跪坐|跪著|蹲下|躺著|側躺|俯臥|仰躺|彎腰/i;
const STANDING_POSITION = /\b(?:stand(?:s|ing)?|upright stance|walking|mid-step)\b|站姿|站著|站立|自然站/i;
const RAILING_CONTACT = /欄杆|栏杆|扶欄|扶栏|扶杆|倚欄|railing|\brail\b/i;
const POSITIONS = {
  railing:{name:'單腳微彎倚欄',tag:'站姿',prompt:'Standing beside a sturdy waist-high railing, place most weight on one supporting leg and bend the other knee slightly, with that foot resting lightly a short step forward. Lean gently toward the rail with a relaxed angled torso and natural hand or forearm contact. Keep both feet on the walkway and the hips at normal standing height, well above the knees.'},
  seated:{name:'坐著',tag:'坐姿',prompt:'Sitting on a stable low seat with the hips fully supported, both knees clearly bent and both feet resting on the ground. The torso turns slightly sideways.'},
  straightLegs:{name:'坐地伸腿',tag:'坐姿',prompt:'Sitting on a flat padded surface with both hips supported and both legs extended straight forward along the surface. Lean the torso slightly forward from the hips.'},
  crossLegged:{name:'盤腿坐著',tag:'坐姿',prompt:'Sitting cross-legged on a flat padded surface with both hips supported, knees lowered to the sides and ankles loosely crossed. Incline the torso slightly forward.'},
  kneeling:{name:'跪坐',tag:'跪坐',prompt:'Kneeling with the hips resting on the heels, both knees bent and both shins fully supported by a flat padded surface. The torso angles gently forward.'},
  crouched:{name:'蹲下',tag:'蹲姿',prompt:'Crouching low with both knees deeply bent, hips lowered close to the heels and both feet firmly supported by the ground. Incline the torso forward to balance the lowered body.'},
  lying:{name:'仰躺',tag:'仰躺',prompt:'Lying on the back on a flat padded surface with the head, shoulders and hips supported. Bend one knee with that foot on the surface while the other leg extends along it.'},
  bent:{name:'彎腰',tag:'彎腰',prompt:'Bending forward from the hips until the torso forms a clear diagonal toward the supporting surface, with both knees visibly bent and the hips shifted backward. Keep both feet firmly planted.'},
};

export const hasBodyPosition = prompt => typeof prompt==='string' && (BODY_POSITION.test(prompt)
  || (STANDING_POSITION.test(prompt) && RAILING_CONTACT.test(prompt) && /\b(?:one|other|opposite) (?:knee|leg)\b/i.test(prompt)));

// Preserve the requested gesture and prop while supplying its missing body pose.
export function withBodyPosition(row) {
  if(row?.category!=='pose' || typeof row.prompt!=='string' || hasBodyPosition(row.prompt)) return row;
  const text=`${row.name} ${row.prompt} ${(row.tags || []).join(' ')}`;
  const railing=RAILING_CONTACT.test(text);
  const standing=!railing && STANDING_POSITION.test(row.prompt);
  let position=railing ? POSITIONS.railing
    : standing ? POSITIONS.seated
    : /愛心|比心|heart/i.test(text) ? POSITIONS.crossLegged
    : /香蕉|banana/i.test(text) ? POSITIONS.kneeling
    : /熊|娃娃|plush|teddy/i.test(text) ? POSITIONS.lying
    : /床|床單|bed|sheet/i.test(text) ? POSITIONS.lying
    : /頭髮|髮|束髮|hair|neck|arms? raised/i.test(text) ? POSITIONS.kneeling
    : /蹲|squat|crouch/i.test(row.name) ? POSITIONS.crouched
    : POSITIONS.straightLegs;
  const gesture=standing ? row.prompt
    .replace(/\bstanding(?: naturally| comfortably| upright)?\b/gi,'sitting')
    .replace(/\bstands?\b/gi,'sits')
    .replace(/\bwalking\b/gi,'sitting')
    .replace(/\bmid-step\b/gi,'seated') : row.prompt;
  const name=standing && /站姿|站著|站立|自然站/.test(row.name)
    ? row.name.replace(/站姿|站著|站立|自然站/g,'坐姿')
    : `${position.name}${row.name}`;
  return {...row,name,prompt:`${position.prompt}\n${gesture}`,tags:[...new Set([...(row.tags || []).filter(tag=>!['站姿','漫步','走路'].includes(tag)),position.tag])]};
}
