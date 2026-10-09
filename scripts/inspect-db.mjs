import fs from "node:fs";
import path from "node:path";

const wfDir = "Z:/AI/comfulUI/ComfyUI-Easy-Install/ComfyUI/user/default/workflows/Qwen Image 2.1";
const file = fs.readdirSync(wfDir).find(f => f.startsWith("01 "));
const wf = JSON.parse(fs.readFileSync(path.join(wfDir, file), "utf8"));
for (const n of wf.nodes) {
  console.log("----", n.id, n.type, JSON.stringify(n.title || ""));
  if (n.widgets_values) console.log("   widgets:", JSON.stringify(n.widgets_values).slice(0, 800));
}
console.log("links:", JSON.stringify(wf.links).slice(0, 1500));
