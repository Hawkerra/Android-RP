import {
  db, uid, loadSettings, saveSettings, newCharacter, newLorebook, newEntry, newChat, newMessage, newPersona, msgText,
  CHUB_PRESETS, DEFAULT_PROMPTS,
} from './db.js';
import {
  importFile, exportCharacterPng, characterToCard, lorebookToJson, lorebookFromJson, blankAvatar, resizeImage,
  chubImportCharacter, chubImportLorebook, parseChubRef, browseSearch, importBrowseResult, BOT_SOURCES,
  chubListPersonas, chubPersonaAvatar,
} from './cards.js';
import {
  buildPrompt, generate, cleanReply, listModels, pickSpeakers, macros, estimateTokens,
  buildContinuityCheck, parseContinuity, locateQuote,
} from './engine.js';
import { saveFile, onBack, isNative } from './native.js';
import {
  $, $$, esc, fmt, timeAgo, toast, sheet, menu, confirmBox, promptBox, pickFile, readAsDataUrl,
  autoGrow, debounce, closeTopModal, ICON,
} from './ui.js';

const app = document.getElementById('app');

const S = {
  settings: null,
  chars: {},
  books: {},
  chats: {},
  personas: {},
  homeTab: 'chats',
  personaQuery: '',
  personaFolder: '*',   // '*' = all, '' = unfiled, otherwise a folder name
  abort: null,          // AbortController while generating
  genChatId: null,
  lastPrompt: null,
  openEntries: new Set(),
  editingMsg: null,
  chub: { warned: new Set(), query: '', tags: '', excludeTags: '', sort: 'download_count', page: 1, results: [], loading: false, done: false },
};

// ---------- persistence helpers ----------

const touch = (o) => { o.updated = Date.now(); return o; };
const saveChar = (c) => { S.chars[c.id] = touch(c); return db.put('characters', c); };
const saveBook = (b) => { S.books[b.id] = touch(b); return db.put('lorebooks', b); };
const saveChat = (c) => { S.chats[c.id] = touch(c); return db.put('chats', c); };
const savePersona = (p) => { S.personas[p.id] = touch(p); return db.put('personas', p); };
const persistSettings = debounce(() => saveSettings(S.settings), 300);

const sortByUpdated = (o) => Object.values(o).sort((a, b) => b.updated - a.updated);
const avatarOf = (c) => c?.avatar || blankAvatar(c?.name || '?');
const defaultPersona = () => S.personas[S.settings.activePersonaId] || sortByUpdated(S.personas)[0] || newPersona();
/** The persona the user plays in a chat (chat override, else the default). */
const personaFor = (chat) => S.personas[chat?.personaId] || defaultPersona();
const personaAvatar = (p) => p?.avatar || blankAvatar(p?.name || 'U');
const activeConn = () => S.settings.connections.find((c) => c.id === S.settings.activeConnectionId) || S.settings.connections[0];

function getPath(obj, path) { return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj); }
function setPath(obj, path, val) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
  target[last] = val;
}

/**
 * Two-way binds [data-bind] fields in `root` to `obj`.
 * data-type: num | bool | list (comma separated) ; onChange is called after each edit.
 */
function bindFields(root, obj, onChange) {
  for (const el of $$('[data-bind]', root)) {
    const path = el.dataset.bind;
    const type = el.dataset.type || (el.type === 'checkbox' ? 'bool' : el.type === 'number' || el.type === 'range' ? 'num' : 'text');
    const v = getPath(obj, path);
    if (type === 'bool') el.checked = !!v;
    else if (type === 'list') el.value = (v || []).join(', ');
    else el.value = v ?? '';
    const ev = el.tagName === 'SELECT' || type === 'bool' ? 'change' : 'input';
    el.addEventListener(ev, () => {
      let val = el.value;
      if (type === 'bool') val = el.checked;
      else if (type === 'num') val = el.value === '' ? 0 : Number(el.value);
      else if (type === 'list') val = el.value.split(',').map((s) => s.trim()).filter(Boolean);
      setPath(obj, path, val);
      const out = el.parentElement?.querySelector('output');
      if (out) out.textContent = val;
      if (el.tagName === 'TEXTAREA') autoGrow(el);
      onChange?.(path, val);
    });
    if (el.tagName === 'TEXTAREA' && !el.classList.contains('fixed')) requestAnimationFrame(() => autoGrow(el));
  }
}

// ---------- routing ----------

const HOME_TABS = ['chats', 'characters', 'personas', 'lorebooks', 'settings'];

const go = (h) => { location.hash = h; };
const parts = () => location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);

function route() {
  const [view, id, sub] = parts();
  app.onclick = null;
  app.className = '';
  window.scrollTo(0, 0);
  switch (view) {
    case 'chat': return S.chats[id] ? (sub === 'settings' ? viewChatSettings(S.chats[id]) : viewChat(S.chats[id])) : go('');
    case 'char': return S.chars[id] ? viewCharEditor(S.chars[id]) : go('');
    case 'lore': return viewLoreEditor(id);
    case 'chub': return viewChub();
    case 'persona': return S.personas[id] ? viewPersonaEditor(S.personas[id]) : go('/personas');
    default:
      if (HOME_TABS.includes(view)) S.homeTab = view;
      return viewHome();
  }
}

function header({ title, back = true, actions = '', sub = '' }) {
  return `<header class="top">${back ? `<button class="icon-btn" data-act="back" aria-label="Back">${ICON.back}</button>` : ''}
    <div class="title">${title}${sub ? `<small>${sub}</small>` : ''}</div><div class="actions">${actions}</div></header>`;
}

function handleActs(map) {
  app.onclick = (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || !app.contains(el)) return;
    const act = el.dataset.act;
    if (act === 'back') return history.length > 1 ? history.back() : go('');
    map[act]?.(el, e);
  };
}

// =====================================================================
// HOME
// =====================================================================

function viewHome() {
  const tab = S.homeTab;
  const titles = { chats: 'Chats', characters: 'Characters', personas: 'Personas', lorebooks: 'Lorebooks', settings: 'Settings' };
  const actions = {
    chats: '',
    characters: `<button class="icon-btn" data-act="chub" aria-label="Browse bots">${ICON.search}</button><button class="icon-btn" data-act="importChar" aria-label="Import">${ICON.upload}</button>`,
    lorebooks: `<button class="icon-btn" data-act="importBook" aria-label="Import">${ICON.upload}</button>`,
    personas: `<button class="icon-btn" data-act="folders" aria-label="Folders">${ICON.folder}</button><button class="icon-btn" data-act="importPersona" aria-label="Import">${ICON.upload}</button>`,
    settings: '',
  }[tab];
  const body = { chats: homeChats, characters: homeChars, personas: homePersonas, lorebooks: homeBooks, settings: homeSettings }[tab]();
  const tabBtn = (t, icon) => `<button class="tab ${tab === t ? 'on' : ''}" data-act="tab" data-tab="${t}">${icon}<span>${titles[t]}</span></button>`;
  app.innerHTML = `${header({ title: titles[tab], back: false, actions })}
    <main class="scroll pad-bottom" id="main">${body}</main>
    ${tab !== 'settings' ? `<button class="fab" data-act="new" aria-label="New">${ICON.plus}</button>` : ''}
    <nav class="tabs">${tabBtn('chats', ICON.chat)}${tabBtn('characters', ICON.people)}${tabBtn('personas', ICON.mask)}${tabBtn('lorebooks', ICON.book)}${tabBtn('settings', ICON.gear)}</nav>`;

  handleActs({
    tab: (el) => go('/' + el.dataset.tab),
    chub: () => go('/chub'),
    new: () => ({ chats: newChatFlow, characters: createCharacter, personas: createPersona, lorebooks: createBook })[tab](),
    openChat: (el) => go('/chat/' + el.dataset.id),
    chatMenu: (el, e) => { e.stopPropagation(); chatMenu(S.chats[el.dataset.id]); },
    openChar: (el) => go('/char/' + el.dataset.id),
    openBook: (el) => go('/lore/' + el.dataset.id),
    importChar: importCharMenu,
    importBook: importBookMenu,
    ...personaActs,
    ...settingsActs,
  });
  if (tab === 'settings') wireSettings();
  if (tab === 'personas') wirePersonas();
}

function avStack(ids) {
  const cs = ids.map((id) => S.chars[id]).filter(Boolean).slice(0, 3);
  return `<div class="av-stack n${cs.length}">${cs.map((c) => `<img src="${avatarOf(c)}" alt="">`).join('') || `<img src="${blankAvatar('?')}" alt="">`}</div>`;
}

const chatTitle = (chat) => chat.title || chat.characterIds.map((id) => S.chars[id]?.name || '(deleted)').join(', ') || 'Empty chat';

function homeChats() {
  const chats = sortByUpdated(S.chats);
  if (!chats.length) {
    return emptyState('No chats yet', Object.keys(S.chars).length
      ? 'Tap + to start a chat with one or more characters.'
      : 'Create or import a character first, then start a chat.');
  }
  return `<div class="list">${chats.map((c) => {
    const last = c.messages[c.messages.length - 1];
    const snippet = last ? `${last.role === 'user' ? 'You: ' : last.name ? last.name + ': ' : ''}${msgText(last)}` : 'No messages';
    return `<div class="row-item" data-act="openChat" data-id="${c.id}">${avStack(c.characterIds)}
      <div class="grow"><div class="ri-title">${esc(chatTitle(c))}${c.characterIds.length > 1 ? '<span class="badge">group</span>' : ''}</div>
      <div class="ri-sub">${esc(snippet.slice(0, 120))}</div></div>
      <div class="ri-side"><span class="muted small">${timeAgo(c.updated)}</span><button class="icon-btn sm" data-act="chatMenu" data-id="${c.id}" aria-label="Options">${ICON.more}</button></div></div>`;
  }).join('')}</div>`;
}

function homeChars() {
  const chars = sortByUpdated(S.chars);
  if (!chars.length) return emptyState('No characters yet', 'Tap + to create one, ⬆ to import a card (PNG/JSON), or 🔍 to browse Chub.');
  return `<div class="grid">${chars.map((c) => `<div class="card" data-act="openChar" data-id="${c.id}">
    <img src="${avatarOf(c)}" alt=""><div class="card-body"><div class="card-title">${esc(c.name)}</div>
    <div class="card-sub">${esc((c.creator_notes || c.description).slice(0, 80))}</div></div></div>`).join('')}</div>`;
}

function homeBooks() {
  const books = sortByUpdated(S.books);
  if (!books.length) return emptyState('No lorebooks yet', 'Lorebooks inject world info into the prompt when their keywords come up. Tap + to make one or ⬆ to import.');
  const global = new Set(S.settings.globalLorebookIds);
  return `<div class="list">${books.map((b) => `<div class="row-item" data-act="openBook" data-id="${b.id}">
    <div class="book-ic">${ICON.book}</div><div class="grow"><div class="ri-title">${esc(b.name)}${global.has(b.id) ? '<span class="badge">global</span>' : ''}</div>
    <div class="ri-sub">${b.entries.length} entries${b.description ? ' · ' + esc(b.description.slice(0, 80)) : ''}</div></div></div>`).join('')}</div>`;
}

const emptyState = (t, s) => `<div class="empty"><h2>${esc(t)}</h2><p>${esc(s)}</p></div>`;

// ---------- new chat ----------

