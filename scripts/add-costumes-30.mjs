// Generate 30 new sexy costume reference images with the ComfyUI "01 文生图"
// workflow and register them in the PhotoCreate costume library.
import fs from 'node:fs';
import path from 'node:path';

const COMFY = process.env.COMFY_URL || 'http://127.0.0.1:8188';
const APP = process.env.APP_URL || 'http://127.0.0.1:4310';
const WORKFLOW_FILE = process.env.WORKFLOW_FILE ||
  'Z:/AI/comfulUI/ComfyUI-Easy-Install/ComfyUI/user/default/workflows/Qwen Image 2.1/01 Qwen Image 2.1 Uncensored 5090 High Quality - 文生圖.json';

const PREFIX = 'clothing reference sheet, item only, no person, no body, no mannequin, no skin, three views, front view, side view, back view, plain white background, product photography, ';
const SUFFIX = ', studio lighting, sharp detail, catalog layout';
const NEGATIVE = 'blurry, low resolution, distorted anatomy, extra fingers, extra limbs, text, watermark';
const WIDTH = 1536, HEIGHT = 1024;

const COSTUMES = [
  'classic satin bunny girl costume, plunging halter neckline, detachable white collar with black bow tie, wrist cuffs, high-cut leotard bottom, black satin with subtle sheen',
  'Japanese sailor school uniform, white sailor top with red neckerchief, pleated mini skirt, thigh-high socks',
  'sexy nurse costume, white micro dress with red cross emblem, front zipper, stethoscope prop, white stockings',
  'sexy miko shrine maiden outfit, white kimono top with red accents, short red hakama skirt, gold ornaments',
  'metallic hot pink micro bikini, tiny triangle tops and high-cut bottoms, glossy fabric',
  'black satin corset with boning and lace trim, matching garter belt and stockings',
  'black lace bra and panty set, scalloped edges, delicate floral lace pattern',
  'babydoll lingerie set, sheer chiffon babydoll dress with lace trim, matching thong',
  'navy blue Japanese school swimsuit, one-piece competitive cut with white trim',
  'cheerleader uniform, cropped halter top and high-cut briefs with diamond pattern, white and gold',
  'idol stage costume, frilly pastel pink two-piece with sequins, detached sleeves, ribbon accents',
  'police officer micro skirt uniform, white cropped shirt with badge, dark blue micro skirt, cap',
  'flight attendant uniform, fitted white blouse, narrow pencil skirt, silk scarf, structured heels',
  'racing queen outfit, cropped zip jacket and micro shorts, sponsor decals, knee-high boots',
  'sexy witch costume, black micro dress with star and moon motifs, pointed hat, sheer cape',
  'succubus costume, deep purple bra set with heart accents, bat wings, spade tail, thigh-high boots',
  'angel costume, white micro set with feather-trimmed wings, halo, feather pasties',
  'catwoman costume, black glossy catsuit with high-cut legs, cat ears, collar and tail',
  'ballet tutu costume, stiff white tulle tutu with leotard, satin ribbons',
  'gymnastics leotard, rhinestone-embellished high-cut one-piece, nude and black panels',
  'office lady pencil skirt suit, fitted white blouse, tight black pencil skirt, nude pumps',
  'waitress uniform, white apron micro dress over black top, ruffled apron, headband',
  'pirate wench outfit, lace-up corset top, low-slung shorts, belt with holster, boots',
  'circus ringmaster costume, red tailcoat with gold epaulettes, black shorts, top hat',
  'rock band tee and shorts set, oversized graphic band tee, tiny distressed denim shorts',
  'tennis skirt outfit, cropped polo top and pleated tennis skirt, white sneakers',
  'volleyball uniform, cropped jersey and spandex shorts, knee pads',
  'leopard print lingerie set, bra and matching thong with garter straps',
  'polka dot swing dress, retro pin-up style, underwired bust, flared skirt',
  '1920s flapper dress, beaded fringe mini dress, jeweled headband, long pearl necklace',
];

