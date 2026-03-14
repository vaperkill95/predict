const axios = require("axios");
const NodeCache = require("node-cache");

// Cache: 60s for live data, 5min for standings
const liveCache = new NodeCache({ stdTTL: 60 });
const standingsCache = new NodeCache({ stdTTL: 300 });

// ESPN public API base
const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";

// Sport config mapping
const SPORT_MAP = {
  nba: { sport: "basketball", league: "nba" },
  nfl: { sport: "football", league: "nfl" },
  mlb: { sport: "baseball", league: "mlb" },
  nhl: { sport: "hockey", league: "nhl" },
  ncaamb: { sport: "basketball", league: "mens-college-basketball" },
  ncaafb: { sport: "football", league: "college-football" },
  epl: { sport: "soccer", league: "eng.1" },
  la_liga: { sport: "soccer", league: "esp.1" },
  serie_a: { sport: "soccer", league: "ita.1" },
  bundesliga: { sport: "soccer", league: "ger.1" },
  ligue_1: { sport: "soccer", league: "fra.1" },
  mls: { sport: "soccer", league: "usa.1" },
};

/**
 * Fetch scoreboard (live + upcoming + recent games)
 */
async function getScoreboard(sportKey) {
  const cacheKey = `scores_${sportKey}`;
  const cached = liveCache.get(cacheKey);
  if (cached) return cached;

  const config = SPORT_MAP[sportKey];
  if (!config) throw new Error(`Unknown sport: ${sportKey}`);

  const url = `${ESPN_BASE}/${config.sport}/${config.league}/scoreboard`;

  try {
    const { data } = await axios.get(url, { timeout: 10000 });
    const games = (data.events || []).map((event) => {
      const competition = event.competitions?.[0];
      const competitors = competition?.competitors || [];
      const home = competitors.find((c) => c.homeAway === "home");
      const away = competitors.find((c) => c.homeAway === "away");

      return {
        id: event.id,
        name: event.name,
        shortName: event.shortName,
        date: event.date,
        status: {
          type: competition?.status?.type?.name, // STATUS_SCHEDULED, STATUS_IN_PROGRESS, STATUS_FINAL
          detail: competition?.status?.type?.detail,
          displayClock: competition?.status?.displayClock,
          period: competition?.status?.period,
          completed: competition?.status?.type?.completed,
        },
        home: {
          id: home?.team?.id,
          name: home?.team?.displayName,
          abbreviation: home?.team?.abbreviation,
          logo: home?.team?.logo,
          score: home?.score ? parseInt(home.score) : null,
          record: home?.records?.[0]?.summary,
          winner: home?.winner,
        },
        away: {
          id: away?.team?.id,
          name: away?.team?.displayName,
          abbreviation: away?.team?.abbreviation,
          logo: away?.team?.logo,
          score: away?.score ? parseInt(away.score) : null,
          record: away?.records?.[0]?.summary,
          winner: away?.winner,
        },
        odds: competition?.odds?.[0]
          ? {
              spread: competition.odds[0].details,
              overUnder: competition.odds[0].overUnder,
              provider: competition.odds[0].provider?.name,
            }
          : null,
        venue: competition?.venue?.fullName,
        broadcast: competition?.broadcasts?.[0]?.names?.join(", "),
      };
    });

    const result = {
      sport: sportKey,
      date: data.day?.date,
      games,
      count: games.length,
    };

    liveCache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.error(`ESPN scoreboard error (${sportKey}):`, err.message);
    throw new Error(`Failed to fetch ${sportKey} scores`);
  }
}

/**
 * Fetch standings
 */
async function getStandings(sportKey) {
  const cacheKey = `standings_${sportKey}`;
  const cached = standingsCache.get(cacheKey);
  if (cached) return cached;

  const config = SPORT_MAP[sportKey];
  if (!config) throw new Error(`Unknown sport: ${sportKey}`);

  const url = `${ESPN_BASE}/${config.sport}/${config.league}/standings`;

  try {
    const { data } = await axios.get(url, { timeout: 10000 });
    const groups = (data.children || []).map((group) => ({
      name: group.name,
      teams: (group.standings?.entries || []).map((entry) => {
        const stats = {};
        (entry.stats || []).forEach((s) => {
          stats[s.abbreviation || s.name] = s.displayValue || s.value;
        });
        return {
          id: entry.team?.id,
          name: entry.team?.displayName,
          abbreviation: entry.team?.abbreviation,
          logo: entry.team?.logos?.[0]?.href,
          stats,
        };
      }),
    }));

    const result = { sport: sportKey, groups };
    standingsCache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.error(`ESPN standings error (${sportKey}):`, err.message);
    throw new Error(`Failed to fetch ${sportKey} standings`);
  }
}

/**
 * Fetch game detail / box score
 */
async function getGameDetail(sportKey, gameId) {
  const config = SPORT_MAP[sportKey];
  if (!config) throw new Error(`Unknown sport: ${sportKey}`);

  const url = `${ESPN_BASE}/${config.sport}/${config.league}/summary?event=${gameId}`;

  try {
    const { data } = await axios.get(url, { timeout: 10000 });
    return {
      boxScore: data.boxscore,
      leaders: data.leaders,
      predictor: data.predictor,
      odds: data.odds,
      standings: data.standings,
      header: data.header,
      plays: data.plays?.items?.slice(-20), // last 20 plays
    };
  } catch (err) {
    console.error(`ESPN game detail error:`, err.message);
    throw new Error(`Failed to fetch game details`);
  }
}

/**
 * Fetch team stats / roster
 */
async function getTeamInfo(sportKey, teamId) {
  const config = SPORT_MAP[sportKey];
  const url = `${ESPN_BASE}/${config.sport}/${config.league}/teams/${teamId}`;

  try {
    const { data } = await axios.get(url, { timeout: 10000 });
    return {
      team: data.team,
      stats: data.team?.record,
      nextEvent: data.team?.nextEvent,
    };
  } catch (err) {
    console.error(`ESPN team info error:`, err.message);
    throw new Error(`Failed to fetch team info`);
  }
}

/**
 * Search athletes
 */
async function searchAthlete(query) {
  const url = `https://site.web.api.espn.com/apis/common/v3/search?query=${encodeURIComponent(query)}&limit=5&type=player`;

  try {
    const { data } = await axios.get(url, { timeout: 10000 });
    return (data.items || []).map((item) => ({
      id: item.id,
      name: item.displayName,
      position: item.position,
      team: item.team,
      link: item.link,
    }));
  } catch (err) {
    console.error("ESPN search error:", err.message);
    return [];
  }
}

module.exports = {
  getScoreboard,
  getStandings,
  getGameDetail,
  getTeamInfo,
  searchAthlete,
  SPORT_MAP,
};
