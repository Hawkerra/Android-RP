// Character card (Tavern V1/V2/V3) and lorebook import/export, plus Chub.ai integration.
import { newCharacter, newLorebook, newEntry } from './db.js';
import { request } from './native.js';
import { booruSearch, booruImport } from './booru.js';

// ---------- PNG tEXt chunk helpers ----------

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function* pngChunks(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 8;
  while (p + 8 <= u8.length) {
    const len = dv.getUint32(p);
    const type = String.fromCharCode(...u8.subarray(p + 4, p + 8));
    yield { type, start: p, data: u8.subarray(p + 8, p + 8 + len), end: p + 12 + len };
    p += 12 + len;
  }
}

const isPng = (u8) => PNG_SIG.every((b, i) => u8[i] === b);

function b64ToUtf8(b64) {
  const bin = atob(b64.trim());
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(u);
}

function utf8ToB64(str) {
  const u = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Reads chara/ccv3 JSON out of a PNG card. */
export function readPngCard(buffer) {
  const u8 = new Uint8Array(buffer);
  if (!isPng(u8)) throw new Error('Not a PNG file');
  const found = {};
  for (const c of pngChunks(u8)) {
    if (c.type !== 'tEXt') continue;
    const zero = c.data.indexOf(0);
    const key = new TextDecoder('latin1').decode(c.data.subarray(0, zero)).toLowerCase();
    if (key === 'chara' || key === 'ccv3') found[key] = new TextDecoder('latin1').decode(c.data.subarray(zero + 1));
  }
  const raw = found.ccv3 || found.chara;
  if (!raw) throw new Error('No character data found in this PNG');
  return JSON.parse(b64ToUtf8(raw));
}

/** Returns a new PNG with the `chara` tEXt chunk replaced. */
export function writePngCard(buffer, cardJson) {
  const u8 = new Uint8Array(buffer);
  const keep = [];
  let iend = null;
  for (const c of pngChunks(u8)) {
    if (c.type === 'IEND') { iend = u8.subarray(c.start, c.end); break; }
    if (c.type === 'tEXt') {
      const zero = c.data.indexOf(0);
      const key = new TextDecoder('latin1').decode(c.data.subarray(0, zero)).toLowerCase();
      if (key === 'chara' || key === 'ccv3') continue;
    }
    keep.push(u8.subarray(c.start, c.end));
  }
  const payload = new TextEncoder().encode('chara\0' + utf8ToB64(JSON.stringify(cardJson)));
  const chunk = new Uint8Array(12 + payload.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, payload.length);
  chunk.set([116, 69, 88, 116], 4); // "tEXt"
  chunk.set(payload, 8);
  dv.setUint32(8 + payload.length, crc32(chunk.subarray(4, 8 + payload.length)));
  return new Blob([new Uint8Array(PNG_SIG), ...keep, chunk, iend], { type: 'image/png' });
}

// ---------- Format conversion ----------

const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const str = (v) => (v == null ? '' : String(v));

/** Normalizes a V2/V3 character_book or SillyTavern world-info JSON into our lorebook shape. */
export function lorebookFromJson(j, fallbackName = 'Imported Lorebook') {
  if (j?.spec && j.data) j = j.data; // wrapped
  const book = newLorebook({
    name: str(j.name) || fallbackName,
    description: str(j.description),
    scanDepth: j.scan_depth ?? 4,
    tokenBudget: j.token_budget ?? 1024,
    recursive: j.recursive_scanning ?? true,
  });
  const rawEntries = Array.isArray(j.entries) ? j.entries : Object.values(j.entries || {});
  book.entries = rawEntries.map((e, i) => {
    const ext = e.extensions || {};
    // ST world-info uses key/keysecondary/disable/order; V2 uses keys/secondary_keys/enabled/insertion_order
    const posNum = typeof ext.position === 'number' ? ext.position : e.position;
    let position = 'after_char';
    if (posNum === 0 || posNum === 'before_char') position = 'before_char';
    else if (posNum === 4 || posNum === 'depth') position = 'depth';
    const logicMap = { 0: 'AND_ANY', 1: 'NOT_ALL', 2: 'NOT_ANY', 3: 'AND_ALL' };
    return newEntry({
      comment: str(e.comment || e.name),
      keys: arr(e.keys ?? e.key).map(String).filter(Boolean),
      secondary_keys: arr(e.secondary_keys ?? e.keysecondary).map(String).filter(Boolean),
      selective: !!e.selective,
      selectiveLogic: logicMap[e.selectiveLogic ?? ext.selectiveLogic] || 'AND_ANY',
      content: str(e.content),
      constant: !!e.constant,
      enabled: e.enabled ?? !e.disable,
      order: e.insertion_order ?? e.order ?? 100 - i,
      position,
      depth: e.depth ?? ext.depth ?? 4,
      caseSensitive: !!(e.case_sensitive ?? ext.case_sensitive),
      wholeWords: ext.match_whole_words ?? e.matchWholeWords ?? true,
      probability: e.useProbability === false ? 100 : (e.probability ?? ext.probability ?? 100),
    });
  });
  return book;
}

/** V2 character_book export shape. */
export function lorebookToJson(book) {
  return {
    name: book.name, description: book.description, scan_depth: book.scanDepth,
    token_budget: book.tokenBudget, recursive_scanning: book.recursive, extensions: {},
    entries: book.entries.map((e, i) => ({
      id: i, keys: e.keys, secondary_keys: e.secondary_keys, comment: e.comment, content: e.content,
      constant: e.constant, selective: e.selective, insertion_order: e.order, enabled: e.enabled,
      position: e.position === 'before_char' ? 'before_char' : 'after_char', case_sensitive: e.caseSensitive,
      extensions: {
        position: { before_char: 0, after_char: 1, depth: 4 }[e.position], depth: e.depth,
        probability: e.probability, match_whole_words: e.wholeWords,
        selectiveLogic: { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 }[e.selectiveLogic],
      },
    })),
  };
}

/** Converts any Tavern V1/V2/V3 card JSON into our character shape. */
export function characterFromCard(card, avatar = '') {
  const d = card?.data && (card.spec || card.data.name) ? card.data : card;
  const ext = d.extensions || {};
  return newCharacter({
    name: str(d.name || d.char_name) || 'Unnamed',
    avatar,
    description: str(d.description || d.char_persona),
    personality: str(d.personality),
    scenario: str(d.scenario || d.world_scenario),
    first_mes: str(d.first_mes || d.char_greeting),
    alternate_greetings: arr(d.alternate_greetings).map(String),
    mes_example: str(d.mes_example || d.example_dialogue),
    system_prompt: str(d.system_prompt),
    post_history_instructions: str(d.post_history_instructions),
    creator_notes: str(d.creator_notes || d.creatorcomment),
    creator: str(d.creator),
    character_version: str(d.character_version),
    tags: arr(d.tags).map(String),
    talkativeness: Number(ext.talkativeness ?? d.talkativeness ?? 0.5) || 0.5,
    character_book: d.character_book ? lorebookFromJson(d.character_book, `${d.name}'s Lorebook`) : null,
  });
}

export function characterToCard(c) {
  return {
    spec: 'chara_card_v2', spec_version: '2.0',
    data: {
      name: c.name, description: c.description, personality: c.personality, scenario: c.scenario,
      first_mes: c.first_mes, mes_example: c.mes_example, creator_notes: c.creator_notes,
      system_prompt: c.system_prompt, post_history_instructions: c.post_history_instructions,
      alternate_greetings: c.alternate_greetings, tags: c.tags, creator: c.creator,
      character_version: c.character_version, extensions: { talkativeness: c.talkativeness },
      ...(c.character_book ? { character_book: lorebookToJson(c.character_book) } : {}),
    },
  };
}

// ---------- Images ----------

export function bufferToDataUrl(buf, mime = 'image/png') {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.readAsDataURL(new Blob([buf], { type: mime }));
  });
}

