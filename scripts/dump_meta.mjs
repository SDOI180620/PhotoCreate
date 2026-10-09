import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('W:/AI/PhotoCreate/data/studio.sqlite');
const m = db.prepare("SELECT key, data FROM meta").all();
for (const r of m) { console.log('=== ' + r.key + ' ==='); console.log(r.data); console.log(); }
const a = db.prepare("SELECT kind, name, data FROM assets").all();
for (const r of a) { console.log('### asset ' + r.kind + ' / ' + r.name + ' ###'); console.log(r.data); console.log(); }
