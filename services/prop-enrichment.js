/**
 * prop-enrichment.js — FIXED VERSION (ESPN-powered)
 * 
 * Uses ESPN game log API instead of Basketball Reference
 * Adds 10 data points to every prop row — matching and exceeding PickFinder.
 * 
 * Setup:
 *   const enrichment = require('./services/prop-enrichment');
 *   app.use('/api/enriched', enrichment.router);
 *   enrichment.startCache();
 */

const express = require('express');
const axios = require('axios');
const router = express.Router();

const CACHE_TTL_MS = 4 * 60 * 60 * 1000;
const PORT = process.env.PORT || 3001;

// Cache
const gameLogCache = {};  // { "playername_lower": { games, espnId, fetchedAt } }
const espnIdCache = {};   // { "playername_lower": espnId }

// ============================================================
// ESPN Player Search + Game Log
// ============================================================

async function findESPNId(playerName) {
  const lower = playerName.toLowerCase();
  if (espnIdCache[lower]) return espnIdCache[lower];

  try {
    const resp = await axios.get('https://site.api.espn.com/apis/common/v3/search', {
      params: { query: playerName, limit: 3, type: 'player' },
      timeout: 8000,
    });
    if (resp.data?.items?.length > 0) {
      espnIdCache[lower] = resp.data.items[0].id;
      return resp.data.items[0].id;
    }
  } catch (e) {}

  try {
    const resp = await axios.get('https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/athletes', {
      params: { limit: 3, active: true, search: playerName.split(' ').pop() },
      timeout: 8000,
    });
    const ref = resp.data?.items?.[0]?.['$ref'];
    if (ref) {
      const m = ref.match(/athletes\/(\d+)/);
      if (m) { espnIdCache[lower] = m[1]; return m[1]; }
    }
  } catch (e) {}

  return null;
}

async function fetchGameLog(playerName) {
  const lower = playerName.toLowerCase();
  const cached = gameLogCache[lower];
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.games;

  const espnId = await findESPNId(playerName);
  if (!espnId) return null;

  try {
    const resp = await axios.get(
      `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/${espnId}/gamelog`,
      { timeout: 10000 }
    );

    const data = resp.data;
    const events = data.events || {};
    const regSeason = data.seasonTypes?.find(s => s.displayName?.includes('Regular'));
    if (!regSeason) return null;

    const games = [];
    const parseFrac = (s) => { const p = (s || '').split('-'); return [parseInt(p[0]) || 0, parseInt(p[1]) || 0]; };

    for (const cat of (regSeason.categories || [])) {
      for (const game of (cat.events || [])) {
        const ev = events[game.eventId];
        if (!ev || !game.stats) continue;
        const s = game.stats;
        const [fgm, fga] = parseFrac(s[1]);
        const [fg3m, fg3a] = parseFrac(s[3]);
        const [ftm, fta] = parseFrac(s[5]);
        const d = new Date(ev.gameDate);

        games.push({
          date: ev.gameDate?.split('T')[0] || '',
          dayOfWeek: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()],
          isHome: ev.atVs === 'vs',
          opponent: ev.opponent?.abbreviation || '',
          result: ev.gameResult || '',
          minutes: parseInt(s[0]) || 0,
          pts: parseInt(s[13]) || 0,
          reb: parseInt(s[7]) || 0,
          ast: parseInt(s[8]) || 0,
          blk: parseInt(s[9]) || 0,
          stl: parseInt(s[10]) || 0,
          tov: parseInt(s[12]) || 0,
          fg3: fg3m, fg: fgm, fga, fg3a, ft: ftm, fta,
        });
      }
    }

    games.sort((a, b) => new Date(a.date) - new Date(b.date));
    gameLogCache[lower] = { games, espnId, fetchedAt: Date.now() };
    return games;
  } catch (err) {
    console.warn(`ESPN game log failed for ${playerName}: ${err.message}`);
    return null;
  }
}

// ============================================================
// Enrichment Engine
// ============================================================

