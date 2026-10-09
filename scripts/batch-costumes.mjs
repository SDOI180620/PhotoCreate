// Batch-generate 30 erotic costume reference sheets via the ComfyUI "01 文生圖" workflow,
// then register the outputs into the PhotoCreate clothing library (garments).
const COMFY = 'http://127.0.0.1:8188';
const STATE = 'http://127.0.0.1:4310';
const WORKFLOW_PATH = 'workflows/Qwen Image 2.1/01 Qwen Image 2.1 Uncensored 5090 High Quality - 文生圖.json';

const NEGATIVE = 'person, body, mannequin, skin, face, eyes, hands, fingers, blurry, lowres, low quality, jpeg artifacts, watermark, signature, text, deformed, disfigured, extra limbs, extra fingers, mutated hands, bad anatomy, bad hands, cropped, out of frame, worst quality, jpeg artifacts, ugly, duplicate, morbid, mutilated, out of focus, dehydrated, bad proportions, fused fingers, too many fingers, long neck';

const COSTUMES = [
  ['水手服學生裝', 'clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, Japanese sailor school uniform (seifuku), white sailor blouse with red neckerchief, navy pleated skirt, brown knee socks, brown loafers, consistent design across all three views, studio lighting, sharp detail, catalog layout'],
  ['護士服', 'clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, white nurse dress with red cross emblem, short fitted dress, white stockings, small nurse cap, consistent design across all three views, studio lighting, sharp detail, catalog layout'],
  ['巫女服', 'clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, miko outfit, white kimono top with red hakama, long flowing sleeves, red ribbon at the chest, consistent design across all three views, studio lighting, sharp detail, catalog layout'],
  ['兔女郎', 'clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, black satin bunny girl bodysuit, white frilled collar, white cuffs, white bow tie, fishnet stockings, black bunny ears headband, consistent design across all three views, studio lighting, sharp detail, catalog layout'],
  ['偶像打歌服', 'clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, sparkly idol stage costume, sequined crop top, micro skirt, thigh-high boots, glitter fabric, consistent design across all three views, studio lighting, sharp detail, catalog layout'],
  ['啦啦隊服', 'clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, cheerleader outfit, cropped white top, ultra-short pleated skirt, pom-poms, white sneakers, consistent design across all three views, studio lighting, sharp detail, catalog layout'],
  ['競泳泳裝', 'clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, competitive racing swimsuit, navy one-piece with white trim, high-cut legs, thin straps, consistent design across all three views, studio lighting, sharp detail, catalog layout'],
  ['哥德蘿莉', 'clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, gothic lolita dress, black with white lace trim, corset lacing, layered ruffled skirt, petticoat, ribbon details, consistent design across all three views, studio lighting, sharp detail, catalog layout'],
  ['女僕裝', 'clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, classic maid dress, black with white apron, frilled headband, short flared skirt, white thigh-high stockings, consistent design across all three views, studio lighting, sharp detail, catalog layout'],
  ['空姐制服', 'clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, flight attendant uniform, fitted beige blazer, pencil skirt, silk scarf, consistent design across all three views, studio lighting, sharp detail, catalog layout'],
  ['OL套裝', 'clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, office lady pencil skirt suit, fitted blazer, blouse, sheer stockings, business formal, consistent design across all three views, studio lighting, sharp detail, catalog layout'],
  ['改良旗袍', 'clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, modern cheongsam, red satin with gold floral pattern, high mandarin collar, side slit, consistent design across all three views, studio lighting, sharp detail, catalog layout'],
  ['比基尼', 'clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, red string bikini, triangle top, side-tie bottoms, glossy fabric, consistent design across all three views, studio lighting, sharp detail, catalog layout'],
  ['微比基尼', 'clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, micro bikini, minimal black fabric, thin strings, glossy finish, consistent design across all three views, studio lighting, sharp detail, catalog layout'],
  ['貓女裝', 'clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, black latex catwoman bodysuit, glossy finish, cat-ear headband, thin tail, high-cut legs, consistent design across all three views, studio lighting, sharp detail, catalog layout'],
  ['海盜女郎裝', 'clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, pirate wench outfit, laced corset top, half-open white shirt, low-slung belt, hip accessories, brown boots, consistent design across all three views, studio lighting, sharp detail, catalog layout'],
  ['束腰馬甲', 'clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, satin corset set, boned bustier with lace trim, garter straps, sheer stockings, vintage lingerie style, consistent design across all three views, studio lighting, sharp detail, catalog layout'],
  ['芭蕾舞裙', 'clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, ballet tutu, pale pink layered tulle skirt, fitted leotard, pointe shoes, consistent design across all three views, studio lighting, sharp detail, catalog layout'],
  ['體育服', 'clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, Japanese gym uniform, white T-shirt with navy trim, navy buruma shorts, white socks, consistent design across all three views, studio lighting, sharp detail, catalog layout'],
  ['半脫和服', 'clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, floral kimono worn loosely, slipping off the shoulders, obi sash, traditional Japanese pattern, consistent design across all three views, studio lighting, sharp detail, catalog layout'],
  ['網紗睡衣', 'clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, sheer babydoll nightgown, lavender lace, translucent fabric, matching panties, lingerie set, consistent design across all three views, studio lighting, sharp detail, catalog layout'],
  ['酒保女郎裝', 'clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, bartender outfit, black deep-plunge top, short shorts, long black gloves, cocktail waitress style, consistent design across all three views, studio lighting, sharp detail, catalog layout'],
  ['賽車女郎', 'clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, race queen outfit, red cropped zip top, micro shorts, glossy fabric, tall white boots, consistent design across all three views, studio lighting, sharp detail, catalog layout'],
  ['修女服', 'clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, playful nun habit, black veil, white wimple, fitted black dress with white trim, cross necklace, consistent design across all three views, studio lighting, sharp detail, catalog layout'],
  ['花魁裝', 'clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, Japanese courtesan oiran costume, ornate multi-layered kimono, elaborate floral patterns, long furisode sleeves, ornate hair ornaments, consistent design across all three views, studio lighting, sharp detail, catalog layout'],
  ['學生泳裝', 'clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, vintage school swimsuit, navy one-piece with white trim, competitive style, consistent design across all three views, studio lighting, sharp detail, catalog layout'],
  ['兔耳內衣組', 'clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, lace bra and panty set with bunny ears, garter straps, sheer stockings, lingerie set, consistent design across all three views, studio lighting, sharp detail, catalog layout'],
  ['舞妓花魁裝', 'clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, floral kimono with long furisode sleeves, obi sash, traditional Japanese patterns, ornate hairpins, consistent design across all three views, studio lighting, sharp detail, catalog layout'],
  ['啦啦隊絲襪套裝', 'clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, cheerleader outfit with white thigh-high stockings, pleated skirt, cropped top, pom-poms, consistent design across all three views, studio lighting, sharp detail, catalog layout'],
  ['透明雨衣套裝', 'clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, transparent vinyl raincoat over black lingerie set, clear material, modern fashion, consistent design across all three views, studio lighting, sharp detail, catalog layout'],
].map(([name, prompt]) => ({ name, prompt }));