const template = JSON.parse(fs.readFileSync(WORKFLOW_FILE, 'utf8'));

const findNode = type => template.nodes.find(node => node.type === type);
const textNode = findNode('TextEncodeQwenImage21');
const latentNode = findNode('EmptyLatentImage');
const samplerNode = findNode('KSampler');
const saveNode = findNode('SaveImage');
if (!textNode || !latentNode || !samplerNode || !saveNode) throw new Error('01 文生圖工作流節點不完整。');

const client_id = `photocreate-batch-${Date.now()}`;

async function json(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return response.json();
}

async function waitForHistory(promptId, timeoutMs = 10 * 60 * 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const history = await json(`${COMFY}/history/${encodeURIComponent(promptId)}`);
    const item = history[promptId];
    if (item) return item;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error(`任務 ${promptId} 等待逾時。`);
}

async function run() {
  const state = await json(`${APP}/api/state`);
  console.log(`現有圖庫：${state.garments.length} 件服裝`);
  const added = [];
  for (const costume of COSTUMES) {
    const prompt = `${PREFIX}${costume}${SUFFIX}`;
    const graph = structuredClone(template);
    for (const node of graph.nodes) {
      if (node.id === textNode.id) node.widgets_values = [prompt, NEGATIVE, 1024];
      if (node.id === latentNode.id) node.widgets_values = [WIDTH, HEIGHT, 1];
      if (node.id === samplerNode.id) {
        const seed = Math.floor(Math.random() * 2 ** 31);
        node.widgets_values = [seed, 'randomize', 40, 1, 'euler', 'simple', 1];
      }
      if (node.id === saveNode.id) node.widgets_values = ['Qwen_Image_2.1_Uncensored_T2I'];
    }
    // Convert UI graph to API format: widgets become inputs, links become [id].
    const apiPrompt = {};
    for (const node of graph.nodes) {
      if (node.type === 'MarkdownNote' || node.type === 'Note') continue;
      const inputs = {};
      let widgetIndex = 0;
      const widgetNames = [];
      for (const input of node.inputs || []) {
        if (input.link === null || input.link === undefined) {
          inputs[input.name ?? input.localized_name] = node.widgets_values[widgetIndex++];
        } else inputs[input.name ?? input.localized_name] = [String(input.link), 0];
      }
      // Nodes whose inputs array lists widgets keep them in order; nodes without
      // an inputs array (pure widget nodes) keep widgets_values order.
      if (!node.inputs?.length) Object.assign(inputs, Object.fromEntries((node.widgets_values || []).map((v, i) => [String(i), v])));
      apiPrompt[node.id] = { class_type: node.type, inputs };
    }
    const submit = await json(`${COMFY}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: apiPrompt, client_id }),
    });
    const history = await waitForHistory(submit.prompt_id);
    const image = history.outputs?.images?.[0];
    if (!image) throw new Error(`任務 ${submit.prompt_id} 沒有輸出圖片。`);
    const fileUrl = new URL(`${COMFY}/view?filename=${encodeURIComponent(image.filename)}&subfolder=${encodeURIComponent(image.subfolder || '')}&type=output`);
    const bytes = await (await fetch(fileUrl)).arrayBuffer();
    const upload = new FormData();
    upload.append('images', new Blob([bytes], { type: 'image/png' }), image.filename);
    const rows = await json(`${APP}/api/assets/garments`, { method: 'POST', body: upload });
    const row = Array.isArray(rows) ? rows[0] : rows;
    await json(`${APP}/api/assets/garments/${row.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: image.filename.replace(/\.png$/i, ''), description: prompt, tags: ['sexy', 'batch-2026-10-09'] }),
    });
    added.push({ name: image.filename, costume });
    console.log(`✓ ${image.filename} — ${costume.slice(0, 60)}…`);
  }
  console.log(`完成：已新增 ${added.length} 件服裝到圖庫。`);
}

run().catch(error => { console.error(error); process.exit(1); });