function pickCharacters(title, exclude = [], okLabel = 'Start chat') {
  const chars = sortByUpdated(S.chars).filter((c) => !exclude.includes(c.id));
  if (!chars.length) { toast('No characters available'); return Promise.resolve(null); }
  const order = [];
  return sheet(`<h3>${esc(title)}</h3><input class="input" placeholder="Filter…" data-f>
    <div class="pick-list">${chars.map((c) => `<label class="pick" data-name="${esc(c.name.toLowerCase())}"><input type="checkbox" value="${c.id}"><img src="${avatarOf(c)}" alt=""><span>${esc(c.name)}</span><b class="ord"></b></label>`).join('')}</div>
    <label class="check"><input type="checkbox" data-allg> Add greetings from every character</label>
    <div class="row end"><button class="btn ghost" data-x="0">Cancel</button><button class="btn primary" data-x="1">${esc(okLabel)}</button></div>`,
  (el, close) => {
    el.querySelector('[data-f]').addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      $$('.pick', el).forEach((p) => { p.style.display = p.dataset.name.includes(q) ? '' : 'none'; });
    });
    el.addEventListener('change', (e) => {
      if (!e.target.value || e.target.type !== 'checkbox' || e.target.hasAttribute('data-allg')) return;
      const i = order.indexOf(e.target.value);
      if (e.target.checked && i < 0) order.push(e.target.value);
      if (!e.target.checked && i >= 0) order.splice(i, 1);
      $$('.pick', el).forEach((p) => { const n = order.indexOf(p.querySelector('input').value); p.querySelector('.ord').textContent = n >= 0 && order.length > 1 ? n + 1 : ''; });
    });
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-x]');
      if (!b) return;
      if (b.dataset.x === '0') return close(null);
      if (!order.length) return toast('Pick at least one character');
      close({ ids: [...order], allGreetings: el.querySelector('[data-allg]').checked });
    });
  });
}

function greetingMessage(c, userName = defaultPersona().name) {
  if (!c.first_mes && !c.alternate_greetings.length) return null;
  const ctx = { char: c.name, user: userName };
  const swipes = [c.first_mes, ...c.alternate_greetings].filter(Boolean).map((t) => macros(t, ctx));
  return newMessage({ role: 'char', charId: c.id, name: c.name, swipes });
}

async function startChat(ids, allGreetings = false) {
  const chat = newChat({ characterIds: ids });
  for (const id of allGreetings ? ids : ids.slice(0, 1)) {
    const g = greetingMessage(S.chars[id]);
    if (g) chat.messages.push(g);
  }
  await saveChat(chat);
  go('/chat/' + chat.id);
}

async function newChatFlow() {
  const r = await pickCharacters('New chat — pick characters');
  if (r) startChat(r.ids, r.allGreetings);
}

function chatMenu(chat) {
  menu(chatTitle(chat), [
    { label: 'Rename', run: async () => { const t = await promptBox('Chat title', chat.title); if (t != null) { chat.title = t.trim(); await saveChat(chat); route(); } } },
    { label: 'Duplicate', run: async () => { const c = { ...structuredClone(chat), id: uid(), title: chatTitle(chat) + ' (copy)', created: Date.now() }; await saveChat(c); route(); } },
    { label: 'Export (JSON)', run: () => exportChat(chat) },
    { label: 'Delete', danger: true, run: async () => { if (await confirmBox('Delete this chat?', 'Delete', true)) { await db.del('chats', chat.id); delete S.chats[chat.id]; route(); } } },
  ]);
}

function exportChat(chat) {
  const out = {
    title: chatTitle(chat), created: chat.created,
    characters: chat.characterIds.map((id) => S.chars[id]?.name),
    messages: chat.messages.map((m) => ({ name: nameOf(m, chat), role: m.role, text: msgText(m), time: m.time })),
  };
  saveFile(`${chatTitle(chat).replace(/[^\w-]+/g, '_').slice(0, 40)}.json`, new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
}

// ---------- character / lorebook creation & import ----------

async function createCharacter() {
  const c = newCharacter();
  await saveChar(c);
  go('/char/' + c.id);
}

async function createBook() {
  const b = newLorebook();
  await saveBook(b);
  go('/lore/' + b.id);
}

async function importFiles(files) {
  let n = 0;
  for (const f of files) {
    try {
      const { kind, item } = await importFile(f);
      if (kind === 'character') await saveChar(item); else await saveBook(item);
      n++;
    } catch (e) { toast(`${f.name}: ${e.message}`, 4000); }
  }
  if (n) { toast(`Imported ${n} file${n > 1 ? 's' : ''}`); route(); }
}

function importCharMenu() {
  menu('Import character', [
    { label: 'From file (PNG card or JSON)', run: async () => importFiles(await pickFile('.png,.json,image/png,application/json', true)) },
    { label: 'From Chub URL', run: () => chubUrlImport() },
    { label: 'Browse bots online', run: () => go('/chub') },
  ]);
}

function importBookMenu() {
  menu('Import lorebook', [
    { label: 'From file (JSON)', run: async () => importFiles(await pickFile('.json,application/json', true)) },
    { label: 'From Chub URL', run: () => chubUrlImport('lorebooks') },
  ]);
}

async function chubUrlImport(defType = 'characters') {
  const v = await promptBox('Chub link or path', '', { placeholder: `https://chub.ai/${defType}/creator/name` });
  if (!v) return;
  const ref = parseChubRef(v.includes('/') && !/^https?:/.test(v) && defType === 'lorebooks' && !v.startsWith('lorebooks/') ? 'lorebooks/' + v : v);
  toast('Importing from Chub…', 10000);
  try {
    if (ref.type === 'lorebooks') {
      const b = await chubImportLorebook(ref.path, chubKey());
      await saveBook(b);
      toast(`Imported lorebook “${b.name}”`);
      go('/lore/' + b.id);
    } else {
      const c = await chubImportCharacter(ref.path, chubKey());
      await saveChar(c);
      toast(`Imported ${c.name}`);
      go('/char/' + c.id);
    }
  } catch (e) { toast(chubError(e), 5000); }
}

const chubKey = () => S.settings.chubApiKey || S.settings.connections.find((c) => c.provider === 'chub' && c.apiKey)?.apiKey || '';
const chubError = (e) => (e instanceof TypeError ? 'Network error reaching Chub (in a desktop browser this is usually CORS — it works in the Android app).' : e.message);

// =====================================================================
// SETTINGS
// =====================================================================

function homeSettings() {
  const s = S.settings;
  const conns = s.connections.map((c) => `<div class="conn ${c.id === s.activeConnectionId ? 'on' : ''}" data-cid="${c.id}">
    <div class="conn-head"><label class="radio"><input type="radio" name="activeConn" value="${c.id}" ${c.id === s.activeConnectionId ? 'checked' : ''}><b>${esc(c.name || 'Connection')}</b></label>
      <button class="icon-btn sm" data-act="delConn" data-id="${c.id}" aria-label="Delete">${ICON.trash}</button></div>
    <div class="fields">
      <label>Name<input class="input" data-cbind="name" value="${esc(c.name)}"></label>
      <label>Preset<select class="input" data-act-preset>${['<option value="">— apply a preset —</option>', ...CHUB_PRESETS.map((p, i) => `<option value="${i}">${esc(p.label)}</option>`)].join('')}</select></label>
      <label>Type<select class="input" data-cbind="provider"><option value="chub" ${c.provider === 'chub' ? 'selected' : ''}>Chub</option><option value="openai" ${c.provider !== 'chub' ? 'selected' : ''}>OpenAI-compatible</option></select></label>
      <label>API URL<input class="input" data-cbind="baseUrl" value="${esc(c.baseUrl)}" inputmode="url" autocapitalize="off" spellcheck="false"></label>
      <label>API key<div class="row"><input class="input grow" type="password" data-cbind="apiKey" value="${esc(c.apiKey)}" autocomplete="off" autocapitalize="off" spellcheck="false"><button class="btn ghost sm" data-act="toggleKey">Show</button></div></label>
      <label>Model<input class="input" data-cbind="model" value="${esc(c.model)}" list="models-${c.id}" autocapitalize="off" spellcheck="false"><datalist id="models-${c.id}"></datalist></label>
      <div class="row"><button class="btn sm" data-act="fetchModels" data-id="${c.id}">Fetch models</button><button class="btn sm" data-act="testConn" data-id="${c.id}">Test</button></div>
    </div></div>`).join('');

  const books = sortByUpdated(S.books);
  const num = (path, label, min, max, step) => `<label class="slider">${label}<output>${getPath(s, path)}</output><input type="range" min="${min}" max="${max}" step="${step}" data-bind="${path}"></label>`;
  return `
  <section class="panel"><h2>API connection</h2>
    <p class="hint">Paste your Chub API key below (from chub.ai → Account → API Key). You can also add any OpenAI-compatible endpoint (OpenRouter, a local KoboldCPP / text-gen-webui server, etc.).</p>
    ${conns}<button class="btn" data-act="addConn">${ICON.plus} Add connection</button></section>

  <section class="panel"><h2>Generation</h2>
    ${num('gen.temperature', 'Temperature', 0, 2, 0.05)}
    ${num('gen.max_tokens', 'Max response tokens', 50, 2000, 10)}
    ${num('gen.context_size', 'Context size (tokens)', 1024, 131072, 1024)}
    ${num('gen.top_p', 'Top P', 0, 1, 0.01)}
    ${num('gen.min_p', 'Min P (0 = off)', 0, 0.5, 0.01)}
    ${num('gen.repetition_penalty', 'Repetition penalty', 1, 1.5, 0.01)}
    ${num('gen.frequency_penalty', 'Frequency penalty', -2, 2, 0.05)}
    ${num('gen.presence_penalty', 'Presence penalty', -2, 2, 0.05)}
    <label class="check"><input type="checkbox" data-bind="gen.stream"> Stream responses</label></section>

  <section class="panel"><h2>Default persona</h2>
    <div class="row"><img class="persona-av" src="${personaAvatar(defaultPersona())}" alt=""><div class="grow"><b>${esc(defaultPersona().name)}</b>
      <div class="muted small">Used in new chats. Each chat can pick its own persona.</div></div>
      <button class="btn sm" data-act="tab" data-tab="personas">Manage</button></div></section>

  <section class="panel"><h2>Chat background</h2>
    <label class="check"><input type="checkbox" data-bind="chatBg.enabled"> Show the character's image behind the chat</label>
    ${num('chatBg.blur', 'Blur', 0, 40, 1)}
    ${num('chatBg.dim', 'Darken', 0, 0.9, 0.05)}</section>

  <section class="panel"><h2>Continuity check</h2>
    <p class="hint">After each reply, a second request checks it against the chat so far and flags contradictions, like the bot claiming you did or said something you never did, with a suggested fix.</p>
    <label>When to check<select class="input" data-bind="continuity.mode">
      <option value="auto">Automatically after every reply</option>
      <option value="manual">Only when I ask (message menu → Check continuity)</option>
      <option value="off">Off</option></select></label>
    <label>Connection for checks<select class="input" data-bind="continuity.connectionId">
      <option value="">Same as chat</option>${s.connections.map((c) => `<option value="${c.id}">${esc(c.name || c.baseUrl)}</option>`).join('')}</select></label>
    <label>Model override<input class="input" data-bind="continuity.model" placeholder="Leave empty to use the connection's model" autocapitalize="off" spellcheck="false"></label>
  </section>

  <section class="panel"><h2>Prompts</h2>
    <p class="hint">Macros: {{char}}, {{user}}, {{members}}, {{time}}, {{date}}, {{random:a,b,c}}, {{roll:2d6}}</p>
    <label>Main system prompt<textarea class="input" rows="4" data-bind="prompts.main"></textarea></label>
    <label>Group chat instruction<textarea class="input" rows="3" data-bind="prompts.group"></textarea></label>
    <label>Post-history instruction (jailbreak / style)<textarea class="input" rows="2" data-bind="prompts.postHistory"></textarea></label>
    <label>Nudge when nobody has spoken<textarea class="input" rows="2" data-bind="prompts.continueNudge"></textarea></label>
    <button class="btn ghost sm" data-act="resetPrompts">Reset prompts to default</button></section>

  <section class="panel"><h2>Chub</h2>
    <label>Chub API key for browsing / importing<input class="input" type="password" data-bind="chubApiKey" placeholder="Leave empty to reuse your Chub connection key" autocomplete="off"></label>
    <label class="check"><input type="checkbox" data-bind="showNsfw"> Show NSFW results when browsing</label></section>

  <section class="panel"><h2>Botbooru</h2>
    <label>Site address<input class="input" data-bind="botbooruUrl" inputmode="url" autocapitalize="off" spellcheck="false"></label>
    <p class="hint">Searched alongside Chub in the bot browser. Works with any booru-style site (Danbooru, Gelbooru, Moebooru, Szurubooru or Philomena software).</p></section>

  <section class="panel"><h2>Global lorebooks</h2><p class="hint">Active in every chat.</p>
    ${books.length ? books.map((b) => `<label class="check"><input type="checkbox" data-globalbook value="${b.id}" ${s.globalLorebookIds.includes(b.id) ? 'checked' : ''}> ${esc(b.name)}</label>`).join('') : '<p class="muted">No lorebooks yet.</p>'}</section>

  <section class="panel"><h2>Data</h2>
    <div class="row wrap"><button class="btn" data-act="backup">Export backup</button><button class="btn" data-act="restore">Import backup</button><button class="btn danger" data-act="wipe">Erase everything</button></div>
    <p class="hint">Everything is stored only on this device.${isNative ? '' : ' (Running in browser mode.)'}</p></section>
  <p class="muted center small">ChatForge 1.0</p>`;
}

function wireSettings() {
  const s = S.settings;
  const main = $('#main');
  bindFields(main, s, () => persistSettings());
  main.addEventListener('input', (e) => {
    const el = e.target.closest('[data-cbind]');
    if (!el) return;
    const conn = s.connections.find((c) => c.id === el.closest('[data-cid]').dataset.cid);
    conn[el.dataset.cbind] = el.value.trim();
    if (el.dataset.cbind === 'name') el.closest('.conn').querySelector('.conn-head b').textContent = el.value || 'Connection';
    persistSettings();
  });
  main.addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'activeConn') { s.activeConnectionId = t.value; persistSettings(); $$('.conn', main).forEach((c) => c.classList.toggle('on', c.dataset.cid === t.value)); }
    if (t.hasAttribute('data-act-preset') && t.value !== '') {
      const p = CHUB_PRESETS[+t.value];
      const conn = s.connections.find((c) => c.id === t.closest('[data-cid]').dataset.cid);
      Object.assign(conn, { provider: p.provider, baseUrl: p.baseUrl, model: p.model, name: conn.name || p.label });
      persistSettings();
      viewHome();
    }
    if (t.hasAttribute('data-cbind') && t.tagName === 'SELECT') {
      s.connections.find((c) => c.id === t.closest('[data-cid]').dataset.cid).provider = t.value; persistSettings();
    }
    if (t.hasAttribute('data-globalbook')) {
      s.globalLorebookIds = $$('[data-globalbook]:checked', main).map((x) => x.value); persistSettings();
    }
  });
}

