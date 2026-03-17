/**
 * enhanced-analytics.js — FIXED VERSION
 * 
 * Uses ESPN game log API instead of Basketball Reference
 * (BBRef blocks cloud server IPs like Railway)
 * 
 * ESPN Endpoints (free, no key needed):
 *   Search: https://site.api.espn.com/apis/common/v3/search?query={name}&type=player
 *   Profile: https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/{id}
 *   Game Log: https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/{id}/gamelog
 * 
 * Stats available per game:
 *   minutes, FGM-FGA, FG%, 3PM-3PA, 3P%, FTM-FTA, FT%, REB, AST, BLK, STL, PF, TO, PTS
 *   Plus: gameDate, atVs (@ or vs), opponent, gameResult (W/L), score
 * 
 * Setup:
 *   const analytics = require('./services/enhanced-analytics');
 *   app.use('/api/analytics', analytics.router);
 *   analytics.startRefresh();
 */

const express = require('express');
const axios = require('axios');
const router = express.Router();

const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const playerCache = {}; // { "playername": { data, fetchedAt } }
const espnIdCache = {}; // { "playername": espnId }

// ============================================================
// ESPN Player Search
// ============================================================

async function findESPNPlayerId(playerName) {
  const lower = playerName.toLowerCase();
  if (espnIdCache[lower]) return espnIdCache[lower];

  try {
    // Method 1: Direct search API
    const searchResp = await axios.get(
      'https://site.api.espn.com/apis/common/v3/search',
      {
        params: { query: playerName, limit: 3, type: 'player' },
        timeout: 8000,
      }
    );
    const items = searchResp.data?.items || [];
    if (items.length > 0) {
      espnIdCache[lower] = items[0].id;
      return items[0].id;
    }
  } catch (err) {
    console.warn(`ESPN search failed for ${playerName}: ${err.message}`);
  }

  try {
    // Method 2: Core athletes search
    const coreResp = await axios.get(
      'https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/athletes',
      {
        params: { limit: 3, active: true, search: playerName.split(' ').pop() },
        timeout: 8000,
      }
    );
    const ref = coreResp.data?.items?.[0]?.['$ref'];
    if (ref) {
      const idMatch = ref.match(/athletes\/(\d+)/);
      if (idMatch) {
        espnIdCache[lower] = idMatch[1];
        return idMatch[1];
      }
    }
  } catch (err) {
    // silently fail
  }

  return null;
}

// ============================================================
// ESPN Game Log Fetcher
// ============================================================

async function fetchESPNGameLog(espnPlayerId) {
  try {
    const resp = await axios.get(
      `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${espnPlayerId}/gamelog`,
      { timeout: 10000 }
    );

    const data = resp.data;
    const names = data.names || [];
    // names: [minutes, FGM-FGA, FG%, 3PM-3PA, 3P%, FTM-FTA, FT%, REB, AST, BLK, STL, PF, TO, PTS]
    const events = data.events || {};
    const regSeason = data.seasonTypes?.find(s => s.displayName?.includes('Regular'));

    if (!regSeason) return [];

    // Get all game event IDs with stats
    const allGames = [];
    for (const cat of (regSeason.categories || [])) {
      for (const game of (cat.events || [])) {
        const eventInfo = events[game.eventId];
        if (!eventInfo || !game.stats) continue;

        const stats = game.stats;
        // Parse compound stats like "9-20" for FGM-FGA
        const parseFraction = (str) => {
          if (!str) return [0, 0];
          const parts = str.split('-');
          return [parseInt(parts[0]) || 0, parseInt(parts[1]) || 0];
        };

        const [fgm, fga] = parseFraction(stats[1]);
        const [fg3m, fg3a] = parseFraction(stats[3]);
        const [ftm, fta] = parseFraction(stats[5]);

        const gameDate = eventInfo.gameDate;
        const dateObj = new Date(gameDate);

        allGames.push({
          date: gameDate?.split('T')[0] || '',
          dayOfWeek: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dateObj.getDay()],
          month: dateObj.getMonth() + 1,
          isHome: eventInfo.atVs === 'vs',
          opponent: eventInfo.opponent?.abbreviation || '',
          result: eventInfo.gameResult || '',
          minutes: parseInt(stats[0]) || 0,
          pts: parseInt(stats[13]) || 0,
          reb: parseInt(stats[7]) || 0,
          ast: parseInt(stats[8]) || 0,
          blk: parseInt(stats[9]) || 0,
          stl: parseInt(stats[10]) || 0,
          tov: parseInt(stats[12]) || 0,
          fg3: fg3m,
          fg: fgm,
          fga,
          fg3a,
          ft: ftm,
          fta,
          fgPct: fga > 0 ? +(fgm / fga).toFixed(3) : 0,
          plusMinus: 0,
        });
      }
    }

    // Sort by date ascending
    allGames.sort((a, b) => new Date(a.date) - new Date(b.date));
    return allGames;
  } catch (err) {
    console.error(`ESPN game log fetch failed for ${espnPlayerId}:`, err.message);
    return [];
  }
}

