/**
 * multi-api.js — Intelligent Multi-API Failover System
 * 
 * Routes between 4 data sources intelligently:
 *   1. Odds API (primary) — 20+ books, player props, game odds
 *   2. SharpAPI (failover) — 2 books free, backup odds + events
 *   3. ESPN (unlimited) — scores, stats, box scores, schedules, standings
 *   4. PandaScore (free) — esports (CDL, VAL, CS2, LoL, Dota2)
 * 
 * Features:
 *   - Shared cache with configurable TTL per data type
 *   - Automatic failover if primary API returns 401/429/500
 *   - Credit tracking to warn before running out
 *   - ESPN used for ALL score/stat data (saves Odds API credits)
 *   - Smart routing: uses cheapest source that has the data needed
 */

const axios = require("axios");

// ============================================================
// CONFIG
// ============================================================

const ODDS_API_KEY = process.env.ODDS_API_KEY;
const SHARP_API_KEY = process.env.SHARP_API_KEY;

const CACHE_TTL = {
  props: 15 * 60 * 1000,      // 15 min — player props (Odds API)
  gameOdds: 15 * 60 * 1000,   // 15 min — game odds (Odds API)
  events: 30 * 60 * 1000,     // 30 min — event schedules (SharpAPI/ESPN)
  scores: 30 * 1000,          // 30 sec — live scores (ESPN only, free)
  standings: 60 * 60 * 1000,  // 1 hour — standings (ESPN only, free)
  boxScores: 5 * 60 * 1000,   // 5 min — box scores (ESPN only, free)
};

// Sport key mapping between APIs
const SPORT_MAP = {
  // Odds API key → SharpAPI league → ESPN path
  nba:  { oddsApi: "basketball_nba",   sharp: "usa-nba",   espn: "basketball/nba" },
  nhl:  { oddsApi: "icehockey_nhl",    sharp: "usa-nhl",   espn: "hockey/nhl" },
  mlb:  { oddsApi: "baseball_mlb",     sharp: "usa-mlb",   espn: "baseball/mlb" },
  nfl:  { oddsApi: "americanfootball_nfl", sharp: "usa-nfl", espn: "football/nfl" },
  epl:  { oddsApi: "soccer_epl",       sharp: "england-premier-league", espn: "soccer/eng.1" },
  ncaam: { oddsApi: "basketball_ncaab", sharp: "usa-ncaab",  espn: "basketball/mens-college-basketball" },
};

// ============================================================
// CACHE LAYER
// ============================================================

const cache = {};

function getCached(key, ttl) {
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.time > (ttl || CACHE_TTL.props)) return null;
  return entry.data;
}

function setCache(key, data) {
  cache[key] = { data, time: Date.now() };
  
  // Evict stale entries if cache grows too large (>50 keys)
  var keys = Object.keys(cache);
  if (keys.length > 50) {
    var now = Date.now();
    var maxAge = 60 * 60 * 1000; // 1 hour max age for any cache entry
    keys.forEach(function(k) {
      if (now - cache[k].time > maxAge) {
        delete cache[k];
      }
    });
  }
}

// ============================================================
// CREDIT TRACKER
// ============================================================

let oddsApiCreditsUsed = 0;
let oddsApiLastReset = Date.now();
const DAILY_BUDGET = 500; // target max credits per day

function trackCredit(count) {
  // Reset daily counter
  if (Date.now() - oddsApiLastReset > 24 * 60 * 60 * 1000) {
    oddsApiCreditsUsed = 0;
    oddsApiLastReset = Date.now();
  }
  oddsApiCreditsUsed += count;
}

function isOverBudget() {
  return oddsApiCreditsUsed >= DAILY_BUDGET;
}

// ============================================================
// ESPN — FREE, UNLIMITED (scores, stats, schedules, box scores)
// ============================================================

async function espnScoreboard(sport) {
  const cacheKey = `espn_scores_${sport}`;
  const cached = getCached(cacheKey, CACHE_TTL.scores);
  if (cached) return cached;

  const espnPath = SPORT_MAP[sport]?.espn;
  if (!espnPath) return { events: [] };

  try {
    const resp = await axios.get(
      `https://site.api.espn.com/apis/site/v2/sports/${espnPath}/scoreboard`,
      { timeout: 10000 }
    );
    const data = resp.data;
    setCache(cacheKey, data);
    return data;
  } catch (e) {
    console.warn(`[MultiAPI] ESPN scoreboard failed for ${sport}: ${e.message}`);
    return cache[cacheKey]?.data || { events: [] };
  }
}