const settingsActs = {
  addConn: () => {
    const p = CHUB_PRESETS[0];
    const c = { id: uid(), name: 'New connection', provider: p.provider, baseUrl: p.baseUrl, model: p.model, apiKey: '' };
    S.settings.connections.push(c);
    if (!S.settings.activeConnectionId) S.settings.activeConnectionId = c.id;
    persistSettings.flush(); viewHome();
  },
  delConn: async (el) => {
    if (S.settings.connections.length <= 1) return toast('Keep at least one connection');
    if (!(await confirmBox('Delete this connection?', 'Delete', true))) return;
    S.settings.connections = S.settings.connections.filter((c) => c.id !== el.dataset.id);
    if (S.settings.activeConnectionId === el.dataset.id) S.settings.activeConnectionId = S.settings.connections[0].id;
    persistSettings.flush(); viewHome();
  },
  toggleKey: (el) => { const i = el.previousElementSibling; i.type = i.type === 'password' ? 'text' : 'password'; el.textContent = i.type === 'password' ? 'Show' : 'Hide'; },
  fetchModels: async (el) => {
    const conn = S.settings.connections.find((c) => c.id === el.dataset.id);
    try {
      const models = await listModels(conn);
      $(`#models-${conn.id}`).innerHTML = models.map((m) => `<option value="${esc(m)}">`).join('');
      toast(models.length ? `${models.length} models found — tap the Model field to choose` : 'No models returned');
    } catch (e) { toast(e.message, 4000); }
  },
  testConn: async (el) => {
    const conn = S.settings.connections.find((c) => c.id === el.dataset.id);
    el.disabled = true; el.textContent = 'Testing…';
    try {
      const out = await generate(conn, { ...S.settings.gen, max_tokens: 20, stream: false }, { messages: [{ role: 'user', content: 'Reply with just the word: OK' }] });
      toast(out ? `✓ Connected — model said: ${out.slice(0, 60)}` : '✓ Connected, but the reply was empty', 4000);
    } catch (e) { toast(e instanceof TypeError ? 'Network error (CORS or unreachable host)' : e.message, 5000); }
    el.disabled = false; el.textContent = 'Test';
  },
  resetPrompts: async () => {
    if (!(await confirmBox('Reset all prompts to their defaults?'))) return;
    S.settings.prompts = { ...DEFAULT_PROMPTS }; persistSettings.flush(); viewHome();
  },
  backup: async () => {
    const data = { app: 'chatforge', version: 1, exported: Date.now(), settings: S.settings, characters: Object.values(S.chars), lorebooks: Object.values(S.books), chats: Object.values(S.chats), personas: Object.values(S.personas) };
    await saveFile(`chatforge-backup-${new Date().toISOString().slice(0, 10)}.json`, new Blob([JSON.stringify(data)], { type: 'application/json' }));
    toast('Backup contains your API keys — keep it private.', 4000);
  },
  restore: async () => {
    const f = await pickFile('.json,application/json');
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (d.app !== 'chatforge') throw new Error('Not a ChatForge backup');
      if (!(await confirmBox(`Import ${d.characters.length} characters, ${d.lorebooks.length} lorebooks and ${d.chats.length} chats? Items with the same ID are overwritten.`, 'Import'))) return;
      for (const c of d.characters) await saveChar(c);
      for (const b of d.lorebooks) await saveBook(b);
      for (const c of d.chats) await saveChat(c);
      for (const p of d.personas || []) await savePersona(p);
      if (d.settings) { S.settings = { ...S.settings, ...d.settings }; await saveSettings(S.settings); }
      toast('Backup imported'); viewHome();
    } catch (e) { toast(e.message, 4000); }
  },
  wipe: async () => {
    if (!(await confirmBox('Erase ALL characters, lorebooks, chats and settings? This cannot be undone.', 'Erase everything', true))) return;
    for (const s of ['characters', 'lorebooks', 'chats', 'personas', 'kv']) await db.clear(s);
    location.reload();
  },
};

// =====================================================================
// PERSONAS
// =====================================================================

const folderList = () => [...new Set([...S.settings.personaFolders, ...Object.values(S.personas).map((p) => p.folder).filter(Boolean)])].sort((a, b) => a.localeCompare(b));

function personaMatches(p, q) {
  return !q || [p.name, p.description, p.folder].join(' ').toLowerCase().includes(q);
}

function personaRows(list) {
  const def = defaultPersona().id;
  return list.map((p) => `<div class="row-item" data-act="openPersona" data-id="${p.id}">
    <img class="p-av" src="${personaAvatar(p)}" alt=""><div class="grow"><div class="ri-title">${esc(p.name)}${p.id === def ? '<span class="badge accent">default</span>' : ''}${p.source === 'chub' ? '<span class="badge">chub</span>' : ''}</div>
    <div class="ri-sub">${esc(p.description.slice(0, 110)) || '<span class="muted">No description</span>'}</div></div>
    <button class="icon-btn sm" data-act="personaMenu" data-id="${p.id}" aria-label="Options">${ICON.more}</button></div>`).join('');
}

/** List body for the personas tab, honouring the search box and folder filter. */
function personaListHtml() {
  const q = S.personaQuery.trim().toLowerCase();
  const f = S.personaFolder;
  const all = Object.values(S.personas).sort((a, b) => a.name.localeCompare(b.name));
  const inFolder = all.filter((p) => (f === '*' || (p.folder || '') === f) && personaMatches(p, q));
  if (!inFolder.length) return `<p class="muted center pad">${q ? 'No personas match your search.' : 'No personas in this folder.'}</p>`;
  if (f !== '*' || q) return `<div class="list">${personaRows(inFolder)}</div>`;
  // "All" without a search: group by folder
  const groups = [...folderList().map((name) => [name, inFolder.filter((p) => p.folder === name)]), ['', inFolder.filter((p) => !p.folder)]];
  return groups.filter(([, ps]) => ps.length).map(([name, ps]) => `<div class="folder-head" data-act="pickFolder" data-folder="${esc(name)}">${ICON.folder}<span>${esc(name || 'Unfiled')}</span><span class="muted small">${ps.length}</span></div>
    <div class="list">${personaRows(ps)}</div>`).join('');
}

function homePersonas() {
  const chip = (val, label) => `<button class="chip ${S.personaFolder === val ? 'on' : ''}" data-act="pickFolder" data-folder="${esc(val)}">${esc(label)}</button>`;
  return `<div class="pad sticky-search"><input class="input" id="personaSearch" type="search" placeholder="Search personas…" value="${esc(S.personaQuery)}"></div>
    <div class="chips">${chip('*', 'All')}${folderList().map((f) => chip(f, f)).join('')}${chip('', 'Unfiled')}<button class="chip add" data-act="newFolder">${ICON.plus} Folder</button></div>
    <div id="personaList">${personaListHtml()}</div>`;
}

function wirePersonas() {
  $('#personaSearch').addEventListener('input', (e) => {
    S.personaQuery = e.target.value;
    $('#personaList').innerHTML = personaListHtml();
  });
}

async function createPersona() {
  const folder = S.personaFolder === '*' ? '' : S.personaFolder;
  const p = newPersona({ name: 'New Persona', folder });
  await savePersona(p);
  go('/persona/' + p.id);
}

async function newFolderPrompt() {
  const name = (await promptBox('New folder', '', { placeholder: 'e.g. Fantasy' }))?.trim();
  if (!name) return null;
  if (!S.settings.personaFolders.includes(name)) S.settings.personaFolders.push(name);
  persistSettings.flush();
  return name;
}

async function moveToFolder(p) {
  let pick = null; // set synchronously by the chosen item, before menu() resolves
  await menu(`Move “${p.name}” to…`, [
    { label: 'Unfiled', run: () => { pick = ''; } },
    ...folderList().map((f) => ({ label: f + (p.folder === f ? '  ✓' : ''), run: () => { pick = f; } })),
    { label: '+ New folder…', run: () => { pick = newFolderPrompt(); } },
  ]);
  const choice = await pick;
  if (choice == null) return false;
  p.folder = choice;
  await savePersona(p);
  return true;
}

function manageFolders() {
  const folders = folderList();
  menu('Persona folders', [
    { label: '+ New folder', run: async () => { await newFolderPrompt(); viewHome(); } },
    ...folders.map((f) => ({ label: `${f}  (${Object.values(S.personas).filter((p) => p.folder === f).length})`, run: () => menu(f, [
      { label: 'Rename', run: async () => {
        const n = (await promptBox('Rename folder', f))?.trim();
        if (!n || n === f) return;
        S.settings.personaFolders = [...new Set(S.settings.personaFolders.map((x) => (x === f ? n : x)).concat(n))];
        for (const p of Object.values(S.personas)) if (p.folder === f) { p.folder = n; await savePersona(p); }
        if (S.personaFolder === f) S.personaFolder = n;
        persistSettings.flush(); viewHome();
      } },
      { label: 'Delete folder (personas become unfiled)', danger: true, run: async () => {
        S.settings.personaFolders = S.settings.personaFolders.filter((x) => x !== f);
        for (const p of Object.values(S.personas)) if (p.folder === f) { p.folder = ''; await savePersona(p); }
        if (S.personaFolder === f) S.personaFolder = '*';
        persistSettings.flush(); viewHome();
      } },
    ]) })),
  ]);
}

function personaMenu(p) {
  menu(p.name, [
    { label: 'Set as default', run: () => { S.settings.activePersonaId = p.id; persistSettings.flush(); viewHome(); } },
    { label: 'Move to folder…', run: async () => { if (await moveToFolder(p)) viewHome(); } },
    { label: 'Duplicate', run: async () => { await savePersona({ ...structuredClone(p), id: uid(), name: p.name + ' (copy)', created: Date.now() }); viewHome(); } },
    { label: 'Delete', danger: true, run: () => deletePersona(p) },
  ]);
}

