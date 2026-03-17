/**
 * model-tuner.js — Auto-Tune Prediction Model Weights
 * 
 * Runs backtests across multiple players and stats to find the
 * optimal factor weights for maximum accuracy.
 * 
 * Current default weights:
 *   Recency: 50% (last 3 games)
 *   Form: 25% (last 5 trend)
 *   Opponent: 25% (vs team history)
 *   Venue: 15% (home/away)
 *   Day: 10% (day of week)
 *   Regression: 30% (mean reversion)
 * 
 * The tuner tests variations and reports which weights produce
 * the highest hit rate across the test set.
 * 
 * Setup:
 *   const tuner = require('./services/model-tuner');
 *   app.use('/api/tuner', tuner.router);
 */

const express = require('express');
const axios = require('axios');
const router = express.Router();

const PORT = process.env.PORT || 3001;

// Top players to backtest against (good sample across positions/teams)
const TEST_PLAYERS = [
  'Jalen Brunson', 'LaMelo Ball', 'Cade Cunningham', 'Donovan Mitchell',
  'Shai Gilgeous-Alexander', 'Anthony Edwards', 'Jayson Tatum',
  'Devin Booker', 'Trae Young', 'Damian Lillard',
];

// Weight configurations to test
const WEIGHT_CONFIGS = [
  { name: 'default', recency: [0.50, 0.30, 0.20], venue: 0.15, day: 0.10, regression: 0.30 },
  { name: 'recency_heavy', recency: [0.60, 0.25, 0.15], venue: 0.10, day: 0.05, regression: 0.25 },
  { name: 'balanced', recency: [0.40, 0.30, 0.30], venue: 0.15, day: 0.15, regression: 0.30 },
  { name: 'form_heavy', recency: [0.35, 0.40, 0.25], venue: 0.15, day: 0.10, regression: 0.35 },
  { name: 'venue_boosted', recency: [0.45, 0.30, 0.25], venue: 0.25, day: 0.10, regression: 0.30 },
  { name: 'day_boosted', recency: [0.45, 0.30, 0.25], venue: 0.15, day: 0.20, regression: 0.30 },
  { name: 'regression_heavy', recency: [0.45, 0.30, 0.25], venue: 0.15, day: 0.10, regression: 0.45 },
  { name: 'minimal_adjustments', recency: [0.55, 0.30, 0.15], venue: 0.05, day: 0.05, regression: 0.15 },
];

/**
 * Run a backtest with specific weight configuration
 */
async function backtestWithWeights(playerName, stat, weights) {
  // Fetch game log via analytics
  let gameLog = [];
  try {
    const resp = await axios.get(
      `http://localhost:${PORT}/api/analytics/player/${encodeURIComponent(playerName)}`,
      { timeout: 15000 }
    );
    if (!resp.data?.found || !resp.data?.espnId) return null;

    const glResp = await axios.get(
      `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${resp.data.espnId}/gamelog`,
      { timeout: 10000 }
    );
    const data = glResp.data;
    const events = data.events || {};
    const regSeason = data.seasonTypes?.find(s => s.displayName?.includes('Regular'));
    if (!regSeason) return null;

    const parseFrac = (s) => { const p = (s || '').split('-'); return [parseInt(p[0]) || 0, parseInt(p[1]) || 0]; };
    for (const cat of (regSeason.categories || [])) {
      for (const game of (cat.events || [])) {
        const ev = events[game.eventId];
        if (!ev || !game.stats) continue;
        const s = game.stats;
        const [fg3m] = parseFrac(s[3]);
        const d = new Date(ev.gameDate);
        gameLog.push({
          date: ev.gameDate?.split('T')[0] || '',
          dayOfWeek: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()],
          isHome: ev.atVs === 'vs',
          opponent: ev.opponent?.abbreviation || '',
          pts: parseInt(s[13]) || 0,
          reb: parseInt(s[7]) || 0,
          ast: parseInt(s[8]) || 0,
          fg3: fg3m,
        });
      }
    }
    gameLog.sort((a, b) => new Date(a.date) - new Date(b.date));
  } catch (e) {
    return null;
  }

  if (gameLog.length < 15) return null;

  // Run backtest with custom weights
  let hits = 0, total = 0;
  const [w1, w2, w3] = weights.recency;

  for (let i = 10; i < gameLog.length; i++) {
    const prior = gameLog.slice(0, i);
    const actual = gameLog[i][stat] || 0;
    const values = prior.map(g => g[stat] || 0);
    const seasonAvg = values.reduce((a, b) => a + b, 0) / values.length;
    const line = +seasonAvg.toFixed(1);

    // Weighted recency with custom weights
    let wSum = 0, wTotal = 0;
    for (let j = prior.length - 1; j >= 0; j--) {
      const ago = prior.length - 1 - j;
      let w;
      if (ago < 3) w = w1 / 3;
      else if (ago < 10) w = w2 / 7;
      else w = w3 / Math.max(1, prior.length - 10);
      wSum += (prior[j][stat] || 0) * w;
      wTotal += w;
    }
    let projection = wTotal > 0 ? wSum / wTotal : seasonAvg;

    // Regression with custom weight
    const last5 = prior.slice(-5);
    const l5Avg = last5.reduce((a, g) => a + (g[stat] || 0), 0) / last5.length;
    const variance = values.reduce((s, v) => s + Math.pow(v - seasonAvg, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);
    if (stdDev > 0) {
      const dev = (l5Avg - seasonAvg) / stdDev;
      if (dev > 1.5) projection += -((dev - 1.0) * stdDev * weights.regression);
      else if (dev < -1.5) projection += -(dev + 1.0) * stdDev * weights.regression;
    }

    // Venue with custom weight
    const venueGames = prior.filter(g => g.isHome === gameLog[i].isHome);
    if (venueGames.length >= 3) {
      const venueAvg = venueGames.reduce((a, g) => a + (g[stat] || 0), 0) / venueGames.length;
      projection += (venueAvg - seasonAvg) * weights.venue;
    }

    // Day of week with custom weight
    const dayGames = prior.filter(g => g.dayOfWeek === gameLog[i].dayOfWeek);
    if (dayGames.length >= 2) {
      const dayAvg = dayGames.reduce((a, g) => a + (g[stat] || 0), 0) / dayGames.length;
      projection += (dayAvg - seasonAvg) * weights.day;
    }

    const pick = projection > line ? 'OVER' : 'UNDER';
    const hit = pick === 'OVER' ? actual > line : actual < line;
    if (actual !== line) {
      if (hit) hits++;
      total++;
    }
  }

  return { hits, total, hitRate: total > 0 ? +((hits / total) * 100).toFixed(1) : 0 };
}