async function espnStandings(sport) {
  const cacheKey = `espn_standings_${sport}`;
  const cached = getCached(cacheKey, CACHE_TTL.standings);
  if (cached) return cached;

  const espnPath = SPORT_MAP[sport]?.espn;
  if (!espnPath) return { children: [] };

  try {
    const resp = await axios.get(
      `https://site.api.espn.com/apis/v2/sports/${espnPath}/standings`,
      { timeout: 10000 }
    );
    setCache(cacheKey, resp.data);
    return resp.data;
  } catch (e) {
    return cache[cacheKey]?.data || { children: [] };
  }
}

async function espnBoxScore(sport, gameId) {
  const cacheKey = `espn_box_${sport}_${gameId}`;
  const cached = getCached(cacheKey, CACHE_TTL.boxScores);
  if (cached) return cached;

  const espnPath = SPORT_MAP[sport]?.espn;
  if (!espnPath) return null;

  try {
    const resp = await axios.get(
      `https://site.api.espn.com/apis/site/v2/sports/${espnPath}/summary?event=${gameId}`,
      { timeout: 10000 }
    );
    setCache(cacheKey, resp.data);
    return resp.data;
  } catch (e) {
    return cache[cacheKey]?.data || null;
  }
}

// ============================================================
// ODDS API — PRIMARY (props, game odds, line shopping)
// ============================================================

async function oddsApiProps(sport) {
  if (!ODDS_API_KEY) return null;

  const sportKey = SPORT_MAP[sport]?.oddsApi;
  if (!sportKey) return null;

  try {
    const resp = await axios.get(
      `https://api.the-odds-api.com/v4/sports/${sportKey}/events`,
      { params: { apiKey: ODDS_API_KEY }, timeout: 15000 }
    );
    trackCredit(1);
    return resp.data;
  } catch (e) {
    if (e.response?.status === 401 || e.response?.status === 429) {
      console.warn(`[MultiAPI] Odds API ${e.response.status} — switching to failover`);
      return null; // Trigger failover
    }
    return null;
  }
}

// ============================================================
// SHARPAPI — FAILOVER (2 books, 60s delay on free tier)
// ============================================================

async function sharpApiOdds(sport) {
  if (!SHARP_API_KEY) return null;

  const league = SPORT_MAP[sport]?.sharp;
  if (!league) return null;

  try {
    const resp = await axios.get(
      `https://api.sharpapi.io/api/v1/odds`,
      {
        params: { sport: getSportCategory(sport), league: league },
        headers: { "X-API-Key": SHARP_API_KEY },
        timeout: 15000,
      }
    );
    return resp.data?.data || [];
  } catch (e) {
    console.warn(`[MultiAPI] SharpAPI failed for ${sport}: ${e.message}`);
    return null;
  }
}

async function sharpApiEvents(sport) {
  if (!SHARP_API_KEY) return null;

  const league = SPORT_MAP[sport]?.sharp;
  if (!league) return null;

  try {
    const resp = await axios.get(
      `https://api.sharpapi.io/api/v1/events`,
      {
        params: { sport: getSportCategory(sport), league: league },
        headers: { "X-API-Key": SHARP_API_KEY },
        timeout: 15000,
      }
    );
    return resp.data?.data || [];
  } catch (e) {
    return null;
  }
}

function getSportCategory(sport) {
  const map = { nba: "basketball", nhl: "ice-hockey", mlb: "baseball", nfl: "american-football", epl: "soccer", ncaam: "basketball" };
  return map[sport] || sport;
}

// ============================================================
// INTELLIGENT ROUTER — picks best source automatically
// ============================================================

/**
 * Get player props — tries Odds API first, falls back to SharpAPI
 * This is the main function all services should call
 */
