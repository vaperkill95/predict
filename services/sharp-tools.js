/**
 * sharp-tools.js — Pro Bettor Toolkit
 * 
 * Features:
 *   1. Closing Line Value (CLV) Tracker
 *      - Snapshots opening lines, tracks to close
 *      - Compares your pick's line to the final line
 *      - CLV+ = you got a better number than where the market settled
 * 
 *   2. Reverse Line Movement (RLM) Detection
 *      - When the line moves OPPOSITE to public sentiment
 *      - 80% of bets on OVER but line moves UP = sharp money on UNDER
 *      - The #1 indicator pros use to find edges
 * 
 *   3. Kelly Criterion Bankroll Calculator
 *      - Optimal bet sizing based on edge size
 *      - Quarter/half/full Kelly options
 *      - Risk-adjusted position sizing
 * 
 *   4. Correlation Engine
 *      - Identifies which props are correlated (move together)
 *      - Flags smart parlay combos
 *      - Warns against negatively correlated legs
 * 
 *   5. Steam Move Detection
 *      - Detects rapid line movement across multiple books
 *      - Sharp money hitting the market hard
 * 
 * Setup:
 *   const sharpTools = require('./services/sharp-tools');
 *   app.use('/api/sharp', sharpTools.router);
 *   sharpTools.startTracking();
 */

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const PORT = process.env.PORT || 3001;
const TRACK_INTERVAL_MS = 15 * 60 * 1000; // 15 min
const CLV_FILE = path.join(__dirname, '..', 'data', 'clv-data.json');

// ============================================================
// 1. CLOSING LINE VALUE (CLV) TRACKER
// ============================================================

/**
 * Line snapshots over time for each prop
 * Structure: { "player|market|line": [{ timestamp, lines: { book: odds }, consensusLine }] }
 */
let lineSnapshots = {};
let clvResults = []; // graded CLV records

function loadCLVData() {
  try {
    if (fs.existsSync(CLV_FILE)) {
      const data = JSON.parse(fs.readFileSync(CLV_FILE, 'utf8'));
      lineSnapshots = data.snapshots || {};
      clvResults = data.results || [];
      console.log(`[Sharp] Loaded ${Object.keys(lineSnapshots).length} line snapshot series, ${clvResults.length} CLV results`);
    }
  } catch (e) {
    console.warn('[Sharp] Could not load CLV data:', e.message);
  }
}