const clientID = `photocreate-batch-${Date.now()}`;

function waitForOutput(promptID) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`job ${promptID} timed out`)), 15 * 60 * 1000);
    const check = async () => {
      try {
        const history = await (await fetch(`${COMFY}/history/${promptID}`)).json();
        const entry = history[promptID];
        if (entry?.outputs) { clearTimeout(timeout); resolve(entry); return; }
        setTimeout(check, 1500);
      } catch (e) { clearTimeout(timeout); reject(e); }
    };
    setTimeout(check, 1500);
  });
}

async function main() {
  const wf = await (await fetch(`${COMFY}/userdata/${encodeURIComponent(WORKFLOW_PATH)}`)).json();
  const objectInfo = await (await fetch(`${COMFY}/object_info`)).json();
  const template = convertWorkflow(wf, objectInfo);
  const byType = {};
  for (const [id, node] of Object.entries(template)) byType[node.class_type] = { id: String(id), node };
  const text = byType['TextEncodeQwenImage21'];
  const latent = byType['EmptyLatentImage'];
  const sampler = byType['KSampler'];
  const save = byType['SaveImage'];
  console.log('template nodes:', Object.values(byType).map(n => `${n.node.class_type}#${n.id}`).join(', '));

  const queue = [];
  for (let i = 0; i < COSTUMES.length; i++) {
    const { name, prompt } = COSTUMES[i];
    const graph = structuredClone(template);
    graph[text.id].inputs.prompt = prompt;
    graph[text.id].inputs.negative = NEGATIVE;
    graph[latent.id].inputs.width = 1536;
    graph[latent.id].inputs.height = 1024;
    graph[latent.id].inputs.batch_size = 1;
    graph[sampler.id].inputs.seed = 20261009000 + i;
    graph[sampler.id].inputs.steps = 40;
    graph[sampler.id].inputs.cfg = 1;
    graph[sampler.id].inputs.sampler_name = 'euler';
    graph[sampler.id].inputs.scheduler = 'simple';
    graph[sampler.id].inputs.denoise = 1;
    graph[save.id].inputs.filename_prefix = `PhotoCreate/costume-batch-2026-10-09/c${String(i + 1).padStart(2, '0')}`;

    const res = await fetch(`${COMFY}/prompt`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: graph, client_id: clientID })
    });
    const body = await res.json();
    if (!res.ok) { console.error(`submit ${i + 1} failed`, body); process.exit(1); }
    queue.push({ promptID: body.prompt_id, name, prompt, index: i + 1 });
    console.log(`queued ${String(i + 1).padStart(2, '0')} ${name} -> ${body.prompt_id}`);
  }

  console.log(`\n${queue.length} jobs queued, waiting...`);
  const results = [];
  for (const job of queue) {
    const history = await waitForOutput(job.promptID);
    const img = history.outputs?.images?.[0];
    if (!img) { console.error(`no output for ${job.name}`); continue; }
    results.push({ ...job, output: img });
    console.log(`done ${String(job.index).padStart(2, '0')} ${job.name} -> ${img.subfolder}/${img.filename}`);
  }

  // Download from ComfyUI and register into the state server clothing library
  for (const r of results) {
    const viewURL = `${COMFY}/view?type=output&subfolder=${encodeURIComponent(r.output.subfolder)}&filename=${encodeURIComponent(r.output.filename)}`;
    const buf = Buffer.from(await (await fetch(viewURL)).arrayBuffer());
    const form = new FormData();
    form.append('images', new Blob([buf], { type: 'image/png' }), `${r.name}.png`);
    const res = await fetch(`${STATE}/api/assets/garments`, { method: 'POST', body: form });
    const created = await res.json();
    const id = created.id ?? created[0]?.id;
    const patch = await fetch(`${STATE}/api/assets/garments/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: r.name, description: r.prompt })
    });
    if (!patch.ok) console.error(`patch ${r.name} failed`, await patch.text());
    console.log(`入库 ${String(r.index).padStart(2, '0')} ${r.name} -> ${id}`);
  }

  // clean up intermediate files in the ComfyUI output folder
  const paths = results.map(x => x.output.subfolder ? `${x.output.subfolder}/${x.output.filename}` : x.output.filename);
  await fetch(`${STATE}/api/outputs/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths })
  }).catch(() => {});
  console.log(`cleaned ${paths.length} intermediate files from the ComfyUI output folder.`);
  console.log(`\nAll ${results.length} costumes added to the clothing library.`);
}

main().catch(e => { console.error(e); process.exit(1); });
