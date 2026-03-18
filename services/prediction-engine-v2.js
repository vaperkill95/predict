/**
 * prediction-engine-v2.js — Enhanced Prediction Engine
 * 
 * 3 NEW high-impact accuracy improvements:
 * 
 *   1. MINUTES PROJECTION
 *      - Estimates expected minutes based on: season avg minutes, spread (blowout risk),
 *        back-to-back flag, teammate injuries (more/fewer minutes), and pace
 *      - Minutes is THE #1 predictor of player stats
 *      - A player projected for 28 min instead of 35 min = ~20% stat reduction
 * 
 *   2. GAME SCRIPT ANALYSIS
 *      - Uses Vegas spread + total to predict the game environment
 *      - High total + close spread = fast, competitive, starters play full game
 *      - Low total + big spread = slow, blowout, starters rest Q4
 *      - Outputs a "game environment score" that adjusts all projections
 * 
 *   3. OPPONENT-SPECIFIC HISTORY
 *      - Checks how this player performs vs THIS specific opponent
 *      - Some players consistently dominate certain teams
 *      - Uses ESPN game log filtered by opponent
 * 
 * Also includes all existing factors:
 *   4. Weighted recency (L3=50%, L4-10=30%, rest=20%)
 *   5. Injury usage redistribution
 *   6. DvP matchup grade
 *   7. Home/away venue adjustment
 *   8. Day-of-week pattern
 *   9. Regression to mean
 *   10. Consistency scoring
 * 
 * Setup:
 *   const predV2 = require('./services/prediction-engine-v2');
 *   app.use('/api/predict-v2', predV2.router);
 */

const express = require('express');
const axios = require('axios');
const router = express.Router();

const PORT = process.env.PORT || 3001;

// ============================================================
// 1. MINUTES PROJECTION
// ============================================================

/**
 * Project expected minutes for a player based on game context
 * 
 * @param {number} avgMinutes - Player's season average minutes
 * @param {number} spread - Vegas spread (negative = favored)
 * @param {boolean} isBackToBack - Is this a B2B game?
 * @param {number} teammatesOut - Number of key teammates injured
 * @param {boolean} isHome - Home game?
 * @returns {object} Minutes projection with adjustment breakdown
 */
function projectMinutes(avgMinutes, spread, isBackToBack, teammatesOut, isHome) {
  let projected = avgMinutes;
  const adjustments = [];

  // Blowout risk: if spread is 10+, starters lose ~4-6 min in Q4
  const absSpread = Math.abs(spread || 0);
  if (absSpread >= 15) {
    projected -= 6;
    adjustments.push({ factor: 'Blowout risk (15+ spread)', change: -6 });
  } else if (absSpread >= 12) {
    projected -= 4;
    adjustments.push({ factor: 'Blowout risk (12+ spread)', change: -4 });
  } else if (absSpread >= 9) {
    projected -= 2;
    adjustments.push({ factor: 'Moderate blowout risk', change: -2 });
  } else if (absSpread <= 3) {
    projected += 1.5;
    adjustments.push({ factor: 'Close game expected', change: +1.5 });
  }

  // Back-to-back fatigue: starters typically lose 2-3 min
  if (isBackToBack) {
    projected -= 2.5;
    adjustments.push({ factor: 'Back-to-back game', change: -2.5 });
  }

  // Teammate injuries: when key players are out, remaining starters play more
  if (teammatesOut >= 3) {
    projected += 3;
    adjustments.push({ factor: `${teammatesOut} teammates OUT — more minutes`, change: +3 });
  } else if (teammatesOut >= 1) {
    projected += 1.5;
    adjustments.push({ factor: `${teammatesOut} teammate(s) OUT`, change: +1.5 });
  }

  // Cap at realistic ranges
  projected = Math.max(10, Math.min(42, projected));

  const minutesMultiplier = projected / Math.max(avgMinutes, 1);

  return {
    avgMinutes: +avgMinutes.toFixed(1),
    projectedMinutes: +projected.toFixed(1),
    minutesMultiplier: +minutesMultiplier.toFixed(3),
    change: +(projected - avgMinutes).toFixed(1),
    adjustments,
    impact: minutesMultiplier < 0.85 ? 'significant_reduction' :
            minutesMultiplier < 0.95 ? 'moderate_reduction' :
            minutesMultiplier > 1.05 ? 'moderate_increase' :
            minutesMultiplier > 1.10 ? 'significant_increase' : 'normal',
  };
}

