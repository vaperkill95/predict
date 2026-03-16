/**
 * line-movement.js — Line Movement Tracking Service
 * 
 * Snapshots player prop lines at regular intervals and serves historical
 * line movement data. Stores snapshots in-memory with a rolling 48-hour window.
 * 
 * How it works:
 *   1. Every 15 minutes, snapshots all current props from the Odds API
 *   2. Stores timestamped line data per player+market+game
 *   3. API endpoints serve movement data for the frontend sparkline charts
 * 
 * Setup:
 *   const lineMovement = require('./line-movement');
 *   
 *   // In server.js — mount the routes
 *   app.use('/api/movement', lineMovement.router);
 *   
 *   // Start the snapshot cron (every 15 min)
 *   lineMovement.startTracking(getPropsFunction);
 */

const express = require('express');
const router = express.Router();

// ============================================================
// In-memory storage (replace with Redis/DB for persistence)
// ============================================================

// Structure: { "player|market|gameId": [ {timestamp, consensus, books: {name: {point, overPrice, underPrice}}} ] }
const lineHistory = {};

// Config
const MAX_HISTORY_HOURS = 48;
const SNAPSHOT_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_SNAPSHOTS_PER_PROP = 200; // ~48 hours at 15-min intervals

let lastSnapshotTime = null;
let snapshotCount = 0;
let trackedProps = 0;

/**
 * Generate a unique key for a prop
 */
function propKey(player, market, gameId) {
  return `${player}|${market}|${gameId}`;
}

/**
 * Take a snapshot of all current props
 * @param {Function} fetchProps - async function(sport) that returns {props: [...]}
 */
async function snapshotProps(fetchProps) {
  const sports = ['nba', 'nfl', 'mlb', 'nhl'];
  const now = new Date().toISOString();
  let totalSnapped = 0;

  for (const sport of sports) {
    try {
      const data = await fetchProps(sport);
      const props = data.props || data || [];

      for (const prop of props) {
        if (!prop.player || !prop.market || !prop.gameId) continue;

        const key = propKey(prop.player, prop.market, prop.gameId);

        if (!lineHistory[key]) {
          lineHistory[key] = {
            player: prop.player,
            market: prop.market,
            marketLabel: prop.marketLabel,
            game: prop.game,
            gameId: prop.gameId,
            sport,
            commenceTime: prop.commenceTime,
            snapshots: [],
          };
        }

        // Build the snapshot
        const bookLines = {};
        for (const book of (prop.books || [])) {
          bookLines[book.name] = {
            point: book.over?.point || book.under?.point,
            overPrice: book.over?.price,
            underPrice: book.under?.price,
          };
        }

        const snapshot = {
          t: now,
          consensus: prop.consensusLine,
          bookCount: prop.bookCount,
          bestOver: prop.bestOver,
          bestUnder: prop.bestUnder,
          books: bookLines,
        };

        // Only add if the line actually changed (or it's the first snapshot)
        const existing = lineHistory[key].snapshots;
        const last = existing[existing.length - 1];
        const lineChanged = !last || last.consensus !== snapshot.consensus ||
          JSON.stringify(last.books) !== JSON.stringify(snapshot.books);

        if (lineChanged) {
          existing.push(snapshot);
          totalSnapped++;
        }

        // Trim old snapshots
        const cutoff = new Date(Date.now() - MAX_HISTORY_HOURS * 60 * 60 * 1000).toISOString();
        lineHistory[key].snapshots = existing.filter(s => s.t >= cutoff);

        // Cap max snapshots
        if (lineHistory[key].snapshots.length > MAX_SNAPSHOTS_PER_PROP) {
          lineHistory[key].snapshots = lineHistory[key].snapshots.slice(-MAX_SNAPSHOTS_PER_PROP);
        }
      }
    } catch (err) {
      console.error(`Line movement snapshot failed for ${sport}:`, err.message);
    }
  }

  lastSnapshotTime = now;
  snapshotCount++;
  trackedProps = Object.keys(lineHistory).length;

  // Clean up old games (started more than 24 hours ago)
  const gamesCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  for (const key of Object.keys(lineHistory)) {
    if (lineHistory[key].commenceTime && lineHistory[key].commenceTime < gamesCutoff) {
      delete lineHistory[key];
    }
  }

  console.log(`Line movement: snapshotted ${totalSnapped} changes across ${sports.length} sports (${trackedProps} total props tracked)`);
}

/**
 * Start the automatic snapshot cron
 * @param {Function} fetchProps - async function(sport) that returns props data
 */
function startTracking(fetchProps) {
  console.log('Line movement tracking started (every 15 min)');

  // Initial snapshot
  snapshotProps(fetchProps).catch(err => console.error('Initial snapshot failed:', err.message));

  // Recurring snapshots
  setInterval(() => {
    snapshotProps(fetchProps).catch(err => console.error('Snapshot failed:', err.message));
  }, SNAPSHOT_INTERVAL_MS);
}

// ============================================================
// API Routes
// ============================================================

/**
 * GET /api/movement/status
 * Returns tracking status
 */
router.get('/status', (req, res) => {
  res.json({
    tracking: true,
    lastSnapshot: lastSnapshotTime,
    snapshotCount,
    trackedProps,
    intervalMinutes: SNAPSHOT_INTERVAL_MS / 60000,
    maxHistoryHours: MAX_HISTORY_HOURS,
  });
});

