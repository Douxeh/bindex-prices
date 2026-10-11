// Market analytics for Bindex PRO: sentiment, movers, momentum signals,
// breakouts, 30-day forecasts, EU/US price gaps and ten articles per run.
//
// Everything is computed from the price data the worker already fetched.
// When ANTHROPIC_API_KEY is set, Claude writes the articles (with web search
// to find out *why* prices moved); otherwise they're written from templates.

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const MIN_USD = 5;           // ignore bulk: movers start at $5
const MIN_SEALED_USD = 20;
const ARTICLE_ARCHIVE = 60;  // keep the last ~6 runs of articles
const SENTIMENT_DAYS = 120;

const cards = [];
const sealed = [];

const r2 = (n) => (n == null || Number.isNaN(n) ? null : Math.round(n * 100) / 100);
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const pct = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
const usdText = (n) => `$${n >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2)}`;

/** Called per set: keeps each card's most valuable printing with a price trend. */
export function collectCards(game, set, list) {
  for (const card of list) {
    let best = null;
    for (const v of card.variants || []) {
      const usd = v.usd?.market;
      if (usd == null || usd < MIN_USD || !v.usd.change) continue;
      if (!best || usd > best.usd.market) best = v;
    }
    if (!best) continue;
    const c = best.usd.change;
    cards.push({
      kind: 'card', game: game.id, gameName: game.name,
      id: card.id, setId: set.id, setName: set.name, name: card.name, number: card.number,
      rarity: card.rarity ?? null, image: card.imageSmall ?? null, variant: best.name,
      usd: best.usd.market, d1: c.d1 ?? null, d7: c.d7 ?? null, d30: c.d30 ?? null, d90: c.d90 ?? null,
      eur: best.eur ?? null,
    });
  }
}

export function collectSealed(game, products) {
  for (const p of products) {
    if (p.usd == null || p.usd < MIN_SEALED_USD || !p.change) continue;
    sealed.push({
      kind: 'sealed', game: game.id, gameName: game.name,
      id: p.id, setId: p.setId, setName: p.setName, name: p.name, number: null, rarity: p.type,
      image: p.imageSmall ?? null, variant: p.variant, usd: p.usd,
      d1: null, d7: p.change.d7 ?? null, d30: p.change.d30 ?? null, d90: p.change.d90 ?? null,
      eur: p.eur ?? null,
    });
  }
}

// ---------- Indicators ----------

/**
 * A huge jump that Cardmarket doesn't confirm is usually one odd sale of a
 * thinly traded card, not a market move — leave it out of movers and signals.
 */
function isSpike(x) {
  const move = Math.max(Math.abs(x.d7 ?? 0), Math.abs(x.d30 ?? 0));
  if (move < 80) return false;
  const e = x.eur;
  if (!e?.avg7 || !e?.avg30) return true;
  const euMove = (e.avg7 / e.avg30 - 1) * 100;
  return Math.sign(euMove) !== Math.sign(x.d7 ?? x.d30) || Math.abs(euMove) < move * 0.25;
}

/** Momentum −100…100: recent change, weighted toward the last week, confirmed by Cardmarket. */
function momentum(x) {
  const d7 = x.d7 ?? 0;
  const d30 = x.d30 ?? 0;
  // tanh keeps the scale readable: only exceptional, broad moves get close to ±100.
  let score = 100 * Math.tanh((d7 * 1.5 + d30 * 0.5) / 200);
  const e = x.eur;
  if (e?.avg7 && e?.avg30) {
    const cross = (e.avg7 / e.avg30 - 1) * 100; // short average vs long average
    if (Math.sign(cross) === Math.sign(score) && Math.abs(cross) > 3) score = clamp(score + Math.sign(score) * 5, -99, 99);
    if (Math.sign(cross) === -Math.sign(score) && Math.abs(cross) > 3) score *= 0.7;
  }
  return Math.round(score);
}

