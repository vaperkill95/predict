const axios = require("axios");
const NodeCache = require("node-cache");

const cache = new NodeCache({ stdTTL: 600 }); // 10min cache for player stats

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";
const ESPN_CORE = "https://sports.core.api.espn.com/v2/sports";

const SPORT_MAP = {
  nba: { sport: "basketball", league: "nba" },
  nfl: { sport: "football", league: "nfl" },
  mlb: { sport: "baseball", league: "mlb" },
  nhl: { sport: "hockey", league: "nhl" },
  ncaamb: { sport: "basketball", league: "mens-college-basketball" },
  ncaafb: { sport: "football", league: "college-football" },
};

/**
 * Search for a player by name and get their ESPN athlete ID
 */
async function findPlayer(name, sportKey) {
  const cacheKey = `find_${sportKey}_${name}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const { data } = await axios.get(
      `https://site.web.api.espn.com/apis/common/v3/search?query=${encodeURIComponent(name)}&limit=3&type=player`,
      { timeout: 8000 }
    );

    const players = (data.items || []).map(p => ({
      id: p.id,
      name: p.displayName,
      position: p.position,
      team: p.team?.displayName,
      teamId: p.team?.id,
      league: p.league,
    }));

    cache.set(cacheKey, players);
    return players;
  } catch (err) {
    console.error("[PlayerData] Search error:", err.message);
    return [];
  }
}

/**
 * Get player season stats + recent game log from ESPN
 */