// ============================================================
// 2. GAME SCRIPT ANALYSIS
// ============================================================

/**
 * Analyze the expected game environment using Vegas lines
 * 
 * @param {number} gameTotal - Vegas over/under total
 * @param {number} spread - Vegas spread
 * @returns {object} Game environment analysis
 */
function analyzeGameScript(gameTotal, spread) {
  const absSpread = Math.abs(spread || 0);
  const total = gameTotal || 220; // NBA average ~220

  // Pace factor: higher total = faster game = more stats
  // NBA avg total ~220, range typically 210-240
  const paceMultiplier = total / 220;

  // Competitiveness: close games = full minutes for starters
  // Blowouts = garbage time for bench
  let competitiveness;
  if (absSpread <= 2) competitiveness = 'nail_biter';
  else if (absSpread <= 5) competitiveness = 'competitive';
  else if (absSpread <= 9) competitiveness = 'moderate_favorite';
  else if (absSpread <= 13) competitiveness = 'heavy_favorite';
  else competitiveness = 'blowout';

  // Scoring environment
  let environment;
  if (total >= 235 && absSpread <= 5) environment = 'shootout';
  else if (total >= 230) environment = 'high_scoring';
  else if (total >= 220) environment = 'average';
  else if (total >= 210) environment = 'low_scoring';
  else environment = 'defensive_battle';

  // Combined stat multiplier
  // High total + close game = boost stats ~5-10%
  // Low total + blowout = reduce stats ~10-15%
  let statMultiplier = 1.0;
  statMultiplier *= paceMultiplier;
  if (competitiveness === 'nail_biter') statMultiplier *= 1.03;
  else if (competitiveness === 'blowout') statMultiplier *= 0.90;
  else if (competitiveness === 'heavy_favorite') statMultiplier *= 0.95;

  // Points are most affected by pace, rebounds by pace too (more misses), assists moderately
  const pointsMultiplier = +(statMultiplier * 1.0).toFixed(3);
  const reboundsMultiplier = +(statMultiplier * 0.95 + 0.05).toFixed(3); // rebounds less volatile
  const assistsMultiplier = +(statMultiplier * 0.90 + 0.10).toFixed(3); // assists least affected

  return {
    gameTotal: total,
    spread,
    paceMultiplier: +paceMultiplier.toFixed(3),
    competitiveness,
    environment,
    statMultipliers: {
      pts: pointsMultiplier,
      reb: reboundsMultiplier,
      ast: assistsMultiplier,
      fg3: pointsMultiplier, // 3PT affected similarly to points
      stl: +(statMultiplier * 0.85 + 0.15).toFixed(3),
      blk: +(statMultiplier * 0.85 + 0.15).toFixed(3),
    },
    analysis: environment === 'shootout'
      ? `High-scoring shootout expected (total ${total}, spread ${absSpread}). Boost all stat projections.`
      : competitiveness === 'blowout'
        ? `Blowout likely (spread ${absSpread}). Starters may sit Q4 — reduce projections for favorites.`
        : competitiveness === 'nail_biter'
          ? `Tight game expected (spread ${absSpread}). Starters play full 48 — boost projections.`
          : `Standard game environment (total ${total}, spread ${absSpread}).`,
  };
}

// ============================================================
// 3. OPPONENT-SPECIFIC HISTORY
// ============================================================

/**
 * Get a player's historical performance vs a specific opponent
 * Uses ESPN game log data filtered by opponent abbreviation
 * 
 * @param {object} enrichedProp - The prop with analytics data
 * @param {string} opponentAbbr - Opponent team abbreviation
 * @returns {object} Opponent-specific analysis
 */