/** Downscales an image (data URL) so avatars don't bloat storage. */
export function resizeImage(dataUrl, max = 512, type = 'image/png') {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      res(cv.toDataURL(type, 0.9));
    };
    img.onerror = () => res(dataUrl);
    img.src = dataUrl;
  });
}

async function dataUrlToPngBuffer(dataUrl) {
  const png = dataUrl && dataUrl.startsWith('data:image/png') ? dataUrl : await resizeImage(dataUrl || blankAvatar(), 1024, 'image/png');
  return (await fetch(png)).arrayBuffer();
}

export function blankAvatar(name = '?') {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const g = cv.getContext('2d');
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  g.fillStyle = `hsl(${h} 45% 40%)`; g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#fff'; g.font = 'bold 120px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText((name[0] || '?').toUpperCase(), 128, 140);
  return cv.toDataURL('image/png');
}

export async function exportCharacterPng(c) {
  return writePngCard(await dataUrlToPngBuffer(c.avatar), characterToCard(c));
}

// ---------- File import ----------

/** Imports a file: PNG card, character JSON, or lorebook JSON. Returns { kind, item }. */
export async function importFile(file) {
  const buf = await file.arrayBuffer();
  const u8 = new Uint8Array(buf);
  if (isPng(u8)) {
    const card = readPngCard(buf);
    const avatar = await resizeImage(await bufferToDataUrl(buf), 512);
    return { kind: 'character', item: characterFromCard(card, avatar) };
  }
  const json = JSON.parse(new TextDecoder().decode(u8));
  const d = json.data || json;
  if (d.entries && d.first_mes === undefined && d.char_greeting === undefined) {
    return { kind: 'lorebook', item: lorebookFromJson(json, file.name.replace(/\.json$/i, '')) };
  }
  return { kind: 'character', item: characterFromCard(json, '') };
}

