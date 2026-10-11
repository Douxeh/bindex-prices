// Daily Bindex price build for several trading card games.
//
// Sources:
//  - Scrydex (https://scrydex.com): every English card with USD raw prices
//    per variant/condition, graded prices and 1–180 day trends.
//  - Cardmarket price guides (public daily downloads): EUR trend/avg/low per
//    product, including the reverse-holo / foil ("-holo"/"-foil") columns.
//  - ECB reference rate: USD→EUR conversion for the app's currency switch.
//
// Cardmarket's guides have no card numbers, so each Cardmarket product is
// matched to a Scrydex card: expansion by card-name overlap, then within a
// name group by price rank (falling back to release order).
//
// Output (./public, served by GitHub Pages):
//   v1/meta.json                      run info, games, USD→EUR rate
//   v1/<game>/sets.json               all expansions of a game
//   v1/<game>/sets/<setId>.json       every card in the set with prices
//   v1/<game>/history/<setId>.json    daily price points per card+variant
//   v1/<game>/search.json             compact all-card index for search
//
// Big catalogs (Magic) are refreshed in rotating shards: recent sets every
// day, older sets once a week; the rest of the files carry over from the
// previous deploy.
//
// Env: SCRYDEX_API_KEY, SCRYDEX_TEAM_ID, PAGES_URL (previous deploy),
//      ONLY_GAMES / ONLY_SETS (comma lists, for local runs)

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const OUT = process.env.OUT_DIR || 'public';
const PAGES_URL = (process.env.PAGES_URL || '').replace(/\/$/, '');
const HISTORY_DAYS = 400;
const ONLY_GAMES = (process.env.ONLY_GAMES || '').split(',').filter(Boolean);
const ONLY_SETS = (process.env.ONLY_SETS || '').split(',').filter(Boolean);
const GRADED_COMPANIES = new Set(['PSA', 'CGC', 'BGS', 'SGC', 'TAG', 'ACE', 'AGS']);

const GAMES = [
  {
    id: 'pokemon', name: 'Pokémon', scrydex: 'pokemon', cardmarketGame: 6,
    standardVariants: ['normal', 'holofoil', 'unlimitedHolofoil', 'unlimited', '1stEditionHolofoil', 'firstEditionHolofoil'],
    secondVariant: 'reverseHolofoil', secondSuffix: '-holo',
    includeExpansion: (e) => !e.is_online_only,
    sealed: true,
  },
  {
    id: 'onepiece', name: 'One Piece', scrydex: 'onepiece', cardmarketGame: 18,
    standardVariants: ['normal'],
    secondVariant: null, secondSuffix: null,
    includeExpansion: () => true,
    // Cardmarket names One Piece singles "Name (OP01-003)": match on that code,
    // one product per printing (normal, alt art, manga…).
    matchByCode: true,
    sealed: true,
  },
  {
    id: 'mtg', name: 'Magic: The Gathering', scrydex: 'magicthegathering', cardmarketGame: 1,
    standardVariants: ['normal', 'nonfoil'],
    secondVariant: 'foil', secondSuffix: '-foil',
    expansionQuery: '',
    includeExpansion: (e) => !e.is_online_only && !e.is_foreign_only
      && !['memorabilia', 'alchemy', 'token', 'minigame'].includes(e.type),
    // ~105k cards: refresh sets released in the last 120 days daily, the rest weekly.
    rotation: { shards: 7, recentDays: 120 },
  },
  {
    id: 'lorcana', name: 'Disney Lorcana', scrydex: 'lorcana', cardmarketGame: 19,
    standardVariants: ['normal'],
    secondVariant: 'foil', secondSuffix: '-foil',
    expansionQuery: '', // the language filter isn't supported for Lorcana
    includeExpansion: (e) => !e.language_code || e.language_code === 'EN',
  },
  {
    id: 'gundam', name: 'Gundam', scrydex: 'gundam', cardmarketGame: 24,
    standardVariants: ['normal'],
    secondVariant: null, secondSuffix: null,
    includeExpansion: () => true,
  },
  {
    id: 'riftbound', name: 'Riftbound', scrydex: 'riftbound', cardmarketGame: 22,
    standardVariants: ['normal'],
    secondVariant: 'foil', secondSuffix: '-foil',
    includeExpansion: () => true,
    sealed: true,
  },
  {
    // Not on Scrydex: cards, images, USD prices and sealed products come from
    // TCGplayer (via tcgcsv.com), EUR prices from the Cardmarket price guide.
    id: 'dragonball', name: 'Dragon Ball Super', source: 'tcgcsv', cardmarketGame: 13,
    disabled: true, // parked: no price trends/history yet
    tcgplayerCategories: [
      { id: 80, prefix: 'fw', series: 'Fusion World' },
      { id: 27, prefix: 'masters', series: 'Masters' },
    ],
    standardVariants: ['normal', 'foil'],
    secondVariant: null, secondSuffix: null,
    includeExpansion: () => true,
    sealed: true,
  },
];

