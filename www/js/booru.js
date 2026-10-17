// Generic booru-style search, used for Botbooru.
// Boorus run one of a few engines, each with its own JSON API. We don't know which one a
// site uses, so the first search probes each style and remembers whichever answers.
import { request } from './native.js';
import { readPngCard, characterFromCard, resizeImage, bufferToDataUrl } from './cards.js';

const PER_PAGE = 24;
const SAFE_RATINGS = new Set(['s', 'g', 'safe', 'general', 'sensitive']);

/** Booru tags use underscores instead of spaces. */
const toTag = (t) => t.trim().replace(/\s+/g, '_');

function buildTags({ query = '', tags = [], excludeTags = [] }) {
  const out = [...tags.map(toTag), ...excludeTags.map((t) => '-' + toTag(t))];
  // Free text is treated as a wildcard tag, so "elf" finds elf, dark_elf, elf_girl…
  if (query.trim()) out.push(`*${toTag(query)}*`);
  return out.filter(Boolean);
}

const splitTags = (s) => (Array.isArray(s) ? s : String(s || '').split(/\s+/)).filter(Boolean).map((t) => t.replace(/_/g, ' '));

/** API styles: how to build a search URL and how to read posts out of the response. */
const ENGINES = {
  danbooru: {
    url: (base, tags, page, sort) => `${base}/posts.json?limit=${PER_PAGE}&page=${page}&tags=${encodeURIComponent([...tags, sort === 'popular' ? 'order:score' : ''].filter(Boolean).join(' '))}`,
    posts: (j) => (Array.isArray(j) ? j : null),
    map: (p) => ({
      id: p.id, file: p.file_url || p.large_file_url, thumb: p.preview_file_url || p.large_file_url || p.file_url,
      tags: splitTags(p.tag_string_general || p.tag_string), name: splitTags(p.tag_string_character)[0],
      score: p.score ?? p.fav_count ?? 0, rating: p.rating, ext: p.file_ext,
    }),
  },
  gelbooru: {
    url: (base, tags, page, sort) => `${base}/index.php?page=dapi&s=post&q=index&json=1&limit=${PER_PAGE}&pid=${page - 1}&tags=${encodeURIComponent([...tags, sort === 'popular' ? 'sort:score' : ''].filter(Boolean).join(' '))}`,
    posts: (j) => (Array.isArray(j) ? j : Array.isArray(j?.post) ? j.post : j && typeof j === 'object' && '@attributes' in j ? [] : null),
    map: (p) => ({
      id: p.id, file: p.file_url, thumb: p.preview_url || p.sample_url || p.file_url,
      tags: splitTags(p.tags), score: p.score ?? 0, rating: p.rating, title: p.title,
    }),
  },
  moebooru: {
    url: (base, tags, page, sort) => `${base}/post.json?limit=${PER_PAGE}&page=${page}&tags=${encodeURIComponent([...tags, sort === 'popular' ? 'order:score' : ''].filter(Boolean).join(' '))}`,
    posts: (j) => (Array.isArray(j) ? j : null),
    map: (p) => ({ id: p.id, file: p.file_url, thumb: p.preview_url || p.sample_url || p.file_url, tags: splitTags(p.tags), score: p.score ?? 0, rating: p.rating }),
  },
  szurubooru: {
    url: (base, tags, page, sort) => `${base}/api/posts/?offset=${(page - 1) * PER_PAGE}&limit=${PER_PAGE}&query=${encodeURIComponent([...tags, sort === 'popular' ? 'sort:score' : ''].filter(Boolean).join(' '))}`,
    posts: (j) => (Array.isArray(j?.results) ? j.results : null),
    map: (p) => ({
      id: p.id, file: p.contentUrl, thumb: p.thumbnailUrl || p.contentUrl,
      tags: (p.tags || []).map((t) => (t.names ? t.names[0] : t)).map((t) => String(t).replace(/_/g, ' ')),
      score: p.score ?? 0, rating: p.safety,
    }),
  },
  philomena: {
    url: (base, tags, page, sort) => `${base}/api/v1/json/search/images?per_page=${PER_PAGE}&page=${page}&q=${encodeURIComponent(tags.map((t) => (t.startsWith('-') ? '-' + t.slice(1).replace(/_/g, ' ') : t.replace(/_/g, ' '))).join(', ') || '*')}${sort === 'popular' ? '&sf=score&sd=desc' : ''}`,
    posts: (j) => (Array.isArray(j?.images) ? j.images : null),
    map: (p) => ({
      id: p.id, file: p.view_url || p.representations?.full, thumb: p.representations?.thumb || p.representations?.medium,
      tags: p.tags || [], score: p.score ?? 0, title: p.name, rating: (p.tags || []).find((t) => ['safe', 'suggestive', 'questionable', 'explicit'].includes(t)),
    }),
  },
};

const engineCache = new Map(); // base URL -> engine name
const failedBases = new Map(); // base URL -> Error, so a dead site isn't re-probed on every search

async function fetchPosts(base, engine, tags, page, sort) {
  const E = ENGINES[engine];
  const r = await request(E.url(base, tags, page, sort), { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  let j;
  try { j = await r.json(); } catch { throw new Error('not JSON'); }
  const posts = E.posts(j);
  if (!posts) throw new Error('unexpected response');
  return posts.map(E.map);
}

/** Finds which API style `base` speaks by trying each with an empty search. */
async function detectEngine(base) {
  if (engineCache.has(base)) return engineCache.get(base);
  if (failedBases.has(base)) throw failedBases.get(base);
  for (const name of Object.keys(ENGINES)) {
    try {
      await fetchPosts(base, name, [], 1, 'new');
      engineCache.set(base, name);
      return name;
    } catch { /* try the next style */ }
  }
  const err = new Error(`couldn't find a search API at ${base} (tried ${Object.keys(ENGINES).join(', ')})`);
  failedBases.set(base, err);
  throw err;
}

const abs = (base, u) => (!u ? '' : /^https?:/i.test(u) ? u : u.startsWith('//') ? 'https:' + u : base + (u.startsWith('/') ? '' : '/') + u);

/** Search in the same result shape the bot browser uses for Chub. */
export async function booruSearch(base, { query, tags, excludeTags, page = 1, nsfw = false, sort }, sourceId = 'botbooru') {
  base = base.replace(/\/+$/, '');
  const engine = await detectEngine(base);
  const posts = await fetchPosts(base, engine, buildTags({ query, tags, excludeTags }), page, sort === 'created_at' || sort === 'last_activity_at' ? 'new' : 'popular');
  return posts
    .filter((p) => p.file && (nsfw || !p.rating || SAFE_RATINGS.has(String(p.rating).toLowerCase())))
    .map((p) => ({
      source: sourceId, id: `${sourceId}:${p.id}`, postId: p.id,
      name: p.title || (p.name ? p.name.replace(/\b\w/g, (c) => c.toUpperCase()) : `Card #${p.id}`),
      tagline: p.tags.slice(0, 8).join(', '), stars: p.score, tags: p.tags,
      avatar: abs(base, p.thumb), file: abs(base, p.file), creator: '',
    }));
}

/** Downloads a search result's file and reads the character card out of it. */
export async function booruImport(r) {
  const res = await request(r.file, { binary: true });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const buf = await res.arrayBuffer();
  let card;
  try { card = readPngCard(buf); } catch { throw new Error('That post has no character card embedded in its image'); }
  return characterFromCard(card, await resizeImage(await bufferToDataUrl(buf), 512));
}