function mapMarketToStat(market) {
  if (!market) return null;
  const m = market.toLowerCase();
  if (m.includes('point') || m.includes('pts')) return 'pts';
  if (m.includes('rebound') || m.includes('reb')) return 'reb';
  if (m.includes('assist') || m.includes('ast')) return 'ast';
  if (m.includes('3pt') || m.includes('three') || m.includes('3-pointer') || m.includes('fg3')) return 'fg3';
  if (m.includes('steal')) return 'stl';
  if (m.includes('block')) return 'blk';
  if (m.includes('turnover')) return 'tov';
  return null;
}

function enrichProp(prop, games) {
  if (!games || games.length < 5) return null;
  const statKey = mapMarketToStat(prop.market || prop.marketLabel);
  if (!statKey) return null;

  const values = games.map(g => g[statKey]);
  const line = prop.consensusLine;
  const seasonAvg = +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(1);
  const lineDiff = +(seasonAvg - line).toFixed(1);

  // Hit rate
  const overCount = values.filter(v => v > line).length;
  const hitRate = +((overCount / values.length) * 100).toFixed(1);

  // L5 / L10
  const last5 = games.slice(-5);
  const last10 = games.slice(-10);
  const l5Avg = +(last5.reduce((a, g) => a + g[statKey], 0) / last5.length).toFixed(1);
  const l10Avg = +(last10.reduce((a, g) => a + g[statKey], 0) / last10.length).toFixed(1);

  // Home/Away
  const homeGames = games.filter(g => g.isHome);
  const awayGames = games.filter(g => !g.isHome);
  const homeAvg = homeGames.length >= 3 ? +(homeGames.reduce((a, g) => a + g[statKey], 0) / homeGames.length).toFixed(1) : null;
  const awayAvg = awayGames.length >= 3 ? +(awayGames.reduce((a, g) => a + g[statKey], 0) / awayGames.length).toFixed(1) : null;

  // Day of week
  const today = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date().getDay()];
  const todayGames = games.filter(g => g.dayOfWeek === today);
  const dayAvg = todayGames.length >= 2 ? +(todayGames.reduce((a, g) => a + g[statKey], 0) / todayGames.length).toFixed(1) : null;

  // Game log bars
  const gameLogBars = games.slice(-15).map(g => ({ date: g.date, value: g[statKey], isHome: g.isHome, opponent: g.opponent, result: g.result }));

  // Rest days
  let restDays = null;
  if (games.length >= 2) {
    restDays = Math.round((new Date(games[games.length - 1].date) - new Date(games[games.length - 2].date)) / 86400000);
  }

  // vs Opponent
  const oppAbbrs = [prop.homeTeam, prop.awayTeam].filter(Boolean).map(t => {
    const words = t.split(' ');
    return words[words.length - 1]?.substring(0, 3).toUpperCase();
  });
  let vsOppAvg = null, vsOppGames = 0;
  for (const opp of oppAbbrs) {
    const og = games.filter(g => g.opponent?.toUpperCase().includes(opp));
    if (og.length > 0) {
      vsOppAvg = +(og.reduce((a, g) => a + g[statKey], 0) / og.length).toFixed(1);
      vsOppGames = og.length;
      break;
    }
  }

  // Trend
  const trendVal = +(l5Avg - seasonAvg).toFixed(1);
  const trend = trendVal > 2 ? 'hot' : trendVal < -2 ? 'cold' : 'steady';

  // Consistency
  const mean = seasonAvg;
  const stdDev = +Math.sqrt(values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / values.length).toFixed(1);
  const consistency = stdDev < 3 ? 'very_consistent' : stdDev < 5 ? 'consistent' : stdDev < 8 ? 'volatile' : 'very_volatile';

  // Confidence score
  let confidence = 50;
  confidence += Math.min(20, Math.abs(lineDiff) * 4);
  confidence += Math.abs(hitRate - 50) * 0.3;
  if (consistency === 'very_consistent') confidence += 10;
  else if (consistency === 'consistent') confidence += 5;
  if ((lineDiff > 0 && l5Avg > seasonAvg) || (lineDiff < 0 && l5Avg < seasonAvg)) confidence += 5;
  confidence = Math.min(99, Math.max(1, Math.round(confidence)));

  return {
    seasonAvg, lineDiff, lineDiffDirection: lineDiff > 0 ? 'OVER' : 'UNDER',
    hitRate, hitRateLabel: hitRate > 65 ? 'strong_over' : hitRate > 55 ? 'lean_over' : hitRate > 45 ? 'coin_flip' : hitRate > 35 ? 'lean_under' : 'strong_under',
    l5Avg, l10Avg, gamesPlayed: games.length,
    homeAvg, awayAvg, dayOfWeek: today, dayAvg, dayDiff: dayAvg ? +(dayAvg - seasonAvg).toFixed(1) : null,
    gameLogBars, line,
    restDays, isBackToBack: restDays !== null && restDays <= 1,
    vsOpponent: vsOppGames > 0 ? { games: vsOppGames, avg: vsOppAvg, diff: +(vsOppAvg - seasonAvg).toFixed(1) } : null,
    trend, trendValue: trendVal, stdDev, consistency, confidence,
    suggestion: lineDiff > 1.5 ? 'OVER' : lineDiff < -1.5 ? 'UNDER' : null,
  };
}

