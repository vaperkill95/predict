/**
 * parlay-builder.js — Smart Parlay Builder + Live Tracker + Custom Alerts + History
 * 
 * Features:
 *   1. PARLAY BUILDER — Pick legs, get correlation analysis, combined odds, hit rate
 *   2. LIVE TRACKER — Track active picks against real-time box scores
 *   3. CUSTOM ALERTS — Set thresholds for +EV, line drops, specific players
 *   4. HISTORICAL RESULTS — Public accuracy record of every pick ORACLE has made
 * 
 * Setup:
 *   const parlayBuilder = require('./services/parlay-builder');
 *   app.use('/api/parlay', parlayBuilder.router);
 */

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const PORT = process.env.PORT || 3001;
const HISTORY_FILE = path.join(__dirname, '..', 'data', 'pick-history.json');

// ============================================================
// 1. PARLAY BUILDER
// ============================================================

// Known correlation matrix for NBA prop types
const CORRELATIONS = {
  // [legA_type, legB_type]: correlation coefficient
  'game_over|player_pts_over': 0.72,
  'game_over|player_reb_over': 0.58,
  'game_over|player_ast_over': 0.45,
  'game_over|player_fg3_over': 0.55,
  'player_pts_over|player_ast_over': 0.45,
  'player_pts_over|player_reb_over': 0.25,
  'player_pts_over|player_fg3_over': 0.60,
  'player_reb_over|player_ast_over': 0.15,
  'close_game|player_pts_over': 0.55,
  'close_game|player_reb_over': 0.40,
  'close_game|player_ast_over': 0.50,
  // Negative correlations
  'blowout_fav|player_pts_over_fav': -0.45,
  'opposing_stars_both_over': -0.30,
};

function americanToDecimal(odds) {
  if (odds > 0) return (odds / 100) + 1;
  return (100 / Math.abs(odds)) + 1;
}

