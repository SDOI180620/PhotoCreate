export const PHOTO_PRESET_GROUPS={
  pose:[
    {id:'standing',label:'站姿',match:/站|立姿|standing|\bstand\b/i},
    {id:'seated',label:'坐姿',match:/坐|座姿|盤腿|盘腿|seated|sitting/i},
    {id:'kneeling',label:'跪蹲',match:/跪|蹲|kneel|squat/i},
    {id:'lying',label:'躺姿',match:/躺|臥|卧|lying|reclin/i},
    {id:'gesture',label:'手勢',match:/手勢|手势|比耶|愛心|爱心|貓爪|猫爪|兔耳|招呼|揮手|挥手|托腮|束髮|束发|撥髮|拨发|撩髮|抱臂|比心|gesture|peace|heart|wave/i},
    {id:'props',label:'道具',match:/道具|娃娃|熊|書|书|蘋果|苹果|香蕉|水果|杯|咖啡|花束|靠枕|相機|相机|傘|伞|帽|plush|teddy|book|apple|banana|\bprop\b|\bcup\b/i},
    {id:'cute',label:'可愛',match:/可愛|可爱|愛心|爱心|比耶|兔耳|貓爪|猫爪|娃娃|招呼|cute|playful/i},
    {id:'glamour',label:'性感',match:/性感|魅力|曲線|曲线|拱背|扭腰|扭身|半躺|束髮|束发|交疊腿|交叠腿|sexy|glamour/i},
    {id:'other',label:'其他'},
  ],
  interaction:[
    {id:'forest',label:'森林竹林',match:/森林|竹林|林間|林间|林地|杉木|woodland|forest|bamboo/i},
    {id:'garden',label:'公園花園',match:/公園|公园|花園|花园|花田|庭院|植物園|植物园|紫藤|玫瑰|薔薇|蔷薇|櫻花|樱花|銀杏|银杏|蓮池|莲池|garden|park|botanical/i},
    {id:'waterfall',label:'瀑布溪流',match:/瀑布|溪流|溪谷|溪畔|溪邊|溪边|waterfall|stream|creek/i},
    {id:'coast',label:'海邊湖畔',match:/海邊|海边|海岸|海灘|海滩|海濱|海滨|湖|碼頭|码头|港口|港邊|港边|河畔|河岸|河濱|河滨|beach|coast|lake|harbor/i},
    {id:'countryside',label:'山野田園',match:/山|田園|田园|梯田|茶園|茶园|草原|丘陵|草丘|稻|牧場|牧场|mountain|hill|field|terrace/i},
    {id:'city',label:'街景建築',match:/街|建築|建筑|磚牆|砖墙|石牆|石墙|迴廊|回廊|柱廊|屋頂|屋顶|陽台|阳台|欄杆|栏杆|樓梯|楼梯|台階|台阶|street|architecture|balcony|rooftop/i},
    {id:'indoor',label:'室內空間',match:/室內|室内|攝影棚|摄影棚|窗|床|浴室|更衣|試衣|试衣|榻榻米|教室|辦公|办公|書店|书店|書架|书架|咖啡|酒吧|保健室|醫院|医院|車內|车内|車座|车座|沙發|沙发|溫室|温室|indoor|studio|bedroom|cafe|bookshop/i},
    {id:'spa',label:'溫泉泳池',match:/溫泉|温泉|泳池|浴池|spa|onsen|pool/i},
    {id:'other',label:'其他'},
  ],
};

// Published group metadata uses the same rules as the older name-only API.
// Unknown names remain available under Other; prompts are never inspected.
export function photoPresetGroupIds(preset) {
  const groups=PHOTO_PRESET_GROUPS[preset.category] || [];
  const declared=groups.filter(group=>Array.isArray(preset.groupIds)&&preset.groupIds.includes(group.id)).map(group=>group.id);
  if(declared.length) return declared;
  const text=[preset.name,...(Array.isArray(preset.tags)?preset.tags:[])].join(' ');
  const matches=groups.filter(group=>group.match?.test(text)).map(group=>group.id);
  return matches.length?matches:['other'];
}