// ============================================================
// Splits Computation
// ============================================================

function computeSplits(games) {
  if (!games || games.length < 3) return null;

  const avg = (arr) => arr.length > 0 ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : 0;
  const statAvg = (gms, stat) => avg(gms.map(g => g[stat]));

  // Season averages
  const seasonAvg = {
    games: games.length,
    pts: statAvg(games, 'pts'),
    reb: statAvg(games, 'reb'),
    ast: statAvg(games, 'ast'),
    fg3: statAvg(games, 'fg3'),
    fgPct: avg(games.filter(g => g.fgPct).map(g => g.fgPct)),
    winPct: +(games.filter(g => g.result === 'W').length / games.length).toFixed(3),
  };

  // Day of Week
  const dayOfWeek = {};
  for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
    const dg = games.filter(g => g.dayOfWeek === day);
    if (dg.length >= 2) {
      dayOfWeek[day] = {
        games: dg.length, pts: statAvg(dg, 'pts'), reb: statAvg(dg, 'reb'),
        ast: statAvg(dg, 'ast'), fg3: statAvg(dg, 'fg3'),
        winPct: +(dg.filter(g => g.result === 'W').length / dg.length).toFixed(3),
      };
    }
  }

  // Rest Days
  const restSplits = { b2b: [], oneDay: [], rested: [] };
  for (let i = 0; i < games.length; i++) {
    if (i === 0) { restSplits.rested.push(games[i]); continue; }
    const diff = Math.round((new Date(games[i].date) - new Date(games[i - 1].date)) / 86400000);
    if (diff <= 1) restSplits.b2b.push(games[i]);
    else if (diff === 2) restSplits.oneDay.push(games[i]);
    else restSplits.rested.push(games[i]);
  }
  const restDays = {};
  if (restSplits.b2b.length >= 2) restDays.backToBack = { games: restSplits.b2b.length, pts: statAvg(restSplits.b2b, 'pts'), reb: statAvg(restSplits.b2b, 'reb'), ast: statAvg(restSplits.b2b, 'ast') };
  if (restSplits.oneDay.length >= 2) restDays.oneDay = { games: restSplits.oneDay.length, pts: statAvg(restSplits.oneDay, 'pts'), reb: statAvg(restSplits.oneDay, 'reb'), ast: statAvg(restSplits.oneDay, 'ast') };
  if (restSplits.rested.length >= 2) restDays.wellRested = { games: restSplits.rested.length, pts: statAvg(restSplits.rested, 'pts'), reb: statAvg(restSplits.rested, 'reb'), ast: statAvg(restSplits.rested, 'ast') };

  // Home vs Away
  const homeGames = games.filter(g => g.isHome);
  const awayGames = games.filter(g => !g.isHome);
  const homeAway = {
    home: homeGames.length >= 3 ? { games: homeGames.length, pts: statAvg(homeGames, 'pts'), reb: statAvg(homeGames, 'reb'), ast: statAvg(homeGames, 'ast') } : null,
    away: awayGames.length >= 3 ? { games: awayGames.length, pts: statAvg(awayGames, 'pts'), reb: statAvg(awayGames, 'reb'), ast: statAvg(awayGames, 'ast') } : null,
  };

  // vs Opponent
  const vsOpponent = {};
  for (const opp of [...new Set(games.map(g => g.opponent))]) {
    const og = games.filter(g => g.opponent === opp);
    if (og.length >= 1) {
      vsOpponent[opp] = { games: og.length, pts: statAvg(og, 'pts'), reb: statAvg(og, 'reb'), ast: statAvg(og, 'ast') };
    }
  }

  // Recent form
  const last5 = games.slice(-5);
  const last10 = games.slice(-10);
  const recentForm = {
    last5: { games: last5.length, pts: statAvg(last5, 'pts'), reb: statAvg(last5, 'reb'), ast: statAvg(last5, 'ast'), fg3: statAvg(last5, 'fg3') },
    last10: { games: last10.length, pts: statAvg(last10, 'pts'), reb: statAvg(last10, 'reb'), ast: statAvg(last10, 'ast'), fg3: statAvg(last10, 'fg3') },
  };

  // Monthly
  const monthly = {};
  for (const g of games) {
    const m = g.date.substring(0, 7);
    if (!monthly[m]) monthly[m] = [];
    monthly[m].push(g);
  }
  const monthlyAvgs = {};
  for (const [m, mg] of Object.entries(monthly)) {
    monthlyAvgs[m] = { games: mg.length, pts: statAvg(mg, 'pts'), reb: statAvg(mg, 'reb'), ast: statAvg(mg, 'ast') };
  }

  // Hit rates
  const hitRates = {};
  for (const stat of ['pts', 'reb', 'ast', 'fg3']) {
    const vals = games.map(g => g[stat]).sort((a, b) => a - b);
    const mean = statAvg(games, stat);
    const variance = vals.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / vals.length;
    hitRates[stat] = {
      mean, median: vals[Math.floor(vals.length / 2)],
      min: vals[0], max: vals[vals.length - 1],
      stdDev: +Math.sqrt(variance).toFixed(1),
      overRates: {},
    };
    const lines = stat === 'pts' ? [15, 17.5, 20, 22.5, 25, 27.5, 30, 35] :
                  stat === 'reb' ? [3, 4, 5, 6, 7, 8, 10, 12] :
                  stat === 'ast' ? [2, 3, 4, 5, 6, 7, 8, 10] :
                  [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];
    for (const line of lines) {
      hitRates[stat].overRates[line] = +((vals.filter(v => v > line).length / vals.length) * 100).toFixed(1);
    }
  }

  return { seasonAvg, dayOfWeek, restDays, homeAway, vsOpponent, recentForm, monthly: monthlyAvgs, hitRates };
}