const key = process.env.SCRYDEX_API_KEY;
const team = process.env.SCRYDEX_TEAM_ID;
const needsScrydex = GAMES.some((g) => g.source !== 'tcgcsv' && (!ONLY_GAMES.length || ONLY_GAMES.includes(g.id)));
if (needsScrydex && (!key || !team)) {
  console.error('Missing SCRYDEX_API_KEY / SCRYDEX_TEAM_ID');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = new Date().toISOString().slice(0, 10);
const dayNumber = Math.floor(Date.now() / 86_400_000);
let creditsUsed = 0;

async function fetchJSON(url, { headers = {}, attempts = 5, allow404 = false } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (res.status === 404 && allow404) return null;
      if (res.status === 429 || res.status >= 500) {
        const wait = Number(res.headers.get('retry-after')) * 1000 || 1000 * 2 ** attempt;
        console.warn(`  ${res.status} on ${url} — retrying in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
      return await res.json();
    } catch (error) {
      if (attempt === attempts) throw error;
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw new Error(`Gave up on ${url}`);
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }));
  return results;
}

const round = (n) => (n == null || Number.isNaN(n) ? null : Math.round(n * 100) / 100);

function hashString(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h);
}

function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// ---------- FX ----------

async function usdToEur() {
  try {
    const res = await fetch('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml');
    const xml = await res.text();
    const rate = Number(xml.match(/currency='USD' rate='([0-9.]+)'/)?.[1]);
    return rate > 0 ? round4(1 / rate) : null;
  } catch {
    return null;
  }
}
const round4 = (n) => Math.round(n * 10000) / 10000;

// ---------- Scrydex ----------

function scrydexClient(game) {
  const base = `https://api.scrydex.com/${game.scrydex}/v1`;
  const get = (path) => {
    creditsUsed++;
    return fetchJSON(`${base}${path}`, { headers: { 'X-Api-Key': key, 'X-Team-ID': team } });
  };
  return {
    async expansions() {
      const all = [];
      for (let page = 1; ; page++) {
        const query = game.expansionQuery ?? 'q=language_code:EN';
        const body = await get(`/expansions?page_size=100&page=${page}${query ? `&${query}` : ''}`);
        all.push(...body.data);
        if (all.length >= (body.total_count ?? 0) || body.data.length === 0) break;
      }
      return all.filter(game.includeExpansion);
    },
    async sealed() {
      const all = [];
      for (let page = 1; ; page++) {
        const body = await get(`/sealed?page_size=100&page=${page}&include=prices`);
        all.push(...body.data);
        if (all.length >= (body.total_count ?? 0) || body.data.length === 0) break;
      }
      return all;
    },
    async cards(setId) {
      const cards = [];
      const select = 'id,name,number,printed_number,rarity,supertype,type,images,variants';
      for (let page = 1; ; page++) {
        const body = await get(`/expansions/${encodeURIComponent(setId)}/cards?include=prices&page_size=100&page=${page}&select=${select}`);
        cards.push(...body.data);
        if (cards.length >= (body.total_count ?? 0) || body.data.length === 0) break;
      }
      return cards;
    },
  };
}

// ---------- TCGplayer via tcgcsv.com (games Scrydex doesn't cover) ----------

const extended = (product, name) => product.extendedData?.find((e) => e.name === name)?.value ?? null;

function tcgcsvClient(game) {
  const base = 'https://tcgcsv.com/tcgplayer';
  const headers = { 'User-Agent': 'bindex-prices/1.0 (+https://github.com/Douxeh/bindex-prices)' };
  const groups = new Map();
  const groupData = new Map();
  const load = async (setId) => {
    if (!groupData.has(setId)) {
      const g = groups.get(setId);
      groupData.set(setId, Promise.all([
        fetchJSON(`${base}/${g.categoryId}/${g.groupId}/products`, { headers }),
        fetchJSON(`${base}/${g.categoryId}/${g.groupId}/prices`, { headers }),
      ]).then(([products, prices]) => ({ products: products.results || [], prices: prices.results || [] })));
    }
    return groupData.get(setId);
  };
  return {
    async expansions() {
      const all = [];
      for (const category of game.tcgplayerCategories) {
        const body = await fetchJSON(`${base}/${category.id}/groups`, { headers });
        for (const g of body.results || []) {
          const id = `${category.prefix}-${String(g.abbreviation || g.groupId).toLowerCase().replace(/[^a-z0-9]+/g, '')}`;
          if (groups.has(id)) continue;
          groups.set(id, { ...g, categoryId: category.id });
          all.push({ id, name: g.name, series: category.series, code: g.abbreviation ?? null, release_date: g.publishedOn?.slice(0, 10) ?? null });
        }
      }
      return all;
    },
    async compactCards(setId) {
      const { products, prices } = await load(setId);
      const byProduct = new Map();
      for (const p of prices) {
        if (!byProduct.has(p.productId)) byProduct.set(p.productId, []);
        byProduct.get(p.productId).push(p);
      }
      return products.filter((p) => extended(p, 'Number')).map((p) => {
        const number = extended(p, 'Number');
        const variants = (byProduct.get(p.productId) || [])
          .map((row) => ({
            name: /foil/i.test(row.subTypeName) ? 'foil' : 'normal',
            usd: (row.marketPrice ?? row.midPrice) != null ? { market: round(row.marketPrice ?? row.midPrice), low: round(row.lowPrice), change: {}, past: {} } : null,
            conditions: {}, graded: [], tcgplayerId: String(p.productId),
          }))
          .sort((a, b) => (a.name === 'normal' ? -1 : 1) - (b.name === 'normal' ? -1 : 1));
        return {
          id: `dbs-${p.productId}`,
          name: p.name.replace(` - ${number}`, '').trim(),
          number,
          printedNumber: null,
          rarity: extended(p, 'Rarity'),
          supertype: extended(p, 'CardType'),
          imageSmall: p.imageUrl ?? null,
          imageLarge: p.imageUrl?.replace('_200w', '_in_1000x1000') ?? null,
          variants: variants.length ? variants : [{ name: 'normal', usd: null, conditions: {}, graded: [], tcgplayerId: String(p.productId) }],
        };
      });
    },
    /** Sealed products in the same shape Scrydex returns them. */
    async sealed() {
      const out = [];
      await mapLimit([...groups.keys()], 4, async (setId) => {
        const g = groups.get(setId);
        const { products, prices } = await load(setId);
        for (const p of products) {
          if (extended(p, 'Number')) continue;
          const row = prices.find((r) => r.productId === p.productId);
          const usd = row?.marketPrice ?? row?.midPrice;
          if (usd == null || /code card/i.test(p.name)) continue;
          out.push({
            id: `dbs-${p.productId}`, name: p.name, release_date: g.publishedOn?.slice(0, 10) ?? null,
            expansion: { id: setId, name: g.name },
            variants: [{
              name: 'normal',
              images: [{ type: 'front', small: p.imageUrl, large: p.imageUrl?.replace('_200w', '_in_1000x1000') }],
              prices: [{ type: 'raw', currency: 'USD', market: usd }],
              marketplaces: [{ name: 'tcgplayer', product_id: String(p.productId) }],
            }],
          });
        }
      });
      return out;
    },
  };
}

/**
 * Dragon Ball Super on Cardmarket: Fusion World singles carry their code
 * ("Son Goku (FB04-129) [Fusion World]"), Masters singles only a name.
 * Prints of one code (regular, alt art…) are paired by price rank.
 */
function attachDragonBall(cards, cm, claimed, game) {
  const byNumber = new Map();
  for (const card of cards) {
    if (!byNumber.has(card.number)) byNumber.set(card.number, []);
    byNumber.get(card.number).push(card);
  }
  const usdOf = (card) => card.variants.find((v) => v.usd?.market != null)?.usd.market ?? 0;
  // Foil prints (SR, alt arts…) are priced in Cardmarket's foil columns.
  const trendOf = (product) => { const g = cm.prices.get(product.idProduct) || {}; return g.trend || g['trend-foil'] || 0; };
  // Sort key that still ranks prints without a recent trend.
  const rankOf = (product) => {
    const g = cm.prices.get(product.idProduct) || {};
    return g.trend || g['trend-foil'] || g.avg30 || g['avg30-foil'] || g.avg || g['avg-foil'] || g.low || 0;
  };
  const setEur = (card, product) => {
    card.cardmarketId = product.idProduct;
    const target = card.variants[0];
    if (!target) return;
    const g = cm.prices.get(product.idProduct);
    const [first, second] = target.name === 'foil' ? ['-foil', ''] : ['', '-foil'];
    const pick = (suffix) => { const v = eurFrom(g, suffix); return v?.trend ? v : null; };
    target.eur = pick(first) || pick(second) || eurFrom(g, first);
    // A wildly different price means the prints were paired wrongly: leave EUR out.
    const usd = target.usd?.market;
    if (usd >= 1 && target.eur?.trend && (target.eur.trend / usd < 0.25 || target.eur.trend / usd > 4)) {
      target.eur = null;
      delete card.cardmarketId;
    }
  };

  // Fusion World: the same code sits in several Cardmarket expansions
  // (English, Japanese, reprints) — take the one whose prices track the US market.
  const counts = new Map();
  for (const number of byNumber.keys()) {
    for (const id of new Set((cm.byLooseCode.get(number) || []).map((p) => p.idExpansion))) counts.set(id, (counts.get(id) || 0) + 1);
  }
  const median = (xs) => { const v = [...xs].sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : Infinity; };
  let best = null;
  for (const [expansionId, hits] of [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5)) {
    const coverage = hits / byNumber.size;
    if (coverage < 0.5) continue;
    const errors = [];
    for (const [number, group] of byNumber) {
      const usd = Math.min(...group.map(usdOf).filter((u) => u > 0));
      const trends = (cm.byLooseCode.get(number) || []).filter((p) => p.idExpansion === expansionId).map(trendOf).filter((t) => t > 0);
      if (usd >= 0.25 && usd < Infinity && trends.length) errors.push(Math.abs(Math.log(Math.min(...trends) / usd)));
    }
    const score = median(errors) - coverage;
    if (errors.length >= 3 && (!best || score < best.score)) best = { expansionId, score };
  }
  if (best) {
    for (const [number, group] of byNumber) {
      const products = (cm.byLooseCode.get(number) || [])
        .filter((p) => p.idExpansion === best.expansionId)
        .sort((x, y) => rankOf(x) - rankOf(y));
      if (!products.length) continue;
      const ordered = [...group].sort((x, y) => usdOf(x) - usdOf(y));
      if (ordered.length === products.length) ordered.forEach((card, i) => setEur(card, products[i]));
      else setEur(ordered[0], products.find((p) => trendOf(p) > 0) || products[0]);
    }
    return best.expansionId;
  }

  // Masters: match on the card name within the most alike expansion.
  const result = matchExpansion(cards, cm, claimed, game);
  if (result.expansionId) claimed.add(result.expansionId);
  for (const card of cards) {
    const match = result.matches.get(card.id);
    if (match?.guide) setEur(card, { idProduct: match.idProduct });
  }
  return result.expansionId;
}

function compactVariant(variant) {
  const prices = variant.prices || [];
  const nm = prices.find((p) => p.type === 'raw' && p.condition === 'NM' && p.currency === 'USD');
  const change = (days) => nm?.trends?.[`days_${days}`]?.price_change;
  const usd = nm ? {
    market: round(nm.market),
    low: round(nm.low),
    change: Object.fromEntries([1, 7, 14, 30, 90, 180]
      .map((d) => [`d${d}`, round(nm.trends?.[`days_${d}`]?.percent_change)])
      .filter(([, v]) => v != null)),
    // Price n days ago = market − change over n days.
    past: Object.fromEntries([1, 7, 14, 30, 90, 180]
      .map((d) => [`d${d}`, change(d) != null && nm.market != null ? round(nm.market - change(d)) : null])
      .filter(([, v]) => v != null && v > 0)),
  } : null;
  const conditions = Object.fromEntries(prices
    .filter((p) => p.type === 'raw' && p.currency === 'USD' && p.condition && p.market != null)
    .map((p) => [p.condition, round(p.market)]));
  const graded = prices
    .filter((p) => p.type === 'graded' && GRADED_COMPANIES.has(p.company) && p.market != null
      && !p.is_perfect && !p.is_signed && !p.is_error)
    .map((p) => ({ company: p.company, grade: p.grade, market: round(p.market), low: round(p.low), high: round(p.high) }))
    .sort((a, b) => a.company.localeCompare(b.company) || Number(b.grade) - Number(a.grade));
  const tcgplayer = (variant.marketplaces || []).find((m) => m.name === 'tcgplayer');
  return { name: variant.name, usd, conditions, graded, tcgplayerId: tcgplayer?.product_id ?? null };
}

function compactCard(card) {
  const image = (card.images || []).find((i) => i.type === 'front') || card.images?.[0];
  return {
    id: card.id,
    name: card.name,
    // Some cards (One Piece DON!!, a few promos) have no number; fall back
    // to the printed number or the id suffix so every card is addressable.
    number: card.number ?? card.printed_number ?? String(card.id).split('-').pop(),
    printedNumber: card.printed_number ?? null,
    rarity: card.rarity ?? null,
    supertype: card.supertype ?? card.type ?? null,
    imageSmall: image?.small ?? null,
    imageLarge: image?.large ?? null,
    variants: (card.variants || []).map(compactVariant),
  };
}

// ---------- Cardmarket ----------

const normalizeName = (name) => name
  .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
  .replace(/\[.*?\]/g, ' ')
  .replace(/\(.*?\)/g, ' ')
  .split(' // ')[0]
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/[’']/g, "'")
  .replace(/[^a-z0-9' -]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function naturalNumber(a, b) {
  const pa = String(a).match(/^(\D*)(\d+)(.*)$/);
  const pb = String(b).match(/^(\D*)(\d+)(.*)$/);
  if (pa && pb && pa[1] === pb[1]) return Number(pa[2]) - Number(pb[2]) || pa[3].localeCompare(pb[3]);
  return String(a).localeCompare(String(b));
}

async function loadCardmarket(gameId) {
  const base = 'https://downloads.s3.cardmarket.com/productCatalog';
  const [guide, products] = await Promise.all([
    fetchJSON(`${base}/priceGuide/price_guide_${gameId}.json`),
    fetchJSON(`${base}/productList/products_singles_${gameId}.json`),
  ]);
  const prices = new Map(guide.priceGuides.map((g) => [g.idProduct, g]));
  const byExpansion = new Map();
  for (const product of products.products) {
    if (!byExpansion.has(product.idExpansion)) byExpansion.set(product.idExpansion, []);
    byExpansion.get(product.idExpansion).push({ ...product, base: normalizeName(product.name) });
  }
  const expansionsByName = new Map();
  for (const [expansionId, list] of byExpansion) {
    for (const name of new Set(list.map((p) => p.base))) {
      if (!expansionsByName.has(name)) expansionsByName.set(name, new Set());
      expansionsByName.get(name).add(expansionId);
    }
  }
  const byCode = new Map();
  for (const product of products.products) {
    const code = product.name.match(/\(([A-Z0-9]+-[A-Z0-9]+)\)\s*$/)?.[1];
    if (!code) continue;
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(product);
  }
  // Like byCode, but also for names with a suffix ("Name (FB01-001) [Fusion World]").
  const byLooseCode = new Map();
  for (const product of products.products) {
    const code = product.name.match(/\(([A-Z0-9]+-[A-Z0-9]+)\)/)?.[1];
    if (!code) continue;
    if (!byLooseCode.has(code)) byLooseCode.set(code, []);
    byLooseCode.get(code).push(product);
  }
  return { createdAt: guide.createdAt, prices, byExpansion, expansionsByName, byCode, byLooseCode };
}

const eurFrom = (g, suffix = '') => {
  if (!g) return null;
  const v = {
    trend: round(g[`trend${suffix}`]) || null, // 0 means "no sales", not free avg: round(g[`avg${suffix}`]), low: round(g[`low${suffix}`]),
    avg1: round(g[`avg1${suffix}`]), avg7: round(g[`avg7${suffix}`]), avg30: round(g[`avg30${suffix}`]),
  };
  return Object.values(v).some((x) => x != null) ? v : null;
};

/**
 * One Piece: every printing of a card code is its own Cardmarket product, and
 * the same code exists in several Cardmarket expansions (English, Japanese,
 * reprints). Pick the expansion whose prices track the US market best, then
 * pair printings by price rank.
 */
function attachByCode(cards, cm) {
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : Infinity; };
  const candidates = new Map();
  for (const card of cards) {
    for (const p of cm.byCode.get(card.id) || []) candidates.set(p.idExpansion, (candidates.get(p.idExpansion) || 0) + 1);
  }
  const top = [...candidates.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id]) => id);
  let best = null;
  for (const expansionId of top) {
    const errors = [];
    for (const card of cards) {
      const usd = card.variants.find((v) => ['normal', 'foil'].includes(v.name))?.usd?.market;
      const trends = (cm.byCode.get(card.id) || []).filter((p) => p.idExpansion === expansionId)
        .map((p) => cm.prices.get(p.idProduct)?.trend).filter((t) => t > 0);
      if (usd >= 0.5 && trends.length) errors.push(Math.abs(Math.log(Math.min(...trends) / usd)));
    }
    const coverage = cards.filter((c) => (cm.byCode.get(c.id) || []).some((p) => p.idExpansion === expansionId)).length / cards.length;
    const score = median(errors) - coverage;
    if (errors.length >= 3 && (!best || score < best.score)) best = { expansionId, score };
  }
  if (!best) return null;

  for (const card of cards) {
    const products = (cm.byCode.get(card.id) || [])
      .filter((p) => p.idExpansion === best.expansionId)
      .map((p) => ({ ...p, guide: cm.prices.get(p.idProduct) }))
      .filter((p) => p.guide?.trend != null)
      .sort((a, b) => a.guide.trend - b.guide.trend);
    if (products.length === 0) continue;
    const priced = card.variants.filter((v) => v.usd?.market != null).sort((a, b) => a.usd.market - b.usd.market);
    card.cardmarketId = products[0].idProduct;
    if (priced.length === products.length) {
      priced.forEach((variant, i) => { variant.eur = eurFrom(products[i].guide); });
    } else {
      // Counts differ: only the cheapest printing (the regular one) is certain.
      const base = card.variants.find((v) => ['normal', 'foil'].includes(v.name)) || priced[0];
      if (base) base.eur = eurFrom(products[0].guide);
    }
  }
  return best.expansionId;
}

function primaryUsd(card, game) {
  const variant = card.variants.find((v) => game.standardVariants.includes(v.name) && v.usd?.market != null)
    || card.variants.find((v) => v.usd?.market != null);
  return variant?.usd?.market ?? null;
}

/** Returns Map(cardId -> Cardmarket product + price guide row). */
function matchExpansion(cards, cm, claimed, game) {
  const names = new Set(cards.map((c) => normalizeName(c.name)));
  const scores = new Map();
  for (const name of names) {
    for (const expansionId of cm.expansionsByName.get(name) || []) {
      scores.set(expansionId, (scores.get(expansionId) || 0) + 1);
    }
  }
  let best = null;
  for (const [expansionId, hits] of scores) {
    const score = hits / names.size;
    const size = cm.byExpansion.get(expansionId).length;
    const sizeGap = Math.abs(size - cards.length) / Math.max(size, cards.length);
    const rank = score - sizeGap * 0.5 - (claimed.has(expansionId) ? 0.2 : 0);
    if (!best || rank > best.rank) best = { expansionId, score, rank };
  }
  const result = new Map();
  if (!best || best.score < 0.5) return { expansionId: null, matches: result };

  const productGroups = new Map();
  for (const p of cm.byExpansion.get(best.expansionId)) {
    if (!productGroups.has(p.base)) productGroups.set(p.base, []);
    productGroups.get(p.base).push(p);
  }
  const cardGroups = new Map();
  for (const c of cards) {
    const base = normalizeName(c.name);
    if (!cardGroups.has(base)) cardGroups.set(base, []);
    cardGroups.get(base).push(c);
  }
  for (const [base, group] of cardGroups) {
    const candidates = productGroups.get(base);
    if (!candidates || candidates.length !== group.length) continue;
    let orderedCards = [...group].sort((a, b) => naturalNumber(a.number, b.number));
    let orderedProducts = [...candidates].sort((a, b) => a.idProduct - b.idProduct);
    const allPriced = group.every((c) => primaryUsd(c, game) != null)
      && candidates.every((p) => cm.prices.get(p.idProduct)?.trend != null);
    if (group.length > 1 && allPriced) {
      orderedCards = [...group].sort((a, b) => primaryUsd(a, game) - primaryUsd(b, game));
      orderedProducts = [...candidates].sort((a, b) => cm.prices.get(a.idProduct).trend - cm.prices.get(b.idProduct).trend);
    }
    orderedCards.forEach((card, i) => {
      const product = orderedProducts[i];
      result.set(card.id, { idProduct: product.idProduct, guide: cm.prices.get(product.idProduct) });
    });
  }
  return { expansionId: best.expansionId, matches: result };
}

function attachCardmarket(card, match, game) {
  if (!match?.guide) return;
  const eur = (suffix = '') => eurFrom(match.guide, suffix);
  card.cardmarketId = match.idProduct;
  // The base columns are the standard print and the suffixed ones the reverse
  // holo / foil. Stamped, cosmos, jumbo etc. are separate products there, so
  // they get no EUR price rather than a wrong one.
  const standard = card.variants.find((v) => game.standardVariants.includes(v.name));
  if (standard) standard.eur = eur();
  if (game.secondVariant) {
    const second = card.variants.find((v) => v.name === game.secondVariant);
    if (second) second.eur = eur(game.secondSuffix);
  }
  if (card.variants.length === 0) card.variants.push({ name: 'normal', usd: null, conditions: {}, graded: [], eur: eur() });
}

// ---------- History ----------

async function previous(path) {
  if (!PAGES_URL) return null;
  try {
    return await fetchJSON(`${PAGES_URL}/${path}`, { allow404: true, attempts: 2 });
  } catch {
    return null;
  }
}

/** points[key] = [[date, usd, eur, estimated?], ...] */
function updateHistory(prev, cards) {
  const points = prev?.points || {};
  const cutoff = daysAgo(HISTORY_DAYS);
  for (const card of cards) {
    for (const variant of card.variants) {
      const usd = variant.usd?.market ?? null;
      const eur = variant.eur?.trend ?? null;
      if (usd == null && eur == null) continue;
      const k = `${card.id}|${variant.name}`;
      let series = points[k] || [];
      if (series.length === 0) {
        // Seed from the trends Scrydex/Cardmarket already report, marked estimated.
        const seed = new Map();
        for (const [d, value] of Object.entries(variant.usd?.past || {})) {
          seed.set(daysAgo(Number(d.slice(1))), [value, null]);
        }
        const cmPast = { 30: variant.eur?.avg30, 7: variant.eur?.avg7, 1: variant.eur?.avg1 };
        for (const [d, value] of Object.entries(cmPast)) {
          if (value == null) continue;
          const date = daysAgo(Number(d));
          seed.set(date, [seed.get(date)?.[0] ?? null, value]);
        }
        series = [...seed.entries()].map(([date, [u, e]]) => [date, u, e, 1]);
      }
      series = series.filter((p) => p[0] !== today && p[0] >= cutoff);
      series.push([today, usd, eur]);
      series.sort((a, b) => a[0].localeCompare(b[0]));
      points[k] = series;
    }
  }
  return { updatedAt: today, points };
}

// ---------- Sealed products ----------

const normalizeSealed = (name) => name
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/\(.*?\)/g, ' ')
  .replace(/pokemon tcg:|pokemon card|pokemon|one piece card game|tcg/g, ' ')
  .replace(/\bbooster pack\b/g, 'booster')
  .replace(/[^a-z0-9 ]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

async function buildSealed(game, client, dir, setNames) {
  const [raw, cmProducts, cmGuide] = await Promise.all([
    client.sealed(),
    fetchJSON(`https://downloads.s3.cardmarket.com/productCatalog/productList/products_nonsingles_${game.cardmarketGame}.json`).catch(() => ({ products: [] })),
    fetchJSON(`https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_${game.cardmarketGame}.json`).catch(() => ({ priceGuides: [] })),
  ]);
  const prices = new Map(cmGuide.priceGuides.map((g) => [g.idProduct, g]));
  const byName = new Map();
  for (const product of cmProducts.products || []) {
    const guide = prices.get(product.idProduct);
    if (!guide?.trend) continue;
    const key = normalizeSealed(product.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push({ ...product, guide });
  }

  let matched = 0;
  const products = raw.map((item) => {
    const variant = (item.variants || []).find((v) => (v.prices || []).some((p) => p.type === 'raw' && p.market != null)) || item.variants?.[0];
    const price = (variant?.prices || []).find((p) => p.type === 'raw' && p.currency === 'USD' && p.market != null);
    const image = (variant?.images || item.images || []).find((i) => i.type === 'front') || variant?.images?.[0] || item.images?.[0];
    const usd = round(price?.market);
    // Same name on Cardmarket; when several, the one whose price best tracks the US one.
    let cm = null;
    const candidates = byName.get(normalizeSealed(item.name)) || [];
    if (candidates.length === 1) cm = candidates[0];
    else if (candidates.length > 1 && usd) {
      cm = candidates.reduce((best, c) => {
        const error = Math.abs(Math.log(c.guide.trend / usd));
        return !best || error < best.error ? { ...c, error } : best;
      }, null);
    }
    if (cm && usd && (cm.guide.trend / usd < 0.25 || cm.guide.trend / usd > 4)) cm = null;
    if (cm) matched++;
    const tcgplayer = (variant?.marketplaces || []).find((m) => m.name === 'tcgplayer');
    return {
      id: item.id,
      name: item.name,
      type: item.type ?? null,
      setId: item.expansion?.id ?? null,
      setName: item.expansion?.name ?? setNames.get(item.expansion?.id) ?? null,
      releaseDate: item.release_date ?? null,
      imageSmall: image?.small ?? null,
      imageLarge: image?.large ?? null,
      variant: variant?.name ?? null,
      usd,
      change: price?.trends ? Object.fromEntries([7, 30, 90].map((d) => [`d${d}`, round(price.trends[`days_${d}`]?.percent_change)]).filter(([, v]) => v != null)) : null,
      eur: cm ? eurFrom(cm.guide) : null,
      cardmarketId: cm?.idProduct ?? null,
      tcgplayerId: tcgplayer?.product_id ?? null,
    };
  }).filter((p) => p.usd != null || p.eur != null)
    .sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || '') || (b.usd || 0) - (a.usd || 0));

  await writeFile(join(dir, 'sealed.json'), JSON.stringify({ updatedAt: today, products }));
  return { sealed: products.length, sealedWithCardmarket: matched };
}

// ---------- Build one game ----------

function isDueToday(game, expansion) {
  if (!game.rotation) return true;
  const released = Date.parse((expansion.release_date || '').replace(/\//g, '-'));
  if (!Number.isNaN(released) && (Date.now() - released) / 86_400_000 <= game.rotation.recentDays) return true;
  return hashString(expansion.id) % game.rotation.shards === dayNumber % game.rotation.shards;
}

async function buildGame(game) {
  const started = Date.now();
  const dir = join(OUT, 'v1', game.id);
  await mkdir(join(dir, 'sets'), { recursive: true });
  await mkdir(join(dir, 'history'), { recursive: true });

  console.log(`\n== ${game.name} ==`);
  const cm = await loadCardmarket(game.cardmarketGame);
  console.log(`  Cardmarket: ${cm.prices.size} price rows, ${cm.byExpansion.size} expansions (guide ${cm.createdAt})`);
  const client = game.source === 'tcgcsv' ? tcgcsvClient(game) : scrydexClient(game);
  let expansions = await client.expansions();
  if (ONLY_SETS.length) expansions = expansions.filter((e) => ONLY_SETS.includes(e.id));
  console.log(`  ${expansions.length} expansions`);

  const claimed = new Set();
  const search = [];
  const summaries = [];
  let refreshed = 0;
  let carried = 0;
  let matchedCards = 0;
  let totalCards = 0;

  // Oldest first so reprint sets claim their own Cardmarket expansion.
  // ONLY_SEALED=1 (local testing): skip the card sets, build sealed products only.
  const ordered = process.env.ONLY_SEALED ? [] : [...expansions].sort((a, b) => (a.release_date || '').localeCompare(b.release_date || ''));
  await mapLimit(ordered, 3, async (expansion) => {
    const set = {
      id: expansion.id,
      name: expansion.name,
      series: expansion.series ?? expansion.block ?? expansion.type ?? null,
      code: expansion.code ?? null,
      total: expansion.total ?? null,
      printedTotal: expansion.printed_total ?? null,
      releaseDate: expansion.release_date ?? null,
      logo: expansion.logo ?? null,
      symbol: expansion.symbol ?? null,
    };

    let file = null;
    if (!isDueToday(game, expansion)) {
      file = await previous(`v1/${game.id}/sets/${encodeURIComponent(expansion.id)}.json`);
      if (file) {
        carried++;
        const history = await previous(`v1/${game.id}/history/${encodeURIComponent(expansion.id)}.json`);
        if (history) await writeFile(join(dir, 'history', `${expansion.id}.json`), JSON.stringify(history));
      }
    }
    if (!file) {
      const cards = (client.compactCards ? await client.compactCards(expansion.id) : (await client.cards(expansion.id)).map(compactCard))
        .sort((a, b) => naturalNumber(a.number, b.number));
      let expansionId = null;
      if (game.source === 'tcgcsv') {
        expansionId = attachDragonBall(cards, cm, claimed, game);
      } else if (game.matchByCode) {
        expansionId = attachByCode(cards, cm);
      } else {
        const result = matchExpansion(cards, cm, claimed, game);
        expansionId = result.expansionId;
        if (expansionId) claimed.add(expansionId);
        for (const card of cards) attachCardmarket(card, result.matches.get(card.id), game);
      }
      const history = updateHistory(await previous(`v1/${game.id}/history/${encodeURIComponent(expansion.id)}.json`), cards);
      await writeFile(join(dir, 'history', `${expansion.id}.json`), JSON.stringify(history));
      file = { updatedAt: today, set: { ...set, cardmarketExpansionId: expansionId }, cards };
      refreshed++;
    }
    const cards = file.cards;
    if (cards.length === 0) return; // sealed-only groups
    if (game.source === 'tcgcsv') file.set.total = file.set.printedTotal = cards.length;
    await writeFile(join(dir, 'sets', `${expansion.id}.json`), JSON.stringify(file));

    const value = cards.reduce((sum, c) => sum + (primaryUsd(c, game) || 0), 0);
    summaries.push({ ...set, cardCount: cards.length, setValueUsd: round(value), updatedAt: file.updatedAt });
    for (const c of cards) search.push([c.id, c.name, c.number, expansion.id, c.rarity, c.imageSmall]);
    totalCards += cards.length;
    matchedCards += cards.filter((c) => c.cardmarketId).length;
  });

  summaries.sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));
  await writeFile(join(dir, 'sets.json'), JSON.stringify({ updatedAt: today, sets: summaries }));

  let sealedInfo = {};
  if (game.sealed && !ONLY_SETS.length) {
    try {
      sealedInfo = await buildSealed(game, client, dir, new Map(summaries.map((s) => [s.id, s.name])));
    } catch (error) {
      console.warn(`  sealed failed for ${game.id}: ${error.message}`);
    }
  }
  await writeFile(join(dir, 'search.json'), JSON.stringify({ updatedAt: today, cards: search }));
  const info = {
    id: game.id, name: game.name, sets: summaries.length, cards: totalCards,
    cardsWithCardmarket: matchedCards, refreshedSets: refreshed, carriedSets: carried,
    cardmarketGuideCreatedAt: cm.createdAt, seconds: Math.round((Date.now() - started) / 1000),
    ...sealedInfo,
  };
  console.log(' ', info);
  return info;
}

// ---------- Main ----------

async function main() {
  const started = Date.now();
  const rate = await usdToEur();
  const games = [];
  for (const game of GAMES) {
    if (ONLY_GAMES.length && !ONLY_GAMES.includes(game.id)) continue;
    if (game.disabled && !ONLY_GAMES.includes(game.id)) continue;
    games.push(await buildGame(game));
  }
  const meta = {
    updatedAt: new Date().toISOString(),
    usdToEur: rate,
    games,
    scrydexCredits: creditsUsed,
    seconds: Math.round((Date.now() - started) / 1000),
  };
  await writeFile(join(OUT, 'v1', 'meta.json'), JSON.stringify(meta, null, 2));
  await writeFile(join(OUT, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Bindex prices</title><pre>${JSON.stringify(meta, null, 2)}</pre>`);
  console.log(meta);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