/** A move that started recently: the last week holds most of the month's gain. */
function isBreakout(x) {
  if (x.d7 == null || x.d30 == null || x.usd < 10) return false;
  const earlier = x.d30 - x.d7; // roughly: change in the 3 weeks before
  const accelerating = x.d1 == null || x.d1 >= 0;
  const euConfirms = !x.eur?.avg1 || !x.eur?.avg7 || x.eur.avg1 >= x.eur.avg7 * 0.97;
  return x.d7 >= 12 && earlier < 6 && accelerating && euConfirms;
}

function signalFor(x, m) {
  if (isBreakout(x)) return { type: 'breakout', label: 'Breakout' };
  if (m >= 40) return { type: 'strongUptrend', label: 'Strong uptrend' };
  if (m >= 15) return { type: 'uptrend', label: 'Uptrend' };
  if (x.d90 != null && x.d90 > 30 && (x.d7 ?? 0) < -8) return { type: 'cooling', label: 'Cooling off' };
  if (x.d90 != null && x.d90 < -25 && (x.d7 ?? 0) > 4) return { type: 'reversal', label: 'Possible reversal' };
  if (m <= -40) return { type: 'strongDowntrend', label: 'Strong downtrend' };
  if (m <= -15) return { type: 'downtrend', label: 'Downtrend' };
  return { type: 'neutral', label: 'Sideways' };
}

/** A transparent 30-day estimate: dampened momentum + partial mean reversion of the 90-day move. */
function forecast(x) {
  const weekly = (x.d7 ?? 0) / 100;
  const monthly = (x.d30 ?? 0) / 100;
  const quarterly = clamp((x.d90 ?? 0) / 100, -0.9, 1.5);
  let drift = weekly * 0.25 + monthly * 0.15 - Math.max(0, quarterly - 0.6) * 0.1;
  drift = clamp(drift, -0.25, 0.25);
  const spread = clamp(Math.abs(weekly) * 1.5 + Math.abs(monthly - weekly) * 0.5 + 0.06, 0.06, 0.45);
  const mid = x.usd * (1 + drift);
  const signals = [x.d7, x.d30].filter((v) => v != null);
  const agree = signals.length === 2 && Math.sign(signals[0]) === Math.sign(signals[1]);
  return {
    usd30: r2(mid), low30: r2(mid * (1 - spread)), high30: r2(mid * (1 + spread)),
    changePct: r2(drift * 100),
    confidence: agree && x.eur?.avg7 ? 'medium' : 'low',
  };
}

function ref(x, extra = {}) {
  return {
    kind: x.kind, game: x.game, id: x.id, setId: x.setId, setName: x.setName, name: x.name,
    number: x.number, rarity: x.rarity, image: x.image, variant: x.variant,
    usd: r2(x.usd), d1: r2(x.d1), d7: r2(x.d7), d30: r2(x.d30), d90: r2(x.d90),
    eurTrend: r2(x.eur?.trend), ...extra,
  };
}

/** 0 (extreme fear) … 100 (extreme greed) from value-weighted weekly change and breadth. */
function sentimentOf(list) {
  const moving = list.filter((x) => x.d7 != null);
  if (moving.length < 20) return null;
  let weight = 0;
  let weighted = 0;
  let up = 0;
  let down = 0;
  for (const x of moving) {
    const w = Math.log10(x.usd + 1);
    weight += w;
    weighted += clamp(x.d7, -50, 50) * w;
    if (x.d7 > 2) up++;
    else if (x.d7 < -2) down++;
  }
  const avg7 = weighted / weight;
  const breadth = (up - down) / moving.length;
  const score = Math.round(clamp(50 + Math.tanh(avg7 / 8) * 30 + breadth * 40, 0, 100));
  const label = score >= 75 ? 'Extreme greed' : score >= 58 ? 'Greed' : score > 42 ? 'Neutral' : score > 25 ? 'Fear' : 'Extreme fear';
  return { score, label, avgChange7d: r2(avg7), advancing: up, declining: down, tracked: moving.length };
}

// ---------- Articles ----------

const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

