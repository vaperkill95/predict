/**
 * smart-picks.js — Model-Powered Top Picks Generator (v2)
 * 
 * Uses enriched props data (already cached by middleware) instead of
 * making individual ESPN API calls for each player. This eliminates
 * the ESPN rate-limiting issue that caused "Failed to generate picks."
 */

const express = require('express');
const axios = require('axios');
const router = express.Router();

const PORT = process.env.PORT || 3001;
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const picksCache = {};

async function generateSmartPicks(sport, limit = 8) {
  console.log(`[SmartPicks] Generating for ${sport}...`);

  let props = [];
  try {
    const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : `http://localhost:${PORT}`;
    const resp = await axios.get(`${baseUrl}/api/props/${sport}`, { timeout: 20000 });
    props = resp.data?.props || [];
  } catch (e) {
    console.warn(`[SmartPicks] Props fetch failed: ${e.message}`);
    return [];
  }

  if (props.length === 0) return [];
  console.log(`[SmartPicks] ${props.length} props, ${props.filter(p => p.enriched).length} enriched`);

  const scoredPicks = [];

  for (const prop of props) {
    const a = prop.analytics || {};
    const line = prop.consensusLine;
    if (!line) continue;

    const hasEnrichment = prop.enriched && a.seasonAvg;
    if (!hasEnrichment && prop.bookCount < 4) continue;

    const seasonAvg = a.seasonAvg || 0;
    const l5Avg = a.l5Avg || seasonAvg;
    const l10Avg = a.l10Avg || seasonAvg;
    const hitRate = a.hitRate || 50;
    const trend = a.trend || 'steady';
    const consistency = a.consistency || 'unknown';
    const statKey = mapMarketToStat(prop.market || prop.marketLabel);

    const projection = hasEnrichment
      ? +((l5Avg * 0.50 + l10Avg * 0.30 + seasonAvg * 0.20)).toFixed(1)
      : seasonAvg;

    const diff = +(projection - line).toFixed(1);
    const pick = diff > 0 ? 'OVER' : 'UNDER';

    let confidence = 50;
    const edgePct = Math.abs(diff) / Math.max(line, 1) * 100;
    confidence += Math.min(20, edgePct * 2);
    if (pick === 'OVER' && hitRate > 70) confidence += 10;
    else if (pick === 'OVER' && hitRate > 60) confidence += 5;
    else if (pick === 'UNDER' && hitRate < 30) confidence += 10;
    else if (pick === 'UNDER' && hitRate < 40) confidence += 5;
    if (consistency === 'very_consistent') confidence += 8;
    else if (consistency === 'consistent') confidence += 4;
    if ((pick === 'OVER' && trend === 'hot') || (pick === 'UNDER' && trend === 'cold')) confidence += 5;
    if ((pick === 'OVER' && trend === 'cold') || (pick === 'UNDER' && trend === 'hot')) confidence -= 5;
    if (prop.lineType === 'demon') confidence += 8;
    if (prop.hasEdge) confidence += 5;
    if (prop.bookCount >= 6) confidence += 3;
    confidence = Math.min(95, Math.max(15, Math.round(confidence)));

    const grade = confidence >= 80 ? 'A+' : confidence >= 70 ? 'A' : confidence >= 60 ? 'B+' : confidence >= 55 ? 'B' : confidence >= 50 ? 'C+' : 'C';

    const reasons = [];
    if (hasEnrichment) {
      reasons.push(`Season avg ${seasonAvg} ${(prop.marketLabel || statKey || '').toUpperCase()}, line ${line}.`);
      if (Math.abs(diff) > 1) reasons.push(`Weighted projection ${projection} is ${Math.abs(diff)} ${pick === 'OVER' ? 'above' : 'below'} the line.`);
      if (pick === 'OVER' && hitRate > 60) reasons.push(`Hit OVER in ${hitRate}% of games.`);
      else if (pick === 'UNDER' && hitRate < 40) reasons.push(`Hit UNDER in ${(100 - hitRate).toFixed(0)}% of games.`);
      if (l5Avg > seasonAvg + 2) reasons.push(`Hot streak: L5 avg ${l5Avg} vs season ${seasonAvg}.`);
      else if (l5Avg < seasonAvg - 2) reasons.push(`Cold streak: L5 avg ${l5Avg} vs season ${seasonAvg}.`);
    }
    if (prop.lineType === 'demon') reasons.push('Demon line — 6+ books agree on strong edge.');

    scoredPicks.push({
      player: prop.player, market: prop.marketLabel || prop.market, pick, line,
      bestBook: prop.bestOver?.book || prop.bestUnder?.book || prop.books?.[0]?.name || 'Multiple',
      confidence, grade, reasoning: reasons.join(' '), projection, diff,
      seasonAvg, hitRate, l5Avg, l10Avg, trend, regressionSignal: trend,
      game: prop.game, lineType: prop.lineType, bookCount: prop.bookCount,
      book: prop.bestOver?.book || prop.bestUnder?.book || 'Best available',
    });
  }

  scoredPicks.sort((a, b) => b.confidence - a.confidence);
  return scoredPicks.slice(0, limit);
}

