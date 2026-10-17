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

/** A card's override replaces the global prompt; {{original}} inside it inserts the global one. */
const withOriginal = (override, original) => (override?.trim() ? override.replace(/{{original}}/gi, original || '') : original);

/** The chat's optional World and Story fields. */
function storyWorldBlocks(chat, M) {
  const out = [];
  if (chat.world?.trim()) out.push(`<world>\nThe world this story takes place in. Treat it as true, even where the character sheets don't mention it:\n${M(chat.world.trim())}\n</world>`);
  if (chat.story?.trim()) out.push(`<story>\nThe premise and broad direction of this story. Steer toward it over time, and don't rush it:\n${M(chat.story.trim())}\n</story>`);
  return out;
}

const norm = (s) => String(s || '').trim().toLowerCase();

/** Tracker entries worth showing now: pinned, present in the scene, or mentioned recently. */
export function relevantTrackerEntries(tracker, history, budgetTokens = 700) {
  const entries = tracker?.entries || [];
  if (!entries.length) return [];
  const recent = history.slice(-8).map((m) => msgText(m)).join('\n').toLowerCase();
  const present = new Set((tracker.scene?.present || []).map(norm));
  const mentioned = (e) => [e.name, ...(e.aliases || [])].some((n) => {
    const k = norm(n);
    return k.length > 1 && new RegExp(`(^|\\W)${escapeRe(k)}(\\W|$)`).test(recent);
  });
  const score = (e) => (e.pinned ? 3 : 0) + (present.has(norm(e.name)) ? 2 : 0) + (mentioned(e) ? 1 : 0);
  const picked = [];
  let used = 0;
  for (const e of entries.map((x) => ({ x, s: score(x) })).filter((y) => y.s > 0).sort((a, b) => b.s - a.s || (b.x.lastSeen || 0) - (a.x.lastSeen || 0))) {
    const t = estimateTokens(e.x.details) + 8;
    if (used + t > budgetTokens) continue;
    used += t;
    picked.push(e.x);
  }
  return picked;
}

/** The scene tracker's notes, formatted for the prompt. */
export function trackerBlock(chat, history) {
  const tr = chat.tracker;
  if (!tr || tr.enabled === false) return '';
  const sc = tr.scene || {};
  const lines = [];
  if (sc.location) lines.push(`Location: ${sc.location}`);
  if (sc.time) lines.push(`Time: ${sc.time}`);
  if (sc.present?.length) lines.push(`Present: ${sc.present.join(', ')}`);
  if (sc.situation) lines.push(`Situation: ${sc.situation}`);
  const ents = relevantTrackerEntries(tr, history);
  if (ents.length) {
    lines.push('People, places and things in play:');
    for (const e of ents) lines.push(`- ${e.name}${e.aliases?.length ? ` (also: ${e.aliases.join(', ')})` : ''} [${e.kind}]: ${e.details}`);
  }
  if (!lines.length) return '';
  return `<scene_notes>\nRunning notes on this story so far. Treat them as established facts unless the chat says otherwise:\n${lines.join('\n')}\n</scene_notes>`;
}

/** The persona's private section: reference for the writer, explicitly outside the story. */
function personaPrivateBlock(userName, text) {
  return `<user_private_background name="${userName}">
OUT-OF-CHARACTER REFERENCE ONLY. This is background on ${userName} for you, the writer, so you can portray them consistently. It is NOT part of the story so far:
- The characters do not know any of it, and none of it has been said, shown or used in the story.
- Never have a character mention, hint at, guess, or act on it, and never state or imply that ${userName} said, did, revealed or used any of it.
- It only becomes part of the story once ${userName} reveals or demonstrates it in the chat, and even then only the parts that actually came up.
${text}
</user_private_background>`;
}

/**
 * Builds an OpenAI chat-completions messages array for `speaker` replying in `chat`.
 * opts: { settings, characters (map id->char), lorebooks (array of book objects), mode: 'reply'|'continue' }
 */