async function getPlayerStats(playerName, sportKey) {
  const cacheKey = `stats_${sportKey}_${playerName}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const config = SPORT_MAP[sportKey];
  if (!config) return null;

  // Step 1: Find the player
  const players = await findPlayer(playerName, sportKey);
  if (!players.length) return null;

  const player = players[0];
  const athleteId = player.id;

  try {
    // Step 2: Get player overview with stats
    const { data: overview } = await axios.get(
      `${ESPN_BASE}/${config.sport}/${config.league}/athletes/${athleteId}`,
      { timeout: 8000 }
    ).catch(() => ({ data: null }));

    // Step 3: Get player's game log (recent games)
    const { data: gamelog } = await axios.get(
      `${ESPN_BASE}/${config.sport}/${config.league}/athletes/${athleteId}/gamelog`,
      { timeout: 8000 }
    ).catch(() => ({ data: null }));

    // Step 4: Get player stats summary
    const { data: statsSummary } = await axios.get(
      `${ESPN_BASE}/${config.sport}/${config.league}/athletes/${athleteId}/statistics`,
      { timeout: 8000 }
    ).catch(() => ({ data: null }));

    // Parse season averages
    let seasonAverages = {};
    if (statsSummary?.statistics?.length) {
      const latest = statsSummary.statistics[0]; // Current season
      if (latest?.stats?.length) {
        const labels = latest.labels || [];
        const values = latest.stats[0]?.stats || [];
        labels.forEach((label, i) => {
          if (values[i] !== undefined) seasonAverages[label] = values[i];
        });
      }
    }

    // Parse recent game log (last 10 games)
    let recentGames = [];
    if (gamelog?.events?.length) {
      const labels = gamelog.labels || [];
      recentGames = gamelog.events.slice(-10).reverse().map(event => {
        const stats = {};
        const values = event.stats || [];
        labels.forEach((label, i) => {
          if (values[i] !== undefined) stats[label] = values[i];
        });
        return {
          date: event.eventDate,
          opponent: event.opponent?.displayName || event.opponent?.abbreviation,
          homeAway: event.homeAway,
          result: event.gameResult,
          stats,
        };
      });
    }

    // Alternative game log parsing for different ESPN response formats
    if (!recentGames.length && gamelog?.seasonTypes?.length) {
      for (const seasonType of gamelog.seasonTypes) {
        for (const cat of seasonType.categories || []) {
          const labels = cat.labels || [];
          for (const event of (cat.events || []).slice(-10).reverse()) {
            const stats = {};
            (event.stats || []).forEach((val, i) => {
              if (labels[i]) stats[labels[i]] = val;
            });
            recentGames.push({
              date: event.eventDate,
              opponent: event.opponent?.displayName || event.opponent?.abbreviation,
              homeAway: event.homeAway,
              result: event.gameResult,
              stats,
            });
          }
          if (recentGames.length) break; // Got data from first category
        }
        if (recentGames.length) break;
      }
    }

    // Calculate recent averages from game log
    let recentAverages = {};
    if (recentGames.length > 0) {
      const numericKeys = Object.keys(recentGames[0]?.stats || {}).filter(k => {
        return !isNaN(parseFloat(recentGames[0].stats[k]));
      });
      numericKeys.forEach(key => {
        const values = recentGames.map(g => parseFloat(g.stats[key])).filter(v => !isNaN(v));
        if (values.length) {
          recentAverages[key] = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
        }
      });
    }

    // Build player profile
    const result = {
      id: athleteId,
      name: player.name,
      position: player.position || overview?.athlete?.position?.abbreviation,
      team: player.team || overview?.athlete?.team?.displayName,
      teamId: player.teamId,
      headshot: overview?.athlete?.headshot?.href,
      jersey: overview?.athlete?.jersey,
      age: overview?.athlete?.age,
      experience: overview?.athlete?.experience?.years,
      seasonAverages,
      recentAverages,
      recentGames: recentGames.slice(0, 10),
      gamesPlayed: recentGames.length,
    };

    cache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.error("[PlayerData] Stats fetch error:", err.message);
    return { id: athleteId, name: player.name, team: player.team, error: err.message };
  }
}

/**
 * Get team defensive stats / rankings
 */
async function getTeamDefense(sportKey, teamId) {
  const cacheKey = `defense_${sportKey}_${teamId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const config = SPORT_MAP[sportKey];
  if (!config) return null;

  try {
    const { data } = await axios.get(
      `${ESPN_BASE}/${config.sport}/${config.league}/teams/${teamId}/statistics`,
      { timeout: 8000 }
    );

    // Extract defensive stats
    let defenseStats = {};
    for (const category of data?.statistics || []) {
      if (category.name?.toLowerCase().includes("defense") ||
          category.name?.toLowerCase().includes("opponent")) {
        for (const stat of category.stats || []) {
          defenseStats[stat.name || stat.label] = {
            value: stat.value || stat.displayValue,
            rank: stat.rank || stat.rankDisplayValue,
          };
        }
      }
    }

    const result = { teamId, sport: sportKey, defenseStats };
    cache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.error("[PlayerData] Defense stats error:", err.message);
    return null;
  }
}

/**
 * Get injury report for a team
 */
async function getInjuries(sportKey, teamId) {
  const config = SPORT_MAP[sportKey];
  if (!config) return [];

  try {
    const { data } = await axios.get(
      `${ESPN_BASE}/${config.sport}/${config.league}/teams/${teamId}/injuries`,
      { timeout: 8000 }
    );

    return (data?.injuries || data?.items || []).map(injury => ({
      player: injury.athlete?.displayName,
      position: injury.athlete?.position?.abbreviation,
      status: injury.status,
      type: injury.type,
      detail: injury.longComment || injury.shortComment,
    }));
  } catch (err) {
    return [];
  }
}

/**
 * Build complete context package for AI prediction
 */
async function buildPredictionContext(playerName, sportKey, propMarket, propLine, gameInfo) {
  console.log(`[PlayerData] Building context for ${playerName} (${sportKey})`);

  // Fetch all data in parallel
  const [playerStats, opponentDefense, teamInjuries, opponentInjuries] = await Promise.all([
    getPlayerStats(playerName, sportKey),
    gameInfo?.opponentTeamId ? getTeamDefense(sportKey, gameInfo.opponentTeamId) : null,
    gameInfo?.teamId ? getInjuries(sportKey, gameInfo.teamId) : Promise.resolve([]),
    gameInfo?.opponentTeamId ? getInjuries(sportKey, gameInfo.opponentTeamId) : Promise.resolve([]),
  ]);

  // Map prop market to the relevant stat key for analysis
  const statKeyMap = {
    player_points: "PTS", player_rebounds: "REB", player_assists: "AST",
    player_threes: "3PM", player_blocks: "BLK", player_steals: "STL",
    player_points_rebounds_assists: "PTS+REB+AST",
    player_pass_yds: "PYDS", player_pass_tds: "PTD", player_rush_yds: "RYDS",
    player_receptions: "REC", player_reception_yds: "RECYDS",
    batter_hits: "H", pitcher_strikeouts: "K", batter_total_bases: "TB",
    player_goals: "G", player_shots_on_goal: "SOG",
  };

  const relevantStat = statKeyMap[propMarket] || propMarket;

  // Calculate over/under hit rate from recent games
  let hitRate = null;
  if (playerStats?.recentGames?.length && propLine) {
    const relevantValues = playerStats.recentGames.map(g => {
      // Try to find the matching stat in game log
      const val = Object.entries(g.stats || {}).find(([k]) =>
        k.toUpperCase().includes(relevantStat) || relevantStat.includes(k.toUpperCase())
      );
      return val ? parseFloat(val[1]) : null;
    }).filter(v => v !== null);

    if (relevantValues.length > 0) {
      const overs = relevantValues.filter(v => v > propLine).length;
      hitRate = {
        over: Math.round((overs / relevantValues.length) * 100),
        under: Math.round(((relevantValues.length - overs) / relevantValues.length) * 100),
        sample: relevantValues.length,
        values: relevantValues,
      };
    }
  }

  return {
    player: playerStats ? {
      name: playerStats.name,
      position: playerStats.position,
      team: playerStats.team,
      age: playerStats.age,
      experience: playerStats.experience,
      seasonAverages: playerStats.seasonAverages,
      recentAverages: playerStats.recentAverages,
      last5Games: playerStats.recentGames?.slice(0, 5),
      gamesPlayed: playerStats.gamesPlayed,
    } : { name: playerName, note: "Could not find detailed stats" },
    prop: {
      market: propMarket,
      relevantStat,
      line: propLine,
      hitRate,
    },
    opponent: {
      defense: opponentDefense?.defenseStats || null,
      injuries: opponentInjuries?.slice(0, 5) || [],
    },
    team: {
      injuries: teamInjuries?.slice(0, 5) || [],
    },
    game: gameInfo || null,
  };
}

module.exports = {
  findPlayer,
  getPlayerStats,
  getTeamDefense,
  getInjuries,
  buildPredictionContext,
};
