// Prompt assembly, lorebook activation, and the OpenAI-compatible generation client.
import { msgText } from './db.js';
import { request } from './native.js';

export const estimateTokens = (s) => Math.ceil((s || '').length / 3.6);

export function macros(text, { char = '', user = '', members = '' } = {}) {
  if (!text) return '';
  const now = new Date();
  return text
    .replace(/{{char}}|<BOT>/gi, char)
    .replace(/{{user}}|<USER>/gi, user)
    .replace(/{{members}}/gi, members)
    .replace(/{{time}}/gi, now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    .replace(/{{date}}/gi, now.toLocaleDateString())
    .replace(/{{random:([^}]*)}}/gi, (_, list) => { const o = list.split(','); return o[Math.floor(Math.random() * o.length)].trim(); })
    .replace(/{{roll:(\d*)d(\d+)}}/gi, (_, n, d) => { let t = 0; for (let i = 0; i < (+n || 1); i++) t += 1 + Math.floor(Math.random() * +d); return String(t); });
}

// ---------- Lorebooks ----------

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function keyMatches(key, text, entry) {
  const k = key.trim();
  if (!k) return false;
  const re = k.match(/^\/(.+)\/([gimsuy]*)$/);
  if (re) {
    try { return new RegExp(re[1], re[2]).test(text); } catch { return false; }
  }
  const flags = entry.caseSensitive ? '' : 'i';
  if (entry.wholeWords && /^[\w\s'-]+$/.test(k)) return new RegExp(`(^|\\W)${escapeRe(k)}(\\W|$)`, flags).test(text);
  return entry.caseSensitive ? text.includes(k) : text.toLowerCase().includes(k.toLowerCase());
}

function entryActive(entry, text) {
  if (!entry.enabled) return false;
  if (entry.constant) return true;
  if (!entry.keys.some((k) => keyMatches(k, text, entry))) return false;
  if (entry.selective && entry.secondary_keys.length) {
    const hits = entry.secondary_keys.map((k) => keyMatches(k, text, entry));
    switch (entry.selectiveLogic) {
      case 'AND_ALL': return hits.every(Boolean);
      case 'NOT_ANY': return !hits.some(Boolean);
      case 'NOT_ALL': return !hits.every(Boolean);
      default: return hits.some(Boolean);
    }
  }
  return true;
}

/**
 * Activates entries from the given lorebooks against recent chat text.
 * Returns { before: [], after: [], depth: [{depth, content}] }.
 */
export function scanLorebooks(books, messages, nameFn) {
  const out = { before: [], after: [], depth: [], activated: [] };
  if (!books.length) return out;
  const maxDepth = Math.max(...books.map((b) => b.scanDepth || 4));
  const recent = messages.slice(-maxDepth);
  const chosen = new Map();

  for (const book of books) {
    const scan = recent.slice(-(book.scanDepth || 4)).map((m) => `${nameFn(m)}: ${msgText(m)}`).join('\n');
    let text = scan;
    let pending = book.entries.filter((e) => !chosen.has(e.id));
    // recursive pass: activated content can trigger further entries
    for (let pass = 0; pass < (book.recursive ? 3 : 1); pass++) {
      const hits = pending.filter((e) => entryActive(e, text) && (e.probability >= 100 || Math.random() * 100 < e.probability));
      if (!hits.length) break;
      for (const e of hits) chosen.set(e.id, { e, budget: book.tokenBudget || 1024, book: book.id });
      text += '\n' + hits.map((e) => e.content).join('\n');
      pending = pending.filter((e) => !chosen.has(e.id));
    }
  }

  // sort by insertion order (higher = more important) and honour per-book token budgets
  const used = {};
  [...chosen.values()]
    .sort((a, b) => b.e.order - a.e.order)
    .forEach(({ e, budget, book }) => {
      const t = estimateTokens(e.content);
      if ((used[book] || 0) + t > budget) return;
      used[book] = (used[book] || 0) + t;
      out.activated.push(e);
      if (e.position === 'before_char') out.before.push(e.content);
      else if (e.position === 'depth') out.depth.push({ depth: e.depth, content: e.content });
      else out.after.push(e.content);
    });
  return out;
}

// ---------- Prompt building ----------

/**
 * Builds an OpenAI chat-completions messages array for `speaker` replying in `chat`.
 * opts: { settings, characters (map id->char), lorebooks (array of book objects), mode: 'reply'|'continue' }
 */
export function buildPrompt(chat, speaker, { settings, characters, books, history, mode = 'reply' }) {
  const persona = settings.persona;
  const userName = persona.name || 'User';
  const members = chat.characterIds.map((id) => characters[id]).filter(Boolean);
  const isGroup = members.length > 1;
  const ctx = { char: speaker.name, user: userName, members: members.map((m) => m.name).join(', ') };
  const M = (t) => macros(t, ctx);
  const nameOf = (m) => (m.role === 'user' ? userName : m.role === 'narrator' ? 'Narrator' : m.name || characters[m.charId]?.name || 'Character');

  const lore = scanLorebooks(books, history, nameOf);

  // --- System block ---
  const sys = [];
  sys.push(M(speaker.system_prompt || settings.prompts.main));
  if (isGroup) sys.push(M(settings.prompts.group));
  if (lore.before.length) sys.push(M(lore.before.join('\n')));

  const defs = (c) => {
    const p = [];
    if (c.description) p.push(macros(c.description, { ...ctx, char: c.name }));
    if (c.personality) p.push(`${c.name}'s personality: ${macros(c.personality, { ...ctx, char: c.name })}`);
    return p.join('\n');
  };
  if (isGroup) {
    sys.push(`<character name="${speaker.name}">\n${defs(speaker)}\n</character>`);
    for (const m of members) if (m.id !== speaker.id) sys.push(`<character name="${m.name}">\n${defs(m)}\n</character>`);
  } else {
    sys.push(defs(speaker));
  }

  const scenario = chat.scenario || speaker.scenario;
  if (scenario) sys.push(`Scenario: ${M(scenario)}`);
  if (persona.description) sys.push(`About ${userName}: ${M(persona.description)}`);
  if (lore.after.length) sys.push(M(lore.after.join('\n')));
  if (speaker.mes_example) {
    const ex = M(speaker.mes_example).replace(/<START>/gi, '').trim();
    if (ex) sys.push(`Example of how ${speaker.name} writes:\n${ex}`);
  }
  const system = sys.filter(Boolean).join('\n\n');

  // --- Trailing instructions ---
  const tail = [];
  const phi = speaker.post_history_instructions || settings.prompts.postHistory;
  if (phi) tail.push(M(phi));
  if (mode === 'continue') tail.push('[Continue ' + speaker.name + "'s last message from exactly where it stopped. Do not repeat it.]");
  if (isGroup) tail.push(`[Write the next reply only as ${speaker.name}.]`);

  // --- History within the context budget ---
  const gen = settings.gen;
  let budget = gen.context_size - gen.max_tokens - estimateTokens(system) - estimateTokens(tail.join('\n')) - 30;
  if (chat.authorNote) budget -= estimateTokens(chat.authorNote);
  lore.depth.forEach((d) => { budget -= estimateTokens(d.content); });

  const hist = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    const text = msgText(m);
    if (!text.trim()) continue;
    const content = isGroup || m.role === 'narrator' ? `${nameOf(m)}: ${text}` : text;
    const t = estimateTokens(content) + 4;
    if (t > budget && hist.length) break;
    budget -= t;
    const role = m.role === 'user' ? 'user' : m.role === 'narrator' ? 'system' : 'assistant';
    hist.unshift({ role, content });
  }

  // depth injections: depth 0 = after last message
  const inject = (depth, content) => {
    const idx = Math.max(0, hist.length - depth);
    hist.splice(idx, 0, { role: 'system', content });
  };
  lore.depth.forEach((d) => inject(d.depth, M(d.content)));
  if (chat.authorNote) inject(chat.authorNoteDepth ?? 4, `[Author's note: ${M(chat.authorNote)}]`);

  const messages = [{ role: 'system', content: system }, ...hist];
  if (tail.length) messages.push({ role: 'system', content: tail.join('\n') });
  // Many backends require the conversation to end on a user turn.
  if (messages[messages.length - 1].role === 'assistant' && mode !== 'continue') {
    messages.push({ role: 'user', content: settings.prompts.continueNudge });
  }

  const stop = [`\n${userName}:`, ...members.filter((m) => m.id !== speaker.id).map((m) => `\n${m.name}:`)].slice(0, 4);
  return { messages, stop, lore: lore.activated, otherNames: [userName, ...members.filter((m) => m.id !== speaker.id).map((m) => m.name)] };
}

/** Removes a leading "Name:" and cuts off text where the model starts speaking for others. */
export function cleanReply(text, speakerName, otherNames) {
  let t = text.replace(new RegExp(`^\\s*${escapeRe(speakerName)}:\\s*`), '');
  for (const n of otherNames) {
    const idx = t.search(new RegExp(`\\n\\s*${escapeRe(n)}:`));
    if (idx > 0) t = t.slice(0, idx);
  }
  return t.replace(/\s+$/, '');
}

// ---------- Generation ----------

function authHeaders(conn) {
  const h = { 'Content-Type': 'application/json' };
  if (conn.apiKey) {
    h.Authorization = `Bearer ${conn.apiKey}`;
    if (conn.provider === 'chub') h['CH-API-KEY'] = conn.apiKey;
  }
  if (conn.baseUrl.includes('openrouter.ai')) { h['HTTP-Referer'] = 'https://chatforge.app'; h['X-Title'] = 'ChatForge'; }
  return h;
}

const endpoint = (conn, path) => conn.baseUrl.replace(/\/+$/, '') + path;

/**
 * Streams (or not) a completion. onToken(fullTextSoFar) is called as text arrives.
 * Returns final text.
 */
export async function generate(conn, gen, { messages, stop }, { signal, onToken } = {}) {
  const body = {
    model: conn.model || undefined,
    messages,
    max_tokens: gen.max_tokens,
    temperature: gen.temperature,
    top_p: gen.top_p,
    frequency_penalty: gen.frequency_penalty || undefined,
    presence_penalty: gen.presence_penalty || undefined,
    stream: !!gen.stream,
    stop: stop && stop.length ? stop : undefined,
  };
  if (gen.min_p) body.min_p = gen.min_p;
  if (gen.repetition_penalty && gen.repetition_penalty !== 1) body.repetition_penalty = gen.repetition_penalty;

  const res = await request(endpoint(conn, '/chat/completions'), {
    method: 'POST', headers: authHeaders(conn), body: JSON.stringify(body), signal, stream: !!gen.stream,
  });
  if (!res.ok) {
    let msg = await res.text().catch(() => '');
    try { const j = JSON.parse(msg); msg = j.error?.message || j.message || j.detail || msg; } catch { /* raw */ }
    throw new Error(`API error ${res.status}: ${String(msg).slice(0, 400)}`);
  }

  let full = '';
  const handleData = (data) => {
    if (!data || data === '[DONE]') return;
    try {
      const j = JSON.parse(data);
      const c = j.choices?.[0];
      const piece = c?.delta?.content ?? c?.message?.content ?? c?.text ?? '';
      if (piece) { full += piece; onToken?.(full); }
    } catch { /* ignore keep-alives */ }
  };

  if (res.body) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) if (line.startsWith('data:')) handleData(line.slice(5).trim());
    }
    if (buf.startsWith('data:')) handleData(buf.slice(5).trim());
    if (full) return full;
  }

  // Non-streamed (or native fallback): body may be JSON or a full SSE transcript.
  const text = await res.text();
  if (/^\s*data:/m.test(text)) {
    text.split('\n').forEach((l) => { if (l.startsWith('data:')) handleData(l.slice(5).trim()); });
  } else {
    handleData(text);
  }
  return full;
}

