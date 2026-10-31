// Botbooru (botbooru.com) search and card import.
// Botbooru runs its own software rather than a standard booru engine. These endpoints are the
// ones its own web pages call (checked against the live site):
//   GET /posts/?q=&sort=&limit=&offset=[&sfw_only=true]  -> { total, total_is_capped, posts: [...] }
//   GET /images/preview/{px}/{filename}                   -> thumbnail
//   GET /images/{filename}                                -> the full PNG character card
// Query syntax: space-separated terms must all match, "-tag" excludes, multi-word tags use
// underscores, and plain words also match character names.
import { request } from './native.js';
import { readPngCard, characterFromCard, resizeImage, bufferToDataUrl } from './cards.js';

const PER_PAGE = 24;

/** Bot-browser sort values (shared with Chub) mapped to Botbooru's. */
const SORTS = { download_count: 'downloads', star_count: 'favorites', created_at: 'latest', last_activity_at: 'latest' };

const toTag = (t) => t.trim().replace(/\s+/g, '_');

function buildQuery({ query = '', tags = [], excludeTags = [] }) {
  return [query.trim(), ...tags.map(toTag), ...excludeTags.map((t) => '-' + toTag(t))].filter(Boolean).join(' ');
}

/** Search in the same result shape the bot browser uses for Chub. */
export async function botbooruSearch(base, { query, tags, excludeTags, page = 1, nsfw = false, sort }) {
  base = base.replace(/\/+$/, '');
  const p = new URLSearchParams({ q: buildQuery({ query, tags, excludeTags }), sort: SORTS[sort] || 'downloads', limit: String(PER_PAGE), offset: String((page - 1) * PER_PAGE) });
  if (sort === 'last_activity_at') p.set('latest_include_updated', 'true');
  if (!nsfw) p.set('sfw_only', 'true');
  const r = await request(`${base}/posts/?${p}`, { headers: { Accept: 'application/json' } });
  if (r.status === 429) throw new Error('Botbooru search limit reached. Wait a minute and try again.');
  if (!r.ok) throw new Error(`Botbooru search failed (${r.status})`);
  let data;
  try { data = await r.json(); } catch { throw new Error('Botbooru sent an unexpected response'); }
  return (data.posts || []).filter((x) => x.filename).map((x) => {
    const tagsOf = (cat) => (x.tags || []).filter((t) => t.category === cat).map((t) => t.name);
    const bust = x.card_image_revision ? `?v=${x.card_image_revision}` : '';
    return {
      source: 'botbooru', id: `botbooru:${x.id}`, postId: x.id,
      name: (x.meta_name || '').trim() || x.character_name || `Card #${x.id}`,
      tagline: x.tagline || x.creator_notes_excerpt || x.description_excerpt || '',
      // "Auto" tags are site bookkeeping (origin_chub, has_example_dialogue…), not useful for searching
      tags: (x.tags || []).filter((t) => t.category !== 'Auto').map((t) => t.name.replace(/_/g, ' ')),
      stars: x.favorite_count || 0, downloads: x.downloads || 0,
      creator: tagsOf('Writer')[0] || '',
      avatar: `${base}/images/preview/320/${encodeURIComponent(x.filename)}${bust}`,
      file: `${base}/images/${encodeURIComponent(x.filename)}${bust}`,
    };
  });
}

/** Downloads a result's card PNG and reads the character out of it. */
export async function botbooruImport(r) {
  const res = await request(r.file, { binary: true });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const buf = await res.arrayBuffer();
  let card;
  try { card = readPngCard(buf); } catch { throw new Error('That card has no character data embedded in its image'); }
  return characterFromCard(card, await resizeImage(await bufferToDataUrl(buf), 512));
}