export function buildPrompt(chat, speaker, { settings, characters, books, history, mode = 'reply', extraInstruction = '', direction = '' }) {
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
  sys.push(M(withOriginal(speaker.system_prompt, settings.prompts.main)));
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
  sys.push(...storyWorldBlocks(chat, M));
  if (persona.description) {
    sys.push(`<user_persona name="${userName}">\nWhat others can see or reasonably know about ${userName} (characters may notice and react to this):\n${M(persona.description)}\n</user_persona>`);
  }
  if (persona.private) sys.push(personaPrivateBlock(userName, M(persona.private)));
  if (lore.after.length) sys.push(M(lore.after.join('\n')));
  const tracked = trackerBlock(chat, history, nameOf);
  if (tracked) sys.push(tracked);
  if (speaker.mes_example) {
    const ex = M(speaker.mes_example).replace(/<START>/gi, '').trim();
    if (ex) sys.push(`Example of how ${speaker.name} writes:\n${ex}`);
  }
  const system = sys.filter(Boolean).join('\n\n');

  // --- Trailing instructions ---
  const tail = [];
  const phi = withOriginal(speaker.post_history_instructions, settings.prompts.postHistory);
  if (phi) tail.push(M(phi));
  if (persona.private) tail.push(`[Reminder: ${userName}'s private background is unknown to the characters. Nobody may mention, know or act on it, or claim ${userName} revealed it, unless it has actually come up in the chat.]`);
  if (mode === 'continue') tail.push('[Continue ' + speaker.name + "'s last message from exactly where it stopped. Do not repeat it.]");
  if (extraInstruction) tail.push(extraInstruction);
  if (direction) tail.push(`[Director's note for this reply: ${M(direction)}\nMake this happen in this reply, naturally and in character, as part of the story. Never mention the note itself.]`);
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
  // With no history yet (an opening post), some APIs reject a prompt that has no user turn.
  if (!hist.some((h) => h.role === 'user' || h.role === 'assistant')) messages.push({ role: 'user', content: '[Begin the story.]' });
  // If the last thing said wasn't the player's (an empty send, or the next speaker in a group round),
  // add a hidden out-of-character note so the model continues instead of waiting for input.
  // It is never stored or shown in the chat.
  const lastSaid = [...history].reverse().find((m) => msgText(m).trim());
  if (mode !== 'continue' && lastSaid && lastSaid.role !== 'user') messages.push({ role: 'user', content: M(settings.prompts.continueNudge) });
  if (tail.length) messages.push({ role: 'system', content: tail.join('\n') });

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

// ---------- Continuity check ----------

export const CONTINUITY_PROMPT = `You are a meticulous continuity editor for a collaborative roleplay between {{user}} (played by a human) and AI-written characters.

Compare the NEW REPLY against the established record: the character sheets, {{user}}'s persona, the lore, and the chat log. Flag only clear contradictions, such as:
- the reply claims someone (especially {{user}}) said, did, revealed, used or agreed to something that the chat log does not show
- a character knows something they never learned or witnessed in the log
- facts that conflict with the record: names, relationships, abilities, places, objects, injuries, clothing, time of day, who is present, what already happened
- the reply decides {{user}}'s actions, words, thoughts or feelings
- a character mentions, knows, hints at or acts on anything from {{user}}'s PRIVATE BACKGROUND that has not actually come up in the chat log, or claims {{user}} revealed, said or used it (the private background is out-of-character notes, not story)

Do NOT flag: new details that fit with the record, style or quality issues, reasonable inferences, or events that could have happened off-screen without conflicting with anything.

For each issue:
- "quote": the exact, shortest span copied verbatim from the NEW REPLY that contains the error
- "problem": one short sentence explaining what contradicts the record
- "fix": replacement text for that span that removes the contradiction, keeps the same voice, tense and flow, fits what has actually happened, and reads naturally when dropped in place of the quote

Respond with JSON only, no other text:
{"issues":[{"quote":"...","problem":"...","fix":"..."}]}
If the reply is consistent, respond {"issues":[]}.`;

/** Builds the messages for checking `reply` (spoken by `speaker`) against `history`. */
export function buildContinuityCheck(chat, speaker, reply, { settings, characters, books, history, direction = '' }) {
  const persona = settings.persona;
  const userName = persona.name || 'User';
  const members = chat.characterIds.map((id) => characters[id]).filter(Boolean);
  const ctx = { char: speaker.name, user: userName, members: members.map((m) => m.name).join(', ') };
  const M = (t) => macros(t, ctx);
  const nameOf = (m) => (m.role === 'user' ? userName : m.role === 'narrator' ? 'Narrator' : m.name || characters[m.charId]?.name || 'Character');
  const clip = (t, n) => (t.length > n ? t.slice(0, n) + '…' : t);

  const record = [];
  for (const c of members) {
    const sheet = [c.description, c.personality && `Personality: ${c.personality}`].filter(Boolean).join('\n');
    record.push(`### Character: ${c.name}\n${clip(macros(sheet, { ...ctx, char: c.name }), 2500)}`);
  }
  record.push(`### ${userName} (the human's character): public, visible to others\n${clip(M(persona.description || '(no description)'), 1500)}`);
  if (persona.private) {
    record.push(`### ${userName}: PRIVATE BACKGROUND (out-of-character notes; NOT known to the characters and NOT part of the story unless it appears in the chat log)\n${clip(M(persona.private), 1500)}`);
  }
  const scenario = chat.scenario || speaker.scenario;
  if (scenario) record.push(`### Scenario\n${clip(M(scenario), 1200)}`);
  if (chat.world?.trim()) record.push(`### World\n${clip(M(chat.world), 1500)}`);
  if (chat.story?.trim()) record.push(`### Story premise\n${clip(M(chat.story), 1000)}`);
  const notes = trackerBlock(chat, history);
  if (notes) record.push(`### Scene notes (kept automatically)\n${notes.replace(/<\/?scene_notes>/g, '').trim()}`);
  if (direction) record.push(`### Director's instruction for this reply\nThe human asked for this reply to do the following. Anything it introduces is intended and is NOT a contradiction:\n${M(direction)}`);
  const lore = scanLorebooks(books, [...history, { role: 'char', name: speaker.name, swipes: [reply], swipeIdx: 0 }], nameOf);
  if (lore.activated.length) record.push(`### Lore\n${clip(M(lore.activated.map((e) => e.content).join('\n')), 2500)}`);
  const header = record.join('\n\n');

  // Fit as much of the log as the context allows, newest first.
  let budget = settings.gen.context_size - 900 - estimateTokens(header) - estimateTokens(reply) - estimateTokens(CONTINUITY_PROMPT);
  const lines = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const line = `${nameOf(history[i])}: ${msgText(history[i])}`;
    const t = estimateTokens(line) + 2;
    if (t > budget) { lines.unshift('[…earlier messages omitted…]'); break; }
    budget -= t;
    lines.unshift(line);
  }

  return [
    { role: 'system', content: M(CONTINUITY_PROMPT) },
    { role: 'user', content: `## ESTABLISHED RECORD\n\n${header}\n\n## CHAT LOG (oldest first)\n\n${lines.join('\n\n') || '(no earlier messages)'}\n\n## NEW REPLY by ${speaker.name}\n\n${reply}\n\nList the continuity issues in the NEW REPLY as JSON.` },
  ];
}

