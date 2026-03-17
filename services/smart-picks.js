/**
 * smart-picks.js — Model-Powered Top Picks Generator
 * 
 * Generates AI Top Picks using the 7-factor prediction model instead of
 * relying solely on Anthropic API calls. This means picks work even when
 * the Claude API key is expired or rate-limited.
 * 
 * Flow:
 *   1. Fetch today's props from Odds API
 *   2. For each prop, fetch player's ESPN game log via analytics engine
 *   3. Run each prop through the 7-factor prediction model
 *   4. Rank by confidence score
 *   5. Return top picks with full factor breakdown + reasoning
 * 
 * Falls back to Anthropic for enhanced reasoning when API key is available.
 * 
 * Setup:
 *   const smartPicks = require('./services/smart-picks');
 *   app.use('/api/picks', smartPicks.router);
 *   smartPicks.startRefresh();
 */

const express = require('express');
const axios = require('axios');
const router = express.Router();

const PORT = process.env.PORT || 3001;
const REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 min
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

// Cache per sport
const picksCache = {}; // { sport: { picks, lastUpdated } }

// ============================================================
// Pick Generation Engine
// ============================================================

/**
 * Generate smart picks for a sport using the prediction model
 */
async function generateSmartPicks(sport, limit = 8) {
  console.log(`[SmartPicks] Generating for ${sport}...`);

  // Step 1: Fetch today's props
  let props = [];
  try {
    const propsResp = await axios.get(`http://localhost:${PORT}/api/props/${sport}`, { timeout: 15000 });
    props = propsResp.data?.props || [];
  } catch (e) {
    console.warn(`[SmartPicks] Props fetch failed for ${sport}: ${e.message}`);
    return [];
  }

  if (props.length === 0) return [];

  // Step 2: Get unique players and fetch their analytics
  const uniquePlayers = [...new Set(props.map(p => p.player))];
  const playerAnalytics = {};
  let fetchCount = 0;

  for (const player of uniquePlayers) {
    if (fetchCount >= 20) break; // Cap to avoid timeout
    try {
      const resp = await axios.get(
        `http://localhost:${PORT}/api/analytics/player/${encodeURIComponent(player)}`,
        { timeout: 10000 }
      );
      if (resp.data?.found && resp.data?.gamesPlayed > 0) {
        playerAnalytics[player] = resp.data;
      }
      fetchCount++;
    } catch (e) {
      // Skip player if analytics unavailable
    }
  }

  console.log(`[SmartPicks] Got analytics for ${Object.keys(playerAnalytics).length}/${uniquePlayers.length} players`);

  // Step 3: Score each prop using the prediction model factors
  const scoredPicks = [];

  for (const prop of props) {
    const analytics = playerAnalytics[prop.player];
    if (!analytics || !analytics.splits || !analytics.gameLog || analytics.gameLog.length < 5) continue;

    // Determine the stat key
    const statKey = mapMarketToStat(prop.market || prop.marketLabel);
    if (!statKey) continue;

    const gameLog = analytics.gameLog;
    const splits = analytics.splits;
    const line = prop.consensusLine;

    // Run prediction model factors locally (faster than API call)
    const values = gameLog.map(g => g[statKey] || 0);
    const seasonAvg = splits.seasonAvg?.[statKey] || 0;
    if (seasonAvg === 0) continue;

    const variance = values.reduce((s, v) => s + Math.pow(v - seasonAvg, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);

    // Factor 1: Weighted recency
    let weightedSum = 0, totalWeight = 0;
    for (let i = gameLog.length - 1; i >= 0; i--) {
      const gamesAgo = gameLog.length - 1 - i;
      let weight;
      if (gamesAgo < 3) weight = 0.50 / 3;
      else if (gamesAgo < 10) weight = 0.30 / 7;
      else weight = 0.20 / Math.max(1, gameLog.length - 10);
      weightedSum += (gameLog[i][statKey] || 0) * weight;
      totalWeight += weight;
    }
    const weightedAvg = totalWeight > 0 ? +(weightedSum / totalWeight).toFixed(1) : seasonAvg;

    // Factor 2: Recent form
    const last5 = gameLog.slice(-5);
    const last5Avg = +(last5.reduce((a, g) => a + (g[statKey] || 0), 0) / last5.length).toFixed(1);

    // Factor 3: Hit rate at this line
    const overCount = values.filter(v => v > line).length;
    const hitRate = +((overCount / values.length) * 100).toFixed(1);

    // Factor 4: Home/away
    const homeGames = gameLog.filter(g => g.isHome);
    const awayGames = gameLog.filter(g => !g.isHome);
    const homeAvg = homeGames.length >= 3 ? +(homeGames.reduce((a, g) => a + (g[statKey] || 0), 0) / homeGames.length).toFixed(1) : null;
    const awayAvg = awayGames.length >= 3 ? +(awayGames.reduce((a, g) => a + (g[statKey] || 0), 0) / awayGames.length).toFixed(1) : null;

    // Factor 5: Day of week
    const today = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date().getDay()];
    const dayGames = gameLog.filter(g => g.dayOfWeek === today);
    const dayAvg = dayGames.length >= 2 ? +(dayGames.reduce((a, g) => a + (g[statKey] || 0), 0) / dayGames.length).toFixed(1) : null;

    // Factor 6: Regression
    const deviations = stdDev > 0 ? (last5Avg - seasonAvg) / stdDev : 0;
    let regressionAdj = 0;
    let regressionSignal = 'stable';
    if (deviations > 1.5) { regressionAdj = -((deviations - 1.0) * stdDev * 0.3); regressionSignal = 'regression_likely'; }
    else if (deviations < -1.5) { regressionAdj = -(deviations + 1.0) * stdDev * 0.3; regressionSignal = 'bounce_back'; }
    else if (deviations > 0.8) regressionSignal = 'hot';
    else if (deviations < -0.8) regressionSignal = 'cold';

    // Compute projection
    let projection = weightedAvg + regressionAdj;
    const diff = +(projection - line).toFixed(1);
    const pick = diff > 0 ? 'OVER' : 'UNDER';

    // Confidence scoring (0-100)
    let confidence = 50;
    const edgePct = Math.abs(diff) / Math.max(line, 1) * 100;
    confidence += Math.min(20, edgePct * 2);
    if (stdDev < 3) confidence += 10;
    else if (stdDev < 5) confidence += 5;
    else if (stdDev > 8) confidence -= 5;
    if (hitRate > 70 || hitRate < 30) confidence += 8;
    if (hitRate > 60 || hitRate < 40) confidence += 3;
    // Factor alignment
    if ((pick === 'OVER' && last5Avg > seasonAvg) || (pick === 'UNDER' && last5Avg < seasonAvg)) confidence += 5;
    if (dayAvg !== null) {
      if ((pick === 'OVER' && dayAvg > seasonAvg) || (pick === 'UNDER' && dayAvg < seasonAvg)) confidence += 3;
    }
    // Demon bonus
    if (prop.lineType === 'demon') confidence += 8;
    if (prop.hasEdge) confidence += 5;
    // Regression penalty
    if (regressionSignal === 'regression_likely' && pick === 'OVER') confidence -= 8;
    if (regressionSignal === 'bounce_back' && pick === 'UNDER') confidence -= 8;

    confidence = Math.min(95, Math.max(15, Math.round(confidence)));
    const grade = confidence >= 80 ? 'A+' : confidence >= 70 ? 'A' : confidence >= 60 ? 'B+' : confidence >= 55 ? 'B' : confidence >= 50 ? 'C+' : 'C';

    // Build reasoning
    const reasons = [];
    reasons.push(`Season avg ${seasonAvg} ${statKey.toUpperCase()}, line ${line}.`);
    if (Math.abs(diff) > 1) reasons.push(`Weighted projection ${projection.toFixed(1)} is ${Math.abs(diff)} ${pick === 'OVER' ? 'above' : 'below'} the line.`);
    if (hitRate > 65) reasons.push(`Hit OVER in ${hitRate}% of games.`);
    else if (hitRate < 35) reasons.push(`Hit UNDER in ${(100 - hitRate).toFixed(0)}% of games.`);
    if (last5Avg > seasonAvg + 2) reasons.push(`Hot streak: L5 avg ${last5Avg} vs season ${seasonAvg}.`);
    else if (last5Avg < seasonAvg - 2) reasons.push(`Cold streak: L5 avg ${last5Avg} vs season ${seasonAvg}.`);
    if (regressionSignal === 'regression_likely') reasons.push('Due for regression — tempered projection.');
    if (regressionSignal === 'bounce_back') reasons.push('Due for bounce-back from cold stretch.');
    if (dayAvg !== null && Math.abs(dayAvg - seasonAvg) > 1.5) reasons.push(`On ${today}s: avg ${dayAvg} (${dayAvg > seasonAvg ? '+' : ''}${(dayAvg - seasonAvg).toFixed(1)} vs season).`);
    if (prop.lineType === 'demon') reasons.push('Demon line — 6+ books agree on strong edge.');

    scoredPicks.push({
      // Match existing picks format
      player: prop.player,
      market: prop.marketLabel || prop.market,
      pick,
      line,
      bestBook: prop.bestOver?.book || prop.bestUnder?.book || prop.books?.[0]?.name || 'Multiple',
      bestOdds: pick === 'OVER' ? (prop.bestOver?.odds || '') : (prop.bestUnder?.odds || ''),
      confidence,
      grade,
      reasoning: reasons.join(' '),

      // Enhanced data (beyond what old picks had)
      projection: +projection.toFixed(1),
      diff,
      seasonAvg,
      weightedAvg,
      last5Avg,
      hitRate,
      stdDev: +stdDev.toFixed(1),
      homeAvg,
      awayAvg,
      dayAvg,
      dayOfWeek: today,
      regressionSignal,
      lineType: prop.lineType,
      hasEdge: prop.hasEdge,
      bookCount: prop.bookCount,
      game: prop.game,
      commenceTime: prop.commenceTime,

      // Game log for mini chart
      gameLogBars: gameLog.slice(-10).map(g => ({
        value: g[statKey] || 0,
        date: g.date,
        opponent: g.opponent,
        isHome: g.isHome,
      })),
    });
  }

  // Sort by confidence (highest first)
  scoredPicks.sort((a, b) => b.confidence - a.confidence);

  // Return top picks
  return scoredPicks.slice(0, limit);
}

