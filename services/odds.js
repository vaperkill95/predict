const axios = require("axios");
const NodeCache = require("node-cache");

const cache = new NodeCache({ stdTTL: 1800 }); // 30 min cache — saves API credits

const ODDS_BASE = "https://api.the-odds-api.com/v4";

// Map our sport keys to Odds API sport keys
const ODDS_SPORT_MAP = {
  nba: "basketball_nba",
  nfl: "americanfootball_nfl",
  mlb: "baseball_mlb",
  nhl: "icehockey_nhl",
  ncaamb: "basketball_ncaab",
  ncaafb: "americanfootball_ncaaf",
  epl: "soccer_epl",
  la_liga: "soccer_spain_la_liga",
  serie_a: "soccer_italy_serie_a",
  bundesliga: "soccer_germany_bundesliga",
  mls: "soccer_usa_mls",
};

/**
 * Fetch current odds for a sport
 */
async function getOdds(sportKey) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return { available: false, message: "Odds API key not configured" };

  const oddsSport = ODDS_SPORT_MAP[sportKey];
  if (!oddsSport) return { available: false, message: `No odds mapping for ${sportKey}` };

  const cacheKey = `odds_${sportKey}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const { data } = await axios.get(`${ODDS_BASE}/sports/${oddsSport}/odds`, {
      params: {
        apiKey,
        regions: "us",
        markets: "h2h,spreads,totals",
        oddsFormat: "american",
      },
      timeout: 10000,
    });

    const result = {
      available: true,
      sport: sportKey,
      games: (data || []).map((game) => ({
        id: game.id,
        homeTeam: game.home_team,
        awayTeam: game.away_team,
        commenceTime: game.commence_time,
        bookmakers: (game.bookmakers || []).slice(0, 3).map((bk) => ({
          name: bk.title,
          markets: (bk.markets || []).map((m) => ({
            key: m.key,
            outcomes: m.outcomes.map((o) => ({
              name: o.name,
              price: o.price,
              point: o.point,
            })),
          })),
        })),
      })),
    };

    cache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.error(`Odds API error (${sportKey}):`, err.message);
    return { available: false, message: "Failed to fetch odds data" };
  }
}

module.exports = { getOdds, ODDS_SPORT_MAP };