// ============================================================
// Player Profile Builder
// ============================================================

async function buildPlayerProfile(playerName) {
  const lower = playerName.toLowerCase();
  const cached = playerCache[lower];
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;

  console.log(`Building ESPN profile for ${playerName}...`);

  const espnId = await findESPNPlayerId(playerName);
  if (!espnId) return { found: false, player: playerName, message: 'Player not found on ESPN' };

  const games = await fetchESPNGameLog(espnId);
  const splits = computeSplits(games);

  // Also get profile summary
  let profile = {};
  try {
    const profResp = await axios.get(
      `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${espnId}`,
      { timeout: 8000 }
    );
    const athlete = profResp.data?.athlete;
    profile = {
      team: athlete?.team?.abbreviation,
      position: athlete?.position?.abbreviation,
      jersey: athlete?.jersey,
      headshot: athlete?.headshot?.href,
      statsSummary: athlete?.statsSummary?.statistics?.reduce((acc, s) => {
        acc[s.name] = { value: s.value, display: s.displayValue, rank: s.rank };
        return acc;
      }, {}),
    };
  } catch (e) { /* optional */ }

  const data = {
    found: true,
    player: playerName,
    espnId,
    ...profile,
    gamesPlayed: games.length,
    lastUpdated: new Date().toISOString(),
    splits,
    gameLog: games.slice(-10),
  };

  playerCache[lower] = { data, fetchedAt: Date.now() };
  return data;
}

// ============================================================
// API Routes
// ============================================================

