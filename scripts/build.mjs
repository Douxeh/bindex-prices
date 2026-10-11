// Daily Bindex price build.
//
// Sources:
//  - Scrydex (https://scrydex.com): every English Pokémon card with USD raw
//    prices per variant/condition, graded prices and 1–180 day trends.
//  - Cardmarket price guide (public daily download): EUR trend/avg/low per
//    product, including the reverse-holo ("-holo") columns.
//
// Cardmarket's guide has no card numbers, so each Cardmarket product is
// matched to a Scrydex card: expansion by card-name overlap, then within a
// name group by price rank (falling back to release order).
//
// Output (written to ./public, served by GitHub Pages):
//   v1/meta.json              run info
//   v1/sets.json              all expansions
//   v1/sets/<setId>.json      every card in the set with current prices
//   v1/history/<setId>.json   daily price points per card+variant (rolling)
//   v1/search.json            compact all-card index for global search
//
// Env: SCRYDEX_API_KEY, SCRYDEX_TEAM_ID, PAGES_URL (previous deploy, for history)

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const API = 'https://api.scrydex.com/pokemon/v1';
const CM_GUIDE = 'https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_6.json';
const CM_PRODUCTS = 'https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_6.json';
const OUT = process.env.OUT_DIR || 'public';
const PAGES_URL = (process.env.PAGES_URL || '').replace(/\/$/, '');
const HISTORY_DAYS = 400;
const ONLY_SETS = (process.env.ONLY_SETS || '').split(',').filter(Boolean);
const GRADED_COMPANIES = new Set(['PSA', 'BGS', 'CGC', 'SGC']);
const STANDARD_VARIANTS = ['normal', 'holofoil', 'unlimitedHolofoil', 'unlimited', '1stEditionHolofoil', 'firstEditionHolofoil'];

