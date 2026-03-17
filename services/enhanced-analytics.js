/**
 * enhanced-analytics.js — Multi-Source Player Analytics Engine
 * 
 * Pulls data from 3 sources to build comprehensive player profiles:
 * 
 * 1. Basketball Reference — Game logs with dates (→ day of week, time splits)
 *    URL: https://www.basketball-reference.com/players/{letter}/{playerId}/gamelog/2026
 *    Data: Per-game stats with GAME_DATE, home/away, opponent, all box score stats
 * 
 * 2. NBA.com Stats API — Player game logs with advanced metrics
 *    URL: https://stats.nba.com/stats/playergamelog?PlayerID={id}&Season=2025-26
 *    Data: PTS, REB, AST, FG%, +/-, and game date/matchup
 * 
 * 3. Cleaning the Glass — Advanced shooting/efficiency metrics (scrape)
 *    URL: https://cleaningtheglass.com/stats/players
 *    Data: eFG%, TS%, usage rate, frequency by zone
 * 
 * Computed Splits:
 *   - Day of Week (Mon-Sun averages)
 *   - Time of Day (early/afternoon/prime time/late)
 *   - Rest Days (back-to-back, 1 day, 2+ days)
 *   - Home vs Away
 *   - vs Opponent history
 *   - Last 5 / Last 10 form
 *   - Monthly trends
 * 
 * Setup:
 *   const analytics = require('./services/enhanced-analytics');
 *   app.use('/api/analytics', analytics.router);
 *   analytics.startRefresh();
 */

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const router = express.Router();

// ============================================================
// Configuration
// ============================================================

const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const RATE_LIMIT_MS = 3500; // 3.5s between requests (BBRef limit: 20/min)

// NBA.com requires specific headers (blocks cloud IPs, but works from Railway sometimes)
const NBA_STATS_HEADERS = {
  'Host': 'stats.nba.com',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.nba.com/',
  'x-nba-stats-origin': 'stats',
  'x-nba-stats-token': 'true',
};

const BBREF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
};

// Cache: { playerId: { data, fetchedAt } }
const playerCache = {};

// Time classification
function classifyGameTime(timeStr) {
  if (!timeStr) return 'unknown';
  // Parse "7:00p" or "19:00" or "7:30 PM" formats
  let hour = 0;
  const match = timeStr.match(/(\d{1,2}):?(\d{2})?\s*(p|pm|a|am)?/i);
  if (match) {
    hour = parseInt(match[1]);
    const ampm = (match[3] || '').toLowerCase();
    if (ampm.startsWith('p') && hour < 12) hour += 12;
    if (ampm.startsWith('a') && hour === 12) hour = 0;
  }
  
  if (hour < 14) return 'early';      // Before 2 PM — matinee
  if (hour < 17) return 'afternoon';   // 2-5 PM
  if (hour < 21) return 'primetime';   // 5-9 PM — most games
  return 'late';                        // 9 PM+ — West Coast
}

function getDayOfWeek(dateStr) {
  const date = new Date(dateStr);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
}

function getRestDays(currentDate, previousDate) {
  if (!previousDate) return 3; // assume well-rested
  const diff = (new Date(currentDate) - new Date(previousDate)) / (1000 * 60 * 60 * 24);
  return Math.round(diff);
}

// ============================================================
// Source 1: Basketball Reference Game Logs
// ============================================================

/**
 * Scrape a player's game log from Basketball Reference
 * URL format: /players/{first letter}/{bbrefId}/gamelog/2026
 * 
 * @param {string} bbrefId - e.g. "jamesle01" for LeBron James
 * @param {number} season - end year, e.g. 2026 for 2025-26 season
 */