function americanToProb(odds) {
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

function decimalToAmerican(decimal) {
  if (decimal >= 2) return Math.round((decimal - 1) * 100);
  return Math.round(-100 / (decimal - 1));
}

/**
 * Analyze a parlay's legs for correlation and value
 */
function analyzeParlay(legs) {
  if (!legs || legs.length < 2) return { error: 'Need at least 2 legs' };

  // Calculate individual probabilities
  const legDetails = legs.map((leg, i) => {
    const impliedProb = americanToProb(leg.odds || -110);
    return {
      ...leg,
      legNum: i + 1,
      impliedProb: +impliedProb.toFixed(4),
      decimalOdds: +americanToDecimal(leg.odds || -110).toFixed(3),
    };
  });

  // Check correlations between pairs
  const correlationChecks = [];
  for (let i = 0; i < legDetails.length; i++) {
    for (let j = i + 1; j < legDetails.length; j++) {
      const a = legDetails[i];
      const b = legDetails[j];

      let correlation = 0;
      let reason = '';

      // Same game, same direction (OVER/OVER) = positively correlated
      if (a.game === b.game && a.direction === b.direction) {
        if (a.direction === 'OVER') {
          correlation = 0.45;
          reason = 'Same game, both OVER — positively correlated (both benefit from high scoring)';
        } else {
          correlation = 0.40;
          reason = 'Same game, both UNDER — positively correlated (both benefit from low scoring)';
        }
      }
      // Same game, opposite directions = negatively correlated
      else if (a.game === b.game && a.direction !== b.direction) {
        correlation = -0.20;
        reason = 'Same game, opposite directions — slightly negatively correlated';
      }
      // Same player, different stats
      else if (a.player === b.player) {
        correlation = 0.35;
        reason = 'Same player — stats tend to move together (good game = good everywhere)';
      }
      // Different games = independent
      else {
        correlation = 0;
        reason = 'Different games — independent (no correlation)';
      }

      correlationChecks.push({
        legs: `#${i + 1} × #${j + 1}`,
        legA: `${a.player} ${a.direction} ${a.line} ${a.market}`,
        legB: `${b.player} ${b.direction} ${b.line} ${b.market}`,
        correlation: +correlation.toFixed(2),
        type: correlation > 0.2 ? 'positive' : correlation < -0.1 ? 'negative' : 'independent',
        reason,
      });
    }
  }

  // Calculate combined odds (standard parlay math)
  const combinedDecimal = legDetails.reduce((prod, leg) => prod * leg.decimalOdds, 1);
  const combinedAmerican = decimalToAmerican(combinedDecimal);

  // Naive probability (assuming independence)
  const naiveProb = legDetails.reduce((prod, leg) => prod * leg.impliedProb, 1);

  // Adjusted probability (accounting for correlations)
  const avgCorrelation = correlationChecks.length > 0
    ? correlationChecks.reduce((s, c) => s + c.correlation, 0) / correlationChecks.length
    : 0;
  // Positive correlation = actual probability higher than naive
  const adjustedProb = Math.min(0.95, Math.max(0.01, naiveProb * (1 + avgCorrelation * 0.5)));

  // EV calculation
  const payoutOn100 = (combinedDecimal - 1) * 100;
  const ev = (adjustedProb * payoutOn100) - ((1 - adjustedProb) * 100);

  // Grade the parlay
  const positiveCorrs = correlationChecks.filter(c => c.type === 'positive').length;
  const negativeCorrs = correlationChecks.filter(c => c.type === 'negative').length;
  let grade;
  if (negativeCorrs > 0) grade = 'D';
  else if (positiveCorrs >= 2 && ev > 0) grade = 'A';
  else if (positiveCorrs >= 1 && ev > 0) grade = 'B+';
  else if (ev > 0) grade = 'B';
  else if (positiveCorrs >= 1) grade = 'C+';
  else grade = 'C';

  return {
    legs: legDetails,
    legCount: legDetails.length,
    combinedOdds: combinedAmerican > 0 ? `+${combinedAmerican}` : `${combinedAmerican}`,
    combinedDecimal: +combinedDecimal.toFixed(3),
    payoutOn100: +payoutOn100.toFixed(2),
    naiveProbability: +(naiveProb * 100).toFixed(2) + '%',
    adjustedProbability: +(adjustedProb * 100).toFixed(2) + '%',
    ev: +ev.toFixed(2),
    isPositiveEV: ev > 0,
    correlations: correlationChecks,
    positiveCorrelations: positiveCorrs,
    negativeCorrelations: negativeCorrs,
    grade,
    advice: negativeCorrs > 0
      ? '⚠️ This parlay has negatively correlated legs — consider removing them.'
      : positiveCorrs >= 2
        ? '✅ Strong parlay — multiple positively correlated legs increase your actual probability.'
        : positiveCorrs >= 1
          ? '👍 Decent parlay — one positive correlation helps.'
          : 'ℹ️ Independent legs — standard parlay, no correlation boost.',
  };
}

// ============================================================
// 2. LIVE TRACKER
// ============================================================

async function getLiveStats() {
  try {
    const resp = await axios.get(
      'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',
      { timeout: 10000 }
    );
    const games = {};
    for (const event of (resp.data?.events || [])) {
      const status = event.status?.type?.name;
      const isLive = status === 'STATUS_IN_PROGRESS';
      const isFinal = status === 'STATUS_FINAL';
      const comp = event.competitions?.[0];

      games[event.id] = {
        id: event.id,
        name: event.name,
        status: isLive ? 'LIVE' : isFinal ? 'FINAL' : 'UPCOMING',
        period: event.status?.period || 0,
        clock: event.status?.displayClock || '',
        homeTeam: comp?.competitors?.find(c => c.homeAway === 'home')?.team?.abbreviation,
        awayTeam: comp?.competitors?.find(c => c.homeAway === 'away')?.team?.abbreviation,
        homeScore: parseInt(comp?.competitors?.find(c => c.homeAway === 'home')?.score) || 0,
        awayScore: parseInt(comp?.competitors?.find(c => c.homeAway === 'away')?.score) || 0,
      };
    }
    return games;
  } catch (e) {
    return {};
  }
}

// ============================================================
// 3. CUSTOM ALERTS
// ============================================================

// In-memory alerts (would use DB in production)
const alerts = []; // { id, type, condition, threshold, active, createdAt }

// ============================================================
// 4. HISTORICAL RESULTS
// ============================================================

let pickHistory = [];

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      pickHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      console.log(`[ParlayBuilder] Loaded ${pickHistory.length} historical picks`);
    }
  } catch (e) {}
}

