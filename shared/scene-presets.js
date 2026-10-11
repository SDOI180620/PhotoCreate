const pose=(slug,name,prompt,tags)=>({id:`pose-scene-${slug}`,category:'pose',name,prompt,tags});
const deskLean=pose('desk-lean','自然倚桌','Leaning lightly against the edge of a desk with balanced weight, relaxed shoulders and hands resting naturally.',['倚靠','桌子']);
const setting=(slug,name,prompt,tags,action=null)=>({scene:{id:`interaction-${slug}`,category:'interaction',name,prompt,tags},pose:action});

// Earlier imported presets are upgraded only when the existing text matches.
export const SCENE_DESCRIPTION_PAIRS=[
  setting('bed','室內床鋪','A bedroom with a neatly made bed, layered bedding, pillows and a visible mattress. Simple bedside furniture and an uncluttered floor complete the room.',['床','室內']),
  setting('window','室內窗邊','A room beside a broad window with a deep windowsill, a clear window frame and simple curtains. The exterior view adds depth beyond the interior wall.',['窗戶','室內'],
    pose('window-rest','輕扶窗台','Standing beside a window with one hand gently resting on the windowsill, relaxed shoulders and a balanced stance.',['站姿','窗台'])),
  setting('railing','欄杆旁','A level walkway bordered by a sturdy railing with a smooth top rail. The receding walkway and open background beyond the rail establish clear spatial depth.',['欄杆','步道'],
    pose('railing-rest','手臂輕扶欄杆','Standing beside a railing with one hand and forearm gently supported on the top rail, relaxed shoulders and both feet grounded.',['站姿','扶欄'])),
  setting('pool','泳池畔','A swimming pool with clear water, a broad dry poolside edge and surrounding paving. Reflections ripple across the water beneath an open outdoor background.',['泳池','水邊'],
    pose('pool-edge-seat','池邊坐姿垂足','Sitting upright on a pool edge with both feet resting in the shallow water, hands lightly supported beside the hips and relaxed shoulders.',['坐姿','池邊'])),
  setting('classroom','教室課桌','An afternoon classroom with rows of school desks and chairs. Windows, a plain board and orderly aisles create depth through the quiet interior.',['教室','課桌'],deskLean),
  setting('nurse','保健室','A quiet medical rest room with a cot covered in crisp white sheets. Soft curtains, a medical cabinet and a clear floor define the simple interior.',['保健室','白色床單'],
    pose('cot-rest','休息床上平躺','Lying comfortably on a cot with the head supported by a pillow, shoulders relaxed and arms resting naturally beside the torso.',['躺姿','休息床'])),
  setting('onsen','溫泉','A hot spring with clear mineral water, natural stone edges and light steam above the surface. Rocks and garden plants frame the tranquil bathing area.',['溫泉','蒸汽'],
    pose('spa-seat','溫泉池內坐姿','Sitting upright on a submerged spa bench with relaxed shoulders and hands resting naturally on a stone ledge. Keep a comfortable balanced posture.',['坐姿','溫泉'])),
  setting('balcony','黃昏陽台','A balcony at dusk with a level floor, simple railings and an open view toward distant city lights. A quiet evening sky extends above the skyline.',['陽台','黃昏']),
  setting('changing-room','更衣室','A changing room with hanging clothes, storage hooks and a wide mirror. A small bench and uncluttered floor complete the softly lit enclosed interior.',['更衣室','衣物'],
    pose('relaxed-standing','放鬆自然站姿','Standing naturally with relaxed shoulders, balanced weight through both feet and hands resting gently by the sides.',['站姿','自然'])),
  setting('rooftop','屋頂露臺','A rooftop terrace with level paving, a low boundary wall and an open view of the city skyline. Broad open sky stretches above distant buildings.',['屋頂','天際線']),
  setting('sofa','客廳沙發','A living room with a soft sofa, layered cushions and visible upholstered seat textures. Simple furnishings and clear floor space surround the seating area.',['沙發','客廳'],
    pose('sofa-seat','沙發舒展坐姿','Sitting comfortably against sofa cushions with relaxed shoulders and arms resting naturally beside the torso. Keep realistic seated weight and cushion compression.',['坐姿','沙發'])),
  setting('bathroom','浴室','A bathroom with tiled walls, a wide mirror and a simple washbasin. Light mist hangs above the floor, with small water droplets on the nearby glass.',['浴室','水氣']),
  setting('tatami','和室榻榻米','A traditional room with woven tatami mats, wooden trim and shoji screens. Warm natural daylight passes through the paper panels onto the uncluttered floor.',['榻榻米','和室'],
    pose('tatami-rest','榻榻米側臥休息','Reclining comfortably on tatami mats with the torso supported by one forearm and relaxed legs. Keep natural contact with the floor.',['躺姿','榻榻米'])),
  setting('car-seat','車內後座','A car interior with a broad upholstered back seat, visible headrests and side windows. Sunlight enters through the glass, with the exterior view beyond the cabin.',['車內','後座'],
    pose('back-seat-rest','後座放鬆倚坐','Sitting comfortably against a back-seat cushion with relaxed shoulders, both feet supported and hands resting naturally on the lap.',['坐姿','後座'])),
  setting('beach','沙灘海岸','A sandy beach with damp sand near the shoreline, small waves and a broad ocean horizon. Reflections across the water create depth beneath an open sky.',['沙灘','海邊']),
  setting('bamboo','竹林','A dense bamboo grove with upright green stalks, layered leaves and a narrow earthy path. Dappled daylight filters through the overhead foliage.',['竹林','綠意']),
  setting('shrine','神社庭院','A shrine courtyard with vermilion torii gates, stone lanterns and a level paved approach. Quiet garden plants and timber structures extend beyond the gateways.',['神社','鳥居']),
  setting('cafe','窗邊咖啡廳','A cafe table beside a large window, with chairs, ceramic cups and a simple tabletop setting. Warm afternoon daylight reaches the softly layered interior.',['咖啡廳','窗邊']),
  setting('office','夜晚辦公室','An office after hours with a broad desk, a chair and orderly furnishings. City lights beyond the window create depth in the quiet night-time interior.',['辦公室','夜晚'],deskLean),
  setting('fitting-room','試衣間','A fitting room with a large mirror, clothing hooks and a small padded bench. Warm enclosed lighting reveals the fabric curtain and clear floor space.',['試衣間','衣物'],
    pose('hold-clothes','雙手拿衣物','Standing comfortably and holding a folded garment in both hands at waist height, with relaxed elbows and natural finger contact on the fabric.',['站姿','拿衣物'])),
  setting('staircase','樓梯間','An interior staircase with broad steps, a sturdy handrail and clean wall surfaces. Diagonal stair lines recede toward a landing under soft directional light.',['樓梯','斜線']),
  setting('window-ledge','寬窗台','A room with a wide window ledge, a broad frame and simple curtains. Daylight enters through the glass, with an exterior view beyond the clean interior wall.',['窗台','日光'],
    pose('window-ledge-seat','窗台自然坐姿','Sitting comfortably on a broad sturdy window ledge with one hand supporting the torso beside the hip and both feet naturally supported.',['坐姿','窗台'])),
  setting('onsen-edge','露天溫泉池畔','The stone edge of an open-air hot spring, with mineral water and light steam above the surface. Natural rocks and garden greenery surround the broad dry paving.',['溫泉','石邊']),
  setting('garden','花園','A garden of blooming flowers, low planted beds and a level winding path. Soft petals and dappled sunlight create depth between the layered foliage.',['花園','花朵']),
  setting('bookshelf','室內書架旁','A tall bookshelf filled with books in a quiet interior, with a simple reading table nearby. Warm light reveals shelf textures and the uncluttered aisle.',['書架','室內']),
  setting('bar','吧台','A bar counter with visible stools, glassware and simple shelving. Warm lamps and distant neon accents add layered color to the quiet interior background.',['吧台','霓虹']),
  setting('cafe-curtain','透光窗簾','A sheer curtain beside a large window in a quiet interior. Diffused daylight reveals the fabric texture, a broad windowsill and the open floor beside the wall.',['窗簾','室內']),
];

export const BASIC_SCENE_PAIRS=SCENE_DESCRIPTION_PAIRS.filter(row=>['interaction-bed','interaction-window','interaction-railing'].includes(row.scene.id));