const key = process.env.SCRYDEX_API_KEY;
const team = process.env.SCRYDEX_TEAM_ID;
if (!key || !team) {
  console.error('Missing SCRYDEX_API_KEY / SCRYDEX_TEAM_ID');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = new Date().toISOString().slice(0, 10);
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

const scrydex = (path) => {
  creditsUsed++;
  return fetchJSON(`${API}${path}`, { headers: { 'X-Api-Key': key, 'X-Team-ID': team } });
};

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

// ---------- Scrydex ----------

async function loadExpansions() {
  const all = [];
  for (let page = 1; ; page++) {
    const body = await scrydex(`/expansions?page_size=100&page=${page}&q=language_code:EN`);
    all.push(...body.data);
    if (all.length >= (body.total_count ?? body.totalCount ?? 0) || body.data.length === 0) break;
  }
  return all.filter((e) => !e.is_online_only);
}

async function loadCards(setId) {
  const cards = [];
  const select = 'id,name,number,printed_number,rarity,supertype,images,variants';
  for (let page = 1; ; page++) {
    const body = await scrydex(`/expansions/${setId}/cards?include=prices&page_size=100&page=${page}&select=${select}`);
    cards.push(...body.data);
    if (cards.length >= (body.total_count ?? body.totalCount ?? 0) || body.data.length === 0) break;
  }
  return cards;
}

const round = (n) => (n == null || Number.isNaN(n) ? null : Math.round(n * 100) / 100);

function compactVariant(variant) {
  const prices = variant.prices || [];
  const nm = prices.find((p) => p.type === 'raw' && p.condition === 'NM' && p.currency === 'USD');
  const change = (days) => nm?.trends?.[`days_${days}`]?.price_change;
  const usd = nm ? {
    market: round(nm.market),
    low: round(nm.low),
    // Price n days ago = market − change over n days.
    change: Object.fromEntries([1, 7, 14, 30, 90, 180]
      .map((d) => [`d${d}`, round(nm.trends?.[`days_${d}`]?.percent_change)])
      .filter(([, v]) => v != null)),
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
  return {
    name: variant.name,
    usd,
    conditions,
    graded,
    tcgplayerId: tcgplayer?.product_id ?? null,
  };
}

function compactCard(card) {
  const image = (card.images || []).find((i) => i.type === 'front') || card.images?.[0];
  return {
    id: card.id,
    name: card.name,
    number: card.number,
    printedNumber: card.printed_number,
    rarity: card.rarity,
    supertype: card.supertype,
    imageSmall: image?.small ?? null,
    imageLarge: image?.large ?? null,
    variants: (card.variants || []).map(compactVariant),
  };
}

// ---------- Cardmarket ----------

const normalizeName = (name) => name
  .replace(/\[.*?\]/g, ' ')
  .replace(/\(.*?\)/g, ' ')
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

async function loadCardmarket() {
  const [guide, products] = await Promise.all([fetchJSON(CM_GUIDE), fetchJSON(CM_PRODUCTS)]);
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
  return { createdAt: guide.createdAt, prices, byExpansion, expansionsByName };
}

function primaryUsd(card) {
  const variant = card.variants.find((v) => STANDARD_VARIANTS.includes(v.name) && v.usd?.market != null)
    || card.variants.find((v) => v.usd?.market != null);
  return variant?.usd?.market ?? null;
}

/** Returns Map(cardId -> Cardmarket product + price guide row). */
function matchExpansion(cards, cm, claimed) {
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

  const products = cm.byExpansion.get(best.expansionId);
  const productGroups = new Map();
  for (const p of products) {
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
    const allPriced = group.every((c) => primaryUsd(c) != null)
      && candidates.every((p) => cm.prices.get(p.idProduct)?.trend != null);
    if (group.length > 1 && allPriced) {
      orderedCards = [...group].sort((a, b) => primaryUsd(a) - primaryUsd(b));
      orderedProducts = [...candidates].sort((a, b) => cm.prices.get(a.idProduct).trend - cm.prices.get(b.idProduct).trend);
    }
    orderedCards.forEach((card, i) => {
      const product = orderedProducts[i];
      result.set(card.id, { idProduct: product.idProduct, guide: cm.prices.get(product.idProduct) });
    });
  }
  return { expansionId: best.expansionId, matches: result };
}

function attachCardmarket(card, match) {
  if (!match?.guide) return;
  const g = match.guide;
  const eur = (prefix = '') => {
    const v = {
      trend: round(g[`trend${prefix}`]), avg: round(g[`avg${prefix}`]), low: round(g[`low${prefix}`]),
      avg1: round(g[`avg1${prefix}`]), avg7: round(g[`avg7${prefix}`]), avg30: round(g[`avg30${prefix}`]),
    };
    return Object.values(v).some((x) => x != null) ? v : null;
  };
  card.cardmarketId = match.idProduct;
  // Cardmarket's base columns are the standard print; "-holo" is the reverse
  // holo. Stamped, cosmos, jumbo etc. are separate products there, so they
  // get no EUR price rather than a wrong one.
  const standard = card.variants.find((v) => STANDARD_VARIANTS.includes(v.name));
  if (standard) standard.eur = eur();
  const reverse = card.variants.find((v) => v.name === 'reverseHolofoil');
  if (reverse) reverse.eur = eur('-holo');
  if (card.variants.length === 0) card.variants.push({ name: 'normal', usd: null, conditions: {}, graded: [], eur: eur() });
}

// ---------- History ----------

async function previousHistory(setId) {
  if (!PAGES_URL) return null;
  try {
    return await fetchJSON(`${PAGES_URL}/v1/history/${setId}.json`, { allow404: true, attempts: 2 });
  } catch {
    return null;
  }
}

function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** points[key] = [[date, usd, eur, estimated?], ...] */
function updateHistory(previous, cards) {
  const points = previous?.points || {};
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

// ---------- Main ----------

async function main() {
  const started = Date.now();
  console.log('Loading Cardmarket price guide…');
  const cm = await loadCardmarket();
  console.log(`  ${cm.prices.size} price rows, ${cm.byExpansion.size} expansions (guide ${cm.createdAt})`);

  console.log('Loading Scrydex expansions…');
  let expansions = await loadExpansions();
  if (ONLY_SETS.length) expansions = expansions.filter((e) => ONLY_SETS.includes(e.id));
  console.log(`  ${expansions.length} expansions`);

  await mkdir(join(OUT, 'v1', 'sets'), { recursive: true });
  await mkdir(join(OUT, 'v1', 'history'), { recursive: true });

  const claimed = new Set();
  const search = [];
  let matchedCards = 0;
  let totalCards = 0;
  const setSummaries = [];

  // Oldest first so reprint sets claim their own Cardmarket expansion.
  const ordered = [...expansions].sort((a, b) => (a.release_date || '').localeCompare(b.release_date || ''));
  await mapLimit(ordered, 3, async (expansion) => {
    const raw = await loadCards(expansion.id);
    const cards = raw.map(compactCard).sort((a, b) => naturalNumber(a.number, b.number));
    const { expansionId, matches } = matchExpansion(cards, cm, claimed);
    if (expansionId) claimed.add(expansionId);
    for (const card of cards) attachCardmarket(card, matches.get(card.id));

    const history = updateHistory(await previousHistory(expansion.id), cards);
    const set = {
      id: expansion.id,
      name: expansion.name,
      series: expansion.series,
      code: expansion.code,
      total: expansion.total,
      printedTotal: expansion.printed_total,
      releaseDate: expansion.release_date,
      logo: expansion.logo,
      symbol: expansion.symbol,
      cardmarketExpansionId: expansionId,
    };
    await writeFile(join(OUT, 'v1', 'sets', `${expansion.id}.json`), JSON.stringify({ updatedAt: today, set, cards }));
    await writeFile(join(OUT, 'v1', 'history', `${expansion.id}.json`), JSON.stringify(history));

    const value = cards.reduce((sum, c) => sum + (primaryUsd(c) || 0), 0);
    setSummaries.push({ ...set, cardCount: cards.length, setValueUsd: round(value) });
    for (const c of cards) search.push([c.id, c.name, c.number, expansion.id, c.rarity, c.imageSmall]);
    totalCards += cards.length;
    matchedCards += matches.size;
    console.log(`  ${expansion.id.padEnd(10)} ${String(cards.length).padStart(4)} cards, ${String(matches.size).padStart(4)} on Cardmarket (#${expansionId ?? '—'})`);
  });

  setSummaries.sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));
  await writeFile(join(OUT, 'v1', 'sets.json'), JSON.stringify({ updatedAt: today, sets: setSummaries }));
  await writeFile(join(OUT, 'v1', 'search.json'), JSON.stringify({ updatedAt: today, cards: search }));
  const meta = {
    updatedAt: new Date().toISOString(),
    cardmarketGuideCreatedAt: cm.createdAt,
    sets: setSummaries.length,
    cards: totalCards,
    cardsWithCardmarket: matchedCards,
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
