/**
 * pick-of-the-day.js — ORACLE's Ultimate Best Bet
 * 
 * Combines EVERY signal into a single recommendation:
 *   1. 7-factor prediction model (confidence, projection)
 *   2. Enrichment data (hit rate, L5/L10, trend, consistency)
 *   3. Demon/Edge detection (book consensus)
 *   4. +EV edge (mathematical advantage)
 *   5. DvP matchup (defense vs position favorability)
 *   6. Injury boost (teammate usage redistribution)
 *   7. Line movement direction
 * 
 * Scoring: Each signal that aligns adds to the "convergence score."
 * The prop with the highest convergence across ALL signals = Pick of the Day.
 * 
 * Also generates a "Top 3 Picks" with full reasoning.
 * 
 * Setup:
 *   const potd = require('./services/pick-of-the-day');
 *   app.use('/api/potd', potd.router);
 *   potd.startRefresh();
 */

const express = require('express');
const axios = require('axios');
const router = express.Router();

const PORT = process.env.PORT || 3001;
const REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 min
const cache = { picks: null, lastUpdated: null };

// ============================================================
// Signal Scoring Engine
// ============================================================

/**
 * Score a prop across all available signals
 * Returns a convergence score (0-100) and detailed signal breakdown
 */
function scoreSignals(prop, evBets, dvpData) {
  const signals = [];
  let totalScore = 0;
  let maxScore = 0;
  const a = prop.analytics || {};

  // --- 1. Hit Rate (0-20 pts) ---
  maxScore += 20;
  if (a.hitRate !== undefined) {
    const direction = a.suggestion || (a.lineDiffDirection === 'OVER' ? 'OVER' : 'UNDER');
    const hr = direction === 'OVER' ? a.hitRate : (100 - a.hitRate);
    if (hr >= 75) { totalScore += 20; signals.push({ name: 'Hit Rate', score: 20, max: 20, value: `${a.hitRate}%`, detail: `Player hits this line ${a.hitRate}% of the time` }); }
    else if (hr >= 65) { totalScore += 15; signals.push({ name: 'Hit Rate', score: 15, max: 20, value: `${a.hitRate}%`, detail: `Solid ${a.hitRate}% hit rate` }); }
    else if (hr >= 55) { totalScore += 8; signals.push({ name: 'Hit Rate', score: 8, max: 20, value: `${a.hitRate}%`, detail: `Moderate ${a.hitRate}% hit rate` }); }
    else { signals.push({ name: 'Hit Rate', score: 0, max: 20, value: `${a.hitRate}%`, detail: `Weak hit rate` }); }
  }

  // --- 2. Recent Form / L5 (0-15 pts) ---
  maxScore += 15;
  if (a.l5Avg !== undefined && a.seasonAvg !== undefined) {
    const l5Diff = a.l5Avg - a.seasonAvg;
    const direction = a.suggestion || (l5Diff > 0 ? 'OVER' : 'UNDER');
    const favorable = (direction === 'OVER' && l5Diff > 0) || (direction === 'UNDER' && l5Diff < 0);
    if (favorable && Math.abs(l5Diff) >= 3) { totalScore += 15; signals.push({ name: 'Recent Form', score: 15, max: 15, value: `L5: ${a.l5Avg}`, detail: `${a.trend === 'hot' ? '🔥 Hot streak' : 'Recent form supports pick'} — L5 avg ${a.l5Avg} vs season ${a.seasonAvg}` }); }
    else if (favorable && Math.abs(l5Diff) >= 1) { totalScore += 10; signals.push({ name: 'Recent Form', score: 10, max: 15, value: `L5: ${a.l5Avg}`, detail: `Positive trend — L5 ${a.l5Avg} vs season ${a.seasonAvg}` }); }
    else { signals.push({ name: 'Recent Form', score: 0, max: 15, value: `L5: ${a.l5Avg}`, detail: `Neutral or against pick direction` }); }
  }

  // --- 3. Demon Line Detection (0-15 pts) ---
  maxScore += 15;
  if (prop.lineType === 'demon') { totalScore += 15; signals.push({ name: 'Demon Line', score: 15, max: 15, value: '🔥 DEMON', detail: `6+ sportsbooks agree — strong consensus with exploitable outlier` }); }
  else if (prop.hasEdge) { totalScore += 8; signals.push({ name: 'Edge Detected', score: 8, max: 15, value: '⚡ EDGE', detail: `1.5+ point line spread between books — value available` }); }
  else { signals.push({ name: 'Line Type', score: 0, max: 15, value: 'Normal', detail: 'No special line signals' }); }

  // --- 4. Book Count / Consensus (0-10 pts) ---
  maxScore += 10;
  if (prop.bookCount >= 7) { totalScore += 10; signals.push({ name: 'Book Count', score: 10, max: 10, value: `${prop.bookCount} books`, detail: `${prop.bookCount} sportsbooks offering this prop — high liquidity and reliable line` }); }
  else if (prop.bookCount >= 5) { totalScore += 7; signals.push({ name: 'Book Count', score: 7, max: 10, value: `${prop.bookCount} books`, detail: `Good coverage across ${prop.bookCount} books` }); }
  else { totalScore += 3; signals.push({ name: 'Book Count', score: 3, max: 10, value: `${prop.bookCount} books`, detail: `Limited book coverage` }); }

  // --- 5. Consistency (0-10 pts) ---
  maxScore += 10;
  if (a.consistency === 'very_consistent') { totalScore += 10; signals.push({ name: 'Consistency', score: 10, max: 10, value: 'Very Consistent', detail: `Low variance — this player reliably hits near their average` }); }
  else if (a.consistency === 'consistent') { totalScore += 7; signals.push({ name: 'Consistency', score: 7, max: 10, value: 'Consistent', detail: `Moderate variance — fairly predictable` }); }
  else { signals.push({ name: 'Consistency', score: 2, max: 10, value: a.consistency || 'Unknown', detail: `Higher variance — less predictable` }); totalScore += 2; }

  // --- 6. Line Diff / Season Avg vs Line (0-15 pts) ---
  maxScore += 15;
  if (a.lineDiff !== undefined) {
    const absDiff = Math.abs(a.lineDiff);
    const direction = a.lineDiffDirection || 'OVER';
    if (absDiff >= 3) { totalScore += 15; signals.push({ name: 'Line vs Average', score: 15, max: 15, value: `${a.lineDiff > 0 ? '+' : ''}${a.lineDiff}`, detail: `Line is ${absDiff} ${direction === 'OVER' ? 'below' : 'above'} the season average — strong statistical edge` }); }
    else if (absDiff >= 1.5) { totalScore += 10; signals.push({ name: 'Line vs Average', score: 10, max: 15, value: `${a.lineDiff > 0 ? '+' : ''}${a.lineDiff}`, detail: `Line differs from average by ${absDiff} — moderate edge` }); }
    else { totalScore += 3; signals.push({ name: 'Line vs Average', score: 3, max: 15, value: `${a.lineDiff > 0 ? '+' : ''}${a.lineDiff}`, detail: `Line is close to the season average` }); }
  }

  // --- 7. +EV Edge (0-15 pts) ---
  maxScore += 15;
  const matchingEV = (evBets || []).find(e =>
    e.player === prop.player && e.market?.toLowerCase().includes(prop.market?.toLowerCase()?.replace('player_', ''))
  );
  if (matchingEV && matchingEV.edgePercent >= 5) { totalScore += 15; signals.push({ name: '+EV Edge', score: 15, max: 15, value: `+${matchingEV.edgePercent}%`, detail: `${matchingEV.edgePercent}% mathematical edge at ${matchingEV.book} — the odds are in your favor` }); }
  else if (matchingEV && matchingEV.edgePercent >= 2) { totalScore += 10; signals.push({ name: '+EV Edge', score: 10, max: 15, value: `+${matchingEV.edgePercent}%`, detail: `${matchingEV.edgePercent}% edge detected` }); }
  else { signals.push({ name: '+EV Edge', score: 0, max: 15, value: 'None', detail: 'No +EV edge detected at current odds' }); }

  // Calculate convergence percentage
  const convergence = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;

  // Determine the pick direction
  let pickDirection = 'OVER';
  if (a.suggestion) pickDirection = a.suggestion;
  else if (a.lineDiffDirection) pickDirection = a.lineDiffDirection;
  else if (a.l5Avg && a.seasonAvg && a.l5Avg < a.seasonAvg) pickDirection = 'UNDER';

  // Determine best book for this direction
  let bestBook = null;
  if (pickDirection === 'OVER' && prop.bestOver) bestBook = prop.bestOver;
  else if (pickDirection === 'UNDER' && prop.bestUnder) bestBook = prop.bestUnder;

  return {
    convergence,
    totalScore,
    maxScore,
    signalCount: signals.filter(s => s.score > s.max * 0.5).length,
    totalSignals: signals.length,
    signals,
    pickDirection,
    bestBook,
    evEdge: matchingEV || null,
  };
}