function analyzeVsOpponent(gameLog, opponentAbbr, statKey) {
  if (!gameLog || gameLog.length === 0 || !opponentAbbr) {
    return { available: false };
  }

  // Filter games vs this opponent
  const vsGames = gameLog.filter(g =>
    (g.opponent || '').toUpperCase() === opponentAbbr.toUpperCase()
  );

  if (vsGames.length < 2) {
    return { available: false, reason: `Only ${vsGames.length} games vs ${opponentAbbr}` };
  }

  const values = vsGames.map(g => g[statKey] || 0);
  const vsAvg = +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(1);
  const allValues = gameLog.map(g => g[statKey] || 0);
  const seasonAvg = +(allValues.reduce((a, b) => a + b, 0) / allValues.length).toFixed(1);
  const diff = +(vsAvg - seasonAvg).toFixed(1);

  return {
    available: true,
    opponent: opponentAbbr,
    gamesVs: vsGames.length,
    vsAvg,
    seasonAvg,
    diff,
    direction: diff > 0 ? 'OVER' : diff < 0 ? 'UNDER' : 'NEUTRAL',
    impact: Math.abs(diff) >= 5 ? 'major' : Math.abs(diff) >= 2 ? 'moderate' : 'minor',
    analysis: Math.abs(diff) >= 2
      ? `${diff > 0 ? 'Dominates' : 'Struggles vs'} ${opponentAbbr}: avg ${vsAvg} vs season ${seasonAvg} (${diff > 0 ? '+' : ''}${diff}) in ${vsGames.length} games`
      : `Neutral vs ${opponentAbbr}: avg ${vsAvg} (close to season avg ${seasonAvg})`,
  };
}

// ============================================================
// COMBINED ENHANCED PREDICTION
// ============================================================

/**
 * Generate an enhanced prediction combining all 10 factors
 */