function templateArticles(data, today) {
  const a = [];
  const line = (x) => `**${x.name}** (${x.setName}${x.number ? ` #${x.number}` : ''}) — ${usdText(x.usd)}, ${pct(x.d7)} this week${x.d30 != null ? `, ${pct(x.d30)} over 30 days` : ''}.`;
  const add = (title, summary, body, refs, tags, mood) => a.push({
    id: `${today}-${slug(title)}`, date: today, title, summary, body, cards: refs.slice(0, 6).map((x) => ref(x)), tags, sentiment: mood, author: 'Bindex Market Desk',
  });
  const s = data.sentiment.overall;

  add(`Market pulse: ${s.label.toLowerCase()} (${s.score}/100)`,
    `${s.advancing} cards rose and ${s.declining} fell this week; the value-weighted average moved ${pct(s.avgChange7d)}.`,
    [
      `The Bindex sentiment index stands at **${s.score}/100 — ${s.label}**.`,
      `Across ${s.tracked.toLocaleString('en-US')} tracked cards worth $${MIN_USD} or more, ${s.advancing} gained and ${s.declining} lost more than 2% over the past seven days.`,
      '',
      ...Object.entries(data.sentiment.byGame).map(([, g]) => `- **${g.name}**: ${g.score}/100 (${g.label}), average ${pct(g.avgChange7d)}`),
      '',
      'Sentiment combines the value-weighted weekly change with market breadth — how many cards go up versus down.',
    ].join('\n'), data.gainers.slice(0, 3), ['sentiment'], s.score >= 58 ? 'bullish' : s.score <= 42 ? 'bearish' : 'neutral');

  for (const [gameId, g] of Object.entries(data.sentiment.byGame).slice(0, 3)) {
    const top = data.gainersAll.filter((x) => x.game === gameId).slice(0, 5);
    if (top.length < 3) continue;
    add(`${g.name}: this week's biggest gainers`, `${top[0].name} leads with ${pct(top[0].d7)}.`,
      ['The strongest risers this week:', '', ...top.map((x) => `- ${line(x)}`), '',
        'A sharp one-week jump often follows a tournament result, a reprint announcement, or a new set release that pulls attention to a character.'].join('\n'),
      top, ['movers', gameId], 'bullish');
  }

  const losers = data.losers.slice(0, 5);
  if (losers.length) add('Biggest drops of the week', `${losers[0].name} fell ${pct(losers[0].d7)}.`,
    ['Cards that gave back the most:', '', ...losers.map((x) => `- ${line(x)}`), '',
      'Drops after a strong run are often profit-taking; drops on new cards usually mean supply is catching up with demand.'].join('\n'),
    losers, ['movers'], 'bearish');

  const sg = data.sealedGainers.slice(0, 5);
  if (sg.length) add('Sealed watch: boxes and collections on the move', `${sg[0].name} is up ${pct(sg[0].d7)} this week.`,
    ['Sealed products with the strongest week:', '', ...sg.map((x) => `- ${line(x)}`), '',
      'Sealed prices tend to climb once a product goes out of print and retail stock dries up.'].join('\n'),
    sg, ['sealed'], 'bullish');

  const br = data.breakouts.slice(0, 5);
  if (br.length) add('Early breakouts to watch', `${br.length} cards started moving only this week.`,
    ['These cards were flat for weeks and jumped in the last seven days — Cardmarket sales confirm the move:', '',
      ...br.map((x) => `- ${line(x)}`), '', 'Breakouts can fade quickly; watch whether the price holds next week.'].join('\n'),
    br, ['breakouts'], 'bullish');

  const mo = data.momentum.slice(0, 5);
  if (mo.length) add('Momentum leaders', `${mo[0].name} has the strongest trend score (${mo[0].momentum}).`,
    ['Cards with the most consistent upward trend over the week and month:', '',
      ...mo.map((x) => `- ${line(x)} Momentum ${x.momentum}.`)].join('\n'), mo, ['momentum'], 'bullish');

  const gaps = data.priceGaps.slice(0, 5);
  if (gaps.length) add('EU vs US: where cards are cheaper', `${gaps[0].name} is ${Math.abs(gaps[0].gapPct).toFixed(0)}% ${gaps[0].gapPct < 0 ? 'cheaper' : 'more expensive'} on Cardmarket.`,
    ['Price differences between Cardmarket (EU) and TCGplayer (US), converted at the ECB rate:', '',
      ...gaps.map((x) => `- **${x.name}** (${x.setName}) — US ${usdText(x.usd)}, EU €${x.eurTrend?.toFixed(2)} (${pct(x.gapPct)} vs US)`), '',
      'Shipping, fees and condition grading differ between the markets, so not every gap is a real opportunity.'].join('\n'),
    gaps, ['price gaps'], 'neutral');

  const fc = data.forecasts.slice(0, 5);
  if (fc.length) add('30-day outlook: model forecasts', `Our model sees the most upside for ${fc[0].name}.`,
    ['Model estimates for the next 30 days, based on momentum and how stretched the 90-day move is:', '',
      ...fc.map((x) => `- **${x.name}** — ${usdText(x.usd)} → ${usdText(x.forecast.usd30)} (${pct(x.forecast.changePct)}, range ${usdText(x.forecast.low30)}–${usdText(x.forecast.high30)})`),
      '', '_Estimates, not financial advice._'].join('\n'), fc, ['forecast'], 'neutral');

  const sets = data.hotSets.slice(0, 5);
  if (sets.length) add('Hot sets this week', `${sets[0].setName} is the strongest set (${pct(sets[0].avgChange7d)}).`,
    ['Sets where valuable cards rose the most on average:', '',
      ...sets.map((s) => `- **${s.setName}** (${s.gameName}) — average ${pct(s.avgChange7d)} across ${s.cards} cards`)].join('\n'),
    sets.map((s) => s.top), ['sets'], 'bullish');

  return a.slice(0, 10);
}