// ============================================================
// API Routes
// ============================================================

router.get('/props/:sport', async (req, res) => {
  const { sport } = req.params;
  try {
    const propsResp = await axios.get(`http://localhost:${PORT}/api/props/${sport}`, { timeout: 15000 });
    const propsData = propsResp.data;
    const props = propsData.props || [];
    if (props.length === 0) return res.json({ ...propsData, enriched: false });

    const uniquePlayers = [...new Set(props.map(p => p.player))];
    const gameLogs = {};
    let fetched = 0;

    for (const player of uniquePlayers) {
      const lower = player.toLowerCase();
      if (!gameLogCache[lower] || Date.now() - gameLogCache[lower].fetchedAt > CACHE_TTL_MS) {
        const games = await fetchGameLog(player);
        if (games) gameLogs[lower] = games;
        fetched++;
        if (fetched >= 15) break; // Cap fresh fetches per request
      } else {
        gameLogs[lower] = gameLogCache[lower].games;
      }
    }

    const enrichedProps = props.map(prop => {
      const games = gameLogs[prop.player.toLowerCase()];
      const analytics = games ? enrichProp(prop, games) : null;
      return { ...prop, enriched: !!analytics, analytics };
    });

    enrichedProps.sort((a, b) => (b.analytics?.confidence || 0) - (a.analytics?.confidence || 0));

    res.json({ ...propsData, props: enrichedProps, enriched: true, playersEnriched: Object.keys(gameLogs).length, totalPlayers: uniquePlayers.length });
  } catch (err) {
    try {
      const fallback = await axios.get(`http://localhost:${PORT}/api/props/${sport}`);
      res.json({ ...fallback.data, enriched: false, error: err.message });
    } catch (e) { res.status(500).json({ error: err.message }); }
  }
});

router.get('/player/:name', async (req, res) => {
  const playerName = decodeURIComponent(req.params.name);
  const games = await fetchGameLog(playerName);
  if (!games || games.length === 0) return res.json({ found: false, player: playerName });

  const splits = {};
  for (const stat of ['pts', 'reb', 'ast', 'fg3']) {
    const avg = (gms) => +(gms.reduce((a, g) => a + g[stat], 0) / Math.max(1, gms.length)).toFixed(1);
    splits[stat] = {
      seasonAvg: avg(games), l5: avg(games.slice(-5)), l10: avg(games.slice(-10)),
      home: avg(games.filter(g => g.isHome)), away: avg(games.filter(g => !g.isHome)),
      gameLog: games.slice(-20).map(g => ({ date: g.date, value: g[stat], opp: g.opponent, home: g.isHome })),
      byDay: {},
    };
    for (const day of ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']) {
      const dg = games.filter(g => g.dayOfWeek === day);
      if (dg.length >= 2) splits[stat].byDay[day] = avg(dg);
    }
  }
  res.json({ found: true, player: playerName, gamesPlayed: games.length, splits, recentGames: games.slice(-5) });
});

router.get('/cache/status', (req, res) => {
  res.json({ cachedPlayers: Object.keys(gameLogCache).length, players: Object.keys(gameLogCache).slice(0, 20) });
});

function startCache() { console.log('Prop enrichment engine started (ESPN-powered)'); }

module.exports = { router, startCache, enrichProp, fetchGameLog, gameLogCache };