router.get('/player/:name', async (req, res) => {
  try {
    const profile = await buildPlayerProfile(decodeURIComponent(req.params.name));
    res.json(profile);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/player/:name/matchup', async (req, res) => {
  const playerName = decodeURIComponent(req.params.name);
  const { opponent, dayOfWeek, restDays } = req.query;

  try {
    const profile = await buildPlayerProfile(playerName);
    if (!profile.found || !profile.splits) return res.json({ found: false, message: 'No data' });

    const s = profile.splits;
    const factors = {};

    if (dayOfWeek && s.dayOfWeek[dayOfWeek]) {
      const d = s.dayOfWeek[dayOfWeek];
      factors.dayOfWeek = { day: dayOfWeek, data: d, ptsVsSeason: +(d.pts - s.seasonAvg.pts).toFixed(1) };
    }
    if (opponent && s.vsOpponent[opponent]) {
      factors.vsOpponent = s.vsOpponent[opponent];
    }
    if (restDays !== undefined) {
      const r = parseInt(restDays);
      if (r <= 1 && s.restDays.backToBack) factors.rest = { type: 'backToBack', ...s.restDays.backToBack };
      else if (r === 2 && s.restDays.oneDay) factors.rest = { type: 'oneDay', ...s.restDays.oneDay };
      else if (s.restDays.wellRested) factors.rest = { type: 'wellRested', ...s.restDays.wellRested };
    }
    factors.recentForm = s.recentForm;

    // Weighted forecast
    let ptsForecast = s.seasonAvg.pts;
    const adjustments = [];
    if (factors.dayOfWeek?.ptsVsSeason) {
      const adj = factors.dayOfWeek.ptsVsSeason * 0.3;
      ptsForecast += adj;
      if (Math.abs(adj) > 0.5) adjustments.push(`${dayOfWeek}: ${adj > 0 ? '+' : ''}${adj.toFixed(1)}`);
    }
    if (factors.vsOpponent) {
      const adj = (factors.vsOpponent.pts - s.seasonAvg.pts) * 0.25;
      ptsForecast += adj;
      if (Math.abs(adj) > 0.5) adjustments.push(`vs ${opponent}: ${adj > 0 ? '+' : ''}${adj.toFixed(1)}`);
    }
    if (factors.rest?.pts) {
      const adj = (factors.rest.pts - s.seasonAvg.pts) * 0.2;
      ptsForecast += adj;
      if (Math.abs(adj) > 0.5) adjustments.push(`Rest: ${adj > 0 ? '+' : ''}${adj.toFixed(1)}`);
    }
    if (s.recentForm?.last5?.pts) {
      const adj = (s.recentForm.last5.pts - s.seasonAvg.pts) * 0.25;
      ptsForecast += adj;
      if (Math.abs(adj) > 0.5) adjustments.push(`Form: ${adj > 0 ? '+' : ''}${adj.toFixed(1)}`);
    }

    res.json({ found: true, player: playerName, seasonAvg: s.seasonAvg, factors, forecast: { pts: +ptsForecast.toFixed(1), adjustments }, hitRates: s.hitRates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/player/:name/hitrate', async (req, res) => {
  const { stat, line } = req.query;
  if (!stat || !line) return res.json({ error: 'Required: ?stat=pts&line=25.5' });

  try {
    const profile = await buildPlayerProfile(decodeURIComponent(req.params.name));
    if (!profile.found || !profile.splits?.hitRates?.[stat]) return res.json({ found: false });

    const hr = profile.splits.hitRates[stat];
    const lineNum = parseFloat(line);
    const games = profile.gameLog || [];
    const closestLine = Object.keys(hr.overRates).map(Number).sort((a, b) => Math.abs(a - lineNum) - Math.abs(b - lineNum))[0];

    res.json({ found: true, stat, line: lineNum, seasonAvg: hr.mean, median: hr.median, stdDev: hr.stdDev, overRate: hr.overRates[closestLine] || 50, recentGames: games.slice(-5).map(g => g[stat]) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function startRefresh() {
  console.log('Enhanced analytics engine started (ESPN-powered, on-demand caching)');
}

module.exports = { router, startRefresh, buildPlayerProfile, findESPNPlayerId, playerCache };