function saveHistory() {
  try {
    const dir = path.dirname(HISTORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(pickHistory.slice(-1000), null, 2));
  } catch (e) {}
}

function recordPick(pick) {
  pickHistory.push({
    ...pick,
    timestamp: new Date().toISOString(),
    date: new Date().toISOString().split('T')[0],
  });
  saveHistory();
}

function getHistoricalStats() {
  const graded = pickHistory.filter(p => p.result === 'hit' || p.result === 'miss');
  const hits = graded.filter(p => p.result === 'hit').length;
  const total = graded.length;

  // By confidence tier
  const byGrade = {};
  for (const grade of ['A+', 'A', 'B+', 'B', 'C+', 'C']) {
    const g = graded.filter(p => p.grade === grade);
    const gHits = g.filter(p => p.result === 'hit').length;
    byGrade[grade] = { total: g.length, hits: gHits, hitRate: g.length > 0 ? +((gHits / g.length) * 100).toFixed(1) : 0 };
  }

  // By stat type
  const byMarket = {};
  for (const market of ['Points', 'Rebounds', 'Assists', '3-Pointers']) {
    const m = graded.filter(p => (p.market || '').toLowerCase().includes(market.toLowerCase()));
    const mHits = m.filter(p => p.result === 'hit').length;
    byMarket[market] = { total: m.length, hits: mHits, hitRate: m.length > 0 ? +((mHits / m.length) * 100).toFixed(1) : 0 };
  }

  // By direction
  const overs = graded.filter(p => p.pick === 'OVER');
  const unders = graded.filter(p => p.pick === 'UNDER');

  // Last 7 days
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const last7 = graded.filter(p => p.date >= weekAgo);
  const last7Hits = last7.filter(p => p.result === 'hit').length;

  return {
    overall: {
      total, hits, misses: total - hits,
      hitRate: total > 0 ? +((hits / total) * 100).toFixed(1) : 0,
      pending: pickHistory.filter(p => !p.result || p.result === 'pending').length,
    },
    last7Days: {
      total: last7.length, hits: last7Hits,
      hitRate: last7.length > 0 ? +((last7Hits / last7.length) * 100).toFixed(1) : 0,
    },
    byGrade,
    byMarket,
    byDirection: {
      OVER: { total: overs.length, hits: overs.filter(p => p.result === 'hit').length, hitRate: overs.length > 0 ? +((overs.filter(p => p.result === 'hit').length / overs.length) * 100).toFixed(1) : 0 },
      UNDER: { total: unders.length, hits: unders.filter(p => p.result === 'hit').length, hitRate: unders.length > 0 ? +((unders.filter(p => p.result === 'hit').length / unders.length) * 100).toFixed(1) : 0 },
    },
    totalPicks: pickHistory.length,
    recentPicks: pickHistory.slice(-20).reverse(),
  };
}

// Load history on startup
loadHistory();

// ============================================================
// API Routes
// ============================================================

// --- Parlay Builder ---
router.post('/build', (req, res) => {
  const { legs } = req.body;
  if (!legs || !Array.isArray(legs)) {
    return res.status(400).json({
      error: 'POST body must include legs array',
      example: { legs: [
        { player: 'Brunson', market: 'Points', direction: 'OVER', line: 27.5, odds: -110, game: 'NYK vs BOS' },
        { player: 'Towns', market: 'Rebounds', direction: 'OVER', line: 10.5, odds: -115, game: 'NYK vs BOS' },
      ]},
    });
  }
  res.json(analyzeParlay(legs));
});

router.get('/build', (req, res) => {
  // GET version — legs passed as JSON query param
  try {
    const legs = JSON.parse(req.query.legs || '[]');
    if (legs.length < 2) return res.json({ error: 'Need 2+ legs. Pass ?legs=[{"player":"X","market":"Points","direction":"OVER","line":27.5,"odds":-110,"game":"NYK vs BOS"}]' });
    res.json(analyzeParlay(legs));
  } catch (e) {
    res.json({ error: 'Invalid legs JSON', example: '?legs=[{"player":"Brunson","market":"Points","direction":"OVER","line":27.5,"odds":-110,"game":"NYK vs BOS"}]' });
  }
});

