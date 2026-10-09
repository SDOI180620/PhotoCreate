// Generate garment-only catalogue sheets using the saved 01 text-to-image workflow.
// Run prepare, submit, collect, then import after reviewing the generated sheets.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN_DIR = path.join(ROOT, 'data', 'costume-catalog-2026-10-09');
const MANIFEST = path.join(RUN_DIR, 'manifest.json');
const COMFY = process.env.COMFY_URL || 'http://127.0.0.1:8188';
const APP = process.env.APP_URL || 'http://127.0.0.1:4310';
const WORKFLOW_FILE = process.env.COSTUME_WORKFLOW_FILE ||
  'Z:/AI/comfulUI/ComfyUI-Easy-Install/ComfyUI/user/default/workflows/Qwen Image 2.1/01 Qwen Image 2.1 Uncensored 5090 High Quality - 文生圖.json';
const BATCH_TAG = '服裝目錄-2026-10-09';
const COSTUMES = [
  ['水手服學生裝（服裝展示）', 'Japanese sailor-style uniform, opaque white sailor blouse fully buttoned with navy collar and red neckerchief, navy blazer, knee-length navy pleated skirt, white knee socks and brown loafers', ['水手服', '制服']],
  ['護士服', 'opaque white nurse dress, short sleeves, modest V neckline, knee-length skirt, small blue medical emblem, matching nurse cap, stethoscope accessory displayed beside the dress, white stockings and white shoes', ['護士', '制服']],
  ['巫女服', 'traditional miko shrine outfit, opaque white kimono top with a properly closed overlapping neckline, long flowing sleeves, ankle-length red hakama tied securely with red sash, white tabi socks and sandals', ['巫女', '和風']],
  ['兔女郎（舞台服）', 'black satin bunny stage costume, opaque structured bodice with moderate neckline and full-coverage leotard bottom, black bunny ears headband, white detachable collar with satin bow tie, white wrist cuffs, black fishnet tights, fluffy white tail and black pumps', ['兔耳', '舞台服']],
  ['偶像打歌服', 'sparkling idol stage costume, pink and silver sequined fitted top with opaque lining, matching pleated skirt ending above the knee with built-in opaque shorts, cropped jacket, ribbon accessories and tall white boots', ['偶像', '舞台服']],
  ['啦啦隊短裙', 'adult athletic cheerleading uniform, red and white opaque fitted sports top, matching mid-thigh pleated skirt with integrated full-coverage shorts, red and white pom-poms, white athletic shoes', ['啦啦隊', '運動']],
  ['競泳泳裝', 'adult competitive racing swimsuit, navy and cobalt opaque performance fabric, secure wide shoulder straps, standard athletic leg openings, properly fitted one-piece design, swim cap and goggles', ['泳裝', '運動']],
  ['哥德蘿莉', 'adult gothic fashion dress, opaque black fabric with ivory lace-trimmed frills, high neckline, fitted bodice with decorative corset lacing, knee-length layered ruffled skirt with full petticoat, ribbon headband and black Mary Jane shoes', ['哥德', '洋裝']],
  ['女僕裝', 'classic black and white maid outfit, opaque black dress with closed white collar, puff sleeves, knee-length flared skirt, white frilled apron securely tied at the waist, frilled headband, white stockings and black shoes', ['女僕', '制服']],
  ['空姐制服', 'flight attendant uniform, tailored navy blazer, knee-length navy pencil skirt with a modest walking slit, opaque ivory silk blouse fully buttoned, red and gold neck scarf, navy pillbox hat and black pumps', ['空姐', '制服']],
  ['OL 套裝', 'office business suit, tailored charcoal blazer and knee-length pencil skirt, opaque white blouse neatly buttoned, fine back-seam black stockings and classic black pumps', ['OL', '套裝']],
  ['改良旗袍', 'modern red silk cheongsam with opaque lining, gold floral embroidery, high mandarin collar, cap sleeves, fitted ankle-length skirt with tasteful knee-height side slits, gold frog closures and matching shoes', ['旗袍', '洋裝']],
  ['比基尼', 'adult metallic silver bikini as a swimwear product, opaque lined supportive halter top, matching standard full-coverage bikini bottoms, secure straps and clean polished seams', ['比基尼', '泳裝']],
  ['細肩帶比基尼（完整覆蓋）', 'adult minimalist black bikini as a swimwear product, slender secure shoulder straps, opaque lined triangle top with standard coverage, matching full-coverage tie-side bottoms, silver ring details', ['比基尼', '泳裝']],
  ['貓女裝', 'black glossy cat-themed costume, long-sleeve full-length fitted catsuit with closed front zipper, opaque fabric, cat-ear headband, detachable long black tail, matching gloves and ankle boots', ['貓耳', '角色服']],
  ['海盜女郎裝', 'pirate costume, opaque ivory ruffled shirt with closed neckline and long sleeves, brown lace-up corset vest worn over the shirt, dark red knee-length skirt, leather waist belt with decorative pouches, tricorn hat and tall brown boots', ['海盜', '角色服']],
  ['束腰馬甲', 'opaque burgundy satin fashion corset, structured boning, moderate sweetheart neckline, secure back lacing, lace-trimmed edges, matching high-waisted full-coverage briefs and black stockings displayed separately, garment product presentation', ['馬甲', '服飾']],
  ['芭蕾舞裙', 'pale pink ballet costume, opaque fitted scoop-neck leotard with secure straps, layered tulle classical tutu, matching pink tights and satin pointe shoes with ankle ribbons', ['芭蕾', '舞台服']],
  ['體育服', 'adult athletic sportswear set, opaque white short-sleeve T-shirt with navy collar and sleeve trim, comfortable navy mid-thigh sports shorts, white crew socks and white sneakers', ['體育服', '運動']],
  ['和服造型（完整穿著）', 'fully assembled floral kimono ensemble, opaque ivory silk with lavender cherry blossom motifs, properly overlapping closed neckline, long flowing sleeves, ankle-length hem, securely tied purple obi with decorative bow, matching sandals', ['和服', '和風']],
  ['蕾絲睡衣（不透視）', 'lavender sleepwear set, knee-length babydoll nightdress with an opaque satin lining beneath decorative floral lace, modest neckline, secure straps, matching full-coverage sleep shorts displayed separately', ['睡衣', '蕾絲']],
  ['酒保女郎裝', 'bartender uniform, opaque white collared shirt fully buttoned, fitted black waistcoat, black bow tie, tailored black shorts ending at mid-thigh, black gloves and classic black shoes', ['酒保', '制服']],
  ['賽車女郎', 'adult motorsport promotional uniform, glossy red and white opaque fitted zip jacket fully fastened, matching mid-thigh tailored shorts, racing-inspired stripes without text or brand logos, tall white boots', ['賽車', '制服']],
  ['修女服', 'traditional nun habit, black veil and white wimple, opaque black ankle-length long-sleeve dress with white collar, waist belt, simple cross pendant and black shoes', ['修女', '制服']],
  ['空姐絲襪套裝', 'flight attendant hosiery outfit, tailored plum jacket, opaque cream blouse fully buttoned, knee-length plum pencil skirt, fine sheer black tights displayed as accessories, silk neck scarf and black pumps', ['空姐', '絲襪']],
  ['學生泳裝（服裝展示）', 'vintage navy one-piece swimsuit shown solely as a garment product, opaque lined swim fabric, white piping, broad secure shoulder straps, standard athletic leg openings and full-coverage bottom, matching navy swim cap', ['泳裝', '復古']],
  ['兔耳內衣組（服裝展示）', 'adult lingerie garment product set laid out without a wearer, opaque lined ivory lace bra with standard supportive cups, matching high-waisted full-coverage briefs, white bunny-ear headband and lace-trimmed stockings displayed separately', ['兔耳', '內衣']],
  ['舞妓花魁裝', 'ornate traditional Japanese ceremonial kimono ensemble, opaque layered red and gold brocade robes properly closed at the neckline, long furisode sleeves, securely tied elaborate obi, floral hairpins displayed separately and matching traditional sandals', ['花魁', '和風']],
  ['啦啦隊絲襪', 'adult blue and white cheerleading outfit, opaque sleeveless athletic top, matching mid-thigh pleated skirt with integrated full-coverage shorts, white thigh-high athletic socks, blue pom-poms and white sneakers', ['啦啦隊', '運動']],
  ['透明雨衣風（內搭完整）', 'clear transparent vinyl raincoat with hood and visible water droplets, displayed over a fully opaque yellow knee-length dress, securely fastened front snaps, yellow rain boots and matching umbrella, fashion garment product', ['雨衣', '外套']],
];
const PREFIX = 'Professional apparel product catalogue, garments and accessories only. No person, no wearer, no human body, no skin, no face, no mannequin. One coordinated outfit repeated in three evenly spaced columns: front view, side view, back view. Invisible support and hollow interior, clothing design sheet on a clean white background. ';
const SUFFIX = '. Consistent garment construction, colors and accessories across all three views. Show the complete outfit without cropping. Realistic fabric texture, sharp seams, soft studio lighting, neutral product styling, no lettering, no watermark.';
const NEGATIVE = 'person, human, wearer, body, skin, face, mannequin, nudity, exposed anatomy, suggestive posing, see-through intimate garments, text, watermark, low quality, blurry, cropped clothing, inconsistent design';

