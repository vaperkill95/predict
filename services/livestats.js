const axios = require("axios");
const NodeCache = require("node-cache");

const cache = new NodeCache({ stdTTL: 30 }); // 30 sec cache for live data

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";
const ESPN_WEB = "https://site.web.api.espn.com/apis/site/v2/sports";

const SPORT_MAP = {
  nba: { sport: "basketball", league: "nba" },
  nfl: { sport: "football", league: "nfl" },
  mlb: { sport: "baseball", league: "mlb" },
  nhl: { sport: "hockey", league: "nhl" },
  ncaamb: { sport: "basketball", league: "mens-college-basketball" },
};

/**
 * Get live box score for a specific game
 */
async function getLiveBoxScore(sportKey, eventId) {
  const config = SPORT_MAP[sportKey];
  if (!config) return null;

  const cacheKey = `live_box_${eventId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const { data } = await axios.get(
      `${ESPN_WEB}/${config.sport}/${config.league}/summary?event=${eventId}`,
      { timeout: 10000 }
    );

    const gameStatus = data.header?.competitions?.[0]?.status;
    const isLive = gameStatus?.type?.name === "STATUS_IN_PROGRESS";
    const isFinal = gameStatus?.type?.completed;
    const clock = gameStatus?.displayClock;
    const period = gameStatus?.period;

    // Parse player stats from box score
    const players = [];
    for (const team of data.boxscore?.players || []) {
      const teamName = team.team?.displayName;
      const teamAbbr = team.team?.abbreviation;

      for (const statGroup of team.statistics || []) {
        const labels = statGroup.labels || [];

        for (const athlete of statGroup.athletes || []) {
          const stats = {};
          (athlete.stats || []).forEach((val, i) => {
            if (labels[i]) stats[labels[i]] = val;
          });

          players.push({
            id: athlete.athlete?.id,
            name: athlete.athlete?.displayName,
            shortName: athlete.athlete?.shortName,
            position: athlete.athlete?.position?.abbreviation,
            team: teamName,
            teamAbbr,
            jersey: athlete.athlete?.jersey,
            starter: athlete.starter,
            stats,
            minutes: stats.MIN || stats.minutes || null,
          });
        }
      }
    }

    const result = {
      eventId,
      sport: sportKey,
      status: {
        isLive,
        isFinal,
        clock,
        period,
        detail: gameStatus?.type?.detail,
      },
      teams: {
        home: {
          name: data.header?.competitions?.[0]?.competitors?.find(c => c.homeAway === "home")?.team?.displayName,
          score: data.header?.competitions?.[0]?.competitors?.find(c => c.homeAway === "home")?.score,
        },
        away: {
          name: data.header?.competitions?.[0]?.competitors?.find(c => c.homeAway === "away")?.team?.displayName,
          score: data.header?.competitions?.[0]?.competitors?.find(c => c.homeAway === "away")?.score,
        },
      },
      players,
      playerCount: players.length,
    };

    cache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.error(`[LiveStats] Box score error for ${eventId}:`, err.message);
    return null;
  }
}

/**
 * Get today's scoreboard with event IDs for live tracking
 */
async function getTodaysGames(sportKey) {
  const config = SPORT_MAP[sportKey];
  if (!config) return [];

  const cacheKey = `today_games_${sportKey}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const { data } = await axios.get(
      `${ESPN_BASE}/${config.sport}/${config.league}/scoreboard`,
      { timeout: 10000 }
    );

    const games = (data.events || []).map(ev => {
      const comp = ev.competitions?.[0];
      const home = comp?.competitors?.find(c => c.homeAway === "home");
      const away = comp?.competitors?.find(c => c.homeAway === "away");

      return {
        eventId: ev.id,
        name: ev.shortName || ev.name,
        status: comp?.status?.type?.name,
        isLive: comp?.status?.type?.name === "STATUS_IN_PROGRESS",
        isFinal: comp?.status?.type?.completed,
        clock: comp?.status?.displayClock,
        period: comp?.status?.period,
        home: { name: home?.team?.displayName, abbr: home?.team?.abbreviation, score: home?.score },
        away: { name: away?.team?.displayName, abbr: away?.team?.abbreviation, score: away?.score },
      };
    });

    cache.set(cacheKey, games);
    return games;
  } catch (err) {
    console.error(`[LiveStats] Scoreboard error:`, err.message);
    return [];
  }
}

/**
 * Match a player prop to a live game and get their current in-game stats
 */
