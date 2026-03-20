/**
 * auto-grader.js — Auto-Grade Picks Against Final Box Scores
 * 
 * After games finish, scrapes final stats from ESPN and compares
 * to the picks that were made. Tracks hit rate over time.
 * 
 * Flow:
 *   1. Every 30 min, check for recently finished games
 *   2. For each finished game, fetch final player stats from ESPN box score
 *   3. Compare each pick's line to actual stat → HIT or MISS
 *   4. Store graded picks in memory (with optional JSON file persistence)
 *   5. Expose hit rate stats via API
 * 
 * Setup:
 *   const autoGrader = require('./services/auto-grader');
 *   app.use('/api/grades', autoGrader.router);
 *   autoGrader.startGrading();
 */

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const PORT = process.env.PORT || 3001;
const GRADE_INTERVAL_MS = 30 * 60 * 1000; // 30 min
const GRADES_FILE = path.join(__dirname, '..', 'data', 'graded-picks.json');

// Graded picks storage
let gradedPicks = []; // [{ date, player, market, line, pick, actual, hit, confidence, grade, game, sport }]
let gradingStats = { total: 0, hits: 0, misses: 0, pending: 0, lastGraded: null };

// Load persisted grades on startup
function loadGrades() {
  try {
    if (fs.existsSync(GRADES_FILE)) {
      const data = JSON.parse(fs.readFileSync(GRADES_FILE, 'utf8'));
      gradedPicks = data.picks || [];
      gradingStats = data.stats || gradingStats;
      console.log(`[AutoGrader] Loaded ${gradedPicks.length} graded picks from disk`);
    }
  } catch (e) {
    console.warn('[AutoGrader] Could not load grades file:', e.message);
  }
}