async function scrapeBBRefGameLog(bbrefId, season = 2026) {
  const url = `https://www.basketball-reference.com/players/${bbrefId.charAt(0)}/${bbrefId}/gamelog/${season}`;
  
  try {
    const resp = await axios.get(url, {
      headers: BBREF_HEADERS,
      timeout: 15000,
    });
    
    const $ = cheerio.load(resp.data);
    const games = [];
    
    // Parse the game log table (id="pgl_basic")
    $('#pgl_basic tbody tr:not(.thead)').each((i, row) => {
      const cells = $(row).find('td, th');
      if (cells.length < 10) return; // skip header/separator rows
      
      const getText = (stat) => $(row).find(`[data-stat="${stat}"]`).text().trim();
      
      const date = getText('date_game');
      const age = getText('age');
      const team = getText('team_id');
      const isHome = getText('game_location') !== '@';
      const opp = getText('opp_id');
      const result = getText('game_result');
      const mp = getText('mp');
      const pts = parseInt(getText('pts')) || 0;
      const reb = parseInt(getText('trb')) || 0;
      const ast = parseInt(getText('ast')) || 0;
      const stl = parseInt(getText('stl')) || 0;
      const blk = parseInt(getText('blk')) || 0;
      const tov = parseInt(getText('tov')) || 0;
      const fg = parseInt(getText('fg')) || 0;
      const fga = parseInt(getText('fga')) || 0;
      const fg3 = parseInt(getText('fg3')) || 0;
      const fg3a = parseInt(getText('fg3a')) || 0;
      const ft = parseInt(getText('ft')) || 0;
      const fta = parseInt(getText('fta')) || 0;
      const plusMinus = parseInt(getText('plus_minus')) || 0;
      
      if (date && pts > 0) {
        games.push({
          date,
          dayOfWeek: getDayOfWeek(date),
          team,
          isHome,
          opponent: opp,
          result: result.includes('W') ? 'W' : 'L',
          minutes: mp,
          pts, reb, ast, stl, blk, tov,
          fg, fga, fg3, fg3a, ft, fta,
          plusMinus,
          fgPct: fga > 0 ? +(fg / fga).toFixed(3) : 0,
          fg3Pct: fg3a > 0 ? +(fg3 / fg3a).toFixed(3) : 0,
          ftPct: fta > 0 ? +(ft / fta).toFixed(3) : 0,
        });
      }
    });
    
    return games;
  } catch (err) {
    console.error(`BBRef scrape failed for ${bbrefId}:`, err.message);
    return [];
  }
}

// ============================================================
// Source 2: NBA.com Stats API
// ============================================================

/**
 * Fetch player game log from NBA.com stats API
 * Note: NBA.com blocks many cloud IPs — this is a backup source
 */
async function fetchNBAComGameLog(nbaPlayerId, season = '2025-26') {
  const url = `https://stats.nba.com/stats/playergamelog`;
  
  try {
    const resp = await axios.get(url, {
      headers: NBA_STATS_HEADERS,
      params: {
        PlayerID: nbaPlayerId,
        Season: season,
        SeasonType: 'Regular Season',
      },
      timeout: 10000,
    });
    
    const data = resp.data;
    const headers = data.resultSets?.[0]?.headers || [];
    const rows = data.resultSets?.[0]?.rowSet || [];
    
    return rows.map(row => {
      const game = {};
      headers.forEach((h, i) => { game[h] = row[i]; });
      return {
        date: game.GAME_DATE,
        dayOfWeek: getDayOfWeek(game.GAME_DATE),
        matchup: game.MATCHUP,
        isHome: !game.MATCHUP?.includes('@'),
        result: game.WL,
        minutes: game.MIN,
        pts: game.PTS || 0,
        reb: game.REB || 0,
        ast: game.AST || 0,
        fg3: game.FG3M || 0,
        plusMinus: game.PLUS_MINUS || 0,
      };
    });
  } catch (err) {
    // NBA.com often blocks cloud IPs — fail silently
    console.warn(`NBA.com stats fetch failed for ${nbaPlayerId}: ${err.message}`);
    return [];
  }
}

// ============================================================
// Source 3: Cleaning the Glass (advanced metrics)
// ============================================================

/**
 * Scrape advanced player metrics from Cleaning the Glass
 * Note: CTG has a paywall for detailed data — we get what's on the free tier
 */
async function scrapeCTGPlayer(playerSlug) {
  try {
    const url = `https://cleaningtheglass.com/stats/player/${playerSlug}`;
    const resp = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 10000,
    });
    
    const $ = cheerio.load(resp.data);
    
    // CTG shows eFG%, TS%, usage, etc. in the player overview
    const stats = {};
    $('.stat-value').each((i, el) => {
      const label = $(el).siblings('.stat-label').text().trim();
      const value = $(el).text().trim();
      if (label && value) {
        stats[label] = value;
      }
    });
    
    return stats;
  } catch (err) {
    console.warn(`CTG scrape failed for ${playerSlug}: ${err.message}`);
    return {};
  }
}

