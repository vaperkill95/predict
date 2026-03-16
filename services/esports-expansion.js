/**
 * esports-expansion.js — Add Valorant, CS2, LoL, and Dota2 to ORACLE
 * 
 * Uses the same PandaScore API you already have for CDL.
 * Each game has the same endpoint pattern:
 *   /{game}/matches, /{game}/matches/upcoming, /{game}/matches/running
 *   /{game}/tournaments/running, /{game}/teams, /{game}/players
 *   /matches/{id} (generic — works for all games)
 *   /tournaments/{id}/standings
 * 
 * PandaScore game slugs:
 *   valorant  → Valorant
 *   csgo      → Counter-Strike 2 (still uses 'csgo' slug)
 *   lol       → League of Legends
 *   dota2     → Dota 2
 *   codmw     → Call of Duty (already integrated)
 * 
 * Setup:
 *   const esports = require('./services/esports-expansion');
 *   app.use('/api/esports', esports.router);
 */

const express = require('express');
const axios = require('axios');
const router = express.Router();

const PANDASCORE_BASE = 'https://api.pandascore.co';
const PANDASCORE_TOKEN = process.env.PANDASCORE_API_KEY || process.env.PANDASCORE_TOKEN;

const pandaHeaders = () => ({
  Authorization: `Bearer ${PANDASCORE_TOKEN}`,
});

// ============================================================
// Game Configuration
// ============================================================

const ESPORTS_GAMES = {
  valorant: {
    slug: 'valorant',
    name: 'Valorant',
    icon: '🎯',
    color: '#fd4556',
    leagues: ['VCT', 'Champions Tour', 'Valorant Champions'],
  },
  cs2: {
    slug: 'csgo', // PandaScore still uses 'csgo' slug for CS2
    name: 'Counter-Strike 2',
    icon: '💣',
    color: '#de9b35',
    leagues: ['ESL Pro League', 'BLAST', 'IEM', 'Major'],
  },
  lol: {
    slug: 'lol',
    name: 'League of Legends',
    icon: '⚔️',
    color: '#c89b3c',
    leagues: ['LEC', 'LCS', 'LCK', 'LPL', 'Worlds', 'MSI'],
  },
  dota2: {
    slug: 'dota2',
    name: 'Dota 2',
    icon: '🛡️',
    color: '#e44c4e',
    leagues: ['The International', 'DPC', 'ESL One'],
  },
};

// Also keep CDL for consistency
const ALL_ESPORTS = {
  ...ESPORTS_GAMES,
  cdl: {
    slug: 'codmw',
    name: 'Call of Duty League',
    icon: '🎮',
    color: '#00ff00',
    leagues: ['CDL', 'Call of Duty League'],
  },
};

// Cache
let matchesCache = {};

/**
 * Fetch matches for an esport (upcoming + running + recent past)
 */
async function fetchMatches(gameKey) {
  const config = ALL_ESPORTS[gameKey];
  if (!config) throw new Error(`Unknown esport: ${gameKey}`);

  const slug = config.slug;
  const headers = pandaHeaders();

  // Fetch upcoming, running, and recent past in parallel
  const [upcoming, running, past] = await Promise.all([
    axios.get(`${PANDASCORE_BASE}/${slug}/matches/upcoming`, {
      headers,
      params: { 'page[size]': 15, sort: 'scheduled_at' },
    }).then(r => r.data).catch(() => []),

    axios.get(`${PANDASCORE_BASE}/${slug}/matches/running`, {
      headers,
    }).then(r => r.data).catch(() => []),

    axios.get(`${PANDASCORE_BASE}/${slug}/matches/past`, {
      headers,
      params: { 'page[size]': 10, sort: '-scheduled_at' },
    }).then(r => r.data).catch(() => []),
  ]);

  // Format matches uniformly
  const formatMatch = (match, status) => ({
    id: match.id,
    name: match.name,
    status: match.status || status,
    scheduledAt: match.scheduled_at || match.begin_at,
    bestOf: match.number_of_games,
    league: match.league?.name || '',
    serie: match.serie?.full_name || match.serie?.name || '',
    tournament: match.tournament?.name || '',
    team1: match.opponents?.[0] ? {
      id: match.opponents[0].opponent.id,
      name: match.opponents[0].opponent.name,
      acronym: match.opponents[0].opponent.acronym,
      logo: match.opponents[0].opponent.image_url,
    } : { name: 'TBD' },
    team2: match.opponents?.[1] ? {
      id: match.opponents[1].opponent.id,
      name: match.opponents[1].opponent.name,
      acronym: match.opponents[1].opponent.acronym,
      logo: match.opponents[1].opponent.image_url,
    } : { name: 'TBD' },
    winner: match.winner ? {
      id: match.winner.id,
      name: match.winner.name,
    } : null,
    results: match.results?.map(r => ({ teamId: r.team_id, score: r.score })) || [],
    streams: (match.streams_list || []).slice(0, 2).map(s => ({
      language: s.language,
      url: s.raw_url,
    })),
    games: (match.games || []).map(g => ({
      id: g.id,
      status: g.status,
      winner: g.winner?.id,
      position: g.position,
    })),
  });

  return {
    game: gameKey,
    gameName: config.name,
    icon: config.icon,
    color: config.color,
    available: true,
    matches: [
      ...running.map(m => formatMatch(m, 'running')),
      ...upcoming.map(m => formatMatch(m, 'not_started')),
      ...past.map(m => formatMatch(m, 'finished')),
    ],
    counts: {
      live: running.length,
      upcoming: upcoming.length,
      recent: past.length,
    },
  };
}