/**
 * Map market names to stat keys
 */
function mapMarketToStat(market) {
  if (!market) return null;
  const m = market.toLowerCase();
  if (m.includes('point') || m.includes('pts')) return 'pts';
  if (m.includes('rebound') || m.includes('reb')) return 'reb';
  if (m.includes('assist') || m.includes('ast')) return 'ast';
  if (m.includes('3pt') || m.includes('three') || m.includes('3-pointer') || m.includes('fg3')) return 'fg3';
  if (m.includes('steal')) return 'stl';
  if (m.includes('block')) return 'blk';
  return null;
}

/**
 * Try to enhance reasoning with Anthropic (optional — works without it)
 */
async function enhanceWithAI(pick) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return pick;

  try {
    const resp = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 150,
        messages: [{
          role: 'user',
          content: `In 1-2 sentences, explain this sports prop pick for a bettor. Player: ${pick.player}, ${pick.market}: ${pick.pick} ${pick.line}. Season avg: ${pick.seasonAvg}, Last 5 avg: ${pick.last5Avg}, Hit rate: ${pick.hitRate}%, Projection: ${pick.projection}. ${pick.regressionSignal !== 'stable' ? 'Regression signal: ' + pick.regressionSignal : ''}`
        }],
      },
      {
        headers: {
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        timeout: 10000,
      }
    );

    const aiReasoning = resp.data?.content?.[0]?.text;
    if (aiReasoning) {
      pick.reasoning = aiReasoning;
      pick.aiEnhanced = true;
    }
  } catch (e) {
    // AI enhancement is optional — model-based reasoning is fine
    pick.aiEnhanced = false;
  }

  return pick;
}

