/**
 * advanced-tools.js — Pro Bettor Advanced Techniques
 * 
 * Features:
 *   1. Middling Detector — finds props where lines differ enough
 *      between books to bet BOTH sides and potentially win both
 *   2. Arbitrage Finder — finds props where odds at different books
 *      guarantee profit regardless of outcome
 *   3. Alternate Line Value — finds props where one book's line is
 *      significantly off from consensus, creating exploitable value
 * 
 * Setup:
 *   const advancedTools = require('./services/advanced-tools');
 *   app.use('/api/advanced', advancedTools.router);
 *   advancedTools.startScanning();
 */

const express = require('express');
const axios = require('axios');
const router = express.Router();

const PORT = process.env.PORT || 3001;
const SCAN_INTERVAL_MS = 15 * 60 * 1000;
const cache = { middles: [], arbs: [], altLines: [], lastScan: null };

// ============================================================
// Utility: Convert American odds to decimal and implied prob
// ============================================================

function americanToDecimal(odds) {
  if (odds > 0) return (odds / 100) + 1;
  return (100 / Math.abs(odds)) + 1;
}

function americanToProb(odds) {
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

// ============================================================
// 1. MIDDLING DETECTOR
// ============================================================
// A middle exists when Book A has OVER X.5 and Book B has UNDER Y.5
// where Y > X. If the actual result lands between X and Y, both hit.
//
// Example: Book A: OVER 25.5  |  Book B: UNDER 28.5
// If player scores 26, 27, or 28 → BOTH bets win!

function detectMiddles(props) {
  const middles = [];

  for (const prop of props) {
    if (!prop.books || prop.books.length < 2) continue;

    // Get all book lines (the point, not the odds)
    const bookLines = [];
    for (const book of prop.books) {
      const overPt = book.over?.point;
      const underPt = book.under?.point;
      const pt = overPt || underPt;
      if (pt !== undefined) {
        bookLines.push({
          book: book.name,
          point: pt,
          overOdds: book.over?.price,
          underOdds: book.under?.price,
        });
      }
    }

    if (bookLines.length < 2) continue;

    // Sort by point value
    bookLines.sort((a, b) => a.point - b.point);
    const lowest = bookLines[0];
    const highest = bookLines[bookLines.length - 1];
    const gap = highest.point - lowest.point;

    if (gap < 2) continue; // Need at least 2-point gap for a middle

    // Middle: bet OVER at the LOW book, UNDER at the HIGH book
    // If result lands between → both win
    const overOdds = lowest.overOdds;
    const underOdds = highest.underOdds;

    if (!overOdds || !underOdds) continue;

    // Calculate cost and potential outcomes
    const overDecimal = americanToDecimal(overOdds);
    const underDecimal = americanToDecimal(underOdds);

    // Bet $100 on each side = $200 total risk
    const stake = 100;
    const totalRisk = stake * 2;

    // If middle hits (both win):
    const overPayout = stake * overDecimal;
    const underPayout = stake * underDecimal;
    const middleProfit = (overPayout + underPayout) - totalRisk;

    // If middle misses (one wins, one loses):
    // Best case: the winning side pays enough to cover both
    const winOnlyOver = overPayout - totalRisk;
    const winOnlyUnder = underPayout - totalRisk;
    const worstLoss = Math.min(winOnlyOver, winOnlyUnder);

    // Middle window: the range of values where both bets win
    const windowLow = Math.ceil(lowest.point);
    const windowHigh = Math.floor(highest.point);
    const windowSize = windowHigh - windowLow + 1;

    // Rough probability of landing in the middle (based on gap)
    // Wider gap = higher chance
    const middleChance = Math.min(40, gap * 5); // rough estimate

    middles.push({
      player: prop.player,
      market: prop.marketLabel || prop.market,
      game: prop.game,
      gap: +gap.toFixed(1),
      overBook: lowest.book,
      overLine: lowest.point,
      overOdds: overOdds,
      overOddsDisplay: overOdds > 0 ? `+${overOdds}` : `${overOdds}`,
      underBook: highest.book,
      underLine: highest.point,
      underOdds: underOdds,
      underOddsDisplay: underOdds > 0 ? `+${underOdds}` : `${underOdds}`,
      middleWindow: `${windowLow} to ${windowHigh}`,
      windowSize,
      middleChance: `~${middleChance}%`,
      profitIfMiddle: +middleProfit.toFixed(2),
      lossIfMiss: +worstLoss.toFixed(2),
      risk: totalRisk,
      grade: gap >= 5 ? 'A+' : gap >= 3 ? 'A' : gap >= 2 ? 'B' : 'C',
      strategy: `Bet OVER ${lowest.point} at ${lowest.book} (${overOdds > 0 ? '+' : ''}${overOdds}) AND UNDER ${highest.point} at ${highest.book} (${underOdds > 0 ? '+' : ''}${underOdds}). If ${prop.player} gets ${windowLow}-${windowHigh} ${(prop.marketLabel || prop.market || '').toLowerCase()}, both bets win.`,
    });
  }

  middles.sort((a, b) => b.gap - a.gap);
  return middles;
}

// ============================================================
// 2. ARBITRAGE FINDER
// ============================================================
// An arb exists when the combined implied probability of both sides
// across two different books is LESS than 100%.
//
// Example: Book A has OVER at +110 (47.6%) and Book B has UNDER at +110 (47.6%)
// Combined: 95.2% < 100% → guaranteed 4.8% profit

function findArbitrages(props) {
  const arbs = [];

  for (const prop of props) {
    if (!prop.books || prop.books.length < 2) continue;

    // Check every pair of books for arb opportunity
    for (let i = 0; i < prop.books.length; i++) {
      for (let j = 0; j < prop.books.length; j++) {
        if (i === j) continue;

        const bookA = prop.books[i]; // take OVER from this book
        const bookB = prop.books[j]; // take UNDER from this book

        if (!bookA.over?.price || !bookB.under?.price) continue;
        // Must be same line for a true arb
        if (bookA.over.point !== bookB.under.point) continue;

        const overProb = americanToProb(bookA.over.price);
        const underProb = americanToProb(bookB.under.price);
        const combinedProb = overProb + underProb;

        if (combinedProb < 1.0) {
          // ARB FOUND! Combined probability < 100%
          const arbPercent = +((1 - combinedProb) * 100).toFixed(2);

          // Calculate optimal stakes for equal profit
          const overDecimal = americanToDecimal(bookA.over.price);
          const underDecimal = americanToDecimal(bookB.under.price);
          const totalBudget = 100;
          const overStake = +(totalBudget * underDecimal / (overDecimal + underDecimal)).toFixed(2);
          const underStake = +(totalBudget - overStake).toFixed(2);
          const guaranteedProfit = +((overStake * overDecimal) - totalBudget).toFixed(2);

          arbs.push({
            player: prop.player,
            market: prop.marketLabel || prop.market,
            game: prop.game,
            line: bookA.over.point,
            arbPercent,
            guaranteedProfit,
            overBook: bookA.name,
            overOdds: bookA.over.price,
            overOddsDisplay: bookA.over.price > 0 ? `+${bookA.over.price}` : `${bookA.over.price}`,
            overStake,
            underBook: bookB.name,
            underOdds: bookB.under.price,
            underOddsDisplay: bookB.under.price > 0 ? `+${bookB.under.price}` : `${bookB.under.price}`,
            underStake,
            totalBudget,
            strategy: `Bet $${overStake} on OVER ${bookA.over.point} at ${bookA.name} (${bookA.over.price > 0 ? '+' : ''}${bookA.over.price}) AND $${underStake} on UNDER at ${bookB.name} (${bookB.under.price > 0 ? '+' : ''}${bookB.under.price}). Guaranteed $${guaranteedProfit} profit on $${totalBudget}.`,
            grade: arbPercent >= 5 ? 'A+' : arbPercent >= 3 ? 'A' : arbPercent >= 1.5 ? 'B' : 'C',
          });
        }
      }
    }
  }

  // Deduplicate (same player+market, keep highest arb)
  const seen = new Set();
  const unique = arbs.filter(a => {
    const key = `${a.player}|${a.market}|${a.overBook}|${a.underBook}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  unique.sort((a, b) => b.arbPercent - a.arbPercent);
  return unique;
}

// ============================================================
// 3. ALTERNATE LINE VALUE SCANNER
// ============================================================
// Finds props where one book's line is way off from consensus,
// meaning that book is offering a line that's easier to hit.

function findAltLineValue(props) {
  const altLines = [];

  for (const prop of props) {
    if (!prop.books || prop.books.length < 3) continue;

    const consensus = prop.consensusLine;
    if (!consensus) continue;

    for (const book of prop.books) {
      const bookLine = book.over?.point || book.under?.point;
      if (!bookLine) continue;

      const diff = Math.abs(bookLine - consensus);
      if (diff < 1.5) continue; // Need meaningful difference

      // Which direction is the value?
      const isLowerLine = bookLine < consensus;
      const valueSide = isLowerLine ? 'OVER' : 'UNDER';
      const valueOdds = isLowerLine ? book.over?.price : book.under?.price;

      if (!valueOdds) continue;

      altLines.push({
        player: prop.player,
        market: prop.marketLabel || prop.market,
        game: prop.game,
        book: book.name,
        bookLine,
        consensusLine: consensus,
        diff: +diff.toFixed(1),
        valueSide,
        valueOdds,
        valueOddsDisplay: valueOdds > 0 ? `+${valueOdds}` : `${valueOdds}`,
        advantage: `${book.name} has ${valueSide} ${bookLine} while consensus is ${consensus}. That's ${diff.toFixed(1)} points easier.`,
        grade: diff >= 4 ? 'A+' : diff >= 3 ? 'A' : diff >= 2 ? 'B' : 'C',
      });
    }
  }

  altLines.sort((a, b) => b.diff - a.diff);
  return altLines;
}