async function getProps(sport) {
  const cacheKey = `props_${sport}`;
  const cached = getCached(cacheKey, CACHE_TTL.props);
  if (cached) {
    console.log(`[MultiAPI] Props ${sport}: serving from cache (${cached.props?.length || 0} props)`);
    return cached;
  }

  // If over daily budget, use stale cache or failover
  if (isOverBudget()) {
    console.warn(`[MultiAPI] Over daily budget (${oddsApiCreditsUsed}/${DAILY_BUDGET}), using failover`);
    const stale = cache[cacheKey]?.data;
    if (stale) return stale;
    // Try SharpAPI as failover
    return await getPropsFromSharp(sport);
  }

  // Try Odds API first (primary)
  try {
    const { getPlayerProps } = require("./props");
    const data = await getPlayerProps(sport);
    if (data && data.props && data.props.length > 0) {
      setCache(cacheKey, data);
      console.log(`[MultiAPI] Props ${sport}: Odds API returned ${data.props.length} props`);
      return data;
    }
  } catch (e) {
    console.warn(`[MultiAPI] Odds API props failed for ${sport}: ${e.message}`);
  }

  // Failover to SharpAPI
  console.log(`[MultiAPI] Props ${sport}: trying SharpAPI failover...`);
  const sharpData = await getPropsFromSharp(sport);
  if (sharpData && sharpData.props && sharpData.props.length > 0) {
    setCache(cacheKey, sharpData);
    return sharpData;
  }

  // Return stale cache if available
  const stale = cache[cacheKey]?.data;
  if (stale) {
    console.log(`[MultiAPI] Props ${sport}: serving stale cache`);
    return stale;
  }

  return { props: [], available: false, source: "none" };
}

/**
 * Convert SharpAPI odds format to our standard props format
 */
async function getPropsFromSharp(sport) {
  const odds = await sharpApiOdds(sport);
  if (!odds || odds.length === 0) return { props: [], available: false, source: "sharpapi" };

  // SharpAPI returns odds in a different format — normalize to our standard
  const props = odds.map(function(o) {
    return {
      player: o.player_name || o.description || "Unknown",
      market: o.market_type || "moneyline",
      marketLabel: o.market_name || o.market_type || "Unknown",
      game: (o.away_team || "") + " @ " + (o.home_team || ""),
      books: (o.outcomes || []).map(function(out) {
        return {
          name: out.sportsbook || "Unknown",
          over: out.over ? { price: out.over.price, point: out.over.point } : null,
          under: out.under ? { price: out.under.price, point: out.under.point } : null,
        };
      }),
      consensusLine: o.line || 0,
      bookCount: o.outcomes ? o.outcomes.length : 0,
      source: "sharpapi",
    };
  });

  return { props, available: true, source: "sharpapi" };
}

/**
 * Get game odds with line shopping — Odds API primary, SharpAPI backup
 */
async function getGameOdds(sport) {
  const cacheKey = `gameOdds_${sport}`;
  const cached = getCached(cacheKey, CACHE_TTL.gameOdds);
  if (cached) return cached;

  // Use ESPN for schedule + Odds API for odds
  // ESPN gives us the game list for free, Odds API gives us the lines
  try {
    const { getGameOddsWithPredictions } = require("./game-predictions");
    if (getGameOddsWithPredictions) {
      const data = await getGameOddsWithPredictions(sport);
      if (data && data.games && data.games.length > 0) {
        setCache(cacheKey, data);
        return data;
      }
    }
  } catch (e) {
    // Fall through
  }

  // Stale cache
  return cache[cacheKey]?.data || { games: [], count: 0 };
}

/**
 * Get scores — ALWAYS uses ESPN (free, unlimited)
 */
async function getScores(sport) {
  return await espnScoreboard(sport);
}

/**
 * Get standings — ALWAYS uses ESPN (free, unlimited)
 */
async function getStandings(sport) {
  return await espnStandings(sport);
}

/**
 * Get box score for a specific game — ALWAYS uses ESPN (free)
 */
async function getBoxScore(sport, gameId) {
  return await espnBoxScore(sport, gameId);
}

// ============================================================
// STATUS / MONITORING
// ============================================================

function getStatus() {
  return {
    oddsApi: {
      configured: !!ODDS_API_KEY,
      creditsToday: oddsApiCreditsUsed,
      dailyBudget: DAILY_BUDGET,
      overBudget: isOverBudget(),
    },
    sharpApi: {
      configured: !!SHARP_API_KEY,
      tier: "free",
      limits: "12 req/min, 2 books, 60s delay",
    },
    espn: {
      configured: true,
      limits: "unlimited",
      role: "scores, standings, box scores, schedules",
    },
    pandaScore: {
      configured: !!process.env.PANDASCORE_API_KEY,
      role: "esports data",
    },
    cache: {
      entries: Object.keys(cache).length,
      keys: Object.keys(cache),
    },
  };
}

module.exports = {
  getProps,
  getGameOdds,
  getScores,
  getStandings,
  getBoxScore,
  getStatus,
  espnScoreboard,
  espnStandings,
  espnBoxScore,
  sharpApiOdds,
  sharpApiEvents,
  getCached,
  setCache,
  trackCredit,
  isOverBudget,
  CACHE_TTL,
};