// ============================================================
// Splits Computation Engine
// ============================================================

/**
 * Compute comprehensive splits from game log data
 */
function computeSplits(games) {
  if (!games || games.length === 0) return null;
  
  const avg = (arr) => arr.length > 0 ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : 0;
  const statAvg = (games, stat) => avg(games.map(g => g[stat]));
  
  // Day of Week splits
  const dayOfWeekSplits = {};
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  for (const day of days) {
    const dayGames = games.filter(g => g.dayOfWeek === day);
    if (dayGames.length >= 2) {
      dayOfWeekSplits[day] = {
        games: dayGames.length,
        pts: statAvg(dayGames, 'pts'),
        reb: statAvg(dayGames, 'reb'),
        ast: statAvg(dayGames, 'ast'),
        fg3: statAvg(dayGames, 'fg3'),
        winPct: +(dayGames.filter(g => g.result === 'W').length / dayGames.length).toFixed(3),
      };
    }
  }
  
  // Time of Day splits (requires game time data — use from schedule)
  // We tag games with time classification during fetch
  const timeOfDaySplits = {};
  const timeSlots = ['early', 'afternoon', 'primetime', 'late'];
  for (const slot of timeSlots) {
    const slotGames = games.filter(g => g.timeOfDay === slot);
    if (slotGames.length >= 2) {
      timeOfDaySplits[slot] = {
        games: slotGames.length,
        pts: statAvg(slotGames, 'pts'),
        reb: statAvg(slotGames, 'reb'),
        ast: statAvg(slotGames, 'ast'),
      };
    }
  }
  
  // Rest Days splits
  const restSplits = { backToBack: [], oneDay: [], twoPlusDays: [] };
  for (let i = 0; i < games.length; i++) {
    const rest = i > 0 ? getRestDays(games[i].date, games[i - 1].date) : 3;
    if (rest <= 1) restSplits.backToBack.push(games[i]);
    else if (rest === 2) restSplits.oneDay.push(games[i]);
    else restSplits.twoPlusDays.push(games[i]);
  }
  
  const restDaySplits = {};
  if (restSplits.backToBack.length >= 2) {
    restDaySplits.backToBack = {
      games: restSplits.backToBack.length,
      pts: statAvg(restSplits.backToBack, 'pts'),
      reb: statAvg(restSplits.backToBack, 'reb'),
      ast: statAvg(restSplits.backToBack, 'ast'),
    };
  }
  if (restSplits.oneDay.length >= 2) {
    restDaySplits.oneDay = {
      games: restSplits.oneDay.length,
      pts: statAvg(restSplits.oneDay, 'pts'),
      reb: statAvg(restSplits.oneDay, 'reb'),
      ast: statAvg(restSplits.oneDay, 'ast'),
    };
  }
  if (restSplits.twoPlusDays.length >= 2) {
    restDaySplits.wellRested = {
      games: restSplits.twoPlusDays.length,
      pts: statAvg(restSplits.twoPlusDays, 'pts'),
      reb: statAvg(restSplits.twoPlusDays, 'reb'),
      ast: statAvg(restSplits.twoPlusDays, 'ast'),
    };
  }
  
  // Home vs Away
  const homeGames = games.filter(g => g.isHome);
  const awayGames = games.filter(g => !g.isHome);
  
  const homeAwaySplits = {
    home: homeGames.length >= 2 ? {
      games: homeGames.length,
      pts: statAvg(homeGames, 'pts'),
      reb: statAvg(homeGames, 'reb'),
      ast: statAvg(homeGames, 'ast'),
      winPct: +(homeGames.filter(g => g.result === 'W').length / homeGames.length).toFixed(3),
    } : null,
    away: awayGames.length >= 2 ? {
      games: awayGames.length,
      pts: statAvg(awayGames, 'pts'),
      reb: statAvg(awayGames, 'reb'),
      ast: statAvg(awayGames, 'ast'),
      winPct: +(awayGames.filter(g => g.result === 'W').length / awayGames.length).toFixed(3),
    } : null,
  };
  
  // vs Opponent history
  const opponentSplits = {};
  const opponents = [...new Set(games.map(g => g.opponent))];
  for (const opp of opponents) {
    const oppGames = games.filter(g => g.opponent === opp);
    if (oppGames.length >= 1) {
      opponentSplits[opp] = {
        games: oppGames.length,
        pts: statAvg(oppGames, 'pts'),
        reb: statAvg(oppGames, 'reb'),
        ast: statAvg(oppGames, 'ast'),
        lastGame: oppGames[oppGames.length - 1],
      };
    }
  }
  
  // Recent form (last 5, last 10)
  const last5 = games.slice(-5);
  const last10 = games.slice(-10);
  
  const recentForm = {
    last5: {
      games: last5.length,
      pts: statAvg(last5, 'pts'),
      reb: statAvg(last5, 'reb'),
      ast: statAvg(last5, 'ast'),
      fg3: statAvg(last5, 'fg3'),
      winPct: +(last5.filter(g => g.result === 'W').length / last5.length).toFixed(3),
    },
    last10: {
      games: last10.length,
      pts: statAvg(last10, 'pts'),
      reb: statAvg(last10, 'reb'),
      ast: statAvg(last10, 'ast'),
      fg3: statAvg(last10, 'fg3'),
      winPct: +(last10.filter(g => g.result === 'W').length / last10.length).toFixed(3),
    },
  };
  
  // Monthly trends
  const monthlySplits = {};
  for (const game of games) {
    const month = game.date.substring(0, 7); // YYYY-MM
    if (!monthlySplits[month]) monthlySplits[month] = [];
    monthlySplits[month].push(game);
  }
  const monthlyAvgs = {};
  for (const [month, monthGames] of Object.entries(monthlySplits)) {
    monthlyAvgs[month] = {
      games: monthGames.length,
      pts: statAvg(monthGames, 'pts'),
      reb: statAvg(monthGames, 'reb'),
      ast: statAvg(monthGames, 'ast'),
    };
  }
  
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
  
  // Hit rate analysis (for props)
  const hitRates = {};
  for (const stat of ['pts', 'reb', 'ast', 'fg3']) {
    const values = games.map(g => g[stat]).sort((a, b) => a - b);
    const median = values[Math.floor(values.length / 2)];
    hitRates[stat] = {
      median,
      mean: statAvg(games, stat),
      min: values[0],
      max: values[values.length - 1],
      stdDev: +(Math.sqrt(values.reduce((sum, v) => sum + Math.pow(v - statAvg(games, stat), 2), 0) / values.length)).toFixed(1),
      // Over/under hit rates at common lines
      overRates: {},
    };
    // Calculate hit rates for common line values
    const commonLines = stat === 'pts' ? [15, 17.5, 20, 22.5, 25, 27.5, 30] :
                        stat === 'reb' ? [4, 5, 6, 7, 8, 9, 10, 12] :
                        stat === 'ast' ? [3, 4, 5, 6, 7, 8, 10] :
                        [1, 1.5, 2, 2.5, 3, 3.5, 4];
    for (const line of commonLines) {
      const overCount = values.filter(v => v > line).length;
      hitRates[stat].overRates[line] = +(overCount / values.length * 100).toFixed(1);
    }
  }
  
  return {
    seasonAvg,
    dayOfWeek: dayOfWeekSplits,
    timeOfDay: timeOfDaySplits,
    restDays: restDaySplits,
    homeAway: homeAwaySplits,
    vsOpponent: opponentSplits,
    recentForm,
    monthly: monthlyAvgs,
    hitRates,
  };
}