async function deletePersona(p) {
  if (Object.keys(S.personas).length <= 1) return toast('Keep at least one persona');
  if (!(await confirmBox(`Delete persona “${p.name}”? Chats using it switch to your default persona.`, 'Delete', true))) return false;
  await db.del('personas', p.id);
  delete S.personas[p.id];
  if (S.settings.activePersonaId === p.id) { S.settings.activePersonaId = sortByUpdated(S.personas)[0].id; persistSettings.flush(); }
  if (parts()[0] === 'persona') go('/personas'); else viewHome();
  return true;
}

function exportPersonas() {
  const data = { app: 'chatforge', kind: 'personas', personas: Object.values(S.personas).map(({ name, description, avatar, folder }) => ({ name, description, avatar, folder })) };
  saveFile('chatforge-personas.json', new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
}

/** Imports ChatForge persona exports, single persona JSON, or SillyTavern persona backups. */
async function importPersonasFile() {
  const f = await pickFile('.json,application/json');
  if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    let list = [];
    if (Array.isArray(j)) list = j;
    else if (Array.isArray(j.personas)) list = j.personas;
    else if (j.personas && typeof j.personas === 'object') {
      // SillyTavern: { personas: {file: name}, persona_descriptions: {file: {description}} }
      list = Object.entries(j.personas).map(([file, name]) => ({ name, description: j.persona_descriptions?.[file]?.description || '' }));
    } else if (j.name) list = [j];
    if (!list.length) throw new Error('No personas found in that file');
    const folder = S.personaFolder === '*' ? '' : S.personaFolder;
    for (const x of list) {
      await savePersona(newPersona({ name: String(x.name || 'Persona'), description: String(x.description || ''), avatar: x.avatar || '', folder: x.folder ?? folder }));
    }
    toast(`Imported ${list.length} persona${list.length > 1 ? 's' : ''}`);
    viewHome();
  } catch (e) { toast(e.message, 4000); }
}

/** Pulls the personas saved on the user's Chub account. Re-running updates them in place. */
async function importChubPersonas() {
  toast('Fetching your Chub personas…', 15000);
  let list;
  try { list = await chubListPersonas(chubKey()); } catch (e) { return toast(chubError(e), 6000); }
  if (!list.length) return toast('No personas found on your Chub account');
  const byChubId = new Map(Object.values(S.personas).filter((p) => p.chubId != null).map((p) => [String(p.chubId), p]));
  let added = 0; let updated = 0;
  for (const cp of list) {
    toast(`Importing ${cp.name}… (${added + updated + 1}/${list.length})`, 15000);
    const existing = byChubId.get(String(cp.chubId));
    const avatar = await chubPersonaAvatar(cp.avatar);
    if (existing) {
      Object.assign(existing, { name: cp.name, description: cp.description, ...(avatar ? { avatar } : {}) });
      await savePersona(existing); updated++;
    } else {
      await savePersona(newPersona({ name: cp.name, description: cp.description, avatar, folder: 'Chub', source: 'chub', chubId: cp.chubId }));
      added++;
    }
  }
  if (!S.settings.personaFolders.includes('Chub')) { S.settings.personaFolders.push('Chub'); persistSettings.flush(); }
  toast(`Chub personas: ${added} added${updated ? `, ${updated} updated` : ''}`, 4000);
  viewHome();
}

const personaActs = {
  openPersona: (el, e) => { if (!e.target.closest('[data-act=personaMenu]')) go('/persona/' + el.dataset.id); },
  personaMenu: (el, e) => { e.stopPropagation(); personaMenu(S.personas[el.dataset.id]); },
  pickFolder: (el) => { S.personaFolder = el.dataset.folder; viewHome(); },
  newFolder: async () => { const n = await newFolderPrompt(); if (n) { S.personaFolder = n; viewHome(); } },
  folders: manageFolders,
  importPersona: () => menu('Personas', [
    { label: 'Import from my Chub account', run: importChubPersonas },
    { label: 'Import from file (JSON)', run: importPersonasFile },
    { label: 'Export all personas', run: exportPersonas },
  ]),
};

function viewPersonaEditor(p) {
  const save = debounce(() => savePersona(p), 400);
  const isDefault = () => defaultPersona().id === p.id;
  const folderOpts = () => `<option value="">Unfiled</option>${folderList().map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('')}<option value="__new">+ New folder…</option>`;
  app.innerHTML = `${header({ title: esc(p.name), sub: 'Persona', actions: `<button class="icon-btn" data-act="more" aria-label="More">${ICON.more}</button>` })}
  <main class="scroll pad-bottom" id="main">
    <div class="char-head"><img class="big-av round" src="${personaAvatar(p)}" data-act="avatar" alt="Avatar — tap to change"><div class="grow">
      <label>Name<input class="input" data-bind="name"></label>
      <label>Folder<select class="input" id="folderSel">${folderOpts()}</select></label></div></div>
    <section class="panel">
      <label>Description<span class="hint">Who you are in the roleplay: appearance, personality, background. Sent to the model as “About {{user}}”.</span><textarea class="input" rows="8" data-bind="description"></textarea></label>
      <button class="btn ${isDefault() ? 'ghost' : ''}" data-act="makeDefault" ${isDefault() ? 'disabled' : ''}>${isDefault() ? '✓ Default persona' : 'Set as default persona'}</button>
    </section>
  </main>`;
  const sel = $('#folderSel');
  sel.value = p.folder || '';
  sel.addEventListener('change', async () => {
    if (sel.value === '__new') {
      const n = await newFolderPrompt();
      if (n) p.folder = n;
      sel.innerHTML = folderOpts();
      sel.value = p.folder || '';
    } else p.folder = sel.value;
    save.flush();
  });
  bindFields($('#main'), p, (path) => { if (path === 'name') $('.top .title').firstChild.textContent = p.name; save(); });
  handleActs({
    avatar: async () => {
      const f = await pickFile('image/*');
      if (!f) return;
      p.avatar = await resizeImage(await readAsDataUrl(f), 512);
      await savePersona(p); $('.big-av').src = p.avatar;
    },
    makeDefault: () => { S.settings.activePersonaId = p.id; persistSettings.flush(); viewPersonaEditor(p); toast(`${p.name} is now your default persona`); },
    more: () => menu(p.name, [
      { label: 'Duplicate', run: async () => { const d = { ...structuredClone(p), id: uid(), name: p.name + ' (copy)', created: Date.now() }; await savePersona(d); go('/persona/' + d.id); } },
      { label: 'Delete persona', danger: true, run: () => deletePersona(p) },
    ]),
  });
}

/**
 * Searchable persona picker. Resolves with a persona id, null for "use default" (when allowDefault),
 * or undefined if cancelled.
 */
function pickPersona(title, currentId = null, allowDefault = false) {
  const all = Object.values(S.personas).sort((a, b) => (a.folder || '￿').localeCompare(b.folder || '￿') || a.name.localeCompare(b.name));
  const row = (p) => `<button class="pick pp" data-id="${p.id}" data-q="${esc([p.name, p.description, p.folder].join(' ').toLowerCase())}">
    <img src="${personaAvatar(p)}" alt=""><span>${esc(p.name)}${p.folder ? `<small class="muted"> · ${esc(p.folder)}</small>` : ''}</span>${p.id === currentId ? '<b class="ord">✓</b>' : ''}</button>`;
  return sheet(`<h3>${esc(title)}</h3><input class="input" type="search" placeholder="Search personas…" data-f>
    <div class="pick-list">${allowDefault ? `<button class="pick pp" data-id="" data-q="default"><span>Use default (${esc(defaultPersona().name)})</span>${!currentId ? '<b class="ord">✓</b>' : ''}</button>` : ''}${all.map(row).join('')}</div>`,
  (el, close) => {
    el.querySelector('[data-f]').addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      $$('.pp', el).forEach((b) => { b.style.display = b.dataset.q.includes(q) ? '' : 'none'; });
    });
    el.addEventListener('click', (e) => { const b = e.target.closest('.pp'); if (b) close(b.dataset.id || null); });
  });
}

// =====================================================================
// CHARACTER EDITOR
// =====================================================================

function viewCharEditor(c) {
  const books = sortByUpdated(S.books);
  const save = debounce(() => { saveChar(c); updateTokens(); }, 400);
  const field = (path, label, rows = 3, hint = '') => `<label>${label}${hint ? `<span class="hint">${hint}</span>` : ''}<textarea class="input" rows="${rows}" data-bind="${path}"></textarea></label>`;
  const emb = c.character_book;

  app.innerHTML = `${header({ title: esc(c.name), actions: `<button class="btn primary sm" data-act="chat">Chat</button><button class="icon-btn" data-act="more" aria-label="More">${ICON.more}</button>` })}
  <main class="scroll pad-bottom" id="main">
    <div class="char-head"><img class="big-av" src="${avatarOf(c)}" data-act="avatar" alt="Avatar — tap to change"><div class="grow">
      <label>Name<input class="input" data-bind="name"></label><p class="muted small" id="tok"></p></div></div>
    <section class="panel">
      ${field('description', 'Description', 6, 'Appearance, background, everything the model must know. Supports {{char}} / {{user}}.')}
      ${field('personality', 'Personality summary', 2)}
      ${field('scenario', 'Scenario', 2)}
      ${field('first_mes', 'First message (greeting)', 4)}
      <div class="alt-greets"><div class="row between"><b>Alternate greetings</b><button class="btn ghost sm" data-act="addGreet">${ICON.plus} Add</button></div>
        ${c.alternate_greetings.map((g, i) => `<div class="alt"><textarea class="input" rows="3" data-bind="alternate_greetings.${i}"></textarea><button class="icon-btn sm" data-act="delGreet" data-i="${i}" aria-label="Remove">${ICON.trash}</button></div>`).join('')}</div>
      ${field('mes_example', 'Example dialogue', 4, 'Separate examples with <START>.')}
    </section>
    <section class="panel"><h2>Advanced</h2>
      ${field('system_prompt', 'System prompt override', 2, 'Replaces the main prompt when this character speaks.')}
      ${field('post_history_instructions', 'Post-history instructions', 2)}
      <label class="slider">Talkativeness (group chats)<output>${c.talkativeness}</output><input type="range" min="0" max="1" step="0.05" data-bind="talkativeness"></label>
      <label>Tags<input class="input" data-bind="tags" data-type="list" placeholder="fantasy, adventure"></label>
      <label>Creator<input class="input" data-bind="creator"></label>
      ${field('creator_notes', 'Creator notes (not sent to the model)', 2)}
    </section>
    <section class="panel"><h2>Lorebooks</h2>
      <div class="row between"><span>Embedded lorebook: ${emb ? `<b>${emb.entries.length} entries</b>` : '<span class="muted">none</span>'}</span>
        <span>${emb ? `<button class="btn sm" data-act="editEmb">Edit</button> <button class="btn ghost sm" data-act="extractEmb">Extract</button>` : '<button class="btn sm" data-act="makeEmb">Create</button>'}</span></div>
      <p class="hint">Linked standalone lorebooks (active whenever this character is in a chat):</p>
      ${books.length ? books.map((b) => `<label class="check"><input type="checkbox" data-linkbook value="${b.id}" ${c.lorebookIds.includes(b.id) ? 'checked' : ''}> ${esc(b.name)}</label>`).join('') : '<p class="muted small">No standalone lorebooks yet.</p>'}
    </section>
  </main>`;

  const main = $('#main');
  const updateTokens = () => { $('#tok').textContent = `≈ ${estimateTokens([c.description, c.personality, c.scenario, c.mes_example].join('\n'))} permanent tokens`; };
  updateTokens();
  bindFields(main, c, (path) => { if (path === 'name') $('.top .title').textContent = c.name; save(); });
  main.addEventListener('change', (e) => {
    if (e.target.hasAttribute('data-linkbook')) { c.lorebookIds = $$('[data-linkbook]:checked', main).map((x) => x.value); save(); }
  });

  handleActs({
    chat: () => { save.flush(); startChat([c.id]); },
    avatar: async () => {
      const f = await pickFile('image/*');
      if (!f) return;
      c.avatar = await resizeImage(await readAsDataUrl(f), 512);
      await saveChar(c); $('.big-av').src = c.avatar;
    },
    addGreet: () => { c.alternate_greetings.push(''); save.flush(); viewCharEditor(c); },
    delGreet: (el) => { c.alternate_greetings.splice(+el.dataset.i, 1); save.flush(); viewCharEditor(c); },
    makeEmb: async () => { c.character_book = newLorebook({ name: `${c.name}'s Lorebook` }); await saveChar(c); go(`/lore/char:${c.id}`); },
    editEmb: () => { save.flush(); go(`/lore/char:${c.id}`); },
    extractEmb: async () => {
      const b = { ...structuredClone(c.character_book), id: uid() };
      await saveBook(b);
      c.character_book = null;
      c.lorebookIds.push(b.id);
      await saveChar(c);
      toast('Moved to a standalone lorebook and linked it'); viewCharEditor(c);
    },
    more: () => menu(c.name, [
      { label: 'Export as PNG card', run: async () => saveFile(`${safeName(c.name)}.png`, await exportCharacterPng(c)) },
      { label: 'Export as JSON', run: () => saveFile(`${safeName(c.name)}.json`, new Blob([JSON.stringify(characterToCard(c), null, 2)], { type: 'application/json' })) },
      { label: 'Duplicate', run: async () => { const d = { ...structuredClone(c), id: uid(), name: c.name + ' (copy)', created: Date.now() }; await saveChar(d); go('/char/' + d.id); } },
      { label: 'Delete character', danger: true, run: async () => {
        if (!(await confirmBox(`Delete ${c.name}? Chats keep their messages.`, 'Delete', true))) return;
        await db.del('characters', c.id); delete S.chars[c.id]; go('/characters');
      } },
    ]),
  });
}

