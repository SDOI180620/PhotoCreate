import {LEGACY_PORTRAIT_SCENE_PRESETS} from './legacy-portrait-scenes.js';
import legacyBasicScenes from './legacy-basic-scenes.json' with {type:'json'};
import {PORTRAIT_SCENE_PAIRS} from '../shared/portrait-scenes.js';
import {SCENE_DESCRIPTION_PAIRS} from '../shared/scene-presets.js';

const replacements=new Map([...PORTRAIT_SCENE_PAIRS,...SCENE_DESCRIPTION_PAIRS].map(pair=>[pair.scene.id,pair]));
const legacy=new Map([...LEGACY_PORTRAIT_SCENE_PRESETS,...legacyBasicScenes].map(row=>[row.id,row]));
const equalTags=(left=[],right=[])=>JSON.stringify([...left].sort())===JSON.stringify([...right].sort());

// Exact known text only: custom edits, withdrawals and completed job snapshots survive.
export function migrateSceneDescriptions(state,{now=()=>new Date().toISOString()}={}) {
  const report={updatedSceneIds:[],addedPoseIds:[],publishedSceneIds:[]};
  if(state.sceneDescriptionsVersion>=1) return report;
  const ids=new Set(state.presets.map(row=>row.id)),poses=new Map();
  const upgrade=row=>{
    const old=legacy.get(row.id),pair=replacements.get(row.id);
    if(!old || !pair || row.category!=='interaction' || row.prompt?.trim()!==old.prompt.trim()) return row;
    if(pair.pose) poses.set(pair.pose.id,pair.pose);
    return {...row,prompt:pair.scene.prompt,name:row.name===old.name ? pair.scene.name : row.name,
      tags:equalTags(row.tags,old.tags) ? [...pair.scene.tags] : row.tags};
  };
  state.presets=state.presets.map(row=>{
    const updated=upgrade(row);if(updated!==row) report.updatedSceneIds.push(row.id);return updated;
  });
  const recipe=state.customerRecipe;
  if(recipe?.pools?.interaction) recipe.pools.interaction=recipe.pools.interaction.map(row=>{
    if(!ids.has(row.id)) return row;
    const updated=upgrade(row);if(updated!==row) report.publishedSceneIds.push(row.id);return updated;
  });
  for(const pose of poses.values()) if(!ids.has(pose.id)) {
    state.presets.push(structuredClone(pose));ids.add(pose.id);report.addedPoseIds.push(pose.id);
  }
  // New poses are available for selection; existing published pose choices stay intact.
  if(report.publishedSceneIds.length) recipe.updatedAt=now();
  state.sceneDescriptionsVersion=1;
  return report;
}