// ---------- Chub.ai ----------

const CHUB_API = 'https://api.chub.ai';

function chubHeaders(key) {
  const h = { Accept: 'application/json' };
  if (key) h['CH-API-KEY'] = key;
  return h;
}

/** Parses "https://chub.ai/characters/user/name" or "user/name" → { type, path } */
export function parseChubRef(input) {
  const s = input.trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  const m = s.match(/(?:chub\.ai|characterhub\.org)\/(characters|lorebooks)\/(.+)$/i);
  if (m) return { type: m[1].toLowerCase(), path: m[2] };
  const lm = s.match(/^lorebooks\/(.+)$/i);
  if (lm) return { type: 'lorebooks', path: lm[1] };
  return { type: 'characters', path: s.replace(/^characters\//i, '') };
}

const tagParam = (t) => (Array.isArray(t) ? t : String(t || '').split(',')).map((x) => x.trim()).filter(Boolean).join(',');

export async function chubSearch({ query = '', tags = [], excludeTags = [], page = 1, nsfw = false, sort = 'download_count', key = '' } = {}) {
  const p = new URLSearchParams({
    search: query, first: '24', page: String(page), sort, asc: 'false', nsfw: String(nsfw),
    nsfl: String(nsfw), include_forks: 'true', venus: 'false', chub: 'true',
  });
  if (tagParam(tags)) p.set('tags', tagParam(tags));
  if (tagParam(excludeTags)) p.set('exclude_tags', tagParam(excludeTags));
  const r = await request(`${CHUB_API}/search?${p}`, { headers: chubHeaders(key) });
  if (!r.ok) throw new Error(`Chub search failed (${r.status})`);
  const j = await r.json();
  const nodes = j?.data?.nodes || j?.nodes || [];
  return nodes.map((n) => ({
    source: 'chub', id: 'chub:' + n.fullPath,
    path: n.fullPath, name: n.name, tagline: n.tagline || '', stars: n.starCount || 0,
    downloads: n.nChats || n.downloadCount || 0, tags: n.topics || [],
    avatar: n.avatar_url || `https://avatars.charhub.io/avatars/${n.fullPath}/avatar.webp`,
  }));
}

/** Imports a character from Chub, preferring the full PNG card, falling back to the JSON API. */
export async function chubImportCharacter(path, key = '') {
  const headers = chubHeaders(key);
  try {
    const r = await request(`https://avatars.charhub.io/avatars/${path}/chara_card_v2.png`, { headers, binary: true });
    if (r.ok) {
      const buf = await r.arrayBuffer();
      const card = readPngCard(buf);
      const avatar = await resizeImage(await bufferToDataUrl(buf), 512);
      return characterFromCard(card, avatar);
    }
  } catch { /* fall through to API */ }

  const r = await request(`${CHUB_API}/api/characters/${path}?full=true`, { headers });
  if (!r.ok) throw new Error(`Chub character not found (${r.status})`);
  const node = (await r.json()).node;
  const def = node.definition || {};
  const ch = characterFromCard({
    name: def.name || node.name,
    description: def.personality, // Chub stores the card "description" in `personality`
    personality: def.tavern_personality,
    scenario: def.scenario, first_mes: def.first_message, mes_example: def.example_dialogs,
    system_prompt: def.system_prompt, post_history_instructions: def.post_history_instructions,
    alternate_greetings: def.alternate_greetings, creator_notes: def.description || node.tagline,
    tags: node.topics, creator: path.split('/')[0],
    character_book: def.embedded_lorebook || null,
  });
  const img = node.max_res_url || node.avatar_url;
  if (img) {
    try {
      const ir = await request(img, { binary: true });
      if (ir.ok) ch.avatar = await resizeImage(await bufferToDataUrl(await ir.arrayBuffer(), 'image/webp'), 512);
    } catch { /* avatar optional */ }
  }
  return ch;
}

export async function chubImportLorebook(path, key = '') {
  const headers = chubHeaders(key);
  const r = await request(`${CHUB_API}/api/lorebooks/${path}?full=true`, { headers });
  if (!r.ok) throw new Error(`Chub lorebook not found (${r.status})`);
  const node = (await r.json()).node;
  const def = node.definition || {};
  const raw = def.embedded_lorebook || (def.extensions && def.extensions.lorebook) || def;
  return lorebookFromJson({ ...raw, name: raw.name || node.name, description: raw.description || node.tagline }, node.name);
}

// ---------- Multi-site bot browsing ----------

/**
 * Sites searched by the bot browser. Each returns results shaped like chubSearch()
 * (source, id, name, tagline, avatar, tags, stars) and can import one of them.
 */
export const BOT_SOURCES = {
  chub: {
    label: 'Chub',
    search: (opts) => chubSearch(opts),
    importResult: (r, opts) => chubImportCharacter(r.path, opts.key),
  },
  botbooru: {
    label: 'Botbooru',
    search: (opts) => booruSearch(opts.botbooruUrl || 'https://botbooru.com', opts, 'botbooru'),
    importResult: (r) => booruImport(r),
  },
};

/** Searches every enabled source in parallel and interleaves the results. */
export async function browseSearch(opts, enabled = Object.keys(BOT_SOURCES)) {
  const ids = enabled.filter((id) => BOT_SOURCES[id]);
  const settled = await Promise.allSettled(ids.map((id) => BOT_SOURCES[id].search(opts)));
  const lists = settled.map((r) => (r.status === 'fulfilled' ? r.value : []));
  const errors = settled.map((r, i) => (r.status === 'rejected' ? { source: ids[i], error: r.reason } : null)).filter(Boolean);
  const merged = [];
  const seen = new Set();
  for (let i = 0; i < Math.max(0, ...lists.map((l) => l.length)); i++) {
    for (const l of lists) {
      const r = l[i];
      const key = r && `${r.name.toLowerCase()}|${(r.tagline || '').slice(0, 40).toLowerCase()}`;
      if (r && !seen.has(key)) { seen.add(key); merged.push(r); }
    }
  }
  // a source is "done" when it returned less than a full page
  const done = lists.every((l) => l.length < 24);
  return { results: merged, errors, done };
}

export const importBrowseResult = (r, opts) => BOT_SOURCES[r.source].importResult(r, opts);

// ---------- Chub account: personas ----------
// gateway.chub.ai is undocumented; endpoint and field names match what the Echo-RP
// project verified against a live account.

const CHUB_GATEWAY = 'https://gateway.chub.ai';

/** Lists the personas saved on the Chub account that owns `key`. */
export async function chubListPersonas(key) {
  if (!key) throw new Error('Add your Chub API key in Settings first');
  const r = await request(`${CHUB_GATEWAY}/api/personas`, { headers: chubHeaders(key) });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`Chub returned ${r.status} for personas${r.status === 401 || r.status === 403 ? ' (check your API key)' : ''}${detail ? ': ' + detail.slice(0, 120) : ''}`);
  }
  const body = await r.json();
  return (body?.personas ?? []).map((p) => ({
    chubId: p.id,
    name: p.persona_name || p.name || 'Persona',
    description: p.chat_profile ?? '',
    avatar: p.avatar ?? '',
    isDefault: !!p.is_default,
  }));
}

/** Best-effort persona picture download; returns a data URL or ''. */
export async function chubPersonaAvatar(avatar) {
  if (!avatar) return '';
  const url = /^https?:/i.test(avatar) ? avatar : `https://avatars.charhub.io/avatars/${String(avatar).replace(/^\/+/, '')}`;
  try {
    const r = await request(url, { binary: true });
    if (!r.ok) return '';
    const buf = await r.arrayBuffer();
    if (!buf.byteLength) return '';
    return await resizeImage(await bufferToDataUrl(buf, 'image/webp'), 512);
  } catch { return ''; }
}