const safeName = (s) => s.replace(/[^\w-]+/g, '_').slice(0, 40) || 'export';

// =====================================================================
// LOREBOOK EDITOR  (id = book id, or "char:<id>" for an embedded book)
// =====================================================================

function viewLoreEditor(id) {
  let book; let persist;
  if (id.startsWith('char:')) {
    const c = S.chars[id.slice(5)];
    if (!c?.character_book) return go('');
    book = c.character_book;
    persist = () => saveChar(c);
  } else {
    book = S.books[id];
    if (!book) return go('');
    persist = () => saveBook(book);
  }
  const save = debounce(persist, 400);
  const posLabel = { before_char: 'Before character', after_char: 'After character', depth: 'In chat at depth' };

  const entryHtml = (e, i) => {
    const open = S.openEntries.has(e.id);
    const summary = e.comment || e.keys.join(', ') || (e.constant ? '(always on)' : '(no keys)');
    return `<div class="entry ${open ? 'open' : ''} ${e.enabled ? '' : 'off'}" data-eid="${e.id}">
      <div class="entry-head" data-act="toggleEntry" data-id="${e.id}"><span class="dot ${e.constant ? 'const' : ''}"></span><span class="grow">${esc(summary)}</span>
        <label class="switch" data-act="noop"><input type="checkbox" data-bind="entries.${i}.enabled"><span></span></label></div>
      ${open ? `<div class="entry-body">
        <label>Title / memo<input class="input" data-bind="entries.${i}.comment"></label>
        <label>Keywords<span class="hint">Comma separated. Use /regex/i for regex.</span><input class="input" data-bind="entries.${i}.keys" data-type="list" autocapitalize="off"></label>
        <label>Content<textarea class="input" rows="5" data-bind="entries.${i}.content"></textarea></label>
        <div class="row wrap"><label class="check"><input type="checkbox" data-bind="entries.${i}.constant"> Always active</label>
          <label class="check"><input type="checkbox" data-bind="entries.${i}.selective"> Secondary keys</label>
          <label class="check"><input type="checkbox" data-bind="entries.${i}.caseSensitive"> Case-sensitive</label>
          <label class="check"><input type="checkbox" data-bind="entries.${i}.wholeWords"> Whole words</label></div>
        ${e.selective ? `<div class="row"><label class="grow">Secondary keys<input class="input" data-bind="entries.${i}.secondary_keys" data-type="list"></label>
          <label>Logic<select class="input" data-bind="entries.${i}.selectiveLogic"><option value="AND_ANY">AND any</option><option value="AND_ALL">AND all</option><option value="NOT_ANY">NOT any</option><option value="NOT_ALL">NOT all</option></select></label></div>` : ''}
        <div class="row"><label class="grow">Position<select class="input" data-bind="entries.${i}.position">${Object.entries(posLabel).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
          <label class="narrow">Depth<input class="input" type="number" min="0" data-bind="entries.${i}.depth"></label></div>
        <div class="row"><label class="grow">Order (higher = priority)<input class="input" type="number" data-bind="entries.${i}.order"></label>
          <label class="grow">Probability %<input class="input" type="number" min="0" max="100" data-bind="entries.${i}.probability"></label></div>
        <div class="row end"><button class="btn ghost sm" data-act="dupEntry" data-i="${i}">Duplicate</button><button class="btn danger sm" data-act="delEntry" data-i="${i}">Delete</button></div>
      </div>` : ''}</div>`;
  };

  const render = () => {
    app.innerHTML = `${header({ title: esc(book.name), sub: id.startsWith('char:') ? 'Embedded in character' : '', actions: `<button class="icon-btn" data-act="more" aria-label="More">${ICON.more}</button>` })}
    <main class="scroll pad-bottom" id="main">
      <section class="panel">
        <label>Name<input class="input" data-bind="name"></label>
        <label>Description<textarea class="input" rows="2" data-bind="description"></textarea></label>
        <div class="row"><label class="grow">Scan depth (messages)<input class="input" type="number" min="1" data-bind="scanDepth"></label>
          <label class="grow">Token budget<input class="input" type="number" min="64" step="64" data-bind="tokenBudget"></label></div>
        <label class="check"><input type="checkbox" data-bind="recursive"> Recursive scanning (entries can trigger other entries)</label>
      </section>
      <div class="row between pad"><h2>Entries (${book.entries.length})</h2><input class="input search" placeholder="Filter…" id="efilter"></div>
      <div class="entries">${book.entries.map(entryHtml).join('')}</div>
      <button class="btn block" data-act="addEntry">${ICON.plus} Add entry</button>
    </main>`;
    bindFields($('#main'), book, (path) => {
      if (path === 'name') $('.top .title').firstChild.textContent = book.name;
      if (/\.(selective)$/.test(path)) { save.flush(); render(); return; }
      const m = path.match(/^entries\.(\d+)\.(comment|keys)$/);
      if (m) {
        const e = book.entries[+m[1]];
        $(`[data-eid="${e.id}"] .entry-head .grow`).textContent = e.comment || e.keys.join(', ') || '(no keys)';
      }
      save();
    });
    $('#efilter').addEventListener('input', (ev) => {
      const q = ev.target.value.toLowerCase();
      book.entries.forEach((e) => {
        const el = $(`[data-eid="${e.id}"]`);
        el.style.display = !q || [e.comment, e.content, ...e.keys].join(' ').toLowerCase().includes(q) ? '' : 'none';
      });
    });
  };
  render();

  handleActs({
    noop: (el, e) => e.stopPropagation(),
    toggleEntry: (el, e) => {
      if (e.target.closest('.switch')) return;
      const eid = el.dataset.id;
      S.openEntries.has(eid) ? S.openEntries.delete(eid) : S.openEntries.add(eid);
      save.flush(); render();
    },
    addEntry: () => {
      const e = newEntry();
      book.entries.push(e); S.openEntries.add(e.id);
      save.flush(); render();
      $(`[data-eid="${e.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
    dupEntry: (el) => { const e = { ...structuredClone(book.entries[+el.dataset.i]), id: uid() }; book.entries.splice(+el.dataset.i + 1, 0, e); save.flush(); render(); },
    delEntry: async (el) => { if (await confirmBox('Delete this entry?', 'Delete', true)) { book.entries.splice(+el.dataset.i, 1); save.flush(); render(); } },
    more: () => menu(book.name, [
      { label: 'Export as JSON', run: () => saveFile(`${safeName(book.name)}.json`, new Blob([JSON.stringify(lorebookToJson(book), null, 2)], { type: 'application/json' })) },
      { label: 'Import entries from file (merge)', run: async () => {
        const f = await pickFile('.json,application/json');
        if (!f) return;
        try { const b = lorebookFromJson(JSON.parse(await f.text())); book.entries.push(...b.entries); save.flush(); render(); toast(`Added ${b.entries.length} entries`); } catch (e) { toast(e.message); }
      } },
      ...(id.startsWith('char:') ? [] : [{ label: 'Delete lorebook', danger: true, run: async () => {
        if (!(await confirmBox(`Delete “${book.name}”?`, 'Delete', true))) return;
        await db.del('lorebooks', book.id); delete S.books[book.id];
        S.settings.globalLorebookIds = S.settings.globalLorebookIds.filter((x) => x !== book.id); persistSettings.flush();
        go('/lorebooks');
      } }]),
    ]),
  });
}

// =====================================================================
// CHUB BROWSER
// =====================================================================

const SUGGESTED_TAGS = ['Female', 'Male', 'OC', 'Fantasy', 'Romance', 'Anime', 'Roleplay', 'Scenario', 'Adventure', 'Sci-Fi', 'Horror', 'Comedy', 'Fluff', 'Angst', 'Drama', 'Multiple Characters', 'Monster', 'Game Characters', 'Historical', 'Modern'];

function viewChub() {
  const C = S.chub;
  const tagsOf = (s) => s.split(',').map((t) => t.trim()).filter(Boolean);
  const renderTags = () => {
    const inc = tagsOf(C.tags).map((t) => `<button class="chip on" data-act="dropTag" data-tag="${esc(t)}">${esc(t)}<span class="x">✕</span></button>`);
    const exc = tagsOf(C.excludeTags).map((t) => `<button class="chip ex" data-act="dropEx" data-tag="${esc(t)}">−${esc(t)}<span class="x">✕</span></button>`);
    $('#tagRow').innerHTML = `${inc.join('')}${exc.join('')}<button class="chip add" data-act="addTag">${ICON.tag} Tag</button>`;
    $('#srcRow').innerHTML = `<span class="muted small">Sites:</span>${Object.entries(BOT_SOURCES).map(([id, src]) => `<button class="chip ${S.settings.browseSources.includes(id) ? 'on' : ''}" data-act="toggleSrc" data-src="${id}">${esc(src.label)}</button>`).join('')}`;
  };
  const renderResults = () => {
    $('#results').innerHTML = C.results.map((r, i) => `<div class="card" data-act="preview" data-i="${i}"><img src="${esc(r.avatar)}" loading="lazy" alt="" referrerpolicy="no-referrer">
      <div class="card-body"><div class="card-title">${esc(r.name)}</div><div class="card-sub">${esc(r.tagline.slice(0, 90))}</div>
      <div class="muted small">★ ${r.stars}<span class="src">${esc(BOT_SOURCES[r.source]?.label || r.source)}</span></div></div></div>`).join('') || (C.loading ? '' : '<p class="muted center">No results.</p>');
    $('#more').style.display = C.results.length && !C.done ? '' : 'none';
    $('#spin').style.display = C.loading ? '' : 'none';
  };
  const search = async (append = false) => {
    if (C.loading) return;
    C.loading = true;
    if (!append) { C.page = 1; C.results = []; C.done = false; }
    renderResults();
    const { results, errors, done } = await browseSearch({
      query: C.query, tags: tagsOf(C.tags), excludeTags: tagsOf(C.excludeTags), page: C.page,
      sort: C.sort, nsfw: S.settings.showNsfw, key: chubKey(), botbooruUrl: S.settings.botbooruUrl,
    }, S.settings.browseSources);
    const have = new Set(C.results.map((r) => r.id));
    C.results.push(...results.filter((r) => !have.has(r.id)));
    C.done = done;
    C.page++;
    errors.filter((e) => !C.warned.has(e.source)).forEach((e) => C.warned.add(e.source) && toast(`${BOT_SOURCES[e.source].label}: ${e.error instanceof TypeError ? "couldn't reach the site" : e.error.message}`, 6000));
    C.loading = false;
    renderResults();
  };
  const addTag = (t, exclude = false) => {
    const key = exclude ? 'excludeTags' : 'tags';
    const other = exclude ? 'tags' : 'excludeTags';
    const lc = t.toLowerCase();
    C[other] = tagsOf(C[other]).filter((x) => x.toLowerCase() !== lc).join(',');
    if (!tagsOf(C[key]).some((x) => x.toLowerCase() === lc)) C[key] = [...tagsOf(C[key]), t].join(',');
    renderTags(); search();
  };

  app.innerHTML = `${header({ title: 'Browse bots', actions: `<button class="btn sm" data-act="url">Import URL</button>` })}
  <main class="scroll pad-bottom" id="main">
    <div class="row pad"><input class="input grow" id="q" type="search" placeholder="Search characters…" value="${esc(C.query)}" enterkeyhint="search">
      <select class="input narrow" id="sort"><option value="download_count">Popular</option><option value="star_count">Stars</option><option value="created_at">Newest</option><option value="last_activity_at">Updated</option></select></div>
    <div class="chips" id="srcRow"></div>
    <div class="chips wrap" id="tagRow"></div>
    <div class="grid" id="results"></div>
    <div class="center pad"><div class="spinner" id="spin"></div><button class="btn" id="more" data-act="more">Load more</button></div>
  </main>`;
  $('#sort').value = C.sort;
  $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { C.query = e.target.value; e.target.blur(); search(); } });
  $('#q').addEventListener('search', (e) => { if (!e.target.value && C.query) { C.query = ''; search(); } });
  $('#sort').addEventListener('change', (e) => { C.sort = e.target.value; search(); });
  renderTags();
  if (!C.results.length) search(); else renderResults();

  handleActs({
    more: () => search(true),
    url: () => chubUrlImport(),
    toggleSrc: (el) => {
      const id = el.dataset.src;
      const on = S.settings.browseSources;
      if (on.includes(id) && on.length === 1) return toast('Keep at least one site selected');
      S.settings.browseSources = on.includes(id) ? on.filter((x) => x !== id) : [...on, id];
      persistSettings.flush(); renderTags(); search();
    },
    dropTag: (el) => { C.tags = tagsOf(C.tags).filter((t) => t !== el.dataset.tag).join(','); renderTags(); search(); },
    dropEx: (el) => { C.excludeTags = tagsOf(C.excludeTags).filter((t) => t !== el.dataset.tag).join(','); renderTags(); search(); },
    addTag: () => {
      // Chub tags are free-form, so suggest the ones actually used by the bots on screen.
      const counts = new Map();
      for (const r of C.results) for (const t of r.tags) { const k = t.trim(); if (k) counts.set(k, (counts.get(k) || 0) + 1); }
      const active = new Set([...tagsOf(C.tags), ...tagsOf(C.excludeTags)].map((t) => t.toLowerCase()));
      const seen = [...counts].sort((a, b) => b[1] - a[1]).map(([t]) => t).filter((t) => !active.has(t.toLowerCase())).slice(0, 40);
      const popular = SUGGESTED_TAGS.filter((t) => !active.has(t.toLowerCase()) && !seen.some((x) => x.toLowerCase() === t.toLowerCase()));
      const chips = (list) => `<div class="chips wrap flush">${list.map((t) => `<button class="chip" data-sug="${esc(t)}">${esc(t)}</button>`).join('')}</div>`;
      return sheet(`<h3>Filter by tag</h3><input class="input" data-t placeholder="Any tag — Chub tags are free-form" autocapitalize="off" list="tagSuggest">
      <datalist id="tagSuggest">${[...counts.keys()].map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
      <div class="row"><button class="btn primary grow" data-mode="inc">Include</button><button class="btn grow" data-mode="exc">Exclude</button></div>
      <p class="hint">Tap a tag to include it, long-press to exclude it.</p>
      ${seen.length ? `<p class="hint"><b>In these results</b></p>${chips(seen)}` : ''}
      <p class="hint"><b>Common tags</b></p>${chips(popular)}`,
    (el, close) => {
      const inp = el.querySelector('[data-t]');
      setTimeout(() => inp.focus(), 50);
      const done = (t, ex) => { t = t.trim(); if (!t) return; close(); addTag(t, ex); };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(inp.value, false); });
      let longPressed = false;
      let timer;
      el.addEventListener('pointerdown', (e) => {
        const b = e.target.closest('[data-sug]');
        longPressed = false;
        if (b) timer = setTimeout(() => { longPressed = true; done(b.dataset.sug, true); }, 500);
      });
      el.addEventListener('pointerup', () => clearTimeout(timer));
      el.addEventListener('pointerleave', () => clearTimeout(timer));
      el.addEventListener('contextmenu', (e) => e.preventDefault());
      el.addEventListener('click', (e) => {
        const m = e.target.closest('[data-mode]');
        if (m) return done(inp.value, m.dataset.mode === 'exc');
        const b = e.target.closest('[data-sug]');
        if (b && !longPressed) done(b.dataset.sug, false);
      });
    });
    },
    preview: (el) => {
      const r = C.results[+el.dataset.i];
      sheet(`<div class="preview"><img src="${esc(r.avatar)}" alt="" referrerpolicy="no-referrer"><div><h3>${esc(r.name)}</h3><p class="muted small">by ${esc(r.creator || r.path?.split('/')[0] || 'unknown')} · ★ ${r.stars} · ${esc(BOT_SOURCES[r.source]?.label || r.source)}</p></div></div>
        <p>${esc(r.tagline)}</p><p class="hint">Tap a tag to search with it:</p><div class="tags">${r.tags.slice(0, 20).map((t) => `<button class="badge tagbtn" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div>
        <div class="row end"><button class="btn ghost" data-x="0">Close</button><button class="btn primary" data-x="1">Import</button></div>`,
      (sh, close) => sh.addEventListener('click', async (e) => {
        const t = e.target.closest('[data-tag]');
        if (t) { close(); addTag(t.dataset.tag); return; }
        const b = e.target.closest('[data-x]');
        if (!b) return;
        if (b.dataset.x === '0') return close();
        b.disabled = true; b.textContent = 'Importing…';
        try {
          const c = await importBrowseResult(r, { key: chubKey() });
          await saveChar(c);
          close();
          toast(`Imported ${c.name}`);
          go('/char/' + c.id);
        } catch (err) { toast(chubError(err), 5000); b.disabled = false; b.textContent = 'Import'; }
      }));
    },
  });
}

// =====================================================================
// CHAT
// =====================================================================

const isGenerating = (chat) => S.abort && S.genChatId === chat.id;
const msgPersona = (m, chat) => S.personas[m.personaId] || personaFor(chat);
const nameOf = (m, chat) => (m.role === 'user' ? msgPersona(m, chat).name : m.role === 'narrator' ? 'Narrator' : m.name || S.chars[m.charId]?.name || 'Character');

function msgHtml(chat, m, idx) {
  const c = S.chars[m.charId];
  const isLast = idx === chat.messages.length - 1;
  const av = m.role === 'user' ? personaAvatar(msgPersona(m, chat)) : m.role === 'narrator' ? '' : avatarOf(c || { name: m.name });
  const showSwipes = m.role === 'char' && (m.swipes.length > 1 || isLast);
  const editing = S.editingMsg === m.id;
  const chk = m.role === 'char' && m.check && m.check.text === msgText(m) ? m.check : null;
  return `<div class="msg ${m.role}" data-mid="${m.id}">
    ${av ? `<img class="av" src="${av}" alt="">` : ''}
    <div class="bubble" data-act="msgMenu" data-id="${m.id}">
      <div class="meta"><span class="name">${esc(nameOf(m, chat))}</span></div>
      ${editing
        ? `<textarea class="input edit-ta">${esc(msgText(m))}</textarea><div class="row end"><button class="btn ghost sm" data-act="editCancel">Cancel</button><button class="btn primary sm" data-act="editSave" data-id="${m.id}">Save</button></div>`
        : `<div class="text">${(chk?.status === 'issues' ? fmtMarked(msgText(m), chk.issues) : fmt(msgText(m))) || '<span class="typing"><i></i><i></i><i></i></span>'}</div>${chk && !editing ? checkBadge(m, chk) : ''}`}
      ${showSwipes && !editing ? `<div class="swipes"><button class="icon-btn xs" data-act="swipeL" data-id="${m.id}" ${m.swipeIdx === 0 ? 'disabled' : ''} aria-label="Previous">${ICON.left}</button>
        <span>${m.swipeIdx + 1}/${m.swipes.length}</span><button class="icon-btn xs" data-act="swipeR" data-id="${m.id}" ${!isLast && m.swipeIdx >= m.swipes.length - 1 ? 'disabled' : ''} aria-label="Next or regenerate">${ICON.right}</button></div>` : ''}
    </div></div>`;
}

/** Formats text with the continuity checker's flagged spans highlighted. */
function fmtMarked(text, issues) {
  const ranges = issues.map((i) => locateQuote(text, i.quote)).filter(Boolean).sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [a, b] of ranges) {
    if (a < pos) continue; // overlapping flags: keep the first
    out += text.slice(pos, a) + '\u0001' + text.slice(a, b) + '\u0002';
    pos = b;
  }
  out += text.slice(pos);
  return fmt(out).replace(/\u0001/g, '<mark class="cc-mark">').replace(/\u0002/g, '</mark>');
}

function checkBadge(m, chk) {
  if (chk.status === 'running') return '<div class="cc running"><span class="spin-sm"></span>Checking continuity…</div>';
  if (chk.status === 'issues') return `<button class="cc warn" data-act="ccReview" data-id="${m.id}">⚠ ${chk.issues.length} continuity issue${chk.issues.length > 1 ? 's' : ''} · Review</button>`;
  if (chk.status === 'error') return `<button class="cc err" data-act="ccCheck" data-id="${m.id}" title="${esc(chk.error)}">Continuity check failed · Retry</button>`;
  return `<div class="cc ok">✓ ${chk.fixed ? 'Fixed' : 'Consistent'}</div>`;
}

function viewChat(chat) {
  const members = chat.characterIds.map((id) => S.chars[id]).filter(Boolean);
  const isGroup = members.length > 1;
  app.classList.add('view-chat');
  app.innerHTML = `<div class="chat-bg" id="chatBg"></div>${header({
    title: `<span data-act="settings">${esc(chatTitle(chat))}</span>`,
    sub: isGroup ? `${members.length} characters · ${{ natural: 'natural order', round: 'round robin', manual: 'manual turns' }[chat.groupMode]}` : '',
    actions: `<button class="icon-btn" data-act="chatMore" aria-label="Chat options">${ICON.more}</button>`,
  })}
  <main class="scroll chat-scroll" id="msgs">${chat.messages.map((m, i) => msgHtml(chat, m, i)).join('') || `<div class="empty"><p>Say something to start the scene.</p></div>`}</main>
  <footer class="composer">
    ${isGroup ? `<div class="speakers">${members.map((m) => `<button class="speaker ${chat.mutedIds.includes(m.id) ? 'muted' : ''}" data-act="speak" data-id="${m.id}"><img src="${avatarOf(m)}" alt=""><span>${esc(m.name.split(' ')[0])}</span></button>`).join('')}</div>` : ''}
    <div class="row input-row"><textarea id="input" class="input fixed" rows="1" placeholder="${isGroup ? 'Message the group… (/n for narration)' : 'Message… (/n for narration)'}" enterkeyhint="send"></textarea>
    <button class="send" id="sendBtn" data-act="send" aria-label="Send">${isGenerating(chat) ? ICON.stop : ICON.send}</button></div>
  </footer>`;

  const input = $('#input');
  const draftKey = 'draft:' + chat.id;
  try { input.value = localStorage.getItem(draftKey) || ''; } catch { /* storage unavailable */ }
  autoGrow(input);
  input.addEventListener('input', () => { autoGrow(input); try { localStorage.setItem(draftKey, input.value); } catch { /* ignore */ } });
  scrollToBottom(true);
  updateChatBg(chat);

  const findMsg = (id) => chat.messages.find((m) => m.id === id);
  handleActs({
    settings: () => go(`/chat/${chat.id}/settings`),
    chatMore: () => menu(chatTitle(chat), [
      { label: 'Chat settings & members', run: () => go(`/chat/${chat.id}/settings`) },
      { label: 'Add a character', run: () => addMembers(chat) },
      { label: `Switch persona (now: ${personaFor(chat).name})`, run: () => switchChatPersona(chat) },
      { label: 'View last prompt', run: showLastPrompt },
      { label: 'Export chat (JSON)', run: () => exportChat(chat) },
    ]),
    send: () => (isGenerating(chat) ? S.abort.abort() : sendMessage(chat)),
    speak: (el) => {
      if (S.abort) return toast('Wait for the current reply (or tap stop)');
      sendMessage(chat, el.dataset.id);
    },
    swipeL: (el, e) => { e.stopPropagation(); const m = findMsg(el.dataset.id); if (m.swipeIdx > 0) { m.swipeIdx--; saveChat(chat); rerenderMsg(chat, m); } },
    swipeR: (el, e) => {
      e.stopPropagation();
      const m = findMsg(el.dataset.id);
      if (m.swipeIdx < m.swipes.length - 1) { m.swipeIdx++; saveChat(chat); rerenderMsg(chat, m); return; }
      if (!S.abort) regenerate(chat, m);
    },
    msgMenu: (el, e) => { if (e.target.closest('.swipes, .edit-ta, button')) return; msgMenu(chat, findMsg(el.dataset.id)); },
    ccReview: (el, e) => { e.stopPropagation(); reviewContinuity(chat, findMsg(el.dataset.id)); },
    ccCheck: (el, e) => { e.stopPropagation(); checkContinuity(chat, findMsg(el.dataset.id)); },
    editCancel: (el, e) => { e.stopPropagation(); S.editingMsg = null; renderMessages(chat); },
    editSave: (el, e) => {
      e.stopPropagation();
      const m = findMsg(el.dataset.id);
      m.swipes[m.swipeIdx] = $('.edit-ta').value;
      S.editingMsg = null; saveChat(chat); renderMessages(chat);
    },
  });
}

/** Character shown behind the chat: whoever spoke last, else the first member. */
function chatBgChar(chat) {
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const m = chat.messages[i];
    if (m.role === 'char' && S.chars[m.charId]) return S.chars[m.charId];
  }
  return S.chars[chat.characterIds[0]];
}

function updateChatBg(chat) {
  const host = $('#chatBg');
  const cfg = S.settings.chatBg;
  if (!host) return;
  const c = cfg.enabled ? chatBgChar(chat) : null;
  if (!c) { host.innerHTML = ''; host.dataset.cid = ''; return; }
  host.style.setProperty('--bg-blur', cfg.blur + 'px');
  host.style.setProperty('--bg-dim', cfg.dim);
  if (host.dataset.cid === c.id) return;
  host.dataset.cid = c.id;
  const layer = document.createElement('div');
  layer.className = 'bg-layer';
  layer.style.backgroundImage = `url("${avatarOf(c)}")`;
  host.appendChild(layer);
  requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add('on')));
  [...host.children].slice(0, -1).forEach((old) => { old.classList.remove('on'); setTimeout(() => old.remove(), 700); });
}

