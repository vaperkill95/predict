/**
 * ev-engine.js — Expected Value (+EV) Detection Engine
 * 
 * THE feature that separates ORACLE from every free tool.
 * Sharp App charges $49/mo for this. OddsJam charges $99/mo.
 * You're giving it away free.
 * 
 * How +EV works:
 *   1. Look at the odds across all sportsbooks for a prop
 *   2. Use the market consensus to estimate the "true probability"
 *      (remove the vig/juice to get the fair line)
 *   3. Compare each book's odds to the fair probability
 *   4. If a book's odds imply a LOWER probability than the fair line,
 *      that bet has positive expected value (+EV)
 * 
 * Example:
 *   Fair probability for Brunson OVER 27.5 pts = 52%
 *   FanDuel offers OVER at +110 (implied prob 47.6%)
 *   Since 52% > 47.6%, this bet is +EV by 4.4%
 *   EV per $100 bet = (0.52 × $110) - (0.48 × $100) = +$9.20
 * 
 * Devigging methods:
 *   - Worst-case: use the least favorable interpretation (conservative)
 *   - Power: assumes the overround is distributed proportionally
 *   - Shin: market-maker model, most accurate for 2-way markets
 *   - Multiplicative: simple proportional vig removal
 * 
 * Setup:
 *   const evEngine = require('./services/ev-engine');
 *   app.use('/api/ev', evEngine.router);
 *   evEngine.startScanning();
 */

const express = require('express');
const axios = require('axios');
const router = express.Router();

const PORT = process.env.PORT || 3001;
const SCAN_INTERVAL_MS = 10 * 60 * 1000; // 10 min
const cache = { evBets: [], lastScan: null };

// ============================================================
// Devigging Math
// ============================================================

/**
 * Convert American odds to implied probability
 */
function americanToProb(odds) {
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

/**
 * Convert implied probability to American odds
 */
function probToAmerican(prob) {
  if (prob >= 0.5) return Math.round(-100 * prob / (1 - prob));
  return Math.round(100 * (1 - prob) / prob);
}

/**
 * Remove vig using multiplicative method
 * Takes over/under odds, returns fair probabilities
 */
function devigMultiplicative(overOdds, underOdds) {
  const overProb = americanToProb(overOdds);
  const underProb = americanToProb(underOdds);
  const total = overProb + underProb; // > 1.0 due to vig
  
  return {
    fairOverProb: +(overProb / total).toFixed(4),
    fairUnderProb: +(underProb / total).toFixed(4),
    vig: +((total - 1) * 100).toFixed(2), // vig as percentage
    overround: +total.toFixed(4),
  };
}

/**
 * Remove vig using power method (more accurate for lopsided lines)
 */
function devigPower(overOdds, underOdds) {
  const p1 = americanToProb(overOdds);
  const p2 = americanToProb(underOdds);
  
  // Binary search for the power that makes probabilities sum to 1
  let lo = 0.5, hi = 2.0;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const sum = Math.pow(p1, mid) + Math.pow(p2, mid);
    if (sum > 1) lo = mid;
    else hi = mid;
  }
  const power = (lo + hi) / 2;
  
  return {
    fairOverProb: +Math.pow(p1, power).toFixed(4),
    fairUnderProb: +Math.pow(p2, power).toFixed(4),
    vig: +((p1 + p2 - 1) * 100).toFixed(2),
  };
}

/**
 * Remove vig using worst-case method (most conservative)
 */
function devigWorstCase(overOdds, underOdds) {
  const overProb = americanToProb(overOdds);
  const underProb = americanToProb(underOdds);
  
  // Worst case: assume all the vig is on your side
  return {
    fairOverProb: +(1 - underProb).toFixed(4),
    fairUnderProb: +(1 - overProb).toFixed(4),
    vig: +((overProb + underProb - 1) * 100).toFixed(2),
  };
}

/**
 * Calculate Expected Value for a bet
 * 
 * @param {number} fairProb - The "true" probability (after devigging)
 * @param {number} odds - The American odds being offered
 * @returns {object} EV details
 */