// ============================================================
// Combined Player Profile Builder
// ============================================================

/**
 * Build a comprehensive player profile from all sources
 */
async function buildPlayerProfile(bbrefId, playerName) {
  // Check cache
  const cached = playerCache[bbrefId];
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }
  
  console.log(`Building profile for ${playerName} (${bbrefId})...`);
  
  // Fetch from Basketball Reference (primary source)
  const bbrefGames = await scrapeBBRefGameLog(bbrefId);
  await new Promise(r => setTimeout(r, RATE_LIMIT_MS)); // Rate limit
  
  // Compute splits
  const splits = computeSplits(bbrefGames);
  
  const profile = {
    player: playerName,
    bbrefId,
    gamesPlayed: bbrefGames.length,
    lastUpdated: new Date().toISOString(),
    splits,
    gameLog: bbrefGames.slice(-10), // Last 10 games for reference
  };
  
  // Cache it
  playerCache[bbrefId] = { data: profile, fetchedAt: Date.now() };
  
  return profile;
}

// ============================================================
// Player ID Mapping (common players)
// ============================================================

// Map player names to Basketball Reference IDs
// This can be expanded or loaded from a file
const PLAYER_BBREF_MAP = {
  // Top NBA players — add more as needed
  'LeBron James': 'jamesle01',
  'Luka Doncic': 'doncilu01',
  'Shai Gilgeous-Alexander': 'gilMDsh01',
  'Nikola Jokic': 'jokicni01',
  'Giannis Antetokounmpo': 'antetgi01',
  'Jayson Tatum': 'tatumja01',
  'Stephen Curry': 'curryst01',
  'Kevin Durant': 'duranke01',
  'Jalen Brunson': 'brunsja01',
  'Anthony Edwards': 'edwaran01',
  'Donovan Mitchell': 'mitchdo01',
  'Karl-Anthony Towns': 'townska01',
  'Cade Cunningham': 'cunnica01',
  'Paolo Banchero': 'banchpa01',
  'Tyrese Haliburton': 'halMDty01',
  'Devin Booker': 'bookede01',
  'Trae Young': 'youngtr01',
  'Darius Garland': 'garlada01',
  'Scottie Barnes': 'barnesc01',
  'Evan Mobley': 'mobleev01',
};