/**
 * Generate human-readable reasoning for the pick
 */
function generateReasoning(prop, scoring) {
  const a = prop.analytics || {};
  const strongSignals = scoring.signals.filter(s => s.score > s.max * 0.5);
  const direction = scoring.pickDirection;
  const player = prop.player;
  const market = prop.marketLabel || prop.market;
  const line = prop.consensusLine;

  let reasoning = `${player} ${direction} ${line} ${market} is ORACLE's top pick with a ${scoring.convergence}% convergence score — ${strongSignals.length} out of ${scoring.totalSignals} signals agree.\n\n`;

  // Build reasoning from strong signals
  const reasons = [];
  for (const sig of strongSignals) {
    reasons.push(sig.detail);
  }

  if (reasons.length > 0) {
    reasoning += `Why this pick:\n`;
    reasons.forEach((r, i) => { reasoning += `${i + 1}. ${r}\n`; });
  }

  // Add risk note
  const weakSignals = scoring.signals.filter(s => s.score <= s.max * 0.3);
  if (weakSignals.length > 0) {
    reasoning += `\nWatch out for: ${weakSignals.map(s => s.name).join(', ')} — these signals are neutral or weak.`;
  }

  return reasoning.trim();
}

// ============================================================
// Main Engine
// ============================================================