async function getLivePlayerStat(sportKey, playerName, propMarket) {
  // Get today's games
  const games = await getTodaysGames(sportKey);
  const liveGames = games.filter(g => g.isLive);

  if (!liveGames.length) return null;

  // Check each live game for this player
  for (const game of liveGames) {
    const box = await getLiveBoxScore(sportKey, game.eventId);
    if (!box?.players?.length) continue;

    // Find player in box score
    const player = box.players.find(p =>
      p.name?.toLowerCase() === playerName.toLowerCase() ||
      p.shortName?.toLowerCase() === playerName.toLowerCase() ||
      p.name?.toLowerCase().includes(playerName.toLowerCase().split(" ").pop())
    );

    if (!player) continue;

    // Map prop market to stat key in ESPN box score
    const statValue = extractStatForMarket(player.stats, propMarket);

    return {
      found: true,
      player: player.name,
      team: player.team,
      teamAbbr: player.teamAbbr,
      position: player.position,
      gameStatus: box.status,
      gameScore: box.teams,
      currentStats: player.stats,
      relevantStat: {
        market: propMarket,
        value: statValue,
      },
      minutes: player.minutes,
    };
  }

  return null; // Player not found in any live game
}

/**
 * Extract the relevant stat value for a prop market from ESPN box score stats
 */
function extractStatForMarket(stats, market) {
  if (!stats) return null;

  const mappings = {
    player_points: ["PTS", "Points"],
    player_rebounds: ["REB", "Rebounds"],
    player_assists: ["AST", "Assists"],
    player_threes: ["3PM", "3PT"],
    player_blocks: ["BLK", "Blocks"],
    player_steals: ["STL", "Steals"],
    player_points_rebounds_assists: null, // composite
    player_pass_yds: ["YDS", "PYDS", "PassYds"],
    player_pass_tds: ["TD", "PTD"],
    player_rush_yds: ["YDS", "RYDS", "RushYds"],
    player_receptions: ["REC"],
    player_reception_yds: ["YDS", "RECYDS"],
    batter_hits: ["H", "Hits"],
    pitcher_strikeouts: ["K", "SO"],
    player_goals: ["G", "Goals"],
    player_shots_on_goal: ["SOG"],
  };

  // Composite stat: PTS + REB + AST
  if (market === "player_points_rebounds_assists") {
    const pts = findStat(stats, ["PTS", "Points"]);
    const reb = findStat(stats, ["REB", "Rebounds"]);
    const ast = findStat(stats, ["AST", "Assists"]);
    if (pts !== null && reb !== null && ast !== null) return pts + reb + ast;
    return null;
  }

  const keys = mappings[market];
  if (!keys) return null;
  return findStat(stats, keys);
}

function findStat(stats, keys) {
  for (const key of keys) {
    for (const [k, v] of Object.entries(stats)) {
      if (k.toUpperCase() === key.toUpperCase() || k.toUpperCase().includes(key.toUpperCase())) {
        const num = parseFloat(v);
        if (!isNaN(num)) return num;
        // Handle "5-10" format (e.g., FG made-attempted) — take the first number
        const match = String(v).match(/^(\d+)/);
        if (match) return parseInt(match[1]);
      }
    }
  }
  return null;
}

/**
 * Grade completed picks against final box scores
 */
async function gradeCompletedPicks(sportKey, picks) {
  const games = await getTodaysGames(sportKey);
  const finalGames = games.filter(g => g.isFinal);

  if (!finalGames.length) return { graded: 0, results: [] };

  const results = [];

  for (const pick of picks) {
    // Find the game this pick belongs to
    for (const game of finalGames) {
      const box = await getLiveBoxScore(sportKey, game.eventId);
      if (!box?.players?.length) continue;

      const player = box.players.find(p =>
        p.name?.toLowerCase() === pick.player?.toLowerCase() ||
        p.name?.toLowerCase().includes(pick.player?.toLowerCase().split(" ").pop())
      );

      if (!player) continue;

      const actual = extractStatForMarket(player.stats, pick.market || marketNameToKey(pick.market));

      if (actual !== null) {
        const line = pick.line;
        const isOver = pick.pick === "OVER";
        const hit = isOver ? actual > line : actual < line;
        const push = actual === line;

        results.push({
          player: pick.player,
          market: pick.market,
          line,
          pick: pick.pick,
          actual,
          result: push ? "push" : hit ? "hit" : "miss",
          confidence: pick.confidence,
        });
        break; // Found the player, move to next pick
      }
    }
  }

  return { graded: results.length, results };
}

function marketNameToKey(name) {
  const map = {
    "Points": "player_points", "Rebounds": "player_rebounds", "Assists": "player_assists",
    "3-Pointers": "player_threes", "Pts+Reb+Ast": "player_points_rebounds_assists",
    "Pass Yards": "player_pass_yds", "Rush Yards": "player_rush_yds",
    "Receptions": "player_receptions", "Rec Yards": "player_reception_yds",
    "Hits": "batter_hits", "Strikeouts": "pitcher_strikeouts",
    "Goals": "player_goals", "SOG": "player_shots_on_goal",
  };
  return map[name] || name;
}

module.exports = { getLiveBoxScore, getTodaysGames, getLivePlayerStat, gradeCompletedPicks, extractStatForMarket };
