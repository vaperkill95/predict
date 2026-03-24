/**
 * trending-picks.js — Trending / Most Popular Picks Service
 * 
 * Aggregates signals from multiple sources to create a "trending" score for each prop:
 *   - Demon/Goblin detection (lineType)
 *   - Book consensus (bookCount + lineSpread)
 *   - Line movement direction & magnitude
 *   - AI pick confidence
 *   - Edge detection
 * 
 * No user system needed — trending is computed from data signals.
 * 
 * Setup:
 *   const trending = require('./services/trending-picks');
 *   app.use('/api/trending', trending.router);
 *   
 *   // Start the refresh cron (computes trending every 10 min)
 *   trending.startRefresh(fetchPropsFunc, fetchPicksFunc, getMovementData);
 */

const express = require('express');
const router = express.Router();

// ============================================================
// Trending cache
// ============================================================

let trendingCache = {};  // { sport: { picks: [], lastUpdated } }
let refreshCount = 0;
const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Compute a trending score for a prop based on multiple signals
 * Score range: 0-100
 */
function computeTrendingScore(prop, movement, aiPick) {
  let score = 0;
  const signals = [];

  // 1. DEMON detection (+30 — strongest signal)
  if (prop.lineType === 'demon') {
    score += 30;
    signals.push({ type: 'demon', label: 'Demon Line', weight: 30 });
  }
  // Goblin is a warning, slight negative
  if (prop.lineType === 'goblin') {
    score -= 5;
    signals.push({ type: 'goblin', label: 'Goblin Warning', weight: -5 });
  }

  // 2. Book consensus (+0-20 — more books agreeing = more trending)
  const bookScore = Math.min(20, (prop.bookCount || 0) * 4);
  if (bookScore > 0) {
    score += bookScore;
    signals.push({ type: 'books', label: `${prop.bookCount} books`, weight: bookScore });
  }

  // 3. Tight line spread = books agree (+0-15)
  if (prop.lineSpread !== undefined && prop.lineSpread !== null) {
    const spreadScore = Math.max(0, 15 - prop.lineSpread * 3);
    if (spreadScore > 5) {
      score += spreadScore;
      signals.push({ type: 'spread', label: `${prop.lineSpread}pt spread`, weight: Math.round(spreadScore) });
    }
  }

  // 4. Edge detection (+10)
  if (prop.hasEdge) {
    score += 10;
    signals.push({ type: 'edge', label: 'Edge Detected', weight: 10 });
  }

  // 5. Line movement (+0-15 — lines moving = sharp action)
  if (movement && Math.abs(movement.movement) >= 0.5) {
    const moveScore = Math.min(15, Math.abs(movement.movement) * 5);
    score += moveScore;
    signals.push({
      type: 'movement',
      label: `Line ${movement.direction === 'UP' ? '▲' : '▼'} ${Math.abs(movement.movement).toFixed(1)}`,
      weight: Math.round(moveScore),
      direction: movement.direction,
    });
  }

  // 6. AI confidence (+0-20)
  if (aiPick && aiPick.confidence) {
    const confScore = Math.min(20, Math.round((aiPick.confidence - 50) / 2.5));
    if (confScore > 0) {
      score += confScore;
      signals.push({
        type: 'ai',
        label: `AI ${aiPick.pick} ${aiPick.confidence}%`,
        weight: confScore,
        pick: aiPick.pick,
        confidence: aiPick.confidence,
      });
    }
  }

  return { score: Math.max(0, Math.min(100, score)), signals };
}

/**
 * Build the trending picks list for a sport
 */