/**
 * GET /api/movement/:sport
 * Returns all props with movement data for a sport
 * Query params: ?movedOnly=true (only return props where line changed)
 */
router.get('/:sport', (req, res) => {
  const { sport } = req.params;
  const movedOnly = req.query.movedOnly === 'true';

  const results = [];

  for (const [key, data] of Object.entries(lineHistory)) {
    if (data.sport !== sport) continue;
    if (data.snapshots.length < 1) continue;

    const snaps = data.snapshots;
    const first = snaps[0];
    const last = snaps[snaps.length - 1];
    const moved = first.consensus !== last.consensus;

    if (movedOnly && !moved) continue;

    // Calculate movement
    const openLine = first.consensus;
    const currentLine = last.consensus;
    const movement = currentLine - openLine;
    const direction = movement > 0 ? 'UP' : movement < 0 ? 'DOWN' : 'FLAT';

    // Find which books moved the most
    const bookMovements = {};
    for (const bookName of Object.keys(last.books || {})) {
      const firstBook = first.books?.[bookName];
      const lastBook = last.books?.[bookName];
      if (firstBook && lastBook && firstBook.point !== lastBook.point) {
        bookMovements[bookName] = {
          from: firstBook.point,
          to: lastBook.point,
          change: lastBook.point - firstBook.point,
        };
      }
    }

    results.push({
      player: data.player,
      market: data.market,
      marketLabel: data.marketLabel,
      game: data.game,
      gameId: data.gameId,
      openLine,
      currentLine,
      movement: +movement.toFixed(1),
      direction,
      snapshots: snaps.length,
      firstSeen: first.t,
      lastUpdated: last.t,
      bookMovements,
      // Sparkline data (just consensus values over time)
      sparkline: snaps.map(s => ({ t: s.t, v: s.consensus })),
    });
  }

  // Sort by absolute movement (biggest moves first)
  results.sort((a, b) => Math.abs(b.movement) - Math.abs(a.movement));

  res.json({
    sport,
    count: results.length,
    lastSnapshot: lastSnapshotTime,
    props: results,
  });
});

/**
 * GET /api/movement/:sport/:player/:market
 * Returns detailed movement history for a specific prop
 */
router.get('/:sport/:player/:market', (req, res) => {
  const { sport, player, market } = req.params;

  // Find matching prop (fuzzy match on player name)
  const playerLower = decodeURIComponent(player).toLowerCase();
  const marketLower = decodeURIComponent(market).toLowerCase();

  let match = null;
  for (const [key, data] of Object.entries(lineHistory)) {
    if (data.sport !== sport) continue;
    if (data.player.toLowerCase() === playerLower && data.market.toLowerCase().includes(marketLower)) {
      match = data;
      break;
    }
  }

  if (!match) {
    return res.json({ found: false, player, market, snapshots: [] });
  }

  const snaps = match.snapshots;
  const first = snaps[0];
  const last = snaps[snaps.length - 1];

  // Build per-book timelines
  const bookTimelines = {};
  for (const snap of snaps) {
    for (const [bookName, bookData] of Object.entries(snap.books || {})) {
      if (!bookTimelines[bookName]) bookTimelines[bookName] = [];
      bookTimelines[bookName].push({
        t: snap.t,
        point: bookData.point,
        overPrice: bookData.overPrice,
        underPrice: bookData.underPrice,
      });
    }
  }

  res.json({
    found: true,
    player: match.player,
    market: match.market,
    marketLabel: match.marketLabel,
    game: match.game,
    sport: match.sport,
    openLine: first?.consensus,
    currentLine: last?.consensus,
    movement: last && first ? +(last.consensus - first.consensus).toFixed(1) : 0,
    snapshotCount: snaps.length,
    firstSeen: first?.t,
    lastUpdated: last?.t,
    consensusTimeline: snaps.map(s => ({ t: s.t, v: s.consensus, bookCount: s.bookCount })),
    bookTimelines,
  });
});

/**
 * GET /api/movement/:sport/biggest
 * Returns the biggest line moves of the day (most interesting for bettors)
 */
router.get('/:sport/biggest', (req, res) => {
  const { sport } = req.params;
  const limit = parseInt(req.query.limit) || 10;

  const moves = [];

  for (const [key, data] of Object.entries(lineHistory)) {
    if (data.sport !== sport) continue;
    if (data.snapshots.length < 2) continue;

    const first = data.snapshots[0];
    const last = data.snapshots[data.snapshots.length - 1];
    const movement = last.consensus - first.consensus;

    if (Math.abs(movement) < 0.5) continue; // Only significant moves

    moves.push({
      player: data.player,
      market: data.marketLabel || data.market,
      game: data.game,
      openLine: first.consensus,
      currentLine: last.consensus,
      movement: +movement.toFixed(1),
      direction: movement > 0 ? 'UP' : 'DOWN',
      firstSeen: first.t,
      lastUpdated: last.t,
      sparkline: data.snapshots.map(s => ({ t: s.t, v: s.consensus })),
    });
  }

  moves.sort((a, b) => Math.abs(b.movement) - Math.abs(a.movement));

  res.json({
    sport,
    biggestMoves: moves.slice(0, limit),
    total: moves.length,
    lastSnapshot: lastSnapshotTime,
  });
});

module.exports = { router, startTracking, snapshotProps, lineHistory };