async function claudeArticles(data, today) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const brief = {
    date: today,
    sentiment: data.sentiment,
    gainers: data.gainers.slice(0, 15).map((x) => ref(x)),
    losers: data.losers.slice(0, 10).map((x) => ref(x)),
    sealedGainers: data.sealedGainers.slice(0, 8).map((x) => ref(x)),
    breakouts: data.breakouts.slice(0, 10).map((x) => ref(x)),
    momentum: data.momentum.slice(0, 10).map((x) => ref(x, { momentum: x.momentum })),
    priceGaps: data.priceGaps.slice(0, 8),
    forecasts: data.forecasts.slice(0, 8).map((x) => ref(x, { forecast: x.forecast })),
    hotSets: data.hotSets.slice(0, 6).map(({ top, ...s }) => s),
  };
  const prompt = `You are the market analyst of Bindex, a trading card collector app (Pokémon, One Piece, Magic, Lorcana, Gundam, Riftbound).
Below is today's price data from TCGplayer (USD) and Cardmarket (EUR, "eurTrend"). Percent fields are price changes (d1 = 1 day, d7 = 7 days, d30, d90).

Write exactly 10 short market articles for collectors: important movers, market sentiment, sealed products, breakouts, price gaps between EU and US, and outlook.
Use web search to find out WHY prices moved (tournament results, set releases, reprints, bans, announcements, influencer attention). Only state reasons you found evidence for; otherwise say the cause is unclear. Never invent sales numbers. Stick to the numbers in the data.

Return ONLY a JSON array (no prose before or after) of 10 objects:
{"title": string (max 70 chars), "summary": string (1 sentence), "body": string (markdown, 80-160 words, may use **bold** and "- " bullets), "tags": string[], "sentiment": "bullish"|"bearish"|"neutral", "cardIds": string[] (ids from the data that the article is about, max 6), "sources": [{"title": string, "url": string}]}

DATA:
${JSON.stringify(brief)}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
        max_tokens: 8000,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      console.warn(`  Claude articles: HTTP ${res.status}`);
      return null;
    }
    const body = await res.json();
    const text = (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const json = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const all = new Map([...data.allRefs].map((x) => [x.id, x]));
    return parsed.slice(0, 10).map((x) => ({
      id: `${today}-${slug(String(x.title || 'article'))}`,
      date: today,
      title: String(x.title || '').slice(0, 90),
      summary: String(x.summary || ''),
      body: String(x.body || ''),
      tags: Array.isArray(x.tags) ? x.tags.map(String).slice(0, 4) : [],
      sentiment: ['bullish', 'bearish', 'neutral'].includes(x.sentiment) ? x.sentiment : 'neutral',
      cards: (x.cardIds || []).map((id) => all.get(id)).filter(Boolean).slice(0, 6).map((c) => ref(c)),
      sources: Array.isArray(x.sources) ? x.sources.filter((s) => /^https:\/\//.test(s?.url || '')).slice(0, 5).map((s) => ({ title: String(s.title || s.url).slice(0, 100), url: s.url })) : [],
      author: 'Bindex AI Market Desk',
      ai: true,
    }));
  } catch (error) {
    console.warn(`  Claude articles failed: ${error.message}`);
    return null;
  }
}

// ---------- Build ----------

export async function buildInsights({ out, today, usdToEur, previous }) {
  const rate = usdToEur || 0.92;
  const all = [...cards, ...sealed];
  for (const x of all) x.momentum = momentum(x);

  const games = new Map();
  for (const x of cards) {
    if (!games.has(x.game)) games.set(x.game, { name: x.gameName, list: [] });
    games.get(x.game).list.push(x);
  }
  const byGame = {};
  for (const [id, g] of games) {
    const s = sentimentOf(g.list);
    if (s) byGame[id] = { name: g.name, ...s };
  }
  const overall = sentimentOf(cards) || { score: 50, label: 'Neutral', avgChange7d: 0, advancing: 0, declining: 0, tracked: 0 };

  // Movers need a real price and a believable move (no data glitches).
  const valid = cards.filter((x) => x.d7 != null && Math.abs(x.d7) < 300 && x.usd >= MIN_USD && !isSpike(x));
  const weight = (x) => Math.min(Math.abs(x.d7), 100) * Math.log10(x.usd);
  const gainersAll = valid.filter((x) => x.d7 > 0 && x.usd >= 10).sort((a, b) => weight(b) - weight(a));
  const gainers = diverse(gainersAll, 25);
  const losers = diverse(valid.filter((x) => x.d7 < 0 && x.usd >= 10).sort((a, b) => weight(b) - weight(a)), 25);
  const sealedValid = sealed.filter((x) => x.d7 != null && Math.abs(x.d7) < 200);
  const clean = all.filter((x) => !isSpike(x));
  const sealedGainers = sealedValid.filter((x) => x.d7 > 0).sort((a, b) => b.d7 - a.d7).slice(0, 20);
  const sealedLosers = sealedValid.filter((x) => x.d7 < 0).sort((a, b) => a.d7 - b.d7).slice(0, 20);
  const breakouts = diverse(clean.filter(isBreakout).sort((a, b) => weight(b) - weight(a)), 25);
  const momentumList = diverse(clean.filter((x) => x.usd >= 10 && x.momentum >= 15).sort((a, b) => b.momentum - a.momentum || b.usd - a.usd), 30);

  // Forecast steady trends only: after a sudden jump the next month is a coin flip.
  const forecastPool = clean.filter((x) => x.usd >= 15 && x.d7 != null && x.d30 != null
    && Math.abs(x.d7) <= 40 && Math.abs(x.d30) <= 80);
  for (const x of forecastPool) x.forecast = forecast(x);
  const rankForecast = (x) => x.forecast.changePct * (x.forecast.confidence === 'medium' ? 1.5 : 1) * Math.log10(x.usd);
  const forecasts = diverse([...forecastPool].sort((a, b) => rankForecast(b) - rankForecast(a)), 25);
  const forecastsDown = diverse([...forecastPool].sort((a, b) => a.forecast.changePct - b.forecast.changePct), 15);

  const priceGaps = cards
    .filter((x) => x.usd >= 20 && x.eur?.trend && x.eur?.avg7 && x.eur?.avg30
      && Math.abs(x.eur.avg7 / x.eur.avg30 - 1) < 0.25 && Math.abs(x.eur.trend / x.eur.avg30 - 1) < 0.25)
    .map((x) => ({ x, gap: (x.eur.trend / (x.usd * rate) - 1) * 100 }))
    // Bigger than ±60% is almost always a mismatched print, not a real gap.
    .filter(({ gap }) => Math.abs(gap) >= 15 && Math.abs(gap) <= 45)
    .sort((a, b) => Math.abs(b.gap) * Math.log10(b.x.usd) - Math.abs(a.gap) * Math.log10(a.x.usd))
    .slice(0, 25)
    .map(({ x, gap }) => ref(x, { gapPct: r2(gap) }));

  const setMap = new Map();
  for (const x of valid) {
    const k = `${x.game}|${x.setId}`;
    if (!setMap.has(k)) setMap.set(k, { game: x.game, gameName: x.gameName, setId: x.setId, setName: x.setName, sum: 0, n: 0, top: x });
    const s = setMap.get(k);
    s.sum += clamp(x.d7, -50, 50);
    s.n++;
    if (x.d7 > s.top.d7) s.top = x;
  }
  const hotSets = [...setMap.values()].filter((s) => s.n >= 8)
    .map((s) => ({ game: s.game, gameName: s.gameName, setId: s.setId, setName: s.setName, cards: s.n, avgChange7d: r2(s.sum / s.n), top: s.top }))
    .sort((a, b) => b.avgChange7d - a.avgChange7d).slice(0, 10);

  const signals = momentumList.concat(diverse(clean.filter((x) => x.usd >= 10 && x.momentum <= -15).sort((a, b) => a.momentum - b.momentum), 15))
    .map((x) => ref(x, { momentum: x.momentum, signal: signalFor(x, x.momentum) }));

  const data = {
    sentiment: { overall, byGame },
    gainers, gainersAll, losers, sealedGainers, breakouts, momentum: momentumList, forecasts, priceGaps, hotSets,
    allRefs: all,
  };

  let articles = await claudeArticles(data, today);
  const aiWritten = Boolean(articles);
  if (!articles) articles = templateArticles(data, today);

  const history = (previous?.sentimentHistory || []).filter((p) => p.date !== today);
  history.push({ date: today, score: overall.score, byGame: Object.fromEntries(Object.entries(byGame).map(([k, v]) => [k, v.score])) });
  const archive = [...articles, ...(previous?.articles || []).filter((a) => a.date !== today)].slice(0, ARTICLE_ARCHIVE);

  const insights = {
    updatedAt: new Date().toISOString(),
    date: today,
    usdToEur: rate,
    aiWritten,
    sentiment: { ...overall, byGame },
    sentimentHistory: history.slice(-SENTIMENT_DAYS),
    gainers: gainers.map((x) => ref(x, { momentum: x.momentum })),
    losers: losers.map((x) => ref(x, { momentum: x.momentum })),
    sealedGainers: sealedGainers.map((x) => ref(x)),
    sealedLosers: sealedLosers.map((x) => ref(x)),
    breakouts: breakouts.map((x) => ref(x, { momentum: x.momentum, signal: signalFor(x, x.momentum) })),
    signals,
    forecasts: forecasts.map((x) => ref(x, { forecast: x.forecast })),
    forecastsDown: forecastsDown.map((x) => ref(x, { forecast: x.forecast })),
    priceGaps,
    hotSets: hotSets.map(({ top, ...s }) => ({ ...s, top: ref(top) })),
    articles: archive,
  };
  await mkdir(join(out, 'v1', 'market'), { recursive: true });
  await writeFile(join(out, 'v1', 'market', 'insights.json'), JSON.stringify(insights));
  return { cards: cards.length, sealed: sealed.length, articles: articles.length, aiWritten, sentiment: overall.score };
}

/** At most two entries per card name, so one character doesn't fill a list. */
function diverse(list, limit) {
  const seen = new Map();
  const out = [];
  for (const x of list) {
    const k = `${x.game}|${x.name}`;
    const n = seen.get(k) || 0;
    if (n >= 2) continue;
    seen.set(k, n + 1);
    out.push(x);
    if (out.length >= limit) break;
  }
  return out;
}