// ============================================================
// Scanner
// ============================================================

async function scanAll(sport = 'nba') {
  try {
    // Read from Redis directly — never trigger a fresh Odds API call
    let redisCache = null;
    try { redisCache = require('./redis-cache'); } catch(e) {}
    
    let props = [];
    if (redisCache && redisCache.isConnected()) {
      const data = await redisCache.getProps(sport);
      props = data ? (data.props || data.picks || []) : [];
    }
    
    if (props.length === 0) {
      console.log(`[Advanced] No props in Redis for ${sport}, skipping scan`);
      return;
    }

    cache.middles = detectMiddles(props);
    cache.arbs = findArbitrages(props);
    cache.altLines = findAltLineValue(props);
    cache.lastScan = new Date().toISOString();

    console.log(`[Advanced] Scan complete: ${cache.middles.length} middles, ${cache.arbs.length} arbs, ${cache.altLines.length} alt lines`);
  } catch (e) {
    console.warn('[Advanced] Scan failed:', e.message);
  }
}

function startScanning() {
  console.log('[Advanced Tools] Starting scanner (every 15 min)');
  setTimeout(() => scanAll(), 60000);
  setInterval(() => scanAll(), SCAN_INTERVAL_MS);
}

// ============================================================
// API Routes
// ============================================================

