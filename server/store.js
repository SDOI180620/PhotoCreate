import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_PRESETS } from '../shared/domain.js';
import { migrateShootBatches } from '../shared/batches.js';
import { upgradeCameraMapping } from '../shared/camera.js';
import { reconcileLibrarySelections } from '../shared/library-selections.js';
import {defaultCharacterPromptSettings} from '../shared/character-profile.js';
import {DEFAULT_TURNAROUND_PROMPT} from '../shared/character-turnaround.js';
import {PORTRAIT_SCENE_PAIRS} from '../shared/portrait-scenes.js';
import {migrateSceneDescriptions} from './scene-preset-migrations.js';
import {initialCharacterPromptProfiles} from '../shared/character-prompt-profiles.js';

export function createStore(dataDir) {
  fs.mkdirSync(path.join(dataDir,'uploads'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir,'studio.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS assets_kind ON assets(kind);
    CREATE TABLE IF NOT EXISTS presets (id TEXT PRIMARY KEY, category TEXT NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL, tags TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS presets_category ON presets(category);
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
    CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0);
    CREATE VIRTUAL TABLE IF NOT EXISTS presets_fts USING fts5(name, prompt, tags, content='presets', content_rowid='rowid', tokenize='trigram');
    CREATE TRIGGER IF NOT EXISTS presets_ai AFTER INSERT ON presets BEGIN
      INSERT INTO presets_fts(rowid,name,prompt,tags) VALUES (new.rowid,new.name,new.prompt,new.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS presets_ad AFTER DELETE ON presets BEGIN
      INSERT INTO presets_fts(presets_fts,rowid,name,prompt,tags) VALUES ('delete',old.rowid,old.name,old.prompt,old.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS presets_au AFTER UPDATE ON presets BEGIN
      INSERT INTO presets_fts(presets_fts,rowid,name,prompt,tags) VALUES ('delete',old.rowid,old.name,old.prompt,old.tags);
      INSERT INTO presets_fts(rowid,name,prompt,tags) VALUES (new.rowid,new.name,new.prompt,new.tags);
    END;
  `);
  for(const table of ['assets','presets','jobs']) if(!db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === 'position')) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN position INTEGER NOT NULL DEFAULT 0; UPDATE ${table} SET position=rowid;`);
  }
  if(!db.prepare('PRAGMA table_info(jobs)').all().some(row => row.name === 'batch_id')) db.exec("ALTER TABLE jobs ADD COLUMN batch_id TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE INDEX IF NOT EXISTS jobs_batch ON jobs(batch_id)');
  const parseRows = table => db.prepare(`SELECT data FROM ${table} ORDER BY position,rowid`).all().map(row => JSON.parse(row.data));
  const meta = Object.fromEntries(db.prepare('SELECT key,data FROM meta').all().map(row => [row.key,JSON.parse(row.data)]));
  const fresh = meta.version === undefined;
  let state = fresh ? {version:2,settings:{comfyUrl:'http://127.0.0.1:8188'},garments:[],characters:[],scenes:[],presets:structuredClone(DEFAULT_PRESETS),jobs:[],batches:[],draft:{},workflow:null,workflowName:null} : {...meta,garments:[],characters:[],scenes:[],presets:parseRows('presets'),jobs:parseRows('jobs'),batches:parseRows('batches')};
  if (!fresh) for(const asset of db.prepare('SELECT kind,data FROM assets ORDER BY position,rowid').all()) state[asset.kind].push(JSON.parse(asset.data));
  const legacyFile = path.join(dataDir,'studio.json');
  if (fresh && fs.existsSync(legacyFile)) state = JSON.parse(fs.readFileSync(legacyFile,'utf8'));
  const metaUpsert = db.prepare('INSERT INTO meta(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data');
  const assetUpsert = db.prepare('INSERT INTO assets(id,kind,name,data,position) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,name=excluded.name,data=excluded.data,position=excluded.position');
  const presetUpsert = db.prepare('INSERT INTO presets(id,category,name,prompt,tags,data,position) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET category=excluded.category,name=excluded.name,prompt=excluded.prompt,tags=excluded.tags,data=excluded.data,position=excluded.position');
  const jobUpsert = db.prepare('INSERT INTO jobs(id,status,created_at,data,position,batch_id) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data,position=excluded.position,batch_id=excluded.batch_id');
  const batchUpsert = db.prepare('INSERT INTO batches(id,name,created_at,data,position) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,data=excluded.data,position=excluded.position');
  const collections = ['garments','characters','scenes','presets','jobs','batches'];
  function save(previous = {}) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for(const [key,value] of Object.entries(state)) if(!collections.includes(key) && JSON.stringify(previous[key]) !== JSON.stringify(value)) metaUpsert.run(key,JSON.stringify(value));
      for(const kind of collections) {
        const table = ['presets','jobs','batches'].includes(kind) ? kind : 'assets';
        const before = new Map((previous[kind] || []).map((row,index) => [row.id,{data:JSON.stringify(row),position:index}]));
        const after = new Set(state[kind].map(row => row.id));
        for(const id of before.keys()) if(!after.has(id)) db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
        for(const [position,row] of state[kind].entries()) {
          const serialized = JSON.stringify(row);
          if(before.get(row.id)?.data === serialized && before.get(row.id)?.position === position) continue;
          if(table === 'presets') presetUpsert.run(row.id,row.category,row.name,row.prompt,JSON.stringify(row.tags),serialized,position);
          else if(table === 'jobs') jobUpsert.run(row.id,row.status,row.createdAt,serialized,position,row.batchId || '');
          else if(table === 'batches') batchUpsert.run(row.id,row.name,row.createdAt,serialized,position);
          else assetUpsert.run(row.id,kind,row.name,serialized,position);
        }
      }
      db.exec('COMMIT');
    } catch(error) {db.exec('ROLLBACK');throw error;}
  }
  const beforeMigration = fresh ? {} : structuredClone(state);
  state.settings.releaseGpuMemory ??= false;
  state.settings.characterPrompts ??= defaultCharacterPromptSettings();
  state.settings.characterPrompts.turnaroundPrompt ??= DEFAULT_TURNAROUND_PROMPT;
  state.settings.characterPromptProfiles ??= initialCharacterPromptProfiles(state.settings.characterPrompts);
  const activePromptProfile=state.settings.characterPromptProfiles.profiles.find(row=>row.id===state.settings.characterPromptProfiles.activeId);
  if(!activePromptProfile) throw new Error('使用中的角色提詞設定檔不存在。');
  activePromptProfile.settings=structuredClone(state.settings.characterPrompts);
  if (!state.interactionPresetsVersion) {
    const ids = new Set(state.presets.map(row => row.id));
    state.presets.push(...structuredClone(DEFAULT_PRESETS.filter(row => row.category === 'interaction' && !row.id.startsWith('interaction-portrait-') && !ids.has(row.id))));
    state.interactionPresetsVersion = 1;
  }
  if (!state.portraitScenePresetsVersion) {
    const ids = new Set(state.presets.map(row => row.id));
    for(const {scene,pose} of PORTRAIT_SCENE_PAIRS) if(!ids.has(scene.id)) {
      state.presets.push(structuredClone(scene));ids.add(scene.id);
      if(!ids.has(pose.id)) {state.presets.push(structuredClone(pose));ids.add(pose.id);}
    }
    state.portraitScenePresetsVersion = 1;
  }
  if (!state.detailPresetsVersion) {
    const ids = new Set(state.presets.map(row => row.id));
    state.presets.push(...structuredClone(DEFAULT_PRESETS.filter(row => ['expression','clothing_state'].includes(row.category) && !ids.has(row.id))));
    state.detailPresetsVersion = 1;
  }
  migrateSceneDescriptions(state);
  state.presets = state.presets.map(row => row.category === 'camera' ? upgradeCameraMapping(row) : row);
  if(state.customerRecipe?.pools?.camera) state.customerRecipe.pools.camera = state.customerRecipe.pools.camera.map(row => row.id === 'camera-original' ? row : upgradeCameraMapping(row));
  reconcileLibrarySelections(state);
  migrateShootBatches(state);
  if(fresh || JSON.stringify(beforeMigration) !== JSON.stringify(state)) save(beforeMigration);
  return {
    // Pure projections avoid copying unrelated workflow snapshots when a
    // request only needs one image or a list of folders. Results stay detached.
    read: (select=value=>value) => structuredClone(select(state)),
    mutate: callback => {
      const previous = state;
      state = structuredClone(state);
      try { const result = callback(state); save(previous); return result; }
      catch (error) { state = previous; throw error; }
    },
    searchPresets: ({q = '',category = '',limit = 60,offset = 0} = {}) => {
      const terms = q.trim().split(/\s+/).filter(Boolean);
      const long = terms.filter(term => [...term].length >= 3);
      const short = terms.filter(term => [...term].length < 3);
      const clauses = [], parameters = [];
      const source = long.length ? 'presets p JOIN presets_fts ON p.rowid=presets_fts.rowid' : 'presets p';
      if(long.length) {clauses.push('presets_fts MATCH ?');parameters.push(long.map(term => `"${term.replaceAll('"','""')}"`).join(' AND '));}
      for(const term of short) {clauses.push("instr(lower(p.name || ' ' || p.prompt || ' ' || p.tags),lower(?)) > 0");parameters.push(term);}
      if(category) {clauses.push('p.category=?');parameters.push(category);}
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const total = db.prepare(`SELECT COUNT(*) AS total FROM ${source} ${where}`).get(...parameters).total;
      const rows = db.prepare(`SELECT p.data FROM ${source} ${where} ORDER BY ${long.length ? 'bm25(presets_fts), p.position, p.rowid' : 'p.position, p.rowid'} LIMIT ? OFFSET ?`).all(...parameters,limit,offset).map(row => JSON.parse(row.data));
      return {rows,total,limit,offset};
    },
    close: () => db.close(),
  };
}