// ============================================================
// API Routes
// ============================================================

/**
 * GET /api/tuner/run?stat=pts&players=5
 * Run the tuner across multiple players and weight configs
 */
router.get('/run', async (req, res) => {
  const stat = req.query.stat || 'pts';
  const playerCount = Math.min(parseInt(req.query.players) || 5, 10);
  const players = TEST_PLAYERS.slice(0, playerCount);

  console.log(`[Tuner] Running ${WEIGHT_CONFIGS.length} configs x ${players.length} players for ${stat}...`);

  const results = [];

  for (const config of WEIGHT_CONFIGS) {
    let totalHits = 0, totalGames = 0;
    const playerResults = [];

    for (const player of players) {
      const result = await backtestWithWeights(player, stat, config);
      if (result) {
        totalHits += result.hits;
        totalGames += result.total;
        playerResults.push({ player, ...result });
      }
    }

    const hitRate = totalGames > 0 ? +((totalHits / totalGames) * 100).toFixed(1) : 0;
    results.push({
      config: config.name,
      weights: config,
      aggregate: { totalGames, totalHits, hitRate },
      players: playerResults,
    });
  }

  // Sort by hit rate
  results.sort((a, b) => b.aggregate.hitRate - a.aggregate.hitRate);

  const best = results[0];
  const worst = results[results.length - 1];

  res.json({
    stat,
    playersTestedCount: players.length,
    configsTested: WEIGHT_CONFIGS.length,
    best: { config: best.config, hitRate: best.aggregate.hitRate, weights: best.weights },
    worst: { config: worst.config, hitRate: worst.aggregate.hitRate },
    improvement: +(best.aggregate.hitRate - worst.aggregate.hitRate).toFixed(1),
    allResults: results.map(r => ({
      config: r.config,
      hitRate: r.aggregate.hitRate,
      totalGames: r.aggregate.totalGames,
    })),
    recommendation: `Use "${best.config}" weights for ${stat} props. Hit rate: ${best.aggregate.hitRate}% across ${best.aggregate.totalGames} games.`,
  });
});

/**
 * GET /api/tuner/optimal
 * Returns the currently recommended optimal weights
 */
router.get('/optimal', (req, res) => {
  // These will be updated as the tuner runs
  res.json({
    recommended: {
      recency: [0.50, 0.30, 0.20],
      venue: 0.15,
      day: 0.10,
      regression: 0.30,
    },
    note: 'Run GET /api/tuner/run?stat=pts to find optimal weights for your data',
  });
});

module.exports = { router, backtestWithWeights, TEST_PLAYERS, WEIGHT_CONFIGS };