async function switchChatPersona(chat) {
  const id = await pickPersona('Your persona in this chat', chat.personaId, true);
  if (id === undefined) return;
  chat.personaId = id;
  await saveChat(chat);
  toast(`You are now ${personaFor(chat).name} in this chat`);
  route();
}

function renderMessages(chat) {
  const box = $('#msgs');
  if (!box) return;
  box.innerHTML = chat.messages.map((m, i) => msgHtml(chat, m, i)).join('');
  updateChatBg(chat);
  const ta = $('.edit-ta', box);
  if (ta) { autoGrow(ta); ta.addEventListener('input', () => autoGrow(ta)); ta.focus(); }
}

function rerenderMsg(chat, m) {
  const el = $(`[data-mid="${m.id}"]`);
  if (!el) return renderMessages(chat);
  const tmp = document.createElement('div');
  tmp.innerHTML = msgHtml(chat, m, chat.messages.indexOf(m));
  el.replaceWith(tmp.firstElementChild);
}

function scrollToBottom(force = false) {
  const box = $('#msgs');
  if (!box) return;
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
  if (force || near) box.scrollTop = box.scrollHeight;
}

function setSendButton(chat) {
  const b = $('#sendBtn');
  if (b) b.innerHTML = isGenerating(chat) ? ICON.stop : ICON.send;
}