// ============================================================
// Refresh Loop
// ============================================================

async function refreshPicks() {
  const sports = ['nba', 'nhl', 'mlb'];

  for (const sport of sports) {
    try {
      const picks = await generateSmartPicks(sport, 8);

      // Try AI enhancement on top 3 picks only (save API calls)
      for (let i = 0; i < Math.min(3, picks.length); i++) {
        picks[i] = await enhanceWithAI(picks[i]);
      }

      picksCache[sport] = {
        picks,
        lastUpdated: new Date().toISOString(),
        sport,
      };

      console.log(`[SmartPicks] ${sport}: ${picks.length} picks generated (top conf: ${picks[0]?.confidence || 0}%)`);
    } catch (err) {
      console.error(`[SmartPicks] ${sport} generation failed:`, err.message);
    }
  }
}

function startRefresh() {
  console.log('[SmartPicks] Starting pick generation (every 15 min)');

  // Initial generation after 30 seconds (let other services warm up)
  setTimeout(() => {
    refreshPicks().catch(e => console.error('[SmartPicks] Initial generation failed:', e.message));
  }, 30000);

  // Recurring refresh
  setInterval(() => {
    refreshPicks().catch(e => console.error('[SmartPicks] Refresh failed:', e.message));
  }, REFRESH_INTERVAL_MS);
}

// ============================================================
// API Routes
// ============================================================

/**
 * GET /api/picks/:sport
 * Returns model-powered top picks for a sport
 * This endpoint can REPLACE /api/props/:sport/picks
 */
router.get('/:sport', async (req, res) => {
  const { sport } = req.params;
  const cached = picksCache[sport];

  // Return cached if fresh
  if (cached && Date.now() - new Date(cached.lastUpdated).getTime() < CACHE_TTL_MS) {
    return res.json({
      available: true,
      picks: cached.picks,
      summary: `${cached.picks.length} model-powered picks`,
      sport,
      lastUpdated: cached.lastUpdated,
      model: 'prediction-model-v1.1',
    });
  }

  // Generate on-demand if not cached
  try {
    const picks = await generateSmartPicks(sport, 8);
    picksCache[sport] = { picks, lastUpdated: new Date().toISOString(), sport };

    res.json({
      available: picks.length > 0,
      picks,
      summary: picks.length > 0 ? `${picks.length} model-powered picks` : 'No picks available — waiting for data',
      sport,
      lastUpdated: new Date().toISOString(),
      model: 'prediction-model-v1.1',
    });
  } catch (err) {
    res.json({
      available: false,
      message: err.message,
      picks: [],
      sport,
    });
  }
});

/**
 * GET /api/picks/:sport/top
 * Returns only the highest confidence picks (70%+)
 */
router.get('/:sport/top', (req, res) => {
  const cached = picksCache[req.params.sport];
  if (!cached) return res.json({ picks: [] });

  const topPicks = cached.picks.filter(p => p.confidence >= 70);
  res.json({ picks: topPicks, count: topPicks.length, sport: req.params.sport });
});

module.exports = { router, startRefresh, generateSmartPicks, picksCache };