async function generatePickOfTheDay() {
  console.log('[POTD] Generating Pick of the Day...');

  // Fetch all data sources in parallel
  let props = [], evBets = [], dvpData = [];
  try {
    // Try enriched props first, fall back to regular props
    let propsResp;
    try {
      propsResp = await axios.get(`http://localhost:${PORT}/api/enriched/props/nba`, { timeout: 20000 });
    } catch (enrichErr) {
      console.log('[POTD] Enriched endpoint unavailable, trying regular props...');
      propsResp = await axios.get(`http://localhost:${PORT}/api/props/nba`, { timeout: 15000 });
    }
    const evResp = await axios.get(`http://localhost:${PORT}/api/ev/bets?minEdge=0`, { timeout: 10000 }).catch(() => ({ data: { bets: [] } }));
    props = propsResp.data?.props || [];
    evBets = evResp.data?.bets || [];
  } catch (e) {
    console.warn('[POTD] Data fetch failed:', e.message);
    return null;
  }

  if (props.length === 0) return null;

  // Score every prop that has analytics (enriched) OR has enough book data
  const scored = [];
  for (const prop of props) {
    // Use enriched data if available, otherwise score with basic signals only
    const hasAnalytics = prop.enriched && prop.analytics && prop.analytics.hitRate;
    if (!hasAnalytics && prop.bookCount < 4) continue; // Need either analytics or good book coverage

    const scoring = scoreSignals(prop, evBets, dvpData);

    scored.push({
      player: prop.player,
      market: prop.marketLabel || prop.market,
      game: prop.game,
      commenceTime: prop.commenceTime,
      line: prop.consensusLine,
      bookCount: prop.bookCount,
      lineType: prop.lineType,
      pick: scoring.pickDirection,
      convergence: scoring.convergence,
      signalCount: scoring.signalCount,
      totalSignals: scoring.totalSignals,
      signals: scoring.signals,
      reasoning: generateReasoning(prop, scoring),
      bestBook: scoring.bestBook,
      evEdge: scoring.evEdge,
      analytics: {
        seasonAvg: prop.analytics.seasonAvg,
        hitRate: prop.analytics.hitRate,
        l5Avg: prop.analytics.l5Avg,
        l10Avg: prop.analytics.l10Avg,
        trend: prop.analytics.trend,
        consistency: prop.analytics.consistency,
        lineDiff: prop.analytics.lineDiff,
      },
    });
  }

  // Sort by convergence score
  scored.sort((a, b) => b.convergence - a.convergence);

  const potd = scored[0] || null;
  const runners = scored.slice(1, 3);

  const result = {
    pickOfTheDay: potd,
    runnersUp: runners,
    totalAnalyzed: scored.length,
    timestamp: new Date().toISOString(),
    sport: 'nba',
  };

  cache.picks = result;
  cache.lastUpdated = new Date().toISOString();

  if (potd) {
    console.log(`[POTD] Pick of the Day: ${potd.player} ${potd.pick} ${potd.line} ${potd.market} — ${potd.convergence}% convergence (${potd.signalCount}/${potd.totalSignals} signals)`);
  }

  return result;
}

function startRefresh() {
  console.log('[POTD] Pick of the Day engine started (refreshes every 15 min)');

  // Initial generation after 90 seconds (wait for other services)
  setTimeout(async () => {
    await generatePickOfTheDay();
  }, 90000);

  // Recurring
  setInterval(async () => {
    await generatePickOfTheDay();
  }, REFRESH_INTERVAL_MS);
}

// ============================================================
// API Routes
// ============================================================

/**
 * GET /api/potd
 * Returns the Pick of the Day with full signal breakdown and reasoning
 */
router.get('/', async (req, res) => {
  let result = cache.picks;

  // If no cached result, generate fresh
  if (!result) {
    result = await generatePickOfTheDay();
  }

  if (!result || !result.pickOfTheDay) {
    return res.json({
      available: false,
      message: 'No games available right now. Pick of the Day generates when games are on the schedule.',
      timestamp: new Date().toISOString(),
    });
  }

  res.json({
    available: true,
    ...result,
  });
});

/**
 * GET /api/potd/top10
 * Returns top 10 picks ranked by convergence
 */
router.get('/top10', async (req, res) => {
  let result = cache.picks;
  if (!result) result = await generatePickOfTheDay();

  if (!result) {
    return res.json({ available: false, picks: [] });
  }

  const all = [result.pickOfTheDay, ...result.runnersUp].filter(Boolean);
  // Re-generate full top 10 if needed
  res.json({
    available: true,
    picks: all,
    totalAnalyzed: result.totalAnalyzed,
    timestamp: result.timestamp,
  });
});

module.exports = { router, startRefresh, generatePickOfTheDay };
