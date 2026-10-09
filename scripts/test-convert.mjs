import fs from 'node:fs';
import { convertWorkflow } from '../server/workflow.js';
const wf = JSON.parse(fs.readFileSync('Z:/AI/comfulUI/ComfyUI-Easy-Install/ComfyUI/user/default/workflows/Qwen Image 2.1/01 Qwen Image 2.1 Uncensored 5090 High Quality - 文生圖.json', 'utf8'));
const types = [...new Set(wf.nodes.filter(n => !['MarkdownNote', 'Note'].includes(n.type)).map(n => n.type))];
const schemas = await Promise.all(types.map(t => fetch(`http://127.0.0.1:8188/object_info/${encodeURIComponent(t)}`).then(r => r.json())));
const objectInfo = Object.assign({}, ...schemas);
try {
  const graph = convertWorkflow(wf, objectInfo);
  console.log('convert OK');
  console.log(JSON.stringify(graph, null, 1));
} catch (e) {
  console.log('convert FAILED:', e.message);
}