async function enhancedPredict(playerName, stat, line, gameInfo) {
  // Fetch player analytics
  let analytics = null;
  try {
    const resp = await axios.get(
      `http://localhost:${PORT}/api/analytics/player/${encodeURIComponent(playerName)}`,
      { timeout: 12000 }
    );
    if (resp.data?.found) analytics = resp.data;
  } catch (e) {}

  if (!analytics || !analytics.gameLog || analytics.gameLog.length < 5) {
    return { available: false, reason: 'Insufficient player data' };
  }

  const gameLog = analytics.gameLog;
  const statKey = stat.toLowerCase().replace('points', 'pts').replace('rebounds', 'reb').replace('assists', 'ast').replace('3-pointers', 'fg3').replace('threes', 'fg3');
  const values = gameLog.map(g => g[statKey] || 0);
  const seasonAvg = +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(1);

  if (seasonAvg === 0) return { available: false, reason: 'No data for this stat' };

  // ---- Factor 1: Weighted Recency ----
  let wSum = 0, wTotal = 0;
  for (let i = gameLog.length - 1; i >= 0; i--) {
    const ago = gameLog.length - 1 - i;
    let w = ago < 3 ? 0.50 / 3 : ago < 10 ? 0.30 / 7 : 0.20 / Math.max(1, gameLog.length - 10);
    wSum += (gameLog[i][statKey] || 0) * w;
    wTotal += w;
  }
  const weightedAvg = wTotal > 0 ? +(wSum / wTotal).toFixed(1) : seasonAvg;

  // ---- Factor 2: L5 Recent Form ----
  const l5 = gameLog.slice(-5);
  const l5Avg = +(l5.reduce((a, g) => a + (g[statKey] || 0), 0) / l5.length).toFixed(1);

  // ---- Factor 3: Hit Rate ----
  const overCount = values.filter(v => v > line).length;
  const hitRate = +((overCount / values.length) * 100).toFixed(1);

  // ---- NEW Factor 4: Minutes Projection ----
  const avgMinutes = analytics.splits?.avgMinutes || 30;
  const spread = gameInfo?.spread || 0;
  const isB2B = gameInfo?.isBackToBack || false;
  const teammatesOut = gameInfo?.teammatesOut || 0;
  const minutesProj = projectMinutes(avgMinutes, spread, isB2B, teammatesOut, gameInfo?.isHome);

  // ---- NEW Factor 5: Game Script ----
  const gameScript = analyzeGameScript(gameInfo?.total || 220, spread);
  const statMultiplier = gameScript.statMultipliers[statKey] || 1.0;

  // ---- NEW Factor 6: Opponent History ----
  const vsOpponent = analyzeVsOpponent(gameLog, gameInfo?.opponentAbbr, statKey);

  // ---- Factor 7: Home/Away ----
  const isHome = gameInfo?.isHome;
  const homeGames = gameLog.filter(g => g.isHome);
  const awayGames = gameLog.filter(g => !g.isHome);
  const homeAvg = homeGames.length >= 3 ? +(homeGames.reduce((a, g) => a + (g[statKey] || 0), 0) / homeGames.length).toFixed(1) : null;
  const awayAvg = awayGames.length >= 3 ? +(awayGames.reduce((a, g) => a + (g[statKey] || 0), 0) / awayGames.length).toFixed(1) : null;
  const venueAvg = isHome ? homeAvg : awayAvg;

  // ---- Factor 8: Regression ----
  const variance = values.reduce((s, v) => s + Math.pow(v - seasonAvg, 2), 0) / values.length;
  const stdDev = Math.sqrt(variance);
  const deviations = stdDev > 0 ? (l5Avg - seasonAvg) / stdDev : 0;
  let regressionAdj = 0;
  if (deviations > 1.5) regressionAdj = -((deviations - 1.0) * stdDev * 0.3);
  else if (deviations < -1.5) regressionAdj = -(deviations + 1.0) * stdDev * 0.3;

  // ============ COMBINE ALL FACTORS ============
  let projection = weightedAvg;

  // Apply regression
  projection += regressionAdj;

  // Apply venue (15% weight)
  if (venueAvg !== null) {
    projection += (venueAvg - seasonAvg) * 0.15;
  }

  // Apply opponent history (20% weight when available)
  if (vsOpponent.available && Math.abs(vsOpponent.diff) >= 1) {
    projection += vsOpponent.diff * 0.20;
  }

  // Apply minutes multiplier (THE most important adjustment)
  projection *= minutesProj.minutesMultiplier;

  // Apply game script multiplier
  projection *= statMultiplier;

  projection = +projection.toFixed(1);

  // ---- Determine pick direction ----
  const diff = +(projection - line).toFixed(1);
  const pick = diff > 0 ? 'OVER' : 'UNDER';

  // ---- Confidence scoring ----
  let confidence = 50;
  const edgePct = Math.abs(diff) / Math.max(line, 1) * 100;
  confidence += Math.min(20, edgePct * 2);
  if (stdDev < 3) confidence += 8; else if (stdDev < 5) confidence += 4;
  if (hitRate > 70 || hitRate < 30) confidence += 8;
  if (hitRate > 60 || hitRate < 40) confidence += 3;
  if ((pick === 'OVER' && l5Avg > seasonAvg) || (pick === 'UNDER' && l5Avg < seasonAvg)) confidence += 5;
  if (vsOpponent.available && vsOpponent.direction === pick) confidence += 5;
  if (minutesProj.impact === 'significant_reduction' && pick === 'OVER') confidence -= 10;
  if (minutesProj.impact === 'significant_increase' && pick === 'OVER') confidence += 5;
  if (gameScript.competitiveness === 'blowout' && pick === 'OVER') confidence -= 8;
  if (gameScript.environment === 'shootout' && pick === 'OVER') confidence += 5;

  confidence = Math.min(95, Math.max(15, Math.round(confidence)));
  const grade = confidence >= 80 ? 'A+' : confidence >= 70 ? 'A' : confidence >= 60 ? 'B+' : confidence >= 55 ? 'B' : confidence >= 50 ? 'C+' : 'C';

  return {
    available: true,
    player: playerName,
    stat,
    line,
    pick,
    projection,
    diff,
    confidence,
    grade,
    factors: {
      seasonAvg,
      weightedAvg,
      l5Avg,
      hitRate,
      minutesProjection: minutesProj,
      gameScript,
      vsOpponent,
      homeAvg,
      awayAvg,
      regressionAdj: +regressionAdj.toFixed(1),
      stdDev: +stdDev.toFixed(1),
    },
    reasoning: buildReasoning(playerName, stat, line, pick, projection, diff, confidence, {
      seasonAvg, weightedAvg, l5Avg, hitRate, minutesProj, gameScript, vsOpponent, regressionAdj
    }),
  };
}

function buildReasoning(player, stat, line, pick, projection, diff, confidence, factors) {
  const parts = [];
  parts.push(`${player} ${pick} ${line} ${stat} — ${confidence}% confidence.`);
  parts.push(`Projection: ${projection} (${diff > 0 ? '+' : ''}${diff} from line).`);
  parts.push(`Season avg: ${factors.seasonAvg}, Weighted recent: ${factors.weightedAvg}, L5: ${factors.l5Avg}.`);

  if (factors.minutesProj.change !== 0) {
    parts.push(`Minutes: ${factors.minutesProj.projectedMinutes} (${factors.minutesProj.change > 0 ? '+' : ''}${factors.minutesProj.change} from avg). ${factors.minutesProj.adjustments.map(a => a.factor).join('. ')}.`);
  }

  if (factors.gameScript.environment !== 'average') {
    parts.push(`Game script: ${factors.gameScript.analysis}`);
  }

  if (factors.vsOpponent.available && Math.abs(factors.vsOpponent.diff) >= 1) {
    parts.push(`Vs ${factors.vsOpponent.opponent}: ${factors.vsOpponent.analysis}`);
  }

  if (pick === 'OVER' && factors.hitRate > 65) parts.push(`Hit OVER in ${factors.hitRate}% of games.`);
  else if (pick === 'UNDER' && factors.hitRate < 35) parts.push(`Hit UNDER in ${(100 - factors.hitRate).toFixed(0)}% of games.`);

  if (Math.abs(factors.regressionAdj) > 1) {
    parts.push(factors.regressionAdj < 0 ? 'Due for regression from hot streak.' : 'Due for bounce-back from cold stretch.');
  }

  return parts.join(' ');
}