/** Finds `quote` in `text`, tolerating whitespace, case and quote-mark differences. Returns [start, end] or null. */
export function locateQuote(text, quote) {
  if (!quote) return null;
  const i = text.indexOf(quote);
  if (i >= 0) return [i, i + quote.length];
  const words = quote.trim().split(/\s+/).map((w) => escapeRe(w).replace(/["“”]/g, '["“”]').replace(/['‘’]/g, "['‘’]"));
  if (!words.length) return null;
  const m = new RegExp(words.join('[\\s*_]+'), 'i').exec(text);
  return m ? [m.index, m.index + m[0].length] : null;
}

/** Parses the checker's answer; keeps only issues whose quote is actually in the reply. */
export function parseContinuity(raw, reply) {
  const cleaned = String(raw).replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error("The checker didn't return JSON");
  let j;
  try { j = JSON.parse(cleaned.slice(start, end + 1)); } catch { throw new Error("Couldn't read the checker's answer"); }
  const list = Array.isArray(j) ? j : j.issues;
  if (!Array.isArray(list)) throw new Error("Couldn't read the checker's answer");
  return list
    .filter((x) => x && typeof x.quote === 'string' && typeof x.fix === 'string')
    .map((x) => ({ quote: x.quote.trim(), problem: String(x.problem || '').trim(), fix: x.fix.trim() }))
    .filter((x) => x.quote && x.quote !== x.fix && locateQuote(reply, x.quote));
}