router.get('/middles', async (req, res) => {
  if (!cache.middles || cache.middles.length === 0) await scanAll();
  res.json({
    found: cache.middles.length,
    lastScan: cache.lastScan,
    middles: cache.middles.slice(0, 20),
    explanation: 'A middle lets you bet BOTH sides at different books. If the result lands in the gap between the two lines, both bets win. Even if it misses, you only lose the vig on one side.',
  });
});

router.get('/arbs', async (req, res) => {
  if (!cache.arbs || cache.arbs.length === 0) await scanAll();
  res.json({
    found: cache.arbs.length,
    lastScan: cache.lastScan,
    arbs: cache.arbs.slice(0, 20),
    explanation: 'An arbitrage is a guaranteed profit. When two books disagree on the odds enough, you can bet both sides and win money no matter what happens. Arbs are rare and disappear fast.',
  });
});

router.get('/alt-lines', async (req, res) => {
  if (!cache.altLines || cache.altLines.length === 0) await scanAll();
  res.json({
    found: cache.altLines.length,
    lastScan: cache.lastScan,
    altLines: cache.altLines.slice(0, 20),
    explanation: 'Alternate line value occurs when one book sets a significantly different line than the consensus. This means that book is giving you an easier number to hit for the same stat.',
  });
});

router.get('/dashboard', async (req, res) => {
  if (!cache.lastScan) await scanAll();
  res.json({
    lastScan: cache.lastScan,
    summary: {
      middles: cache.middles.length,
      arbs: cache.arbs.length,
      altLines: cache.altLines.length,
    },
    topMiddle: cache.middles[0] || null,
    topArb: cache.arbs[0] || null,
    topAltLine: cache.altLines[0] || null,
  });
});

module.exports = { router, startScanning, detectMiddles, findArbitrages, findAltLineValue };