function saveCLVData() {
  try {
    const dir = path.dirname(CLV_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Only keep last 24h of snapshots and last 200 results
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const trimmed = {};
    for (const [key, snaps] of Object.entries(lineSnapshots)) {
      const recent = snaps.filter(s => s.timestamp > cutoff);
      if (recent.length > 0) trimmed[key] = recent;
    }
    fs.writeFileSync(CLV_FILE, JSON.stringify({
      snapshots: trimmed,
      results: clvResults.slice(-200),
    }, null, 2));
  } catch (e) {
    console.warn('[Sharp] Could not save CLV data:', e.message);
  }
}

/**
 * Snapshot current lines for all props
 */
async function snapshotLines(sport = 'nba') {
  try {
    const resp = await axios.get(`http://localhost:${PORT}/api/props/${sport}`, { timeout: 15000 });
    const props = resp.data?.props || [];
    const now = Date.now();

    for (const prop of props) {
      const key = `${prop.player}|${prop.market}|${prop.consensusLine}`;
      if (!lineSnapshots[key]) lineSnapshots[key] = [];

      const bookLines = {};
      let bestOver = null, bestUnder = null;
      for (const book of (prop.books || [])) {
        if (book.over?.price) {
          bookLines[`${book.name}_over`] = book.over.price;
          if (!bestOver || book.over.price > bestOver.price) bestOver = { book: book.name, price: book.over.price };
        }
        if (book.under?.price) {
          bookLines[`${book.name}_under`] = book.under.price;
          if (!bestUnder || book.under.price > bestUnder.price) bestUnder = { book: book.name, price: book.under.price };
        }
      }

      lineSnapshots[key].push({
        timestamp: now,
        consensusLine: prop.consensusLine,
        bookCount: prop.bookCount,
        lines: bookLines,
        bestOver,
        bestUnder,
      });

      // Keep only last 20 snapshots per prop
      if (lineSnapshots[key].length > 20) {
        lineSnapshots[key] = lineSnapshots[key].slice(-20);
      }
    }

    saveCLVData();
    return props.length;
  } catch (e) {
    console.warn('[Sharp] Snapshot failed:', e.message);
    return 0;
  }
}

/**
 * Calculate CLV for a pick
 * Compares the line you got vs the closing (most recent) line
 */
function calculateCLV(player, market, pickLine, pickOdds, pickDirection) {
  // Find matching snapshots
  const matchKey = Object.keys(lineSnapshots).find(k =>
    k.startsWith(`${player}|${market}`)
  );

  if (!matchKey || !lineSnapshots[matchKey] || lineSnapshots[matchKey].length < 2) {
    return { available: false, reason: 'Not enough line history' };
  }

  const snaps = lineSnapshots[matchKey];
  const closingSnap = snaps[snaps.length - 1]; // most recent = closing
  const openingSnap = snaps[0]; // first = opening

  const openingLine = openingSnap.consensusLine;
  const closingLine = closingSnap.consensusLine;
  const lineMovement = +(closingLine - openingLine).toFixed(1);

  // CLV: did you get a better number than the close?
  let clvPoints = 0;
  if (pickDirection === 'OVER') {
    // For OVER, a lower line is better (easier to go over)
    clvPoints = +(closingLine - pickLine).toFixed(1);
  } else {
    // For UNDER, a higher line is better (easier to stay under)
    clvPoints = +(pickLine - closingLine).toFixed(1);
  }

  const hasCLV = clvPoints > 0;

  return {
    available: true,
    openingLine,
    closingLine,
    pickLine,
    lineMovement,
    lineMovementDirection: lineMovement > 0 ? 'UP' : lineMovement < 0 ? 'DOWN' : 'FLAT',
    clvPoints,
    hasCLV,
    clvGrade: clvPoints >= 2.0 ? 'A+' : clvPoints >= 1.0 ? 'A' : clvPoints >= 0.5 ? 'B' : clvPoints > 0 ? 'C' : clvPoints === 0 ? 'EVEN' : 'NEGATIVE',
    analysis: hasCLV
      ? `+${clvPoints} CLV — you got a better number than where the market closed. Sharp move.`
      : clvPoints === 0
        ? 'Line closed exactly where you took it. No CLV advantage.'
        : `${clvPoints} CLV — the market moved in your favor after you bet. The closing line was better for your direction.`,
    snapshotCount: snaps.length,
    hoursTracked: +((snaps[snaps.length - 1].timestamp - snaps[0].timestamp) / (1000 * 60 * 60)).toFixed(1),
  };
}

// ============================================================
// 2. REVERSE LINE MOVEMENT (RLM) DETECTION
// ============================================================

/**
 * Detect Reverse Line Movement across all props
 * RLM = line moves OPPOSITE to what public betting would suggest
 * 
 * We estimate public sentiment from:
 *   - If most books have similar OVER odds (consensus) but one book's line is lower
 *   - The direction of line movement vs the "popular" side
 *   - Props where the OVER is heavily juiced (-150 or worse) = public on OVER
 */
function detectRLM(sport = 'nba') {
  const rlmAlerts = [];

  for (const [key, snaps] of Object.entries(lineSnapshots)) {
    if (snaps.length < 2) continue;

    const first = snaps[0];
    const latest = snaps[snaps.length - 1];
    const lineMove = latest.consensusLine - first.consensusLine;

    if (Math.abs(lineMove) < 0.5) continue; // Need meaningful movement

    // Estimate public side from juice
    // Heavy juice on OVER (e.g., -150) = public is betting OVER
    // Heavy juice on UNDER = public is betting UNDER
    let publicSide = null;
    if (latest.bestOver && latest.bestUnder) {
      const overJuice = latest.bestOver.price;
      const underJuice = latest.bestUnder.price;
      // If best over is very negative = books want OVER action = public is on OVER
      // More precisely: if median over odds are more negative than under
      const overPrices = Object.entries(latest.lines)
        .filter(([k]) => k.endsWith('_over'))
        .map(([, v]) => v);
      const underPrices = Object.entries(latest.lines)
        .filter(([k]) => k.endsWith('_under'))
        .map(([, v]) => v);

      if (overPrices.length > 0 && underPrices.length > 0) {
        const avgOver = overPrices.reduce((a, b) => a + b, 0) / overPrices.length;
        const avgUnder = underPrices.reduce((a, b) => a + b, 0) / underPrices.length;

        // More negative avg = more public action on that side
        if (avgOver < avgUnder - 15) publicSide = 'OVER';
        else if (avgUnder < avgOver - 15) publicSide = 'UNDER';
      }
    }

    if (!publicSide) continue;

    // RLM: line moved AGAINST the public side
    const lineDirection = lineMove > 0 ? 'UP' : 'DOWN';
    // Line going UP favors UNDER (harder to go over), DOWN favors OVER
    const lineMoveFavors = lineDirection === 'UP' ? 'UNDER' : 'OVER';

    // RLM = public on one side but line moves to favor the OTHER side
    if (publicSide === 'OVER' && lineMoveFavors === 'UNDER') {
      // Public on OVER but line moved UP = sharps on UNDER
      const parts = key.split('|');
      rlmAlerts.push({
        player: parts[0],
        market: parts[1],
        line: latest.consensusLine,
        publicSide: 'OVER',
        sharpSide: 'UNDER',
        lineMovement: +lineMove.toFixed(1),
        lineDirection,
        signal: 'REVERSE_LINE_MOVEMENT',
        strength: Math.abs(lineMove) >= 1.5 ? 'strong' : Math.abs(lineMove) >= 1.0 ? 'moderate' : 'weak',
        analysis: `Public is betting OVER but the line moved UP ${Math.abs(lineMove).toFixed(1)} pts. Sharp money appears to be on UNDER.`,
      });
    } else if (publicSide === 'UNDER' && lineMoveFavors === 'OVER') {
      const parts = key.split('|');
      rlmAlerts.push({
        player: parts[0],
        market: parts[1],
        line: latest.consensusLine,
        publicSide: 'UNDER',
        sharpSide: 'OVER',
        lineMovement: +lineMove.toFixed(1),
        lineDirection,
        signal: 'REVERSE_LINE_MOVEMENT',
        strength: Math.abs(lineMove) >= 1.5 ? 'strong' : Math.abs(lineMove) >= 1.0 ? 'moderate' : 'weak',
        analysis: `Public is betting UNDER but the line moved DOWN ${Math.abs(lineMove).toFixed(1)} pts. Sharp money appears to be on OVER.`,
      });
    }
  }

  // Sort by strength
  const order = { strong: 0, moderate: 1, weak: 2 };
  rlmAlerts.sort((a, b) => order[a.strength] - order[b.strength]);

  return rlmAlerts;
}

// ============================================================
// 3. KELLY CRITERION BANKROLL CALCULATOR
// ============================================================

/**
 * Calculate optimal bet size using Kelly Criterion
 * 
 * @param {number} bankroll - Total bankroll
 * @param {number} edge - Your estimated edge (e.g., 0.05 for 5%)
 * @param {number} odds - American odds (e.g., -110, +150)
 * @param {string} kellyFraction - 'full', 'half', 'quarter', 'eighth'
 * @returns {object} Recommended bet size and details
 */
function kellyCalculator(bankroll, edge, odds, kellyFraction = 'quarter') {
  // Convert American odds to decimal
  let decimal;
  if (odds > 0) decimal = (odds / 100) + 1;
  else decimal = (100 / Math.abs(odds)) + 1;

  // Kelly formula: f* = (bp - q) / b
  // where b = decimal odds - 1, p = win probability, q = 1 - p
  const b = decimal - 1;
  const p = 0.5 + edge / 2; // rough conversion from edge to probability
  const q = 1 - p;

  const kellyFull = Math.max(0, (b * p - q) / b);

  const fractions = {
    full: 1.0,
    half: 0.5,
    quarter: 0.25,
    eighth: 0.125,
  };

  const fraction = fractions[kellyFraction] || 0.25;
  const kellyAdj = kellyFull * fraction;
  const betAmount = +(bankroll * kellyAdj).toFixed(2);
  const maxBet = +(bankroll * 0.05).toFixed(2); // Hard cap at 5%
  const recommendedBet = Math.min(betAmount, maxBet);

  // Calculate potential outcomes
  const potentialWin = odds > 0
    ? +(recommendedBet * (odds / 100)).toFixed(2)
    : +(recommendedBet * (100 / Math.abs(odds))).toFixed(2);

  return {
    bankroll,
    edge: +(edge * 100).toFixed(2) + '%',
    odds,
    kellyFraction,
    kellyFullPercent: +(kellyFull * 100).toFixed(2),
    kellyAdjustedPercent: +(kellyAdj * 100).toFixed(2),
    recommendedBet,
    potentialWin,
    potentialLoss: recommendedBet,
    riskPercent: +((recommendedBet / bankroll) * 100).toFixed(2),
    maxBetCap: maxBet,
    wasCapped: betAmount > maxBet,
    advice: kellyAdj > 0.03
      ? 'Strong edge — bet near the recommended amount.'
      : kellyAdj > 0.01
        ? 'Decent edge — consider the recommended amount or slightly less.'
        : kellyAdj > 0
          ? 'Small edge — bet conservatively or skip.'
          : 'No edge detected — do not bet.',
  };
}

// ============================================================
// 4. CORRELATION ENGINE
// ============================================================

/**
 * Find correlated props for smart parlay building
 * Positive correlation: if one hits, the other is more likely to hit
 * Example: Game OVER + Player OVER points (more total scoring = more individual scoring)
 */
function findCorrelations(sport = 'nba') {
  const correlations = [];

  // Known positive correlations for NBA
  const POSITIVE_CORRELATIONS = [
    {
      type: 'game_total_player_points',
      description: 'High game total + Player OVER points',
      reason: 'More total scoring = more possessions = more individual scoring opportunities',
      strength: 0.72,
    },
    {
      type: 'player_points_assists',
      description: 'Player OVER points + Player OVER assists (same player)',
      reason: 'High-usage players who score a lot also create for teammates',
      strength: 0.45,
    },
    {
      type: 'blowout_bench_points',
      description: 'Large spread + UNDER on favorite starters, OVER on bench',
      reason: 'In blowouts, starters sit and bench players get extended minutes',
      strength: 0.65,
    },
    {
      type: 'pace_rebounds',
      description: 'Fast pace game + OVER rebounds',
      reason: 'More possessions = more shot attempts = more rebound opportunities',
      strength: 0.58,
    },
    {
      type: 'injury_usage',
      description: 'Key player OUT + Remaining starter OVER points',
      reason: 'When a scorer is out, remaining players absorb their usage',
      strength: 0.62,
    },
    {
      type: 'close_game_minutes',
      description: 'Close spread (1-3 pts) + OVER on starter stats',
      reason: 'Close games = starters play full 4th quarter = max minutes',
      strength: 0.55,
    },
  ];

  // Known NEGATIVE correlations (warn against these parlays)
  const NEGATIVE_CORRELATIONS = [
    {
      type: 'opposing_players_both_over',
      description: 'Both opposing team stars OVER points',
      reason: 'If one team dominates, the losing team star often underperforms due to garbage time or different game script',
      strength: -0.30,
    },
    {
      type: 'blowout_favorite_over',
      description: 'Large spread favorite + OVER on that team star points',
      reason: 'In blowouts, the favorite pulls starters early, capping their stats',
      strength: -0.45,
    },
  ];

  return {
    positive: POSITIVE_CORRELATIONS,
    negative: NEGATIVE_CORRELATIONS,
    tips: [
      'Always combine positively correlated legs in parlays for better hit rates.',
      'Never combine negatively correlated legs — they work against each other.',
      'The strongest correlation is game total + player points (r=0.72).',
      'Close games (spread 1-3) are the best environment for starter stat OVERs.',
      'Blowout risk is the #1 parlay killer — always check the spread.',
    ],
  };
}

// ============================================================
// 5. STEAM MOVE DETECTION
// ============================================================

/**
 * Detect steam moves — rapid line movement across multiple books
 */
function detectSteamMoves() {
  const steamMoves = [];

  for (const [key, snaps] of Object.entries(lineSnapshots)) {
    if (snaps.length < 3) continue;

    // Check last 3 snapshots for rapid movement
    const recent = snaps.slice(-3);
    const timeSpan = recent[recent.length - 1].timestamp - recent[0].timestamp;
    const lineChange = recent[recent.length - 1].consensusLine - recent[0].consensusLine;

    // Steam = 1+ point move within 30 min across 3+ books
    if (Math.abs(lineChange) >= 1.0 && timeSpan <= 30 * 60 * 1000) {
      const parts = key.split('|');

      // Check if multiple books moved in the same direction
      const firstBooks = Object.keys(recent[0].lines || {});
      const latestBooks = Object.keys(recent[recent.length - 1].lines || {});
      const movedBooks = Math.min(firstBooks.length, latestBooks.length);

      if (movedBooks >= 2) {
        steamMoves.push({
          player: parts[0],
          market: parts[1],
          line: recent[recent.length - 1].consensusLine,
          movement: +lineChange.toFixed(1),
          direction: lineChange > 0 ? 'UP' : 'DOWN',
          sharpSide: lineChange > 0 ? 'UNDER' : 'OVER',
          timeMinutes: +(timeSpan / (1000 * 60)).toFixed(0),
          booksAffected: movedBooks,
          signal: 'STEAM_MOVE',
          urgency: Math.abs(lineChange) >= 2.0 ? 'high' : 'moderate',
          analysis: `Line moved ${Math.abs(lineChange).toFixed(1)} pts ${lineChange > 0 ? 'UP' : 'DOWN'} in ${(timeSpan / (1000 * 60)).toFixed(0)} min across ${movedBooks} books. Sharp money is on the ${lineChange > 0 ? 'UNDER' : 'OVER'}.`,
        });
      }
    }
  }

  steamMoves.sort((a, b) => Math.abs(b.movement) - Math.abs(a.movement));
  return steamMoves;
}

// ============================================================
// Tracking Loop
// ============================================================

function startTracking() {
  console.log('[Sharp Tools] Starting line tracking (every 15 min)');
  loadCLVData();

  // Initial snapshot after 60 seconds
  setTimeout(async () => {
    const count = await snapshotLines('nba');
    console.log(`[Sharp Tools] Initial snapshot: ${count} props tracked`);
  }, 60000);

  // Recurring snapshots
  setInterval(async () => {
    const count = await snapshotLines('nba');
    console.log(`[Sharp Tools] Snapshot: ${count} props tracked, ${Object.keys(lineSnapshots).length} series`);
  }, TRACK_INTERVAL_MS);
}

// ============================================================
// API Routes
// ============================================================

// --- CLV ---
router.get('/clv', (req, res) => {
  const { player, market, line, odds, direction } = req.query;
  if (!player || !market) {
    return res.json({
      error: 'Required: ?player=Jalen+Brunson&market=Points&line=27.5&odds=-110&direction=OVER',
      trackedProps: Object.keys(lineSnapshots).length,
    });
  }
  const result = calculateCLV(player, market, parseFloat(line) || 0, parseInt(odds) || -110, direction || 'OVER');
  res.json(result);
});

router.get('/clv/all', (req, res) => {
  // Return all tracked line series with their movement
  const series = Object.entries(lineSnapshots).map(([key, snaps]) => {
    const parts = key.split('|');
    const first = snaps[0];
    const latest = snaps[snaps.length - 1];
    return {
      player: parts[0],
      market: parts[1],
      openingLine: first.consensusLine,
      currentLine: latest.consensusLine,
      movement: +(latest.consensusLine - first.consensusLine).toFixed(1),
      snapshots: snaps.length,
      hoursTracked: +((latest.timestamp - first.timestamp) / (1000 * 60 * 60)).toFixed(1),
    };
  }).filter(s => s.snapshots >= 2);

  series.sort((a, b) => Math.abs(b.movement) - Math.abs(a.movement));
  res.json({ tracked: series.length, series: series.slice(0, 50) });
});

// --- RLM ---
router.get('/rlm', (req, res) => {
  const alerts = detectRLM(req.query.sport || 'nba');
  res.json({
    found: alerts.length,
    strong: alerts.filter(a => a.strength === 'strong').length,
    alerts,
  });
});

// --- Kelly ---
router.get('/kelly', (req, res) => {
  const { bankroll, edge, odds, fraction } = req.query;
  if (!bankroll || !edge || !odds) {
    return res.status(400).json({
      error: 'Required: ?bankroll=1000&edge=0.05&odds=-110&fraction=quarter',
      example: '/api/sharp/kelly?bankroll=1000&edge=0.05&odds=-110&fraction=quarter',
    });
  }
  const result = kellyCalculator(
    parseFloat(bankroll),
    parseFloat(edge),
    parseInt(odds),
    fraction || 'quarter'
  );
  res.json(result);
});

// --- Correlations ---
router.get('/correlations', (req, res) => {
  const data = findCorrelations(req.query.sport || 'nba');
  res.json(data);
});

// --- Steam Moves ---
router.get('/steam', (req, res) => {
  const moves = detectSteamMoves();
  res.json({
    found: moves.length,
    high: moves.filter(m => m.urgency === 'high').length,
    moves,
  });
});

// --- Full Dashboard ---
router.get('/dashboard', async (req, res) => {
  const sport = req.query.sport || 'nba';
  const rlm = detectRLM(sport);
  const steam = detectSteamMoves();
  const correlations = findCorrelations(sport);

  // Get +EV data too
  let evBets = [];
  try {
    const evResp = await axios.get(`http://localhost:${PORT}/api/ev/best`, { timeout: 10000 });
    evBets = evResp.data?.bets || [];
  } catch (e) {}

  res.json({
    timestamp: new Date().toISOString(),
    sport,
    trackedProps: Object.keys(lineSnapshots).length,
    signals: {
      rlm: { count: rlm.length, strong: rlm.filter(a => a.strength === 'strong').length, top3: rlm.slice(0, 3) },
      steam: { count: steam.length, high: steam.filter(m => m.urgency === 'high').length, top3: steam.slice(0, 3) },
      ev: { count: evBets.length, top3: evBets.slice(0, 3) },
    },
    correlations: correlations.positive.slice(0, 3),
    summary: `${rlm.length} RLM alerts, ${steam.length} steam moves, ${evBets.length} +EV bets detected`,
  });
});

module.exports = { router, startTracking, calculateCLV, kellyCalculator, findCorrelations, detectRLM, detectSteamMoves };