// ---------- Persona splitting ----------

export const PERSONA_SPLIT_PROMPT = `You sort a roleplay persona description into two sections.

PUBLIC: what other characters could see, hear or reasonably know on meeting this person: name, apparent age, appearance, clothing, voice, body language, obvious gear, demeanor, public role or reputation.
PRIVATE: what others would NOT know without being told or shown: secrets, hidden or unrevealed abilities and powers, past history, true motives, feelings and inner thoughts, relationships nobody has seen, anything the person is hiding.

Keep the original wording as much as possible; only move sentences between sections (split a sentence if it mixes both). Do not add, invent or drop information.
Respond with JSON only: {"public":"...","private":"..."}`;

export function parsePersonaSplit(raw) {
  const cleaned = String(raw).replace(/```(?:json)?/gi, '');
  const a = cleaned.indexOf('{');
  const b = cleaned.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error("The model didn't return JSON");
  const j = JSON.parse(cleaned.slice(a, b + 1));
  if (typeof j.public !== 'string' || typeof j.private !== 'string') throw new Error("Couldn't read the model's answer");
  return { public: j.public.trim(), private: j.private.trim() };
}

// ---------- Scene tracker ----------

export const TRACKER_PROMPT = `You keep running scene notes for an ongoing roleplay, so the writer can keep track of the scene and of everything that comes and goes.

Given the CURRENT NOTES and the NEW MESSAGES, return what changed, as JSON.

"scene": the scene as of the end of the new messages:
- "location": where the scene is now
- "time": time of day / date, if known
- "present": names of everyone currently in the scene, including {{user}} and the main characters
- "situation": one sentence on what is happening right now
Use "" (or []) for anything not known. Repeat unchanged values.

"entries": people (side characters / NPCs), places, objects, and facts that matter to the story, that are NEW in these messages or whose state CHANGED. Each entry:
- "kind": "character", "place", "object" or "fact"
- "name": the name used in the story; for unnamed ones, a short description ("the hooded stranger")
- "aliases": other names or descriptions used for the same thing
- "details": concise and factual, only what the story established: appearance, role, relationship to the cast, current state, where it is, who has it. When updating, give the complete updated details, not just the change.

Do NOT make entries for {{user}} or the main characters ({{members}}); they have their own sheets. Skip trivial things that won't matter later. Never invent anything the messages don't say.

Respond with JSON only:
{"scene":{"location":"","time":"","present":[],"situation":""},"entries":[{"kind":"","name":"","aliases":[],"details":""}]}`;

export function emptyTracker() {
  return { enabled: true, scene: { location: '', time: '', present: [], situation: '' }, entries: [], lastMsgId: null, updatedAt: 0 };
}

/** Messages for a tracker update covering everything after tracker.lastMsgId. */
export function buildTrackerUpdate(chat, { settings, characters }) {
  const tr = chat.tracker || emptyTracker();
  const userName = settings.persona.name || 'User';
  const members = chat.characterIds.map((id) => characters[id]).filter(Boolean);
  const nameOf = (m) => (m.role === 'user' ? userName : m.role === 'narrator' ? 'Narrator' : m.name || characters[m.charId]?.name || 'Character');
  const msgs = chat.messages.filter((m) => msgText(m).trim());
  let start = tr.lastMsgId ? msgs.findIndex((m) => m.id === tr.lastMsgId) + 1 : 0;
  if (start <= 0 && tr.lastMsgId) start = Math.max(0, msgs.length - 4); // marker message was deleted
  start = Math.max(start, msgs.length - 12);
  const fresh = msgs.slice(start);
  const before = msgs.slice(Math.max(0, start - 2), start);
  const fmtMsgs = (list) => list.map((m) => `${nameOf(m)}: ${msgText(m)}`).join('\n\n');
  const notes = {
    scene: tr.scene,
    entries: tr.entries.map(({ kind, name, aliases, details }) => ({ kind, name, aliases, details })),
  };
  const ctx = { user: userName, members: members.map((m) => m.name).join(', '), char: members[0]?.name || '' };
  return {
    lastMsgId: fresh.length ? fresh[fresh.length - 1].id : tr.lastMsgId,
    count: fresh.length,
    messages: [
      { role: 'system', content: macros(TRACKER_PROMPT, ctx) },
      { role: 'user', content: `## CURRENT NOTES\n${JSON.stringify(notes)}\n\n${before.length ? `## EARLIER (already in the notes)\n${fmtMsgs(before)}\n\n` : ''}## NEW MESSAGES\n${fmtMsgs(fresh)}\n\nReturn the JSON.` },
    ],
  };
}