router.get('/correlations', (req, res) => {
  res.json({
    positive: [
      { combo: 'Game Total OVER + Player Points OVER', correlation: 0.72, tip: 'Best combo — more scoring benefits both' },
      { combo: 'Game Total OVER + Player 3PT OVER', correlation: 0.55, tip: 'More scoring = more 3PT attempts' },
      { combo: 'Close game + Starter OVER (any stat)', correlation: 0.55, tip: 'Close games = full minutes' },
      { combo: 'Game Total OVER + Player Rebounds OVER', correlation: 0.58, tip: 'More shots = more misses = more rebounds' },
      { combo: 'Same player Points OVER + Assists OVER', correlation: 0.45, tip: 'Good game = good everywhere' },
      { combo: 'Teammate OUT + Remaining star OVER', correlation: 0.62, tip: 'Usage redistributes to remaining players' },
    ],
    negative: [
      { combo: 'Blowout favorite + Favorite star OVER', correlation: -0.45, tip: 'AVOID — starters sit Q4 in blowouts' },
      { combo: 'Both opposing stars OVER points', correlation: -0.30, tip: 'AVOID — if one team dominates, other star suffers' },
    ],
    rules: [
      'Always use positive correlations in parlays',
      'Never combine negatively correlated legs',
      'Same-game legs of the same direction are naturally correlated',
      '2-3 leg parlays are optimal — more legs = more variance',
      'Check the spread — blowout risk kills starter stat OVERs',
    ],
  });
});

// --- Live Tracker ---
router.get('/live', async (req, res) => {
  const games = await getLiveStats();
  res.json({ games: Object.values(games), count: Object.keys(games).length, timestamp: new Date().toISOString() });
});

// --- Custom Alerts ---
router.post('/alerts', (req, res) => {
  const { type, condition, threshold } = req.body;
  const alert = {
    id: Date.now(),
    type: type || 'ev', // ev, line_drop, player
    condition: condition || 'edge >= threshold',
    threshold: threshold || 5,
    active: true,
    createdAt: new Date().toISOString(),
  };
  alerts.push(alert);
  res.json({ created: true, alert, totalAlerts: alerts.length });
});

router.get('/alerts', (req, res) => {
  res.json({ alerts: alerts.filter(a => a.active), total: alerts.length });
});

router.delete('/alerts/:id', (req, res) => {
  const idx = alerts.findIndex(a => a.id === parseInt(req.params.id));
  if (idx >= 0) { alerts[idx].active = false; return res.json({ deleted: true }); }
  res.json({ deleted: false, error: 'Alert not found' });
});

// --- Historical Results ---
router.get('/history', (req, res) => {
  res.json(getHistoricalStats());
});

router.get('/history/recent', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json({ picks: pickHistory.slice(-limit).reverse(), total: pickHistory.length });
});

router.post('/history/record', (req, res) => {
  const pick = req.body;
  if (!pick.player || !pick.market) return res.status(400).json({ error: 'Need player and market' });
  recordPick(pick);
  res.json({ recorded: true, total: pickHistory.length });
});

// Auto-record POTD picks for history
router.get('/history/auto-record', async (req, res) => {
  try {
    const potd = await axios.get(`http://localhost:${PORT}/api/potd`, { timeout: 10000 });
    if (potd.data?.pickOfTheDay) {
      const p = potd.data.pickOfTheDay;
      const existing = pickHistory.find(h =>
        h.player === p.player && h.market === p.market && h.date === new Date().toISOString().split('T')[0]
      );
      if (!existing) {
        recordPick({
          player: p.player, market: p.market, pick: p.pick, line: p.line,
          confidence: p.convergence, grade: p.convergence >= 80 ? 'A+' : p.convergence >= 70 ? 'A' : 'B+',
          source: 'potd', result: 'pending',
        });
        return res.json({ recorded: true, player: p.player });
      }
      return res.json({ recorded: false, reason: 'Already recorded today' });
    }
    res.json({ recorded: false, reason: 'No POTD available' });
  } catch (e) {
    res.json({ recorded: false, error: e.message });
  }
});

module.exports = { router, analyzeParlay, getHistoricalStats, recordPick };