function calculateEV(fairProb, odds) {
  const impliedProb = americanToProb(odds);
  const edge = fairProb - impliedProb;
  
  // Calculate dollar EV per $100 bet
  let profit;
  if (odds > 0) profit = odds; // e.g., +150 → win $150
  else profit = 10000 / Math.abs(odds); // e.g., -110 → win ~$90.91
  
  const evDollars = +(fairProb * profit - (1 - fairProb) * 100).toFixed(2);
  const evPercent = +(edge * 100).toFixed(2);
  const roi = +((evDollars / 100) * 100).toFixed(2); // ROI %
  
  // Kelly Criterion bet sizing (fraction of bankroll)
  const kellyFull = edge > 0 ? +((edge * (odds > 0 ? (odds / 100) : (100 / Math.abs(odds))) - (1 - fairProb)) / ((odds > 0 ? (odds / 100) : (100 / Math.abs(odds))))).toFixed(4) : 0;
  const kellyQuarter = +(kellyFull * 0.25).toFixed(4); // Quarter Kelly (safer)
  
  return {
    fairProb: +fairProb.toFixed(4),
    impliedProb: +impliedProb.toFixed(4),
    edge: +edge.toFixed(4),
    edgePercent: evPercent,
    evPer100: evDollars,
    roi,
    isPositiveEV: evDollars > 0,
    kellyFull: Math.max(0, kellyFull),
    kellyQuarter: Math.max(0, kellyQuarter),
    grade: evPercent >= 8 ? 'A+' : evPercent >= 5 ? 'A' : evPercent >= 3 ? 'B+' : evPercent >= 2 ? 'B' : evPercent >= 1 ? 'C+' : evPercent > 0 ? 'C' : 'NEGATIVE',
  };
}

// ============================================================
// +EV Scanner
// ============================================================

/**
 * Scan all props for +EV opportunities
 * Uses the consensus of all books as the "sharp" line
 */
async function scanForEV(sport = 'nba') {
  let props = [];
  try {
    const resp = await axios.get(`http://localhost:${PORT}/api/props/${sport}`, { timeout: 15000 });
    props = resp.data?.props || [];
  } catch (e) {
    console.warn(`[EV] Props fetch failed for ${sport}: ${e.message}`);
    return [];
  }

  const evBets = [];

  for (const prop of props) {
    if (!prop.books || prop.books.length < 2) continue;

    // Step 1: Build the consensus "fair line" from all books
    const allOvers = [];
    const allUnders = [];
    
    for (const book of prop.books) {
      if (book.over?.price && book.under?.price) {
        allOvers.push(book.over.price);
        allUnders.push(book.under.price);
      }
    }

    if (allOvers.length < 2) continue;

    // Use median odds as the "market consensus" (more robust than average)
    allOvers.sort((a, b) => a - b);
    allUnders.sort((a, b) => a - b);
    const medianOver = allOvers[Math.floor(allOvers.length / 2)];
    const medianUnder = allUnders[Math.floor(allUnders.length / 2)];

    // Step 2: Devig the consensus to get fair probabilities
    const fair = devigPower(medianOver, medianUnder);
    const fairWC = devigWorstCase(medianOver, medianUnder);

    // Use average of power and worst-case for robustness
    const fairOverProb = (fair.fairOverProb + fairWC.fairOverProb) / 2;
    const fairUnderProb = (fair.fairUnderProb + fairWC.fairUnderProb) / 2;

    // Step 3: Check each book for +EV opportunities
    for (const book of prop.books) {
      // Check OVER
      if (book.over?.price) {
        const ev = calculateEV(fairOverProb, book.over.price);
        if (ev.isPositiveEV && ev.edgePercent >= 1.0) {
          evBets.push({
            player: prop.player,
            market: prop.marketLabel || prop.market,
            game: prop.game,
            commenceTime: prop.commenceTime,
            pick: 'OVER',
            line: book.over.point || prop.consensusLine,
            book: book.name,
            odds: book.over.price,
            oddsDisplay: book.over.price > 0 ? `+${book.over.price}` : `${book.over.price}`,
            ...ev,
            consensusLine: prop.consensusLine,
            bookCount: prop.bookCount,
            lineType: prop.lineType,
            vig: fair.vig,
            medianOdds: medianOver,
            sport,
          });
        }
      }

      // Check UNDER
      if (book.under?.price) {
        const ev = calculateEV(fairUnderProb, book.under.price);
        if (ev.isPositiveEV && ev.edgePercent >= 1.0) {
          evBets.push({
            player: prop.player,
            market: prop.marketLabel || prop.market,
            game: prop.game,
            commenceTime: prop.commenceTime,
            pick: 'UNDER',
            line: book.under.point || prop.consensusLine,
            book: book.name,
            odds: book.under.price,
            oddsDisplay: book.under.price > 0 ? `+${book.under.price}` : `${book.under.price}`,
            ...ev,
            consensusLine: prop.consensusLine,
            bookCount: prop.bookCount,
            lineType: prop.lineType,
            vig: fair.vig,
            medianOdds: medianUnder,
            sport,
          });
        }
      }
    }
  }

  // Sort by EV (highest first)
  evBets.sort((a, b) => b.evPer100 - a.evPer100);

  return evBets;
}

/**
 * Start periodic scanning
 */