/**
 * Try to find a BBRef ID for a player name
 */
function findBBRefId(playerName) {
  // Direct lookup
  if (PLAYER_BBREF_MAP[playerName]) return PLAYER_BBREF_MAP[playerName];
  
  // Fuzzy match
  const lower = playerName.toLowerCase();
  for (const [name, id] of Object.entries(PLAYER_BBREF_MAP)) {
    if (name.toLowerCase() === lower) return id;
    if (lower.includes(name.toLowerCase().split(' ').pop())) return id;
  }
  
  // Generate a guess based on BBRef naming convention
  // Format: first 5 of last name + first 2 of first name + 01
  const parts = playerName.split(' ');
  if (parts.length >= 2) {
    const last = parts[parts.length - 1].toLowerCase().replace(/[^a-z]/g, '');
    const first = parts[0].toLowerCase().replace(/[^a-z]/g, '');
    return `${last.substring(0, 5)}${first.substring(0, 2)}01`;
  }
  
  return null;
}

// ============================================================
// Refresh
// ============================================================

let refreshInterval = null;

function startRefresh() {
  console.log('Enhanced analytics engine started (on-demand caching)');
  // Profiles are built on-demand and cached for 4 hours
  // No proactive refresh needed — saves rate limit budget
}

// ============================================================
// API Routes
// ============================================================

/**
 * GET /api/analytics/player/:name
 * Returns comprehensive player profile with all splits
 */
router.get('/player/:name', async (req, res) => {
  const playerName = decodeURIComponent(req.params.name);
  const bbrefId = findBBRefId(playerName);
  
  if (!bbrefId) {
    return res.json({
      found: false,
      player: playerName,
      message: 'Player not found in mapping. Add to PLAYER_BBREF_MAP.',
    });
  }
  
  try {
    const profile = await buildPlayerProfile(bbrefId, playerName);
    res.json({ found: true, ...profile });
  } catch (err) {
    res.status(500).json({ error: err.message, player: playerName });
  }
});

/**
 * GET /api/analytics/player/:name/splits
 * Returns just the splits for a player (lighter endpoint)
 */
