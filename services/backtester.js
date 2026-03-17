/**
 * backtester.js — Historical Accuracy Backtester
 * 
 * Runs the prediction model against past games to measure
 * how accurate each factor actually is.
 * 
 * Flow:
 *   1. Fetch a player's full season game log (ESPN)
 *   2. For each game, pretend we only knew the games BEFORE it
 *   3. Generate a "prediction" using those prior games
 *   4. Compare prediction to actual result → HIT or MISS
 *   5. Report accuracy by factor, stat type, and confidence tier
 * 
 * Setup:
 *   const backtester = require('./services/backtester');
 *   app.use('/api/backtest', backtester.router);
 */

const express = require('express');
const axios = require('axios');
const router = express.Router();

const PORT = process.env.PORT || 3001;

// ============================================================
// Backtest Engine
// ============================================================

/**
 * Run a backtest for a specific player and stat
 * 
 * @param {string} playerName
 * @param {string} stat - pts, reb, ast, fg3
 * @param {number} lineOffset - how to set the line (0 = use season avg, +/- offset)
 * @returns {object} Backtest results with accuracy breakdown
 */
async function backtestPlayer(playerName, stat = 'pts', lineOffset = 0) {
  // Fetch full game log
  let gameLog = [];
  try {
    const resp = await axios.get(
      `http://localhost:${PORT}/api/analytics/player/${encodeURIComponent(playerName)}`,
      { timeout: 15000 }
    );
    if (!resp.data?.found || !resp.data?.splits) {
      return { error: 'Player not found or no data' };
    }
    // We need the full game log, not just last 10
    // Fetch directly from ESPN
    const espnId = resp.data.espnId;
    if (espnId) {
      const glResp = await axios.get(
        `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${espnId}/gamelog`,
        { timeout: 10000 }
      );
      const data = glResp.data;
      const events = data.events || {};
      const regSeason = data.seasonTypes?.find(s => s.displayName?.includes('Regular'));
      if (regSeason) {
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
              result: ev.gameResult || '',
              pts: parseInt(s[13]) || 0,
              reb: parseInt(s[7]) || 0,
              ast: parseInt(s[8]) || 0,
              fg3: fg3m,
            });
          }
        }
        gameLog.sort((a, b) => new Date(a.date) - new Date(b.date));
      }
    }
    if (gameLog.length === 0) gameLog = resp.data.gameLog || [];
  } catch (e) {
    return { error: `Failed to fetch game log: ${e.message}` };
  }

  if (gameLog.length < 15) {
    return { error: `Only ${gameLog.length} games — need at least 15 for backtest` };
  }

  // Run backtest: for each game from game 10 onward, predict using prior games
  const results = [];
  const startIdx = 10; // Need at least 10 prior games

  for (let i = startIdx; i < gameLog.length; i++) {
    const priorGames = gameLog.slice(0, i);
    const actualGame = gameLog[i];
    const actual = actualGame[stat] || 0;

    // Compute prediction using prior games only
    const values = priorGames.map(g => g[stat] || 0);
    const seasonAvg = +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(1);

    // Set line as season average + offset (simulates typical book line)
    const line = +(seasonAvg + lineOffset).toFixed(1);

    // Weighted recency
    let wSum = 0, wTotal = 0;
    for (let j = priorGames.length - 1; j >= 0; j--) {
      const ago = priorGames.length - 1 - j;
      let w;
      if (ago < 3) w = 0.50 / 3;
      else if (ago < 10) w = 0.30 / 7;
      else w = 0.20 / Math.max(1, priorGames.length - 10);
      wSum += (priorGames[j][stat] || 0) * w;
      wTotal += w;
    }
    const weightedAvg = wTotal > 0 ? +(wSum / wTotal).toFixed(1) : seasonAvg;

    // Recent form
    const last5 = priorGames.slice(-5);
    const last5Avg = +(last5.reduce((a, g) => a + (g[stat] || 0), 0) / last5.length).toFixed(1);

    // Regression
    const variance = values.reduce((s, v) => s + Math.pow(v - seasonAvg, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);
    const deviations = stdDev > 0 ? (last5Avg - seasonAvg) / stdDev : 0;
    let regressionAdj = 0;
    if (deviations > 1.5) regressionAdj = -((deviations - 1.0) * stdDev * 0.3);
    else if (deviations < -1.5) regressionAdj = -(deviations + 1.0) * stdDev * 0.3;

    // Home/away
    const homeGames = priorGames.filter(g => g.isHome);
    const awayGames = priorGames.filter(g => !g.isHome);
    const homeAvg = homeGames.length >= 3 ? +(homeGames.reduce((a, g) => a + (g[stat] || 0), 0) / homeGames.length).toFixed(1) : null;
    const awayAvg = awayGames.length >= 3 ? +(awayGames.reduce((a, g) => a + (g[stat] || 0), 0) / awayGames.length).toFixed(1) : null;
    const venueAvg = actualGame.isHome ? homeAvg : awayAvg;

    // Day of week
    const dayGames = priorGames.filter(g => g.dayOfWeek === actualGame.dayOfWeek);
    const dayAvg = dayGames.length >= 2 ? +(dayGames.reduce((a, g) => a + (g[stat] || 0), 0) / dayGames.length).toFixed(1) : null;

    // Combine factors
    let projection = weightedAvg + regressionAdj;
    if (venueAvg !== null) projection += (venueAvg - seasonAvg) * 0.15;
    if (dayAvg !== null) projection += (dayAvg - seasonAvg) * 0.10;
    projection = +projection.toFixed(1);

    const diff = projection - line;
    const pick = diff > 0 ? 'OVER' : 'UNDER';

    // Did it hit?
    const hit = pick === 'OVER' ? actual > line : actual < line;
    const push = actual === line;

    // Confidence
    let confidence = 50;
    const edgePct = Math.abs(diff) / Math.max(line, 1) * 100;
    confidence += Math.min(20, edgePct * 2);
    if (stdDev < 3) confidence += 10; else if (stdDev < 5) confidence += 5;
    const hitRate = +((values.filter(v => v > line).length / values.length) * 100).toFixed(1);
    if (hitRate > 70 || hitRate < 30) confidence += 5;
    confidence = Math.min(95, Math.max(15, Math.round(confidence)));

    results.push({
      gameNum: i + 1,
      date: actualGame.date,
      opponent: actualGame.opponent,
      isHome: actualGame.isHome,
      line,
      projection,
      pick,
      actual,
      hit: push ? 'push' : hit,
      confidence,
      diff: +diff.toFixed(1),
    });
  }

  // Calculate accuracy
  const graded = results.filter(r => r.hit !== 'push');
  const hits = graded.filter(r => r.hit === true).length;
  const totalGraded = graded.length;
  const hitRate = totalGraded > 0 ? +((hits / totalGraded) * 100).toFixed(1) : 0;

  // Accuracy by confidence tier
  const byConfidence = {};
  for (const tier of [[80, 95, '80+'], [65, 79, '65-79'], [50, 64, '50-64'], [0, 49, 'below50']]) {
    const tierResults = graded.filter(r => r.confidence >= tier[0] && r.confidence <= tier[1]);
    const tierHits = tierResults.filter(r => r.hit === true).length;
    byConfidence[tier[2]] = {
      total: tierResults.length,
      hits: tierHits,
      hitRate: tierResults.length > 0 ? +((tierHits / tierResults.length) * 100).toFixed(1) : 0,
    };
  }

  // Accuracy by pick direction
  const overs = graded.filter(r => r.pick === 'OVER');
  const unders = graded.filter(r => r.pick === 'UNDER');

  return {
    player: playerName,
    stat,
    lineOffset,
    gamesTotal: gameLog.length,
    gamesTested: results.length,
    accuracy: {
      total: totalGraded,
      hits,
      misses: totalGraded - hits,
      hitRate,
    },
    byConfidence,
    byDirection: {
      OVER: { total: overs.length, hits: overs.filter(r => r.hit === true).length, hitRate: overs.length > 0 ? +((overs.filter(r => r.hit === true).length / overs.length) * 100).toFixed(1) : 0 },
      UNDER: { total: unders.length, hits: unders.filter(r => r.hit === true).length, hitRate: unders.length > 0 ? +((unders.filter(r => r.hit === true).length / unders.length) * 100).toFixed(1) : 0 },
    },
    // Last 10 results for spot check
    sampleResults: results.slice(-10),
  };
}