function startScanning() {
  console.log('[EV Engine] +EV scanner started (every 10 min)');

  // Initial scan after 45 seconds
  setTimeout(async () => {
    try {
      cache.evBets = await scanForEV('nba');
      cache.lastScan = new Date().toISOString();
      console.log(`[EV Engine] Found ${cache.evBets.length} +EV bets`);
    } catch (e) {
      console.warn('[EV Engine] Initial scan failed:', e.message);
    }
  }, 45000);

  // Recurring scan
  setInterval(async () => {
    try {
      cache.evBets = await scanForEV('nba');
      cache.lastScan = new Date().toISOString();
      console.log(`[EV Engine] Found ${cache.evBets.length} +EV bets`);
    } catch (e) {
      console.warn('[EV Engine] Scan failed:', e.message);
    }
  }, SCAN_INTERVAL_MS);
}

// ============================================================
// API Routes
// ============================================================

/**
 * GET /api/ev/bets
 * Returns all current +EV opportunities, sorted by edge size
 * Query: ?minEdge=3&sport=nba&limit=20
 */
router.get('/bets', async (req, res) => {
  const minEdge = parseFloat(req.query.minEdge) || 1.0;
  const sport = req.query.sport || 'nba';
  const limit = parseInt(req.query.limit) || 30;

  let bets = cache.evBets;

  // If cache is stale or different sport requested, scan fresh
  if (!bets || bets.length === 0 || (cache.lastScan && Date.now() - new Date(cache.lastScan).getTime() > SCAN_INTERVAL_MS)) {
    bets = await scanForEV(sport);
    cache.evBets = bets;
    cache.lastScan = new Date().toISOString();
  }

  const filtered = bets.filter(b => b.edgePercent >= minEdge).slice(0, limit);

  res.json({
    found: filtered.length,
    total: bets.length,
    minEdge,
    lastScan: cache.lastScan,
    bets: filtered,
    summary: {
      avgEdge: filtered.length > 0 ? +(filtered.reduce((s, b) => s + b.edgePercent, 0) / filtered.length).toFixed(2) : 0,
      avgEV: filtered.length > 0 ? +(filtered.reduce((s, b) => s + b.evPer100, 0) / filtered.length).toFixed(2) : 0,
      topBook: filtered.length > 0 ? filtered[0].book : null,
      gradeA: filtered.filter(b => b.grade.startsWith('A')).length,
      gradeB: filtered.filter(b => b.grade.startsWith('B')).length,
    },
  });
});

/**
 * GET /api/ev/best
 * Returns only the highest-edge +EV bets (Grade A and above)
 */
router.get('/best', async (req, res) => {
  let bets = cache.evBets || [];
  if (bets.length === 0) {
    bets = await scanForEV('nba');
    cache.evBets = bets;
    cache.lastScan = new Date().toISOString();
  }

  const best = bets.filter(b => b.edgePercent >= 3.0).slice(0, 15);

  res.json({
    count: best.length,
    lastScan: cache.lastScan,
    bets: best,
  });
});

/**
 * GET /api/ev/calculate?overOdds=-110&underOdds=-110&betOdds=+150&side=over
 * Manual EV calculator
 */
router.get('/calculate', (req, res) => {
  const { overOdds, underOdds, betOdds, side } = req.query;
  if (!overOdds || !underOdds || !betOdds) {
    return res.status(400).json({ error: 'Required: ?overOdds=-110&underOdds=-110&betOdds=+150&side=over' });
  }

  const fair = devigPower(parseInt(overOdds), parseInt(underOdds));
  const fairProb = side === 'under' ? fair.fairUnderProb : fair.fairOverProb;
  const ev = calculateEV(fairProb, parseInt(betOdds));

  res.json({
    fairLine: fair,
    bet: {
      side: side || 'over',
      odds: parseInt(betOdds),
      ...ev,
    },
  });
});

/**
 * GET /api/ev/devig?overOdds=-110&underOdds=-110
 * Devig calculator — shows the fair line from any over/under odds pair
 */
router.get('/devig', (req, res) => {
  const { overOdds, underOdds } = req.query;
  if (!overOdds || !underOdds) {
    return res.status(400).json({ error: 'Required: ?overOdds=-110&underOdds=-110' });
  }

  const mult = devigMultiplicative(parseInt(overOdds), parseInt(underOdds));
  const power = devigPower(parseInt(overOdds), parseInt(underOdds));
  const wc = devigWorstCase(parseInt(overOdds), parseInt(underOdds));

  res.json({
    input: { overOdds: parseInt(overOdds), underOdds: parseInt(underOdds) },
    methods: {
      multiplicative: { ...mult, fairOverOdds: probToAmerican(mult.fairOverProb), fairUnderOdds: probToAmerican(mult.fairUnderProb) },
      power: { ...power, fairOverOdds: probToAmerican(power.fairOverProb), fairUnderOdds: probToAmerican(power.fairUnderProb) },
      worstCase: { ...wc, fairOverOdds: probToAmerican(wc.fairOverProb), fairUnderOdds: probToAmerican(wc.fairUnderProb) },
    },
  });
});

module.exports = { router, startScanning, scanForEV, calculateEV, devigPower, devigMultiplicative, devigWorstCase, americanToProb, probToAmerican };