async function json(url, options = {}) {
  const response = await fetch(url, {...options, signal: AbortSignal.timeout(30000)});
  const text = await response.text();
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status} ${text.slice(0,1200)}`);
  return JSON.parse(text);
}
function save(manifest) {
  const temporary = `${MANIFEST}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2));
  fs.renameSync(temporary, MANIFEST);
}
function convertTextWorkflow(workflow, schemas) {
  const links = new Map(workflow.links.map(link => [link[0], [String(link[1]), link[2]]]));
  const graph = {};
  for (const node of workflow.nodes) {
    if (['MarkdownNote','Note'].includes(node.type)) continue;
    if (node.mode !== undefined && node.mode !== 0) throw new Error(`Disabled workflow node: ${node.id}`);
    const schema = schemas[node.type];
    if (!schema) throw new Error(`Missing ComfyUI node: ${node.type}`);
    const fields = {...schema.input?.required, ...schema.input?.optional};
    const names = [...(schema.input_order?.required || Object.keys(schema.input?.required || {})), ...(schema.input_order?.optional || Object.keys(schema.input?.optional || {}))];
    const inputs = {};
    for (const input of node.inputs || []) {
      if (input.link == null) continue;
      const connection = links.get(input.link);
      if (!connection) throw new Error(`Missing link ${input.link}`);
      inputs[input.name] = connection;
    }
    let widgetIndex = 0;
    for (const name of names) {
      if (inputs[name] !== undefined) continue;
      const [type, options = {}] = fields[name];
      if (options.forceInput || !(Array.isArray(type) || ['STRING','INT','FLOAT','BOOLEAN','COMBO'].includes(type))) continue;
      const value = node.widgets_values?.[widgetIndex++];
      if (value !== undefined) inputs[name] = value;
      else if (options.default !== undefined) inputs[name] = options.default;
      else if (Object.hasOwn(schema.input?.required || {}, name)) throw new Error(`Missing ${node.type}.${name}`);
      if (options.control_after_generate) widgetIndex++;
    }
    graph[String(node.id)] = {class_type:node.type, inputs};
  }
  for (const node of Object.values(graph)) for (const value of Object.values(node.inputs)) {
    if (Array.isArray(value) && value.length === 2 && typeof value[1] === 'number' && !graph[String(value[0])]) throw new Error('Dangling workflow connection');
  }
  return graph;
}
function nodeId(graph, type) {
  const entries = Object.entries(graph).filter(([,node]) => node.class_type === type);
  if (entries.length !== 1) throw new Error(`Expected one ${type}, got ${entries.length}`);
  return entries[0][0];
}
async function prepare() {
  if (fs.existsSync(MANIFEST)) throw new Error(`Run already exists: ${MANIFEST}`);
  fs.mkdirSync(RUN_DIR, {recursive:true});
  const workflow = JSON.parse(fs.readFileSync(WORKFLOW_FILE, 'utf8'));
  const classes = [...new Set(workflow.nodes.map(node => node.type).filter(type => !['MarkdownNote','Note'].includes(type)))];
  const schemas = Object.assign({}, ...await Promise.all(classes.map(type => json(`${COMFY}/object_info/${encodeURIComponent(type)}`))));
  const template = convertTextWorkflow(workflow, schemas);
  const textId = nodeId(template, 'TextEncodeQwenImage21');
  const samplerId = nodeId(template, 'KSampler');
  const latentId = nodeId(template, 'EmptyLatentImage');
  const saveId = nodeId(template, 'SaveImage');
  const state = await json(`${APP}/api/state`);
  fs.writeFileSync(path.join(RUN_DIR, 'library-before.json'), JSON.stringify(state.garments, null, 2));
  fs.writeFileSync(path.join(RUN_DIR, 'workflow-source.json'), JSON.stringify(workflow, null, 2));
  const manifest = {version:1,createdAt:new Date().toISOString(),workflowFile:WORKFLOW_FILE,clientId:`photocreate-catalog-${randomUUID()}`,batchTag:BATCH_TAG,beforeCount:state.garments.length,settings:{...template[latentId].inputs,...template[samplerId].inputs,model:template[nodeId(template,'UNETLoader')].inputs.unet_name},items:[]};
  for (const [index,[name,details,tags]] of COSTUMES.entries()) {
    const code = `c${String(index + 1).padStart(2,'0')}`;
    const graph = structuredClone(template);
    graph[textId].inputs.prompt = PREFIX + details + SUFFIX;
    graph[textId].inputs.negative_prompt = NEGATIVE;
    graph[samplerId].inputs.seed = 20261009000 + index;
    graph[saveId].inputs.filename_prefix = `PhotoCreate/costume-catalog-2026-10-09/${code}`;
    fs.writeFileSync(path.join(RUN_DIR, `${code}.api.json`), JSON.stringify(graph, null, 2));
    manifest.items.push({index:index+1,code,name,description:details+'.',tags:[BATCH_TAG,'純服裝三視圖',...tags],generationPrompt:graph[textId].inputs.prompt,seed:graph[samplerId].inputs.seed,status:'prepared'});
  }
  save(manifest);
  console.log(`Prepared ${manifest.items.length} outfits: ${MANIFEST}`);
  console.log(JSON.stringify(manifest.settings));
}
async function submit(manifest, limit) {
  let submitted = 0;
  for (const item of manifest.items) {
    if (item.status !== 'prepared' || submitted >= limit) continue;
    const prompt = JSON.parse(fs.readFileSync(path.join(RUN_DIR, `${item.code}.api.json`), 'utf8'));
    item.status = 'submitting';
    save(manifest);
    let result;
    try { result = await json(`${COMFY}/prompt`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt,client_id:manifest.clientId,extra_data:{photocreate_catalog:{batchTag:BATCH_TAG,code:item.code,name:item.name}}})}); }
    catch (error) { item.status = 'submission-unconfirmed'; item.error = error.message; save(manifest); throw error; }
    if (!result.prompt_id) throw new Error(`Missing prompt_id for ${item.name}`);
    Object.assign(item,{promptId:result.prompt_id,status:'queued',submittedAt:new Date().toISOString()});
    save(manifest);
    submitted++;
    console.log(`QUEUED ${item.code} ${item.name} ${item.promptId}`);
  }
  console.log(`Submitted ${submitted}; progress: ${JSON.stringify(counts(manifest))}`);
}
async function collect(manifest, quiet = false) {
  for (const item of manifest.items.filter(item => item.promptId && ['queued','generated'].includes(item.status))) {
    const history = (await json(`${COMFY}/history/${encodeURIComponent(item.promptId)}`))[item.promptId];
    if (!history) continue;
    fs.writeFileSync(path.join(RUN_DIR, `${item.code}.history.json`), JSON.stringify(history, null, 2));
    if (history.status?.status_str === 'error') {
      Object.assign(item,{status:'failed',error:JSON.stringify(history.status.messages)});
      save(manifest);
      console.error(`FAILED ${item.code} ${item.error}`);
      continue;
    }
    if (!history.status?.completed) continue;
    const images = Object.values(history.outputs || {}).flatMap(output => output.images || []).filter(image => image.type === 'output');
    if (images.length !== 1) throw new Error(`Expected one image for ${item.code}, got ${images.length}`);
    const output = images[0];
    const query = new URLSearchParams({filename:output.filename,subfolder:output.subfolder || '',type:output.type});
    const response = await fetch(`${COMFY}/view?${query}`, {signal:AbortSignal.timeout(30000)});
    if (!response.ok) throw new Error(`Image download failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error(`Invalid PNG for ${item.code}`);
    const file = `${item.code}.png`;
    fs.writeFileSync(path.join(RUN_DIR,file),bytes);
    Object.assign(item,{status:'collected',output,localFile:path.join(RUN_DIR,file),width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20),collectedAt:new Date().toISOString()});
    save(manifest);
    console.log(`COLLECTED ${item.code} ${item.name} ${item.width}x${item.height}`);
  }
  if (!quiet) console.log(JSON.stringify(counts(manifest)));
}
async function watch(manifest) {
  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    await collect(manifest,true);
    if (!manifest.items.some(item => item.status === 'queued')) {
      console.log(`Generation finished: ${JSON.stringify(counts(manifest))}`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve,5000));
  }
  throw new Error('Generation wait timed out; stored prompt IDs remain available for collect.');
}
async function importReviewed(manifest) {
  if (manifest.items.some(item => !['collected','uploaded','imported'].includes(item.status))) throw new Error('Collect all 30 sheets before importing.');
  const state = await json(`${APP}/api/state`);
  for (const item of manifest.items) {
    const existing = state.garments.find(asset => asset.id === item.assetId || (asset.tags.includes(BATCH_TAG) && asset.name === item.name));
    if (item.status === 'imported' && existing && existing.name === item.name && existing.description === item.description && existing.tags.length === item.tags.length && item.tags.every(tag => existing.tags.includes(tag))) continue;
    if (existing) item.assetId = existing.id;
    if (!item.assetId) {
      const form = new FormData();
      form.append('images',new Blob([fs.readFileSync(item.localFile)],{type:'image/png'}),`${item.code}-${item.name}.png`);
      const rows = await json(`${APP}/api/assets/garments`,{method:'POST',body:form});
      if (rows.length !== 1 || !rows[0]?.id) throw new Error(`Unexpected upload result for ${item.code}`);
      item.assetId = rows[0].id;
      item.status = 'uploaded';
      save(manifest);
    }
    const asset = await json(`${APP}/api/assets/garments/${item.assetId}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:item.name,description:item.description,tags:item.tags})});
    Object.assign(item,{status:'imported',libraryImage:asset.image,libraryFile:asset.fileName,importedAt:new Date().toISOString()});
    save(manifest);
    console.log(`IMPORTED ${item.code} ${item.name} ${item.assetId}`);
  }
  const current = await json(`${APP}/api/state`);
  const imported = current.garments.filter(asset => asset.tags.includes(BATCH_TAG));
  if (imported.length !== 30 || manifest.items.some(item => !imported.some(asset => asset.id === item.assetId && asset.name === item.name && asset.description === item.description))) throw new Error('Library verification failed');
  for (const asset of imported) {
    const response = await fetch(`${APP}${asset.image}`,{signal:AbortSignal.timeout(30000)});
    if (!response.ok) throw new Error(`Library image missing: ${asset.id}`);
    await response.arrayBuffer();
  }
  console.log(`VERIFIED ${imported.length} new outfits; library total ${current.garments.length}`);
}
async function review(manifest) {
  if (manifest.items.some(item => !item.localFile)) throw new Error('Collect every image before creating review sheets.');
  const escape = value => String(value).replace(/[&<>"']/g,char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const cards = items => items.map(item => `<article><img src="${item.code}.png" alt="${escape(item.name)}"><div><span>${item.code.toUpperCase()}</span> ${escape(item.name)}</div></article>`).join('');
  const pages = [0,10,20].map((offset,index) => `<section class="sheet" id="sheet-${index+1}"><h2>服裝三視圖 ${offset+1}–${offset+10}</h2><div class="grid">${cards(manifest.items.slice(offset,offset+10))}</div></section>`).join('');
  const html = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>PhotoCreate · 30 款服裝目錄</title><style>body{margin:0;padding:24px;background:#f0f2f5;color:#192332;font:18px "Microsoft JhengHei",sans-serif}h1{margin:4px 0 12px}p{color:#526071;margin:8px 0 24px}.sheet{padding:20px;background:#f0f2f5;margin:20px 0}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}article{background:white;border-radius:8px;overflow:hidden;border:1px solid #dbe1e8}img{display:block;width:100%;aspect-ratio:3/2;object-fit:contain}article div{padding:9px 12px;font-size:17px;font-weight:600;min-height:24px}span{color:#617187;font-size:14px;margin-right:6px}#overview{padding:20px;background:#f0f2f5}#overview .grid{grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}#overview article div{font-size:15px;padding:8px}@media(max-width:750px){.grid,#overview .grid{grid-template-columns:1fr}}</style><h1>PhotoCreate · 30 款服裝目錄</h1><p>01 Qwen Image 2.1 Uncensored 5090 High Quality - 文生圖 · 1536 × 1024 · 40 steps · 純服裝正面／側面／背面展示。裸露與透視描述已調整為完整覆蓋版本。</p><section id="overview"><h2>全部 30 款</h2><div class="grid">${cards(manifest.items)}</div></section>${pages}</html>`;
  const htmlFile = path.join(RUN_DIR,'index.html');
  fs.writeFileSync(htmlFile,html);
  const {chromium} = await import('playwright');
  const browser = await chromium.launch({channel:'chrome',headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1800,height:1100},deviceScaleFactor:1});
    const {pathToFileURL} = await import('node:url');
    await page.goto(pathToFileURL(htmlFile).href);
    await page.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
    await page.locator('#overview').screenshot({path:path.join(RUN_DIR,'overview.png')});
    await page.setViewportSize({width:1800,height:1100});
    for (let i=1;i<=3;i++) await page.locator(`#sheet-${i}`).screenshot({path:path.join(RUN_DIR,`review-${i}.png`)});
  } finally {await browser.close();}
  console.log(`Review sheets: ${htmlFile}`);
}
function counts(manifest) {
  return manifest.items.reduce((result,item) => ({...result,[item.status]:(result[item.status] || 0)+1}),{});
}

const command = process.argv[2];
const limit = Number(process.argv.find(arg => arg.startsWith('--limit='))?.slice(8) || 'Infinity');
try {
  if (command === 'prepare') await prepare();
  else {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST,'utf8'));
    if (command === 'submit') await submit(manifest,limit);
    else if (command === 'collect') await collect(manifest);
    else if (command === 'watch') await watch(manifest);
    else if (command === 'review') await review(manifest);
    else if (command === 'import') await importReviewed(manifest);
    else if (command === 'status') console.log(JSON.stringify({counts:counts(manifest),items:manifest.items.map(({code,name,status,promptId,error}) => ({code,name,status,promptId,error}))},null,2));
    else throw new Error('Use: prepare | submit [--limit=1] | collect | watch | review | import | status');
  }
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