async function buildTrending(sport, fetchProps, fetchPicks, getMovement) {
  try {
    // Fetch all data sources
    const [propsData, picksData, movementData] = await Promise.all([
      fetchProps(sport).catch(() => ({ props: [] })),
      fetchPicks(sport).catch(() => ({ picks: [] })),
      getMovement(sport).catch(() => ({ props: [] })),
    ]);

    const props = Array.isArray(propsData.props) ? propsData.props : (Array.isArray(propsData) ? propsData : []);
    const picks = Array.isArray(picksData.picks) ? picksData.picks : (Array.isArray(picksData) ? picksData : []);
    const movements = Array.isArray(movementData.props) ? movementData.props : [];

    // Index picks and movement by player+market for fast lookup
    const pickMap = {};
    for (const pick of picks) {
      const key = `${pick.player}|${pick.market}`.toLowerCase();
      pickMap[key] = pick;
    }

    const moveMap = {};
    for (const move of movements) {
      const key = `${move.player}|${move.market}`.toLowerCase();
      moveMap[key] = move;
    }

    // Score each prop
    const scored = [];
    for (const prop of props) {
      const key = `${prop.player}|${prop.market}`.toLowerCase();
      const movement = moveMap[key];
      const aiPick = pickMap[key];

      const { score, signals } = computeTrendingScore(prop, movement, aiPick);

      // Only include props with meaningful scores
      if (score >= 15) {
        scored.push({
          player: prop.player,
          market: prop.market,
          marketLabel: prop.marketLabel,
          game: prop.game,
          gameId: prop.gameId,
          commenceTime: prop.commenceTime,
          consensusLine: prop.consensusLine,
          bookCount: prop.bookCount,
          lineSpread: prop.lineSpread,
          lineType: prop.lineType,
          hasEdge: prop.hasEdge,
          bestOver: prop.bestOver,
          bestUnder: prop.bestUnder,
          books: prop.books,

          // Trending data
          trendingScore: score,
          signals,

          // Movement data (if any)
          movement: movement ? {
            direction: movement.direction,
            amount: movement.movement,
            sparkline: movement.sparkline,
            openLine: movement.openLine,
            currentLine: movement.currentLine,
          } : null,

          // AI pick data (if any)
          aiPick: aiPick ? {
            pick: aiPick.pick,
            confidence: aiPick.confidence,
            reasoning: aiPick.reasoning,
          } : null,
        });
      }
    }

    // Sort by trending score (highest first)
    scored.sort((a, b) => b.trendingScore - a.trendingScore);

    return {
      sport,
      count: scored.length,
      lastUpdated: new Date().toISOString(),
      picks: scored,
    };
  } catch (err) {
    console.error(`Trending build failed for ${sport}:`, err.message);
    return { sport, count: 0, picks: [], error: err.message };
  }
}

/**
 * Refresh trending for all sports
 */
async function refreshAll(fetchProps, fetchPicks, getMovement) {
  const sports = ['nba', 'nfl', 'mlb', 'nhl', 'epl'];

  for (const sport of sports) {
    trendingCache[sport] = await buildTrending(sport, fetchProps, fetchPicks, getMovement);
  }

  refreshCount++;
  console.log(`Trending refreshed (#${refreshCount}): ${sports.map(s => `${s}:${trendingCache[s]?.count || 0}`).join(', ')}`);
}

/**
 * Start the auto-refresh cron
 */
function startRefresh(fetchProps, fetchPicks, getMovement) {
  console.log('Trending picks refresh started (every 10 min)');

  // Initial build
  refreshAll(fetchProps, fetchPicks, getMovement).catch(err =>
    console.error('Initial trending build failed:', err.message)
  );

  // Recurring refresh
  setInterval(() => {
    refreshAll(fetchProps, fetchPicks, getMovement).catch(err =>
      console.error('Trending refresh failed:', err.message)
    );
  }, REFRESH_INTERVAL_MS);
}

// ============================================================
// API Routes
// ============================================================

/**
 * GET /api/trending/:sport
 * Returns trending picks for a sport, sorted by score
 * Query: ?limit=20&minScore=30
 */
router.get('/:sport', (req, res) => {
  const { sport } = req.params;
  const limit = parseInt(req.query.limit) || 25;
  const minScore = parseInt(req.query.minScore) || 0;

  const cached = trendingCache[sport];
  if (!cached) {
    return res.json({ sport, count: 0, picks: [], message: 'No trending data yet — refreshes every 10 min' });
  }

  const filtered = cached.picks.filter(p => p.trendingScore >= minScore).slice(0, limit);

  res.json({
    sport,
    count: filtered.length,
    totalTracked: cached.count,
    lastUpdated: cached.lastUpdated,
    picks: filtered,
  });
});

/**
 * GET /api/trending/all/top
 * Returns top trending picks across ALL sports
 */
router.get('/all/top', (req, res) => {
  const limit = parseInt(req.query.limit) || 15;

  const allPicks = [];
  for (const [sport, data] of Object.entries(trendingCache)) {
    for (const pick of (data.picks || [])) {
      allPicks.push({ ...pick, sport });
    }
  }

  allPicks.sort((a, b) => b.trendingScore - a.trendingScore);

  res.json({
    count: Math.min(allPicks.length, limit),
    totalAcrossSports: allPicks.length,
    lastUpdated: new Date().toISOString(),
    picks: allPicks.slice(0, limit),
  });
});

/**
 * GET /api/trending/status
 * Returns refresh status
 */
router.get('/status/info', (req, res) => {
  const sportCounts = {};
  for (const [sport, data] of Object.entries(trendingCache)) {
    sportCounts[sport] = data.count;
  }
  res.json({
    refreshCount,
    sportCounts,
    intervalMinutes: REFRESH_INTERVAL_MS / 60000,
  });
});

module.exports = { router, startRefresh, buildTrending, trendingCache };
