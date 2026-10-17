// Small DOM helpers: escaping, message formatting, modals, toasts.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Roleplay-flavoured markdown: *actions*, **bold**, "speech", `code`, ``` blocks. */
export function fmt(text) {
  const blocks = [];
  let s = esc(text).replace(/```([\s\S]*?)(```|$)/g, (_, code) => { blocks.push(code); return `\u0000${blocks.length - 1}\u0000`; });
  s = s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(>])(&quot;|“)(.+?)(&quot;|”)/g, '$1<q>$3</q>')
    .replace(/\n/g, '<br>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<pre>${blocks[+i]}</pre>`);
}

export function timeAgo(t) {
  const d = (Date.now() - t) / 1000;
  if (d < 60) return 'now';
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  if (d < 604800) return `${Math.floor(d / 86400)}d`;
  return new Date(t).toLocaleDateString();
}

let toastTimer;
export function toast(msg, ms = 2600) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

const modalStack = [];
export const modalOpen = () => modalStack.length > 0;

/** Opens a bottom sheet. `build(el, close)` wires it up. Resolves with close(value). */
export function sheet(html, build) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'sheet-wrap';
    wrap.innerHTML = `<div class="sheet" role="dialog">${html}</div>`;
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add('open'));
    const close = (val) => {
      const i = modalStack.indexOf(close);
      if (i >= 0) modalStack.splice(i, 1);
      wrap.classList.remove('open');
      setTimeout(() => wrap.remove(), 200);
      resolve(val);
    };
    modalStack.push(close);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(undefined); });
    build?.(wrap.firstElementChild, close);
  });
}

/** Closes the topmost modal; returns true if one was open. */
export function closeTopModal() {
  const c = modalStack[modalStack.length - 1];
  if (c) { c(undefined); return true; }
  return false;
}

export function menu(title, items) {
  const html = `${title ? `<h3>${esc(title)}</h3>` : ''}<div class="menu">${items
    .map((it, i) => (it ? `<button class="menu-item ${it.danger ? 'danger' : ''}" data-i="${i}">${it.icon ? `<span class="mi">${it.icon}</span>` : ''}${esc(it.label)}</button>` : ''))
    .join('')}</div>`;
  return sheet(html, (el, close) => {
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (b) { close(); items[+b.dataset.i].run?.(); }
    });
  });
}

export function confirmBox(message, okLabel = 'OK', danger = false) {
  return sheet(`<p class="confirm-msg">${esc(message)}</p><div class="row end"><button class="btn ghost" data-x="0">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-x="1">${esc(okLabel)}</button></div>`,
    (el, close) => el.addEventListener('click', (e) => { const b = e.target.closest('[data-x]'); if (b) close(b.dataset.x === '1'); }));
}

export function promptBox(title, value = '', { multiline = false, placeholder = '' } = {}) {
  const field = multiline
    ? `<textarea class="input" rows="8" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
    : `<input class="input" value="${esc(value)}" placeholder="${esc(placeholder)}">`;
  return sheet(`<h3>${esc(title)}</h3>${field}<div class="row end"><button class="btn ghost" data-x="0">Cancel</button><button class="btn primary" data-x="1">Save</button></div>`,
    (el, close) => {
      const inp = el.querySelector('.input');
      setTimeout(() => inp.focus(), 50);
      el.addEventListener('click', (e) => { const b = e.target.closest('[data-x]'); if (b) close(b.dataset.x === '1' ? inp.value : null); });
      if (!multiline) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(inp.value); });
    });
}

/** Opens a file picker and resolves with the chosen File(s). */
export function pickFile(accept, multiple = false) {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = accept; inp.multiple = multiple;
    inp.onchange = () => resolve(multiple ? [...inp.files] : inp.files[0]);
    inp.click();
  });
}

export function readAsDataUrl(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
}

export function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
}

export function debounce(fn, ms = 400) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  return d;
}

export const ICON = {
  back: '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="M4 12l16-8-6 16-2-7z"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  people: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-4 3.4-6 6.5-6s5.7 2 6.5 6"/><circle cx="17" cy="9" r="2.5"/><path d="M17 14c2.5 0 4 1.6 4.6 4.5"/></svg>',
  book: '<svg viewBox="0 0 24 24"><path d="M5 4h11a3 3 0 013 3v13H8a3 3 0 01-3-3z"/><path d="M5 17a3 3 0 013-3h11"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l5 5"/></svg>',
  left: '<svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
  upload: '<svg viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5M4 20h16"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
};