// ============================================================
// API Routes
// ============================================================

/**
 * GET /api/backtest/player/:name?stat=pts&offset=0
 * Run a backtest for a specific player
 */
router.get('/player/:name', async (req, res) => {
  const { stat, offset } = req.query;
  try {
    const result = await backtestPlayer(
      decodeURIComponent(req.params.name),
      stat || 'pts',
      parseFloat(offset) || 0
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/backtest/multi?players=Jalen+Brunson,LaMelo+Ball&stat=pts
 * Run backtests for multiple players and aggregate
 */
router.get('/multi', async (req, res) => {
  const playerNames = (req.query.players || '').split(',').map(p => p.trim()).filter(Boolean);
  const stat = req.query.stat || 'pts';

  if (playerNames.length === 0) return res.json({ error: 'Provide ?players=Name1,Name2' });

  const results = [];
  let totalHits = 0, totalGames = 0;

  for (const name of playerNames.slice(0, 10)) {
    const result = await backtestPlayer(name, stat);
    if (!result.error) {
      results.push({ player: name, hitRate: result.accuracy.hitRate, total: result.accuracy.total, hits: result.accuracy.hits });
      totalHits += result.accuracy.hits;
      totalGames += result.accuracy.total;
    } else {
      results.push({ player: name, error: result.error });
    }
  }

  res.json({
    stat,
    players: results,
    aggregate: {
      totalGames,
      totalHits,
      hitRate: totalGames > 0 ? +((totalHits / totalGames) * 100).toFixed(1) : 0,
    },
  });
});

module.exports = { router, backtestPlayer };