function mapMarketToStat(market) {
  if (!market) return null;
  const m = market.toLowerCase();
  if (m.includes('point') || m.includes('pts')) return 'pts';
  if (m.includes('rebound') || m.includes('reb')) return 'reb';
  if (m.includes('assist') || m.includes('ast')) return 'ast';
  if (m.includes('3pt') || m.includes('three') || m.includes('fg3')) return 'fg3';
  if (m.includes('steal')) return 'stl';
  if (m.includes('block')) return 'blk';
  return null;
}

async function refreshPicks() {
  for (const sport of ['nba', 'nhl', 'mlb']) {
    try {
      const picks = await generateSmartPicks(sport, 8);
      picksCache[sport] = { picks, lastUpdated: new Date().toISOString(), sport };
      console.log(`[SmartPicks] ${sport}: ${picks.length} picks (top: ${picks[0]?.confidence || 0}%)`);
    } catch (err) {
      console.error(`[SmartPicks] ${sport} failed:`, err.message);
    }
  }
}

function startRefresh() {
  console.log('[SmartPicks] Starting (every 15 min)');
  setTimeout(() => refreshPicks().catch(e => console.error('[SmartPicks]', e.message)), 45000);
  setInterval(() => refreshPicks().catch(e => console.error('[SmartPicks]', e.message)), REFRESH_INTERVAL_MS);
}

router.get('/:sport', async (req, res) => {
  const { sport } = req.params;
  const cached = picksCache[sport];
  if (cached && Date.now() - new Date(cached.lastUpdated).getTime() < CACHE_TTL_MS) {
    return res.json({ available: cached.picks.length > 0, picks: cached.picks, summary: `${cached.picks.length} model-powered picks`, sport, lastUpdated: cached.lastUpdated, model: 'prediction-model-v2' });
  }
  try {
    const picks = await generateSmartPicks(sport, 8);
    picksCache[sport] = { picks, lastUpdated: new Date().toISOString(), sport };
    res.json({ available: picks.length > 0, picks, summary: picks.length > 0 ? `${picks.length} model-powered picks` : 'No picks available', sport, lastUpdated: new Date().toISOString(), model: 'prediction-model-v2' });
  } catch (err) {
    res.json({ available: false, message: err.message, picks: [], sport });
  }
});

router.get('/:sport/top', (req, res) => {
  const cached = picksCache[req.params.sport];
  if (!cached) return res.json({ picks: [] });
  res.json({ picks: cached.picks.filter(p => p.confidence >= 70), sport: req.params.sport });
});

module.exports = { router, startRefresh, generateSmartPicks, picksCache };
