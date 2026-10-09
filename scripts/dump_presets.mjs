import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('W:/AI/PhotoCreate/data/studio.sqlite');
const rows = db.prepare("SELECT category, name, prompt FROM presets ORDER BY category, position").all();
let last = '';
for (const r of rows) {
  if (r.category !== last) { console.log('\n########## CATEGORY: ' + r.category + ' ##########'); last = r.category; }
  console.log('--- ' + r.name + ' ---');
  console.log(r.prompt);
}
