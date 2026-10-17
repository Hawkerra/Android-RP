// Bridges to Capacitor plugins when running as the Android app,
// with plain-browser fallbacks so the same code runs as a PWA.
const Cap = window.Capacitor;
export const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
const plugin = (name) => (Cap && Cap.Plugins ? Cap.Plugins[name] : null);

// Hosts where browser fetch failed (CORS) – go straight to native HTTP next time.
const nativeOnlyHosts = new Set();

function headersToObj(h) {
  const o = {};
  if (!h) return o;
  if (h instanceof Headers) h.forEach((v, k) => { o[k] = v; });
  else Object.assign(o, h);
  return o;
}

/**
 * HTTP request that survives CORS on Android by falling back to native HTTP.
 * Returns { ok, status, text(), json(), arrayBuffer(), body (ReadableStream|null) }.
 */
export async function request(url, { method = 'GET', headers = {}, body, signal, binary = false, stream = false } = {}) {
  const host = new URL(url).host;
  const tryBrowser = !isNative || !nativeOnlyHosts.has(host);
  if (tryBrowser) {
    try {
      const r = await fetch(url, { method, headers, body, signal });
      return {
        ok: r.ok, status: r.status, body: stream ? r.body : null,
        text: () => r.text(), json: () => r.json(), arrayBuffer: () => r.arrayBuffer(),
      };
    } catch (e) {
      if (e.name === 'AbortError' || !isNative) throw e;
      nativeOnlyHosts.add(host); // likely CORS – retry natively
    }
  }
  const Http = plugin('CapacitorHttp');
  if (!Http) throw new Error('Native HTTP unavailable');
  let data = body;
  if (typeof body === 'string') { try { data = JSON.parse(body); } catch { /* keep string */ } }
  // Chub sits behind a firewall that rejects empty or bot-like User-Agents.
  const h = { 'User-Agent': 'ChatForge/1.0 (Android)', ...headersToObj(headers) };
  const p = Http.request({
    url, method, headers: h, data,
    responseType: binary ? 'arraybuffer' : 'text', connectTimeout: 30000, readTimeout: 300000,
  });
  const res = await (signal ? Promise.race([p, new Promise((_, rej) => signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError'))))]) : p);
  const raw = res.data;
  const asText = () => (typeof raw === 'string' ? raw : JSON.stringify(raw));
  return {
    ok: res.status >= 200 && res.status < 300, status: res.status, body: null,
    text: async () => asText(),
    json: async () => (typeof raw === 'string' ? JSON.parse(raw) : raw),
    arrayBuffer: async () => {
      if (typeof raw !== 'string') return new TextEncoder().encode(JSON.stringify(raw)).buffer;
      const bin = atob(raw);
      const u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return u.buffer;
    },
  };
}

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

/** Save/share a file. On Android this opens the share sheet (Save to Files, Drive, etc.). */
export async function saveFile(filename, blob) {
  const Fs = plugin('Filesystem');
  const Share = plugin('Share');
  if (isNative && Fs && Share) {
    const data = await blobToBase64(blob);
    const w = await Fs.writeFile({ path: filename, data, directory: 'CACHE' });
    await Share.share({ title: filename, url: w.uri, dialogTitle: 'Save ' + filename });
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/** Hardware back button. handler() returns true if it navigated; otherwise the app exits. */
export function onBack(handler) {
  const App = plugin('App');
  if (!isNative || !App) return;
  App.addListener('backButton', () => { if (!handler()) App.exitApp(); });
}
