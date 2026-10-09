const base = "http://127.0.0.1:8188";
const path = "Qwen Image 2.1/01 Qwen Image 2.1 Uncensored 5090 High Quality - \u6587\u751f\u5716.json";
const res = await fetch(`${base}/userdata?dir=workflows&recurse=true&split=false`);
const files = await res.json();
const file = files.find(f => f.includes("01 Qwen"));
console.log("file entry:", JSON.stringify(file));
const r2 = await fetch(`${base}/userdata/${encodeURIComponent(file)}`);
const wf = await r2.json();
console.log("nodes:", wf.nodes.length);
for (const n of wf.nodes) {
  console.log("---", n.id, n.type, JSON.stringify(n.title || ""));
  if (n.widgets_values) console.log("   widgets:", JSON.stringify(n.widgets_values).slice(0, 600));
  if (n.inputs) console.log("   inputs:", JSON.stringify(n.inputs).slice(0, 400));
}
console.log("links:", JSON.stringify(wf.links || []).slice(0, 800));
