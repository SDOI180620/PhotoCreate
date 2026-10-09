// Generate 30 sexy costume reference sheets with the ComfyUI "01 ... 文生圖" workflow
// and import them into the PhotoStudio garments library (服裝圖庫).
import fs from "node:fs";
import path from "node:path";

const COMFY = "http://127.0.0.1:8188";
const STUDIO = "http://127.0.0.1:4310";
const WF_FILE = "Z:/AI/comfulUI/ComfyUI-Easy-Install/ComfyUI/user/default/workflows/Qwen Image 2.1/01 Qwen Image 2.1 Uncensored 5090 High Quality - \u6587\u751f\u5716.json";
const OUTPUT_ROOT = "Z:/AI/comfulUI/ComfyUI-Easy-Install/ComfyUI/output";

const PREFIX = "clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, product photography, ";
const SUFFIX = ", consistent design across all three views, studio lighting, sharp detail, catalog layout";

const COSTUMES = [
  ["bunny_girl", "sexy bunny girl costume, black satin strapless leotard with high-cut legs, white collar with black bow tie, white cuff bracelets, white bunny tail, sheer black stockings"],
  ["sailor_school_uniform", "sexy Japanese sailor school uniform (sailor fuku), white sailor blouse with red neckerchief, short pleated navy micro skirt, navy thigh-high stockings"],
  ["nurse_outfit", "sexy nurse outfit, white fitted mini dress with red cross emblem, white nurse cap, white thigh-high stockings, small clipboard"],
  ["miko_outfit", "sexy miko outfit, white kimono top with wide sleeves and short hem, red hakama modified into an ultra-short pleated skirt"],
  ["police_officer", "sexy police officer uniform, white fitted blouse, black micro skirt, police cap, handcuff holster"],
  ["flight_attendant", "sexy flight attendant uniform, fitted navy blazer, tight pencil micro skirt, silk neck scarf"],
  ["cheerleader", "cheerleader outfit, cropped white top with silver trim, ultra-short pleated skirt, hair ribbons, pom-poms"],
  ["office_lady", "sexy office lady outfit, white buttoned blouse, tight grey pencil micro skirt, black thigh-high stockings"],
  ["school_swimsuit", "Japanese school swimsuit (sukumizu), navy one-piece swimsuit with white trim"],
  ["gothic_lolita", "gothic lolita mini dress, black with white frills, lace trim, matching headband"],
  ["santa_outfit", "sexy Santa outfit, red velvet mini dress with white fur trim, white fur-trimmed boots, Santa hat"],
  ["witch_outfit", "sexy Halloween witch outfit, black mini dress with purple accents, pointed witch hat, tiny broom"],
  ["pirate_outfit", "sexy pirate outfit, white ruffled blouse, red sash, short black shorts, tricorn hat"],
  ["circus_performer", "sexy circus performer leotard, sparkly red and gold, long gloves, top hat"],
  ["ballet_tutu", "pink ballet tutu, fitted bodice with thin straps, full tulle skirt, satin ballet shoes"],
  ["tennis_outfit", "sexy tennis outfit, white visor, cropped white top, pleated white micro skirt"],
  ["race_queen", "race queen outfit, fitted white crop top and micro skirt with racing sponsor decals"],
  ["idol_stage_outfit", "sparkly idol stage outfit, sequined crop top and micro skirt, thigh-high boots"],
  ["angel_outfit", "sexy angel costume, white frilled dress, large white feather wings, golden halo"],
  ["succubus", "sexy succubus costume, black lace bra and thong set, black bat wings, small devil tail"],
  ["fox_maid", "sexy fox (kitsune) maid outfit, cream kimono-style dress with wide sleeves, fox ears and fluffy tail"],
  ["belly_dancer", "belly dancer outfit, jeweled bra top, hip scarf with coins, sheer skirt panel"],
  ["military_uniform", "sexy military uniform, olive cropped jacket, ultra-short shorts, epaulettes, cap"],
  ["waitress_outfit", "sexy waitress outfit, black mini dress with white apron, white headband"],
  ["rock_band", "sexy rock band outfit, distressed band tee, tiny denim shorts, choker, wristbands"],
  ["kunoichi", "sexy kunoichi (female ninja) outfit, black fitted top and shorts, red sash, arm wraps"],
  ["devil_outfit", "sexy devil costume, red fitted bodysuit with heart cutouts, black horns, spade tail, wrist cuffs"],
  ["vampire_outfit", "sexy vampire outfit, black cape with red lining, low-cut black dress, choker"],
  ["fairy_outfit", "sexy fairy costume, emerald micro dress, translucent iridescent wings, vine accessories"],
  ["geisha_outfit", "sexy geisha-style outfit, floral kimono worn off-shoulder, wide obi sash, hair pins with flowers"],
];

const wfTemplate = JSON.parse(fs.readFileSync(WF_FILE, "utf8"));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForHistory(id, timeoutMs = 15 * 60 * 1000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const h = await (await fetch(`${COMFY}/history/${id}`)).json();
    if (h[id]) return h[id];
    await sleep(1500);
  }
  throw new Error(`history timeout for ${id}`);
}

async function main() {
  const results = [];
  for (let i = 0; i < COSTUMES.length; i++) {
    const [name, details] = COSTUMES[i];
    const prompt = PREFIX + details + SUFFIX;
    const graph = structuredClone(wfTemplate);
    for (const n of graph.nodes) {
      if (n.type === "TextEncodeQwenImage21") n.widgets_values[0] = prompt;
      if (n.type === "SaveImage") n.widgets_values[0] = `PhotoCreate/garments_2026-10-09/${name}`;
    }
    const res = await fetch(`${COMFY}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: graph }),
    });
    if (!res.ok) throw new Error(`submit failed: ${res.status} ${await res.text()}`);
    const { prompt_id } = await res.json();
    const hist = await waitForHistory(prompt_id);
    const img = Object.values(hist.outputs).flatMap(o => o.images || [])[0];
    if (!img) throw new Error(`no output image for ${prompt_id}`);
    const diskPath = path.join(OUTPUT_ROOT, img.subfolder || "", img.filename);
    const buf = fs.readFileSync(diskPath);
    const form = new FormData();
    form.append("images", new Blob([buf], { type: "image/png" }), img.filename);
    const up = await (await fetch(`${STUDIO}/api/assets/garments`, { method: "POST", body: form })).json();
    await fetch(`${STUDIO}/api/assets/garments/${up.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: prompt }),
    });
    results.push({ name: up.name, file: img.filename });
    console.log(`imported ${String(i + 1).padStart(2, "0")}: ${up.name}`);
  }
  const st = await (await fetch(`${STUDIO}/api/state`)).json();
  console.log("done. garments in library:", st.garments.length);
}

main().catch(e => { console.error(e); process.exit(1); });