function saveGrades() {
  try {
    const dir = path.dirname(GRADES_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(GRADES_FILE, JSON.stringify({ picks: gradedPicks.slice(-500), stats: gradingStats }, null, 2));
  } catch (e) {
    console.warn('[AutoGrader] Could not save grades:', e.message);
  }
}

// ============================================================
// ESPN Box Score Fetcher
// ============================================================

/**
 * Fetch final box score stats for a finished game
 * Returns: { players: { "Player Name": { pts, reb, ast, fg3, stl, blk, ... } } }
 */
async function fetchBoxScore(eventId) {
  try {
    const resp = await axios.get(
      `https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${eventId}`,
      { timeout: 12000 }
    );

    const data = resp.data;
    const players = {};

    // Parse box score from both teams
    for (const team of (data.boxscore?.teams || [])) {
      for (const statGroup of (team.statistics || [])) {
        if (statGroup.name !== 'starters' && statGroup.name !== 'bench') continue;

        for (const athlete of (statGroup.athletes || [])) {
          const name = athlete.athlete?.displayName;
          if (!name) continue;

          const stats = {};
          for (const stat of (athlete.stats || [])) {
            // ESPN returns stats as an array of strings in order
            // We need to map them using the labels
          }

          // ESPN box score athletes have stats as array matching team.statistics[0].labels
          const labels = statGroup.labels || [];
          const values = athlete.stats || [];

          for (let i = 0; i < labels.length && i < values.length; i++) {
            const label = labels[i];
            const val = values[i];

            if (label === 'MIN') stats.minutes = parseInt(val) || 0;
            else if (label === 'PTS') stats.pts = parseInt(val) || 0;
            else if (label === 'REB') stats.reb = parseInt(val) || 0;
            else if (label === 'AST') stats.ast = parseInt(val) || 0;
            else if (label === 'STL') stats.stl = parseInt(val) || 0;
            else if (label === 'BLK') stats.blk = parseInt(val) || 0;
            else if (label === 'TO') stats.tov = parseInt(val) || 0;
            else if (label === '3PM') stats.fg3 = parseInt(val) || 0;
            else if (label === 'FG') {
              // "9-20" format
              const parts = val.split('-');
              stats.fg = parseInt(parts[0]) || 0;
              stats.fga = parseInt(parts[1]) || 0;
            }
            else if (label === '3PT') {
              const parts = val.split('-');
              stats.fg3 = parseInt(parts[0]) || 0;
            }
          }

          players[name] = stats;
        }
      }
    }

    return { players, gameStatus: data.header?.competitions?.[0]?.status?.type?.name || 'unknown' };
  } catch (err) {
    console.warn(`[AutoGrader] Box score fetch failed for event ${eventId}:`, err.message);
    return { players: {}, gameStatus: 'error' };
  }
}

/**
 * Fetch today's finished NBA games from ESPN
 */
async function fetchFinishedGames() {
  try {
    const resp = await axios.get(
      'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',
      { timeout: 10000 }
    );

    const finished = [];
    for (const event of (resp.data?.events || [])) {
      const status = event.status?.type?.name;
      if (status === 'STATUS_FINAL') {
        finished.push({
          id: event.id,
          name: event.name,
          date: event.date,
          homeTeam: event.competitions?.[0]?.competitors?.find(c => c.homeAway === 'home')?.team?.abbreviation,
          awayTeam: event.competitions?.[0]?.competitors?.find(c => c.homeAway === 'away')?.team?.abbreviation,
        });
      }
    }

    return finished;
  } catch (err) {
    console.warn('[AutoGrader] Finished games fetch failed:', err.message);
    return [];
  }
}

// ============================================================
// Grading Engine
// ============================================================

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

/**
 * Grade all pending picks against finished games
 */
async function gradePicksRound() {
  console.log('[AutoGrader] Starting grading round...');

  // Get today's smart picks — use direct cache access to avoid rate limiting
  let picks = [];
  try {
    // Try direct cache access first (no HTTP needed)
    try {
      var smartPicks = require('./smart-picks');
      if (smartPicks && smartPicks.picksCache) {
        var cached = smartPicks.picksCache['nba'];
        if (cached && cached.picks && cached.picks.length > 0) {
          picks = cached.picks;
          console.log('[AutoGrader] Got ' + picks.length + ' picks from cache');
        }
      }
    } catch(e) {}

    // Also check parlay builder history for ungraded picks
    try {
      var parlayBuilder = require('./parlay-builder');
      if (parlayBuilder && parlayBuilder.getPickHistory) {
        var history = parlayBuilder.getPickHistory();
        var ungraded = (history || []).filter(function(p) { return !p.result || p.result === 'pending'; });
        if (ungraded.length > 0 && picks.length === 0) {
          picks = ungraded;
          console.log('[AutoGrader] Got ' + picks.length + ' ungraded picks from history');
        }
      }
    } catch(e) {}

    // Fallback to HTTP if no cache
    if (picks.length === 0) {
      var resp = await axios.get('http://localhost:' + PORT + '/api/picks/nba', { timeout: 15000 });
      picks = resp.data && resp.data.picks ? resp.data.picks : [];
    }
  } catch (e) {
    console.warn('[AutoGrader] Could not fetch picks:', e.message);
    return;
  }

  if (picks.length === 0) return;

  // Get finished games
  const finishedGames = await fetchFinishedGames();
  if (finishedGames.length === 0) {
    console.log('[AutoGrader] No finished games yet');
    return;
  }

  let newGrades = 0;

  for (const game of finishedGames) {
    // Find picks for this game
    const gamePicks = picks.filter(p => {
      const gameStr = (p.game || '').toLowerCase();
      return gameStr.includes((game.homeTeam || '').toLowerCase()) ||
             gameStr.includes((game.awayTeam || '').toLowerCase());
    });

    if (gamePicks.length === 0) continue;

    // Fetch box score
    const { players, gameStatus } = await fetchBoxScore(game.id);
    if (Object.keys(players).length === 0) continue;

    for (const pick of gamePicks) {
      // Check if already graded
      const alreadyGraded = gradedPicks.some(g =>
        g.player === pick.player && g.market === pick.market &&
        g.line === pick.line && g.date === new Date().toISOString().split('T')[0]
      );
      if (alreadyGraded) continue;

      // Find player in box score
      const playerStats = players[pick.player];
      if (!playerStats) continue;

      const statKey = mapMarketToStat(pick.market);
      if (!statKey) continue;

      const actual = playerStats[statKey];
      if (actual === undefined) continue;

      // Grade: did the pick hit?
      const hit = pick.pick === 'OVER' ? actual > pick.line : actual < pick.line;
      const push = actual === pick.line;

      const graded = {
        date: new Date().toISOString().split('T')[0],
        timestamp: new Date().toISOString(),
        player: pick.player,
        market: pick.market,
        line: pick.line,
        pick: pick.pick,
        actual,
        hit: push ? 'push' : hit,
        confidence: pick.confidence,
        grade: pick.grade,
        projection: pick.projection,
        game: pick.game || game.name,
        sport: 'nba',
      };

      gradedPicks.push(graded);
      newGrades++;

      if (hit && !push) gradingStats.hits++;
      else if (!push) gradingStats.misses++;
      gradingStats.total++;

      // Also update parlay-builder history with the grading result
      try {
        var parlayBuilder = require('./parlay-builder');
        if (parlayBuilder && parlayBuilder.gradePick) {
          parlayBuilder.gradePick(pick.player, pick.market, pick.line, push ? 'push' : (hit ? 'hit' : 'miss'), actual);
        }
      } catch(e) {}
    }

    // Rate limit between box score fetches
    await new Promise(r => setTimeout(r, 500));
  }

  gradingStats.lastGraded = new Date().toISOString();
  gradingStats.pending = picks.length - newGrades;

  if (newGrades > 0) {
    console.log(`[AutoGrader] Graded ${newGrades} picks. Hit rate: ${gradingStats.total > 0 ? ((gradingStats.hits / gradingStats.total) * 100).toFixed(1) : 0}%`);
    saveGrades();
  } else {
    console.log('[AutoGrader] No new picks to grade');
  }
}

function startGrading() {
  console.log('[AutoGrader] Starting auto-grading (every 30 min)');
  loadGrades();

  // Initial grade after 2 minutes
  setTimeout(() => {
    gradePicksRound().catch(e => console.warn('[AutoGrader] Grading failed:', e.message));
  }, 2 * 60 * 1000);

  // Recurring
  setInterval(() => {
    gradePicksRound().catch(e => console.warn('[AutoGrader] Grading failed:', e.message));
  }, GRADE_INTERVAL_MS);
}

// ============================================================
// API Routes
// ============================================================

/**
 * GET /api/grades/stats
 * Returns overall hit rate and grading statistics
 */
router.get('/stats', (req, res) => {
  const hitRate = gradingStats.total > 0 ? +((gradingStats.hits / gradingStats.total) * 100).toFixed(1) : 0;

  // Breakdown by confidence tier
  const byConfidence = {};
  for (const tier of ['90+', '80-89', '70-79', '60-69', '50-59', 'below50']) {
    const range = tier === '90+' ? [90, 100] : tier === 'below50' ? [0, 49] :
      tier.split('-').map(Number);
    const tierPicks = gradedPicks.filter(p => {
      if (tier === '90+') return p.confidence >= 90;
      if (tier === 'below50') return p.confidence < 50;
      return p.confidence >= range[0] && p.confidence <= range[1];
    });
    const tierHits = tierPicks.filter(p => p.hit === true).length;
    byConfidence[tier] = {
      total: tierPicks.length,
      hits: tierHits,
      hitRate: tierPicks.length > 0 ? +((tierHits / tierPicks.length) * 100).toFixed(1) : 0,
    };
  }

  // Breakdown by stat type
  const byMarket = {};
  for (const market of ['Points', 'Rebounds', 'Assists', '3PT']) {
    const marketPicks = gradedPicks.filter(p => (p.market || '').toLowerCase().includes(market.toLowerCase()));
    const marketHits = marketPicks.filter(p => p.hit === true).length;
    byMarket[market] = {
      total: marketPicks.length,
      hits: marketHits,
      hitRate: marketPicks.length > 0 ? +((marketHits / marketPicks.length) * 100).toFixed(1) : 0,
    };
  }

  // Breakdown by pick direction
  const overs = gradedPicks.filter(p => p.pick === 'OVER');
  const unders = gradedPicks.filter(p => p.pick === 'UNDER');

  res.json({
    overall: {
      total: gradingStats.total,
      hits: gradingStats.hits,
      misses: gradingStats.misses,
      hitRate,
      pending: gradingStats.pending,
      lastGraded: gradingStats.lastGraded,
    },
    byConfidence,
    byMarket,
    byDirection: {
      OVER: { total: overs.length, hits: overs.filter(p => p.hit === true).length, hitRate: overs.length > 0 ? +((overs.filter(p => p.hit === true).length / overs.length) * 100).toFixed(1) : 0 },
      UNDER: { total: unders.length, hits: unders.filter(p => p.hit === true).length, hitRate: unders.length > 0 ? +((unders.filter(p => p.hit === true).length / unders.length) * 100).toFixed(1) : 0 },
    },
  });
});

/**
 * GET /api/grades/recent
 * Returns recent graded picks
 */
router.get('/recent', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const recent = gradedPicks.slice(-limit).reverse();
  res.json({ picks: recent, total: gradedPicks.length });
});

/**
 * GET /api/grades/today
 * Returns today's graded picks
 */
router.get('/today', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const todayPicks = gradedPicks.filter(p => p.date === today);
  const hits = todayPicks.filter(p => p.hit === true).length;
  res.json({
    date: today,
    picks: todayPicks,
    total: todayPicks.length,
    hits,
    hitRate: todayPicks.length > 0 ? +((hits / todayPicks.length) * 100).toFixed(1) : 0,
  });
});

module.exports = { router, startGrading, gradePicksRound, gradedPicks, gradingStats };
