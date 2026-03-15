const axios = require("axios");
const NodeCache = require("node-cache");

const liveCache = new NodeCache({ stdTTL: 60 });
const standingsCache = new NodeCache({ stdTTL: 300 });

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";
// FIXED: Standings uses a DIFFERENT base URL than scores
const ESPN_STANDINGS_BASE = "https://site.api.espn.com/apis/v2/sports";

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
          type: competition?.status?.type?.name,
          detail: competition?.status?.type?.detail,
          displayClock: competition?.status?.displayClock,
          period: competition?.status?.period,
          completed: competition?.status?.type?.completed,
        },
        home: {
          id: home?.team?.id, name: home?.team?.displayName, abbreviation: home?.team?.abbreviation,
          logo: home?.team?.logo, score: home?.score ? parseInt(home.score) : null,
          record: home?.records?.[0]?.summary, winner: home?.winner,
        },
        away: {
          id: away?.team?.id, name: away?.team?.displayName, abbreviation: away?.team?.abbreviation,
          logo: away?.team?.logo, score: away?.score ? parseInt(away.score) : null,
          record: away?.records?.[0]?.summary, winner: away?.winner,
        },
        odds: competition?.odds?.[0] ? {
          spread: competition.odds[0].details,
          overUnder: competition.odds[0].overUnder,
          provider: competition.odds[0].provider?.name,
        } : null,
        venue: competition?.venue?.fullName,
        broadcast: competition?.broadcasts?.[0]?.names?.join(", "),
      };
    });

    const result = { sport: sportKey, date: data.day?.date, games, count: games.length };
    liveCache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.error(`ESPN scoreboard error (${sportKey}):`, err.message);
    throw new Error(`Failed to fetch ${sportKey} scores`);
  }
}

/**
 * FIXED: Standings - uses correct ESPN URL /apis/v2/ and proper stat parsing
 */
async function getStandings(sportKey) {
  const cacheKey = `standings_${sportKey}`;
  const cached = standingsCache.get(cacheKey);
  if (cached) return cached;

  const config = SPORT_MAP[sportKey];
  if (!config) throw new Error(`Unknown sport: ${sportKey}`);

  // FIXED: Use /apis/v2/ NOT /apis/site/v2/ for standings
  const url = `${ESPN_STANDINGS_BASE}/${config.sport}/${config.league}/standings`;

  try {
    const { data } = await axios.get(url, { timeout: 10000 });

    const groups = (data.children || []).map((group) => {
      const entries = group.standings?.entries || [];

      const teams = entries.map((entry) => {
        // Build stats object from ESPN stats array
        const statsMap = {};
        (entry.stats || []).forEach((s) => {
          statsMap[s.name] = s.displayValue || String(s.value);
        });

        return {
          id: entry.team?.id,
          name: entry.team?.displayName,
          abbreviation: entry.team?.abbreviation,
          logo: entry.team?.logos?.[0]?.href,
          stats: {
            W: statsMap.wins || statsMap.gamesWon || "0",
            L: statsMap.losses || statsMap.gamesLost || "0",
            PCT: statsMap.winPercent || statsMap.winPct || ".000",
            GB: statsMap.gamesBehind || "-",
            STRK: statsMap.streak || "-",
            DIFF: statsMap.differential || statsMap.pointDifferential || "-",
          },
        };
      });

      // Sort by wins descending
      teams.sort((a, b) => parseInt(b.stats.W || 0) - parseInt(a.stats.W || 0));

      return { name: group.name, teams };
    });

    const result = { sport: sportKey, groups };
    standingsCache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.error(`ESPN standings error (${sportKey}):`, err.message);
    throw new Error(`Failed to fetch ${sportKey} standings`);
  }
}

async function getGameDetail(sportKey, gameId) {
  const config = SPORT_MAP[sportKey];
  if (!config) throw new Error(`Unknown sport: ${sportKey}`);

  const url = `${ESPN_BASE}/${config.sport}/${config.league}/summary?event=${gameId}`;

  try {
    const { data } = await axios.get(url, { timeout: 10000 });
    return {
      boxScore: data.boxscore, leaders: data.leaders, predictor: data.predictor,
      odds: data.odds, standings: data.standings, header: data.header,
      plays: data.plays?.items?.slice(-20),
    };
  } catch (err) {
    console.error(`ESPN game detail error:`, err.message);
    throw new Error(`Failed to fetch game details`);
  }
}

async function getTeamInfo(sportKey, teamId) {
  const config = SPORT_MAP[sportKey];
  const url = `${ESPN_BASE}/${config.sport}/${config.league}/teams/${teamId}`;
  try {
    const { data } = await axios.get(url, { timeout: 10000 });
    return { team: data.team, stats: data.team?.record, nextEvent: data.team?.nextEvent };
  } catch (err) {
    throw new Error(`Failed to fetch team info`);
  }
}

async function searchAthlete(query) {
  const url = `https://site.web.api.espn.com/apis/common/v3/search?query=${encodeURIComponent(query)}&limit=5&type=player`;
  try {
    const { data } = await axios.get(url, { timeout: 10000 });
    return (data.items || []).map((item) => ({
      id: item.id, name: item.displayName, position: item.position, team: item.team, link: item.link,
    }));
  } catch { return []; }
}

module.exports = { getScoreboard, getStandings, getGameDetail, getTeamInfo, searchAthlete, SPORT_MAP };