export async function listModels(conn) {
  const res = await request(endpoint(conn, '/models'), { headers: authHeaders(conn) });
  if (!res.ok) throw new Error(`Could not list models (${res.status})`);
  const j = await res.json();
  return (j.data || j.models || []).map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean);
}

// ---------- Group turn selection ----------

/** Decides which characters reply after a user message. */
export function pickSpeakers(chat, characters, lastText, userName) {
  const active = chat.characterIds.filter((id) => !chat.mutedIds.includes(id)).map((id) => characters[id]).filter(Boolean);
  if (!active.length) return [];
  if (active.length === 1) return [active[0]];
  if (chat.groupMode === 'manual') return [];
  if (chat.groupMode === 'round') return active;

  // natural: mentioned characters reply first (in mention order), else weighted by talkativeness
  const lower = (lastText || '').toLowerCase();
  const mentioned = active
    .map((c) => ({ c, i: lower.search(new RegExp(`\\b${escapeRe(c.name.split(' ')[0].toLowerCase())}\\b`)) }))
    .filter((x) => x.i >= 0)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.c);
  if (mentioned.length) return mentioned;

  const lastSpeakerId = [...chat.messages].reverse().find((m) => m.role === 'char')?.charId;
  const pool = active.filter((c) => Math.random() < (c.talkativeness ?? 0.5) && c.id !== lastSpeakerId);
  if (pool.length) return [pool[Math.floor(Math.random() * pool.length)]];
  const others = active.filter((c) => c.id !== lastSpeakerId);
  return [(others.length ? others : active)[Math.floor(Math.random() * (others.length || active.length))]];
}