function msgMenu(chat, m) {
  const idx = chat.messages.indexOf(m);
  const isLastChar = m.role === 'char' && idx === chat.messages.length - 1;
  menu(null, [
    { label: 'Edit', run: () => { S.editingMsg = m.id; renderMessages(chat); } },
    { label: 'Copy text', run: () => { navigator.clipboard?.writeText(msgText(m)).then(() => toast('Copied'), () => toast('Copy failed')); } },
    isLastChar && { label: 'Regenerate (new swipe)', run: () => !S.abort && regenerate(chat, m) },
    isLastChar && { label: 'Continue this message', run: () => !S.abort && continueMsg(chat, m) },
    m.role === 'char' && { label: 'Check continuity', run: () => checkContinuity(chat, m) },
    { label: 'Branch from here (new chat)', run: async () => {
      const c = { ...structuredClone(chat), id: uid(), title: chatTitle(chat) + ' (branch)', messages: structuredClone(chat.messages.slice(0, idx + 1)), created: Date.now() };
      await saveChat(c); go('/chat/' + c.id);
    } },
    { label: 'Delete message', danger: true, run: () => { chat.messages.splice(idx, 1); saveChat(chat); renderMessages(chat); } },
    idx < chat.messages.length - 1 && { label: 'Delete this and everything after', danger: true, run: async () => {
      if (await confirmBox(`Delete ${chat.messages.length - idx} messages?`, 'Delete', true)) { chat.messages.splice(idx); saveChat(chat); renderMessages(chat); }
    } },
  ].filter(Boolean));
}

// ---------- generation flow ----------

function booksFor(chat) {
  const ids = new Set([...S.settings.globalLorebookIds, ...chat.lorebookIds]);
  const books = [];
  for (const cid of chat.characterIds) {
    const c = S.chars[cid];
    if (!c) continue;
    c.lorebookIds.forEach((id) => ids.add(id));
    if (c.character_book?.entries.length) books.push(c.character_book);
  }
  ids.forEach((id) => S.books[id] && books.push(S.books[id]));
  return books;
}

async function sendMessage(chat, forceSpeakerId = null) {
  const input = $('#input');
  let text = input.value.trim();
  if (text) {
    let role = 'user';
    const nm = text.match(/^\/(n|narrate|narrator)\s+([\s\S]+)/i);
    if (nm) { role = 'narrator'; text = nm[2]; }
    chat.messages.push(newMessage({ role, swipes: [text], personaId: role === 'user' ? personaFor(chat).id : null }));
    input.value = ''; autoGrow(input);
    try { localStorage.removeItem('draft:' + chat.id); } catch { /* ignore */ }
    await saveChat(chat);
    renderMessages(chat); scrollToBottom(true);
  }

  let speakers;
  if (forceSpeakerId) speakers = [S.chars[forceSpeakerId]];
  else {
    speakers = pickSpeakers(chat, S.chars, text, personaFor(chat).name);
    if (!speakers.length) {
      if (chat.characterIds.length > 1 && chat.groupMode === 'manual') return toast('Tap a character above the input to choose who replies');
      if (!chat.characterIds.length) return toast('This chat has no characters — add some in chat settings');
      return toast('All characters are muted');
    }
  }
  await runTurns(chat, speakers.filter(Boolean));
}

async function runTurns(chat, speakers) {
  S.abort = new AbortController();
  S.genChatId = chat.id;
  setSendButton(chat);
  try {
    for (const sp of speakers) {
      if (S.abort.signal.aborted) break;
      const m = newMessage({ role: 'char', charId: sp.id, name: sp.name });
      chat.messages.push(m);
      renderMessages(chat); scrollToBottom(true);
      const ok = await generateInto(chat, m, sp, 'reply');
      if (!ok) break;
      autoCheck(chat, m);
    }
  } finally {
    S.abort = null; S.genChatId = null;
    setSendButton(chat);
    await saveChat(chat);
    if (location.hash.startsWith('#/chat/' + chat.id)) renderMessages(chat);
  }
}

async function regenerate(chat, m, extraInstruction = '') {
  const sp = S.chars[m.charId];
  if (!sp) return toast('That character was deleted');
  m.swipes.push(''); m.swipeIdx = m.swipes.length - 1;
  rerenderMsg(chat, m);
  S.abort = new AbortController(); S.genChatId = chat.id; setSendButton(chat);
  let ok = false;
  try { ok = await generateInto(chat, m, sp, 'reply', extraInstruction); } finally {
    S.abort = null; S.genChatId = null; setSendButton(chat); await saveChat(chat); renderMessages(chat);
  }
  if (ok) autoCheck(chat, m);
}

async function continueMsg(chat, m) {
  const sp = S.chars[m.charId];
  if (!sp) return;
  S.abort = new AbortController(); S.genChatId = chat.id; setSendButton(chat);
  let ok = false;
  try { ok = await generateInto(chat, m, sp, 'continue'); } finally {
    S.abort = null; S.genChatId = null; setSendButton(chat); await saveChat(chat); renderMessages(chat);
  }
  if (ok) autoCheck(chat, m);
}

