// Tiny IndexedDB wrapper. Every record is keyed by `id`.
const DB_NAME = 'chatforge';
const DB_VERSION = 1;
export const STORES = ['characters', 'lorebooks', 'chats', 'kv'];

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const db = {
  get: (store, id) => tx(store, 'readonly', s => s.get(id)),
  all: (store) => tx(store, 'readonly', s => s.getAll()).then(r => r || []),
  put: (store, obj) => tx(store, 'readwrite', s => s.put(obj)).then(() => obj),
  del: (store, id) => tx(store, 'readwrite', s => s.delete(id)),
  clear: (store) => tx(store, 'readwrite', s => s.clear()),
};

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- Settings ----------

export const CHUB_PRESETS = [
  { label: 'Chub – Asha (Mars)', provider: 'chub', baseUrl: 'https://mars.chub.ai/chub/asha/v1', model: 'asha' },
  { label: 'Chub – Mixtral (Mars)', provider: 'chub', baseUrl: 'https://mars.chub.ai/mixtral/v1', model: 'mixtral' },
  { label: 'Chub – Mythomax (Mercury)', provider: 'chub', baseUrl: 'https://mercury.chub.ai/mythomax/v1', model: 'mythomax' },
  { label: 'OpenRouter', provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: '' },
  { label: 'OpenAI-compatible (custom)', provider: 'openai', baseUrl: 'http://192.168.1.10:5001/v1', model: '' },
];

export const DEFAULT_PROMPTS = {
  main: "Write {{char}}'s next reply in a fictional roleplay between {{char}} and {{user}}. Stay in character, be descriptive and proactive, and never write dialogue or actions for {{user}}.",
  group: "This is a group roleplay with several characters: {{members}}. Write only {{char}}'s next reply. Do not write for {{user}} or the other characters.",
  postHistory: '',
  continueNudge: '[Continue the scene naturally from where it left off.]',
};

export function defaultSettings() {
  return {
    id: 'settings',
    connections: [{ id: uid(), name: 'Chub – Asha', ...pick(CHUB_PRESETS[0], ['provider', 'baseUrl', 'model']), apiKey: '' }],
    activeConnectionId: null,
    chubApiKey: '',
    gen: {
      temperature: 0.9, max_tokens: 350, top_p: 1, min_p: 0, frequency_penalty: 0,
      presence_penalty: 0, repetition_penalty: 1, context_size: 8192, stream: true,
    },
    persona: { name: 'User', description: '', avatar: '' },
    prompts: { ...DEFAULT_PROMPTS },
    globalLorebookIds: [],
    showNsfw: false,
  };
}

function pick(o, keys) { const r = {}; for (const k of keys) r[k] = o[k]; return r; }

export async function loadSettings() {
  const def = defaultSettings();
  const s = await db.get('kv', 'settings');
  if (!s) { def.activeConnectionId = def.connections[0].id; await db.put('kv', def); return def; }
  // shallow-merge new defaults into older saves
  return { ...def, ...s, gen: { ...def.gen, ...s.gen }, prompts: { ...def.prompts, ...s.prompts }, persona: { ...def.persona, ...s.persona } };
}

export const saveSettings = (s) => db.put('kv', s);

// ---------- Model factories ----------

export function newCharacter(over = {}) {
  return {
    id: uid(), name: 'New Character', avatar: '', description: '', personality: '', scenario: '',
    first_mes: '', alternate_greetings: [], mes_example: '', system_prompt: '', post_history_instructions: '',
    creator_notes: '', creator: '', character_version: '', tags: [], talkativeness: 0.5,
    character_book: null, lorebookIds: [], created: Date.now(), updated: Date.now(), ...over,
  };
}

export function newLorebook(over = {}) {
  return { id: uid(), name: 'New Lorebook', description: '', scanDepth: 4, tokenBudget: 1024, recursive: true, entries: [], created: Date.now(), updated: Date.now(), ...over };
}

export function newEntry(over = {}) {
  return {
    id: uid(), comment: '', keys: [], secondary_keys: [], selective: false, selectiveLogic: 'AND_ANY',
    content: '', constant: false, enabled: true, order: 100, position: 'after_char', depth: 4,
    caseSensitive: false, wholeWords: true, probability: 100, ...over,
  };
}

export function newChat(over = {}) {
  return {
    id: uid(), title: '', characterIds: [], mutedIds: [], lorebookIds: [], groupMode: 'natural',
    scenario: '', authorNote: '', authorNoteDepth: 4, messages: [],
    created: Date.now(), updated: Date.now(), ...over,
  };
}

export function newMessage(over = {}) {
  return { id: uid(), role: 'user', charId: null, name: '', swipes: [''], swipeIdx: 0, time: Date.now(), ...over };
}

export const msgText = (m) => m.swipes[m.swipeIdx] ?? '';