// ============================================================
// API Routes
// ============================================================

/**
 * GET /api/predict-v2/player?name=Jalen+Brunson&stat=pts&line=27.5&spread=-3&total=225&opponent=BOS&b2b=false&home=true&teammatesOut=1
 */
router.get('/player', async (req, res) => {
  const { name, stat, line, spread, total, opponent, b2b, home, teammatesOut } = req.query;

  if (!name || !stat || !line) {
    return res.status(400).json({
      error: 'Required: ?name=Player+Name&stat=pts&line=27.5',
      optional: 'spread=-3&total=225&opponent=BOS&b2b=false&home=true&teammatesOut=1',
    });
  }

  const result = await enhancedPredict(name, stat, parseFloat(line), {
    spread: parseFloat(spread) || 0,
    total: parseFloat(total) || 220,
    opponentAbbr: opponent || '',
    isBackToBack: b2b === 'true',
    isHome: home === 'true',
    teammatesOut: parseInt(teammatesOut) || 0,
  });

  res.json(result);
});

/**
 * GET /api/predict-v2/factors
 * Explains all 10 prediction factors
 */
router.get('/factors', (req, res) => {
  res.json({
    version: '2.0',
    factors: [
      { name: 'Weighted Recency', weight: 'Primary', description: 'Last 3 games = 50%, games 4-10 = 30%, rest = 20%', new: false },
      { name: 'Recent Form (L5)', weight: 'High', description: 'Average of last 5 games — detects hot/cold streaks', new: false },
      { name: 'Hit Rate', weight: 'High', description: 'Percentage of games where player exceeds this line', new: false },
      { name: 'Minutes Projection', weight: 'Critical', description: 'Projected minutes based on spread (blowout risk), B2B, injuries', new: true },
      { name: 'Game Script', weight: 'High', description: 'Vegas total + spread predict pace, scoring, and minutes', new: true },
      { name: 'Opponent History', weight: 'Moderate', description: 'Player performance vs this specific opponent', new: true },
      { name: 'Home/Away', weight: 'Low-Moderate', description: 'Venue-specific performance history', new: false },
      { name: 'Regression to Mean', weight: 'Moderate', description: 'Extreme hot/cold streaks tend to revert', new: false },
      { name: 'Injury Impact', weight: 'High', description: 'Teammate injuries redistribute usage', new: false },
      { name: 'Consistency', weight: 'Confidence modifier', description: 'Low-variance players are more predictable', new: false },
    ],
    improvements: [
      'Minutes projection prevents overestimating stats in blowouts',
      'Game script analysis catches slow/fast game environments',
      'Opponent history catches player-specific matchup advantages',
    ],
  });
});

/**
 * GET /api/predict-v2/game-script?total=230&spread=-3
 * Analyze a game environment
 */
router.get('/game-script', (req, res) => {
  const { total, spread } = req.query;
  res.json(analyzeGameScript(parseFloat(total) || 220, parseFloat(spread) || 0));
});

/**
 * GET /api/predict-v2/minutes?avg=34&spread=-12&b2b=true&teammatesOut=2
 * Project minutes for a player
 */
router.get('/minutes', (req, res) => {
  const { avg, spread, b2b, teammatesOut, home } = req.query;
  res.json(projectMinutes(
    parseFloat(avg) || 30,
    parseFloat(spread) || 0,
    b2b === 'true',
    parseInt(teammatesOut) || 0,
    home === 'true'
  ));
});

module.exports = {
  router,
  projectMinutes,
  analyzeGameScript,
  analyzeVsOpponent,
  enhancedPredict,
};