/** Fills message m (current swipe) with a generation. Returns false on error/abort. */
async function generateInto(chat, m, speaker, mode, extraInstruction = '') {
  const conn = activeConn();
  if (!conn?.baseUrl) { toast('Set up an API connection in Settings first'); dropEmpty(chat, m); return false; }
  const idx = chat.messages.indexOf(m);
  const history = mode === 'continue' ? chat.messages.slice(0, idx + 1) : chat.messages.slice(0, idx);
  const base = mode === 'continue' ? msgText(m) : '';
  const prompt = buildPrompt(chat, speaker, { settings: { ...S.settings, persona: personaFor(chat) }, characters: S.chars, books: booksFor(chat), history, mode, extraInstruction });
  S.lastPrompt = { ...prompt, speaker: speaker.name, at: Date.now() };

  const join = (t) => (mode === 'continue' ? base + (base && t && !/^[\s,.!?;:'")\]]/.test(t) && !/\s$/.test(base) ? ' ' : '') + t : t);
  const update = (raw) => {
    m.swipes[m.swipeIdx] = join(cleanReply(raw, speaker.name, prompt.otherNames));
    const el = $(`[data-mid="${m.id}"] .text`);
    if (el) el.innerHTML = fmt(msgText(m));
    scrollToBottom();
  };
  try {
    const out = await generate(conn, S.settings.gen, prompt, { signal: S.abort.signal, onToken: update });
    update(out);
    if (!msgText(m).trim()) { toast('The model returned an empty reply'); dropEmpty(chat, m); return false; }
    m.time = Date.now();
    return true;
  } catch (e) {
    if (e.name !== 'AbortError') toast(e instanceof TypeError ? `Network error: couldn't reach ${new URL(conn.baseUrl).host}` : e.message, 6000);
    dropEmpty(chat, m);
    return false;
  }
}

// ---------- continuity check ----------

function autoCheck(chat, m) {
  if (S.settings.continuity.mode === 'auto') checkContinuity(chat, m, { quiet: true });
}

const showIfVisible = (chat, m) => { if (location.hash === '#/chat/' + chat.id && S.editingMsg !== m.id) rerenderMsg(chat, m); };

/** Asks the model to compare message m against the story so far; stores the result on m.check. */
async function checkContinuity(chat, m, { quiet = false } = {}) {
  const speaker = S.chars[m.charId];
  const text = msgText(m);
  if (!speaker || !text.trim() || m.check?.status === 'running' && m.check.text === text) return;
  const cc = S.settings.continuity;
  const base = S.settings.connections.find((c) => c.id === cc.connectionId) || activeConn();
  if (!base?.baseUrl) return quiet || toast('Set up an API connection in Settings first');
  const conn = cc.model ? { ...base, model: cc.model } : base;
  m.check = { text, status: 'running', issues: [] };
  showIfVisible(chat, m);
  try {
    const messages = buildContinuityCheck(chat, speaker, text, {
      settings: { ...S.settings, persona: personaFor(chat) }, characters: S.chars, books: booksFor(chat),
      history: chat.messages.slice(0, chat.messages.indexOf(m)),
    });
    const gen = { ...S.settings.gen, temperature: 0.2, top_p: 1, min_p: 0, repetition_penalty: 1, frequency_penalty: 0, presence_penalty: 0, max_tokens: 1000, stream: false };
    const raw = await generate(conn, gen, { messages });
    if (msgText(m) !== text) return; // edited while we were checking
    const issues = parseContinuity(raw, text);
    m.check = { text, status: issues.length ? 'issues' : 'ok', issues };
  } catch (e) {
    if (msgText(m) !== text) return;
    m.check = { text, status: 'error', error: e.message, issues: [] };
    if (!quiet) toast('Continuity check: ' + e.message, 5000);
  }
  await saveChat(chat);
  showIfVisible(chat, m);
}

function applyContinuityFix(m, issue) {
  const text = msgText(m);
  const loc = locateQuote(text, issue.quote);
  if (!loc) return false;
  const next = text.slice(0, loc[0]) + issue.fix + text.slice(loc[1]);
  m.swipes[m.swipeIdx] = next;
  const rest = m.check.issues.filter((i) => i !== issue && locateQuote(next, i.quote));
  m.check = { text: next, status: rest.length ? 'issues' : 'ok', issues: rest, fixed: true };
  return true;
}

function reviewContinuity(chat, m) {
  const isLast = chat.messages[chat.messages.length - 1] === m;
  sheet('<div id="ccBody"></div>', (el, close) => {
    const body = el.querySelector('#ccBody');
    const render = () => {
      const issues = m.check?.status === 'issues' && m.check.text === msgText(m) ? m.check.issues : [];
      if (!issues.length) { close(); return; }
      body.innerHTML = `<h3>Continuity check — ${esc(m.name)}</h3>
        ${issues.map((it, i) => `<div class="cc-issue">
          <p class="cc-problem">${esc(it.problem || 'Contradicts the story so far.')}</p>
          <div class="cc-diff"><del>${esc(it.quote)}</del><ins>${esc(it.fix) || '<i>(remove)</i>'}</ins></div>
          <div class="row end"><button class="btn ghost sm" data-ignore="${i}">Ignore</button><button class="btn primary sm" data-apply="${i}">Apply fix</button></div></div>`).join('')}
        <div class="row wrap end">${isLast && !S.abort ? '<button class="btn sm" data-x="rewrite">Rewrite reply instead</button>' : ''}${issues.length > 1 ? '<button class="btn primary sm" data-x="all">Apply all</button>' : ''}</div>`;
    };
    const commit = () => { saveChat(chat); showIfVisible(chat, m); render(); };
    body.addEventListener('click', (e) => {
      const t = e.target.closest('button');
      if (!t) return;
      const issues = m.check.issues;
      if (t.dataset.apply) {
        if (!applyContinuityFix(m, issues[+t.dataset.apply])) toast("That text has changed — edit the message instead");
        commit();
      } else if (t.dataset.ignore) {
        const rest = issues.filter((_, i) => i !== +t.dataset.ignore);
        m.check = { ...m.check, issues: rest, status: rest.length ? 'issues' : 'ok', fixed: true };
        commit();
      } else if (t.dataset.x === 'all') {
        [...issues].forEach((it) => applyContinuityFix(m, it));
        commit();
        toast('Fixes applied');
      } else if (t.dataset.x === 'rewrite') {
        const notes = issues.map((it) => `- ${it.problem || it.quote}`).join('\n');
        close();
        regenerate(chat, m, `[Continuity notes: a previous draft of this reply contradicted the story. Avoid these mistakes and stay consistent with what has actually happened:\n${notes}]`);
      }
    });
    render();
  });
}

/** Removes an empty swipe / message left by a failed generation. */
function dropEmpty(chat, m) {
  if (msgText(m).trim()) return;
  if (m.swipes.length > 1) { m.swipes.splice(m.swipeIdx, 1); m.swipeIdx = m.swipes.length - 1; } else chat.messages.splice(chat.messages.indexOf(m), 1);
}

function showLastPrompt() {
  const p = S.lastPrompt;
  if (!p) return toast('Nothing generated yet this session');
  sheet(`<h3>Last prompt — ${esc(p.speaker)}</h3>
    <p class="muted small">≈ ${estimateTokens(p.messages.map((m) => m.content).join('\n'))} tokens · lore entries: ${p.lore.length ? esc(p.lore.map((e) => e.comment || e.keys[0] || '?').join(', ')) : 'none'}</p>
    <div class="prompt-view">${p.messages.map((m) => `<div class="pm"><b>${m.role}</b><pre>${esc(m.content)}</pre></div>`).join('')}</div>
    <div class="row end"><button class="btn" data-x>Close</button></div>`, (el, close) => el.querySelector('[data-x]').onclick = () => close());
}

async function addMembers(chat) {
  const r = await pickCharacters('Add characters', chat.characterIds, 'Add');
  if (!r) return;
  chat.characterIds.push(...r.ids);
  if (r.allGreetings) r.ids.forEach((id) => { const g = greetingMessage(S.chars[id], personaFor(chat).name); if (g) chat.messages.push(g); });
  await saveChat(chat);
  route();
}

// ---------- chat settings ----------

function viewChatSettings(chat) {
  const books = sortByUpdated(S.books);
  const save = debounce(() => saveChat(chat), 400);
  const members = chat.characterIds.map((id) => S.chars[id] || { id, name: '(deleted)', avatar: '' });
  app.innerHTML = `${header({ title: 'Chat settings' })}
  <main class="scroll pad-bottom" id="main">
    <section class="panel"><label>Title<input class="input" data-bind="title" placeholder="${esc(chat.characterIds.map((id) => S.chars[id]?.name).join(', '))}"></label>
      <div class="row"><img class="p-av" src="${personaAvatar(personaFor(chat))}" alt=""><div class="grow"><b>You: ${esc(personaFor(chat).name)}</b>
        <div class="muted small">${chat.personaId ? 'Persona chosen for this chat' : 'Using your default persona'}</div></div><button class="btn sm" data-act="persona">Change</button></div></section>
    <section class="panel"><div class="row between"><h2>Characters</h2><button class="btn sm" data-act="add">${ICON.plus} Add</button></div>
      ${members.map((c, i) => `<div class="member"><img src="${avatarOf(c)}" alt=""><span class="grow">${esc(c.name)}</span>
        <button class="icon-btn xs" data-act="up" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">▲</button>
        <label class="check small"><input type="checkbox" data-mute="${c.id}" ${chat.mutedIds.includes(c.id) ? 'checked' : ''}> mute</label>
        <button class="icon-btn sm" data-act="remove" data-id="${c.id}" aria-label="Remove">${ICON.trash}</button></div>`).join('')}
      <label>Who replies after you send a message?<select class="input" data-bind="groupMode">
        <option value="natural">Natural — characters you mention reply; otherwise one picked by talkativeness</option>
        <option value="round">Round robin — every unmuted character replies in order</option>
        <option value="manual">Manual — nobody replies until you tap a character</option></select></label>
      <p class="hint">In any mode, tap a character's bubble above the message box to make them speak next. Send an empty message to let the scene continue.</p>
    </section>
    <section class="panel"><h2>Scene</h2>
      <label>Scenario override<span class="hint">Replaces the characters' own scenario in this chat.</span><textarea class="input" rows="3" data-bind="scenario"></textarea></label>
      <label>Author's note<span class="hint">Short steering text inserted near the end of the context.</span><textarea class="input" rows="2" data-bind="authorNote"></textarea></label>
      <label class="narrow">Insertion depth<input class="input" type="number" min="0" data-bind="authorNoteDepth"></label>
    </section>
    <section class="panel"><h2>Lorebooks in this chat</h2>
      ${books.length ? books.map((b) => `<label class="check"><input type="checkbox" data-chatbook value="${b.id}" ${chat.lorebookIds.includes(b.id) ? 'checked' : ''}> ${esc(b.name)}</label>`).join('') : '<p class="muted small">No standalone lorebooks.</p>'}
      <p class="hint">Also active: global lorebooks, plus each character's embedded and linked lorebooks.</p>
    </section>
    <section class="panel"><div class="row wrap"><button class="btn" data-act="export">Export chat</button><button class="btn danger" data-act="delete">Delete chat</button></div></section>
  </main>`;
  const main = $('#main');
  bindFields(main, chat, save);
  main.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.mute) { chat.mutedIds = $$('[data-mute]:checked', main).map((x) => x.dataset.mute); save(); }
    if (t.hasAttribute('data-chatbook')) { chat.lorebookIds = $$('[data-chatbook]:checked', main).map((x) => x.value); save(); }
  });
  handleActs({
    persona: async () => { await switchChatPersona(chat); },
    add: () => addMembers(chat),
    up: (el) => { const i = +el.dataset.i; [chat.characterIds[i - 1], chat.characterIds[i]] = [chat.characterIds[i], chat.characterIds[i - 1]]; save.flush(); viewChatSettings(chat); },
    remove: async (el) => {
      if (!(await confirmBox('Remove this character from the chat? Their messages stay.', 'Remove'))) return;
      chat.characterIds = chat.characterIds.filter((x) => x !== el.dataset.id);
      chat.mutedIds = chat.mutedIds.filter((x) => x !== el.dataset.id);
      save.flush(); viewChatSettings(chat);
    },
    export: () => exportChat(chat),
    delete: async () => {
      if (!(await confirmBox('Delete this chat?', 'Delete', true))) return;
      await db.del('chats', chat.id); delete S.chats[chat.id]; go('/chats');
    },
  });
}

// =====================================================================
// BOOT
// =====================================================================

async function boot() {
  S.settings = await loadSettings();
  for (const c of await db.all('characters')) S.chars[c.id] = c;
  for (const b of await db.all('lorebooks')) S.books[b.id] = b;
  for (const c of await db.all('chats')) S.chats[c.id] = c;
  for (const p of await db.all('personas')) S.personas[p.id] = p;
  if (!Object.keys(S.personas).length) {
    const lp = S.settings.persona;
    const p = newPersona({ name: lp.name || 'User', description: lp.description || '', avatar: lp.avatar || '' });
    await savePersona(p);
    S.settings.activePersonaId = p.id;
    await saveSettings(S.settings);
  }
  window.addEventListener('hashchange', route);
  onBack(() => {
    if (closeTopModal()) return true;
    if (S.editingMsg) { S.editingMsg = null; route(); return true; }
    const [view] = parts();
    if (!view || HOME_TABS.includes(view)) {
      if (S.homeTab !== 'chats') { go('/chats'); return true; }
      return false;
    }
    history.back();
    return true;
  });
  // Allow sending with Enter on physical keyboards (Shift+Enter = newline)
  document.addEventListener('keydown', (e) => {
    if (e.target.id === 'input' && e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) {
      e.preventDefault(); $('#sendBtn')?.click();
    }
  });
  route();
  if ('serviceWorker' in navigator && !isNative && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot().catch((e) => { app.innerHTML = `<div class="empty"><h2>Failed to start</h2><p>${esc(e.message)}</p></div>`; });
