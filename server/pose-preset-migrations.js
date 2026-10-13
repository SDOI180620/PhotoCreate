import legacyPoses from './legacy-body-poses.json' with {type:'json'};
import legacyRailingPoses from './legacy-railing-poses.json' with {type:'json'};
import {DEFAULT_PRESETS} from '../shared/domain.js';
import {SCENE_DESCRIPTION_PAIRS} from '../shared/scene-presets.js';
import {BODY_POSING_VERSION,withBodyPosition} from '../shared/pose-body.js';

const legacy=new Map(legacyPoses.map(row=>[row.id,row]));
const legacyRailing=new Map(legacyRailingPoses.map(row=>[row.id,row]));
const current=new Map([...DEFAULT_PRESETS.filter(row=>row.category==='pose'),...SCENE_DESCRIPTION_PAIRS.flatMap(row=>row.pose?[row.pose]:[])].map(row=>[row.id,row]));
const additions=DEFAULT_PRESETS.filter(row=>row.category==='pose' && !legacy.has(row.id));
const equalTags=(a=[],b=[])=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
const bodyTags=new Set(['坐姿','蹲姿','跪姿','跪坐','仰躺','側躺','俯臥','半躺','彎腰','弓步','站姿','單腳微彎']);

function upgrade(row,{initial=true}={}) {
  if(row?.category!=='pose') return row;
  const previous=[legacyRailing.get(row.id),initial ? legacy.get(row.id) : null].find(old=>old && row.prompt?.trim()===old.prompt.trim());
  const replacement=current.get(row.id);
  if(previous && replacement && row.prompt!==replacement.prompt) {
    const tags=equalTags(row.tags,previous.tags) ? [...replacement.tags]
      : [...new Set([...(row.tags || []).filter(tag=>!['站姿','漫步','走路',...(legacyRailing.has(row.id) ? ['坐姿','蹲姿','彎腰'] : [])].includes(tag)),...replacement.tags.filter(tag=>bodyTags.has(tag))])];
    return {...row,prompt:replacement.prompt,name:row.name===previous.name ? replacement.name : row.name,tags};
  }
  return initial ? withBodyPosition(row) : row;
}

// Upgrade the current library and its published pose snapshots, once. Other
// published choices and completed photographs retain their own saved content.
export function migratePoseBodyPositions(state,{now=()=>new Date().toISOString()}={}) {
  const report={updatedPoseIds:[],addedPoseIds:[],publishedPoseIds:[],publishedNewPoseIds:[]};
  if(state.bodyPosingVersion>=BODY_POSING_VERSION) return report;
  const initial=!(state.bodyPosingVersion>=1);
  const existing=new Set(state.presets.filter(row=>row.category==='pose').map(row=>row.id));
  const published=state.customerRecipe?.pools?.pose;
  const publishedIds=new Set((published || []).map(row=>row.id));
  const allPublished=existing.size>0 && publishedIds.size===existing.size && [...existing].every(id=>publishedIds.has(id));
  state.presets=state.presets.map(row=>{
    const updated=upgrade(row,{initial});if(updated!==row) report.updatedPoseIds.push(row.id);return updated;
  });
  if(published) state.customerRecipe.pools.pose=published.map(row=>{
    if(!existing.has(row.id)) return row;
    const updated=upgrade(row,{initial});if(updated!==row) report.publishedPoseIds.push(row.id);return updated;
  });
  for(const row of additions) if(initial && !existing.has(row.id)) {
    state.presets.push(structuredClone(row));existing.add(row.id);report.addedPoseIds.push(row.id);
    if(allPublished) {state.customerRecipe.pools.pose.push(structuredClone(row));report.publishedNewPoseIds.push(row.id);}
  }
  if(report.publishedPoseIds.length || report.publishedNewPoseIds.length) state.customerRecipe.updatedAt=now();
  state.bodyPosingVersion=BODY_POSING_VERSION;
  return report;
}