export function parseTrackerUpdate(raw) {
  const cleaned = String(raw).replace(/```(?:json)?/gi, '');
  const a = cleaned.indexOf('{');
  const b = cleaned.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error("The tracker didn't return JSON");
  let j;
  try { j = JSON.parse(cleaned.slice(a, b + 1)); } catch { throw new Error("Couldn't read the tracker's answer"); }
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const sc = j.scene || {};
  return {
    scene: { location: str(sc.location), time: str(sc.time), present: Array.isArray(sc.present) ? sc.present.map(str).filter(Boolean) : [], situation: str(sc.situation) },
    entries: (Array.isArray(j.entries) ? j.entries : [])
      .filter((e) => e && str(e.name))
      .map((e) => ({
        kind: ['character', 'place', 'object', 'fact'].includes(str(e.kind)) ? str(e.kind) : 'fact',
        name: str(e.name), aliases: Array.isArray(e.aliases) ? e.aliases.map(str).filter(Boolean) : [], details: str(e.details),
      })),
  };
}

/** Merges an update into the tracker in place. Locked entries keep their details. */
export function mergeTracker(tr, update, { exclude = [], uid }) {
  const skip = new Set(exclude.map(norm));
  const sc = update.scene;
  for (const k of ['location', 'time', 'situation']) if (sc[k]) tr.scene[k] = sc[k];
  if (sc.present.length) tr.scene.present = sc.present;
  const now = Date.now();
  let added = 0;
  for (const e of update.entries) {
    if (skip.has(norm(e.name))) continue;
    const keys = [e.name, ...e.aliases].map(norm);
    const hit = tr.entries.find((x) => [x.name, ...(x.aliases || [])].map(norm).some((k) => keys.includes(k)));
    if (hit) {
      hit.aliases = [...new Set([...(hit.aliases || []), ...e.aliases, ...(norm(e.name) !== norm(hit.name) ? [e.name] : [])])].filter((a) => norm(a) !== norm(hit.name));
      if (!hit.locked && e.details) { hit.details = e.details; hit.kind = e.kind; }
      hit.lastSeen = now;
    } else {
      tr.entries.push({ id: uid(), ...e, pinned: false, locked: false, created: now, lastSeen: now });
      added++;
    }
  }
  tr.updatedAt = now;
  return added;
}

/** Extra instruction for the first message of a chat, written from the player's guidance. */
export function openingInstruction(speakerName, userName) {
  return `[This is the very first message of the story. Write ${speakerName}'s opening scene, starting exactly where the director's note says. Establish where and when it begins and what is happening, then leave ${userName} a natural moment to respond. Do not write ${userName}'s actions, words or thoughts.]`;
}
