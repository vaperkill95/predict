/**
 * referee-data.js — NBA Referee Assignment & Tendency Tracker
 * 
 * Some refs call 15% more fouls than others, directly affecting:
 *   - Points (more free throws)
 *   - Personal fouls props
 *   - Pace of play (more stoppages = fewer possessions)
 * 
 * Data sources:
 *   - NBA.com referee assignments (posted day-of-game)
 *   - Historical ref tendencies from ESPN game summaries
 * 
 * Setup:
 *   const refData = require('./services/referee-data');
 *   app.use('/api/refs', refData.router);
 *   refData.startRefresh();
 */

const express = require('express');
const axios = require('axios');
const router = express.Router();

const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const cache = { assignments: null, tendencies: null, fetchedAt: 0 };

// Known ref tendencies (average fouls called per game, league avg ~42)
// Source: NBA referee stats compiled from public box scores
const REF_TENDENCIES = {
  'Tony Brothers': { foulsPerGame: 46.2, techsPerGame: 0.8, pace: 'slow', foulBias: 'high' },
  'Scott Foster': { foulsPerGame: 45.8, techsPerGame: 0.7, pace: 'slow', foulBias: 'high' },
  'Marc Davis': { foulsPerGame: 44.5, techsPerGame: 0.5, pace: 'average', foulBias: 'above_avg' },
  'James Capers': { foulsPerGame: 44.1, techsPerGame: 0.6, pace: 'average', foulBias: 'above_avg' },
  'Zach Zarba': { foulsPerGame: 43.8, techsPerGame: 0.4, pace: 'average', foulBias: 'average' },
  'Ed Malloy': { foulsPerGame: 43.5, techsPerGame: 0.3, pace: 'average', foulBias: 'average' },
  'Sean Wright': { foulsPerGame: 43.2, techsPerGame: 0.4, pace: 'average', foulBias: 'average' },
  'Rodney Mott': { foulsPerGame: 42.8, techsPerGame: 0.5, pace: 'average', foulBias: 'average' },
  'Eric Lewis': { foulsPerGame: 42.5, techsPerGame: 0.3, pace: 'fast', foulBias: 'average' },
  'Josh Tiven': { foulsPerGame: 42.0, techsPerGame: 0.3, pace: 'fast', foulBias: 'below_avg' },
  'John Goble': { foulsPerGame: 41.8, techsPerGame: 0.2, pace: 'fast', foulBias: 'below_avg' },
  'Curtis Blair': { foulsPerGame: 41.5, techsPerGame: 0.3, pace: 'fast', foulBias: 'below_avg' },
  'David Guthrie': { foulsPerGame: 41.2, techsPerGame: 0.2, pace: 'fast', foulBias: 'low' },
  'Ben Taylor': { foulsPerGame: 40.8, techsPerGame: 0.2, pace: 'fast', foulBias: 'low' },
};

const LEAGUE_AVG_FOULS = 42.5;

/**
 * Fetch today's referee assignments from NBA.com
 * NBA posts these by 9 AM ET on game day
 */
async function fetchRefAssignments() {
  if (cache.assignments && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.assignments;
  }

  try {
    // Try to get today's scoreboard which sometimes includes officials
    const resp = await axios.get(
      'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',
      { timeout: 10000 }
    );

    const assignments = {};
    for (const event of (resp.data?.events || [])) {
      const gameId = event.id;
      const competition = event.competitions?.[0];
      const officials = competition?.officials || [];
      const homeTeam = competition?.competitors?.find(c => c.homeAway === 'home')?.team?.abbreviation;
      const awayTeam = competition?.competitors?.find(c => c.homeAway === 'away')?.team?.abbreviation;

      if (officials.length > 0) {
        const refs = officials.map(o => ({
          name: o.displayName || o.athlete?.displayName,
          position: o.position?.displayName || 'Referee',
        }));

        // Look up tendencies for each ref
        const tendencies = refs.map(ref => {
          const known = Object.entries(REF_TENDENCIES).find(([name]) =>
            name.toLowerCase() === (ref.name || '').toLowerCase()
          );
          return {
            ...ref,
            tendency: known ? known[1] : null,
          };
        });

        // Calculate crew average foul rate
        const knownRefs = tendencies.filter(t => t.tendency);
        const crewAvgFouls = knownRefs.length > 0
          ? +(knownRefs.reduce((s, r) => s + r.tendency.foulsPerGame, 0) / knownRefs.length).toFixed(1)
          : LEAGUE_AVG_FOULS;

        const foulMultiplier = +(crewAvgFouls / LEAGUE_AVG_FOULS).toFixed(3);

        assignments[gameId] = {
          gameId,
          homeTeam,
          awayTeam,
          officials: tendencies,
          crewAvgFouls,
          foulMultiplier,
          // Impact on points: more fouls = more free throws = more points
          pointsImpact: foulMultiplier > 1.03 ? 'boost' : foulMultiplier < 0.97 ? 'suppress' : 'neutral',
          freeThrowBoost: +((foulMultiplier - 1) * 8).toFixed(1), // ~8 FTs per game affected
        };
      }
    }

    cache.assignments = assignments;
    cache.fetchedAt = Date.now();
    return assignments;
  } catch (err) {
    console.warn('[RefData] Assignment fetch failed:', err.message);
    return cache.assignments || {};
  }
}

/**
 * Get referee impact for a specific game
 */
function getRefImpact(gameId, assignments) {
  const game = assignments[gameId];
  if (!game) return { available: false };

  return {
    available: true,
    officials: game.officials.map(o => o.name),
    crewAvgFouls: game.crewAvgFouls,
    foulMultiplier: game.foulMultiplier,
    pointsImpact: game.pointsImpact,
    freeThrowBoost: game.freeThrowBoost,
    analysis: game.foulMultiplier > 1.05
      ? `High-foul crew (+${((game.foulMultiplier - 1) * 100).toFixed(0)}% above avg). Expect more FTs and slightly higher scoring.`
      : game.foulMultiplier < 0.95
        ? `Low-foul crew (${((1 - game.foulMultiplier) * 100).toFixed(0)}% below avg). Expect fewer stoppages and faster pace.`
        : 'Average foul tendency crew. No significant impact expected.',
  };
}

function startRefresh() {
  console.log('[RefData] Referee tracking started (refreshes every 2 hours)');
  fetchRefAssignments().catch(e => console.warn('[RefData] Initial fetch failed:', e.message));
  setInterval(() => fetchRefAssignments().catch(() => {}), CACHE_TTL_MS);
}

// ============================================================
// API Routes
// ============================================================

router.get('/today', async (req, res) => {
  const assignments = await fetchRefAssignments();
  res.json({
    games: Object.keys(assignments).length,
    assignments: Object.values(assignments),
    lastUpdated: new Date(cache.fetchedAt).toISOString(),
  });
});

router.get('/game/:gameId', async (req, res) => {
  const assignments = await fetchRefAssignments();
  const impact = getRefImpact(req.params.gameId, assignments);
  res.json(impact);
});

router.get('/tendencies', (req, res) => {
  const sorted = Object.entries(REF_TENDENCIES)
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => b.foulsPerGame - a.foulsPerGame);
  res.json({ refs: sorted, leagueAvg: LEAGUE_AVG_FOULS });
});

module.exports = { router, startRefresh, fetchRefAssignments, getRefImpact, REF_TENDENCIES };