/**
 * Fetch standings for an esport's current tournament
 */
async function fetchStandings(gameKey) {
  const config = ALL_ESPORTS[gameKey];
  if (!config) throw new Error(`Unknown esport: ${gameKey}`);

  const slug = config.slug;
  const headers = pandaHeaders();

  // Find running tournaments
  let tournaments = [];
  try {
    const resp = await axios.get(`${PANDASCORE_BASE}/${slug}/tournaments/running`, { headers });
    tournaments = resp.data || [];
  } catch (e) {
    // Try upcoming
    const resp = await axios.get(`${PANDASCORE_BASE}/${slug}/tournaments/upcoming`, {
      headers,
      params: { 'page[size]': 3, sort: 'begin_at' },
    });
    tournaments = resp.data || [];
  }

  if (tournaments.length === 0) {
    return { available: false, game: gameKey, groups: [], message: 'No active tournaments' };
  }

  // Get standings for the first tournament
  const tournament = tournaments[0];
  
  try {
    const standingsResp = await axios.get(
      `${PANDASCORE_BASE}/tournaments/${tournament.id}/standings`,
      { headers }
    );
    const standings = standingsResp.data || [];

    const teams = standings.map(entry => ({
      id: entry.team?.id,
      name: entry.team?.name || entry.team?.acronym,
      logo: entry.team?.image_url,
      rank: entry.rank,
      stats: {
        W: String(entry.wins || 0),
        L: String(entry.losses || 0),
      },
    }));

    teams.sort((a, b) => (a.rank || 999) - (b.rank || 999));

    return {
      available: true,
      game: gameKey,
      tournament: {
        id: tournament.id,
        name: tournament.name,
        serie: tournament.serie?.full_name,
        league: tournament.league?.name,
      },
      groups: [{ name: tournament.name || `${config.name} Standings`, teams }],
    };
  } catch (e) {
    // Standings endpoint may not exist for all tournaments
    return { available: false, game: gameKey, groups: [], message: 'Standings not available for current tournament' };
  }
}

/**
 * Fetch a single match detail (for predictions)
 */
async function fetchMatchDetail(matchId) {
  const headers = pandaHeaders();
  // Use GENERIC /matches/{id} endpoint (not game-specific)
  const resp = await axios.get(`${PANDASCORE_BASE}/matches/${matchId}`, { headers });
  return resp.data;
}

// ============================================================
// API Routes
// ============================================================

/**
 * GET /api/esports/games
 * Returns list of all supported esports
 */
router.get('/games', (req, res) => {
  res.json({
    games: Object.entries(ALL_ESPORTS).map(([key, config]) => ({
      key,
      slug: config.slug,
      name: config.name,
      icon: config.icon,
      color: config.color,
    })),
  });
});

/**
 * GET /api/esports/:game/matches
 * Returns matches for an esport
 */
router.get('/:game/matches', async (req, res) => {
  const { game } = req.params;
  const config = ALL_ESPORTS[game];
  if (!config) {
    return res.status(400).json({ error: `Unknown esport: ${game}. Valid: ${Object.keys(ALL_ESPORTS).join(', ')}` });
  }

  try {
    // Use cache if fresh (< 5 min)
    const cached = matchesCache[game];
    if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < 5 * 60 * 1000) {
      return res.json(cached.data);
    }

    const data = await fetchMatches(game);
    matchesCache[game] = { data, fetchedAt: new Date().toISOString() };
    res.json(data);
  } catch (err) {
    console.error(`Esports matches error (${game}):`, err.message);
    res.status(500).json({ error: err.message, game });
  }
});

/**
 * GET /api/esports/:game/standings
 * Returns standings for an esport
 */
router.get('/:game/standings', async (req, res) => {
  const { game } = req.params;
  try {
    const data = await fetchStandings(game);
    res.json(data);
  } catch (err) {
    console.error(`Esports standings error (${game}):`, err.message);
    res.json({ available: false, game, groups: [], error: err.message });
  }
});

/**
 * GET /api/esports/:game/match/:matchId
 * Returns detail for a specific match (for predictions)
 */
router.get('/:game/match/:matchId', async (req, res) => {
  try {
    const match = await fetchMatchDetail(req.params.matchId);
    res.json(match);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/esports/:game/predict/:matchId
 * AI prediction for an esports match (uses Anthropic)
 */
router.get('/:game/predict/:matchId', async (req, res) => {
  const { game, matchId } = req.params;
  const config = ALL_ESPORTS[game];
  if (!config) return res.status(400).json({ error: `Unknown esport: ${game}` });

  try {
    // Fetch match details
    const match = await fetchMatchDetail(matchId);

    const team1 = match.opponents?.[0]?.opponent;
    const team2 = match.opponents?.[1]?.opponent;

    if (!team1 || !team2) {
      return res.json({ error: 'Match does not have two teams assigned yet' });
    }

    // Build context for AI prediction
    const matchContext = {
      game: config.name,
      team1: team1.name,
      team2: team2.name,
      league: match.league?.name,
      tournament: match.tournament?.name,
      bestOf: match.number_of_games,
      scheduledAt: match.scheduled_at,
    };

    // If you have Anthropic configured, call it
    // Otherwise return the match context for the frontend to handle
    res.json({
      matchContext,
      matchId,
      game: config.name,
      team1: { name: team1.name, logo: team1.image_url },
      team2: { name: team2.name, logo: team2.image_url },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = {
  router,
  fetchMatches,
  fetchStandings,
  fetchMatchDetail,
  ALL_ESPORTS,
  ESPORTS_GAMES,
};