router.get('/player/:name/splits', async (req, res) => {
  const playerName = decodeURIComponent(req.params.name);
  const bbrefId = findBBRefId(playerName);
  
  if (!bbrefId) return res.json({ found: false });
  
  try {
    const profile = await buildPlayerProfile(bbrefId, playerName);
    res.json({
      found: true,
      player: playerName,
      splits: profile.splits,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/analytics/player/:name/matchup?opponent=BOS&dayOfWeek=Fri&timeOfDay=primetime
 * Returns matchup-specific prediction factors
 */
router.get('/player/:name/matchup', async (req, res) => {
  const playerName = decodeURIComponent(req.params.name);
  const { opponent, dayOfWeek, timeOfDay, restDays } = req.query;
  const bbrefId = findBBRefId(playerName);
  
  if (!bbrefId) return res.json({ found: false });
  
  try {
    const profile = await buildPlayerProfile(bbrefId, playerName);
    if (!profile.splits) return res.json({ found: false, message: 'No game data' });
    
    const s = profile.splits;
    const factors = {};
    
    // Day of week factor
    if (dayOfWeek && s.dayOfWeek[dayOfWeek]) {
      const dayAvg = s.dayOfWeek[dayOfWeek];
      factors.dayOfWeek = {
        day: dayOfWeek,
        data: dayAvg,
        ptsVsSeason: +(dayAvg.pts - s.seasonAvg.pts).toFixed(1),
        signal: dayAvg.pts > s.seasonAvg.pts + 2 ? 'boost' : dayAvg.pts < s.seasonAvg.pts - 2 ? 'dip' : 'neutral',
      };
    }
    
    // Time of day factor
    if (timeOfDay && s.timeOfDay[timeOfDay]) {
      const timeAvg = s.timeOfDay[timeOfDay];
      factors.timeOfDay = {
        slot: timeOfDay,
        data: timeAvg,
        ptsVsSeason: +(timeAvg.pts - s.seasonAvg.pts).toFixed(1),
      };
    }
    
    // Opponent factor
    if (opponent && s.vsOpponent[opponent]) {
      factors.vsOpponent = s.vsOpponent[opponent];
    }
    
    // Rest factor
    if (restDays !== undefined) {
      const rest = parseInt(restDays);
      if (rest <= 1 && s.restDays.backToBack) factors.rest = { type: 'backToBack', ...s.restDays.backToBack };
      else if (rest === 2 && s.restDays.oneDay) factors.rest = { type: 'oneDay', ...s.restDays.oneDay };
      else if (s.restDays.wellRested) factors.rest = { type: 'wellRested', ...s.restDays.wellRested };
    }
    
    // Recent form
    factors.recentForm = s.recentForm;
    
    // Overall assessment
    let ptsForecast = s.seasonAvg.pts;
    let adjustments = [];
    
    if (factors.dayOfWeek?.ptsVsSeason) {
      const adj = factors.dayOfWeek.ptsVsSeason * 0.3; // 30% weight
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
    
    res.json({
      found: true,
      player: playerName,
      seasonAvg: s.seasonAvg,
      factors,
      forecast: {
        pts: +ptsForecast.toFixed(1),
        adjustments,
        confidence: adjustments.length > 0 ? 'adjusted' : 'baseline',
      },
      hitRates: s.hitRates,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/analytics/player/:name/hitrate?stat=pts&line=25.5
 * Returns over/under hit rate for a specific line
 */
router.get('/player/:name/hitrate', async (req, res) => {
  const playerName = decodeURIComponent(req.params.name);
  const { stat, line } = req.query;
  const bbrefId = findBBRefId(playerName);
  
  if (!bbrefId || !stat || !line) {
    return res.json({ found: false, message: 'Required: ?stat=pts&line=25.5' });
  }
  
  try {
    const profile = await buildPlayerProfile(bbrefId, playerName);
    if (!profile.splits?.hitRates?.[stat]) return res.json({ found: false });
    
    const hr = profile.splits.hitRates[stat];
    const lineNum = parseFloat(line);
    const games = profile.gameLog || [];
    
    // Calculate exact hit rate for this line
    const allGames = profile.splits ? 
      [...Array(profile.gamesPlayed)].map((_, i) => profile.splits) : [];
    
    // Use the overRates to interpolate
    const closestLine = Object.keys(hr.overRates)
      .map(Number)
      .sort((a, b) => Math.abs(a - lineNum) - Math.abs(b - lineNum))[0];
    
    res.json({
      found: true,
      player: playerName,
      stat,
      line: lineNum,
      seasonAvg: hr.mean,
      median: hr.median,
      stdDev: hr.stdDev,
      overRate: hr.overRates[closestLine] || 50,
      closestLine,
      min: hr.min,
      max: hr.max,
      recentGames: games.slice(-5).map(g => g[stat]),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, startRefresh, buildPlayerProfile, computeSplits, findBBRefId, PLAYER_BBREF_MAP };
