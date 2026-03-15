const axios = require("axios");
const NodeCache = require("node-cache");

const cache = new NodeCache({ stdTTL: 600 });

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";
const ESPN_WEB = "https://site.web.api.espn.com/apis/site/v2/sports";

const SPORT_MAP = {
  nba: { sport: "basketball", league: "nba" },
  nfl: { sport: "football", league: "nfl" },
  mlb: { sport: "baseball", league: "mlb" },
  nhl: { sport: "hockey", league: "nhl" },
  ncaamb: { sport: "basketball", league: "mens-college-basketball" },
  ncaafb: { sport: "football", league: "college-football" },
};

// ─── Helper: safe ESPN fetch ───
async function espnGet(url, fallback = null) {
  try {
    const { data } = await axios.get(url, { timeout: 8000 });
    return data;
  } catch (err) {
    console.error(`[PlayerData] Fetch failed: ${url.split("?")[0]} — ${err.message}`);
    return fallback;
  }
}

// ─── Find player by name ───
async function findPlayer(name, sportKey) {
  const cacheKey = `find_${sportKey}_${name}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const data = await espnGet(
    `https://site.web.api.espn.com/apis/common/v3/search?query=${encodeURIComponent(name)}&limit=3&type=player`
  );

  const players = (data?.items || []).map(p => ({
    id: p.id, name: p.displayName, position: p.position,
    team: p.team?.displayName, teamId: p.team?.id, league: p.league,
  }));

  cache.set(cacheKey, players);
  return players;
}

// ─── Get player season stats + game log ───
async function getPlayerStats(playerName, sportKey) {
  const cacheKey = `stats_${sportKey}_${playerName}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const config = SPORT_MAP[sportKey];
  if (!config) return null;

  const players = await findPlayer(playerName, sportKey);
  if (!players.length) return null;

  const player = players[0];
  const id = player.id;
  const base = `${ESPN_BASE}/${config.sport}/${config.league}/athletes/${id}`;

  const [overview, gamelog, stats] = await Promise.all([
    espnGet(base),
    espnGet(`${base}/gamelog`),
    espnGet(`${base}/statistics`),
  ]);

  // Parse season averages
  let seasonAverages = {};
  if (stats?.statistics?.length) {
    const latest = stats.statistics[0];
    const labels = latest.labels || [];
    const vals = latest.stats?.[0]?.stats || [];
    labels.forEach((l, i) => { if (vals[i] !== undefined) seasonAverages[l] = vals[i]; });
  }

  // Parse game log — handle multiple ESPN response formats
  let recentGames = [];

  // Format 1: events array
  if (gamelog?.events?.length) {
    const labels = gamelog.labels || [];
    recentGames = gamelog.events.slice(-15).reverse().map(ev => {
      const s = {};
      (ev.stats || []).forEach((v, i) => { if (labels[i]) s[labels[i]] = v; });
      return { date: ev.eventDate, opponent: ev.opponent?.displayName || ev.opponent?.abbreviation, homeAway: ev.homeAway, result: ev.gameResult, stats: s };
    });
  }

  // Format 2: seasonTypes array
  if (!recentGames.length && gamelog?.seasonTypes?.length) {
    for (const st of gamelog.seasonTypes) {
      for (const cat of st.categories || []) {
        const labels = cat.labels || [];
        for (const ev of (cat.events || []).slice(-15).reverse()) {
          const s = {};
          (ev.stats || []).forEach((v, i) => { if (labels[i]) s[labels[i]] = v; });
          recentGames.push({ date: ev.eventDate, opponent: ev.opponent?.displayName || ev.opponent?.abbreviation, homeAway: ev.homeAway, result: ev.gameResult, stats: s });
        }
        if (recentGames.length) break;
      }
      if (recentGames.length) break;
    }
  }

  // Calculate recent averages
  let recentAverages = {};
  if (recentGames.length) {
    const keys = Object.keys(recentGames[0]?.stats || {}).filter(k => !isNaN(parseFloat(recentGames[0].stats[k])));
    keys.forEach(k => {
      const vals = recentGames.slice(0, 10).map(g => parseFloat(g.stats[k])).filter(v => !isNaN(v));
      if (vals.length) recentAverages[k] = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
    });
  }

  // ─── HOME/AWAY SPLITS ───
  let homeAwayStats = { home: {}, away: {} };
  if (recentGames.length) {
    const homeGames = recentGames.filter(g => g.homeAway === "home");
    const awayGames = recentGames.filter(g => g.homeAway === "away");

    const calcAvg = (games) => {
      if (!games.length) return {};
      const keys = Object.keys(games[0]?.stats || {}).filter(k => !isNaN(parseFloat(games[0].stats[k])));
      const avgs = {};
      keys.forEach(k => {
        const vals = games.map(g => parseFloat(g.stats[k])).filter(v => !isNaN(v));
        if (vals.length) avgs[k] = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
      });
      return avgs;
    };

    homeAwayStats = { home: { ...calcAvg(homeGames), games: homeGames.length }, away: { ...calcAvg(awayGames), games: awayGames.length } };
  }

  // ─── VS SPECIFIC OPPONENT (from game log) ───
  // We'll compute this in buildPredictionContext when we know the opponent

  const result = {
    id, name: player.name,
    position: player.position || overview?.athlete?.position?.abbreviation,
    team: player.team || overview?.athlete?.team?.displayName,
    teamId: player.teamId,
    headshot: overview?.athlete?.headshot?.href,
    jersey: overview?.athlete?.jersey,
    age: overview?.athlete?.age,
    experience: overview?.athlete?.experience?.years,
    seasonAverages, recentAverages, homeAwayStats,
    recentGames: recentGames.slice(0, 15),
    gamesPlayed: recentGames.length,
  };

  cache.set(cacheKey, result);
  return result;
}

// ─── Team defensive stats ───
async function getTeamDefense(sportKey, teamName) {
  // Try to find team ID from name
  const config = SPORT_MAP[sportKey];
  if (!config) return null;

  const cacheKey = `defense_${sportKey}_${teamName}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // Get all teams to find the ID
  const teamsData = await espnGet(`${ESPN_BASE}/${config.sport}/${config.league}/teams?limit=50`);
  if (!teamsData?.sports?.[0]?.leagues?.[0]?.teams) return null;

  const allTeams = teamsData.sports[0].leagues[0].teams.map(t => t.team);
  const team = allTeams.find(t =>
    t.displayName?.toLowerCase().includes(teamName.toLowerCase()) ||
    teamName.toLowerCase().includes(t.displayName?.toLowerCase()) ||
    t.abbreviation?.toLowerCase() === teamName.toLowerCase() ||
    t.shortDisplayName?.toLowerCase() === teamName.toLowerCase()
  );

  if (!team) return null;

  const statsData = await espnGet(`${ESPN_BASE}/${config.sport}/${config.league}/teams/${team.id}/statistics`);

  let defenseStats = {};
  let offenseStats = {};
  for (const cat of statsData?.statistics || []) {
    const bucket = cat.name?.toLowerCase().includes("defense") || cat.name?.toLowerCase().includes("opponent") ? defenseStats : offenseStats;
    for (const stat of cat.stats || []) {
      bucket[stat.name || stat.label] = { value: stat.displayValue || stat.value, rank: stat.rankDisplayValue || stat.rank };
    }
  }

  const result = { teamId: team.id, teamName: team.displayName, abbreviation: team.abbreviation, defenseStats, offenseStats };
  cache.set(cacheKey, result);
  return result;
}

// ─── Team pace / tempo ───
async function getTeamPace(sportKey, teamName) {
  const config = SPORT_MAP[sportKey];
  if (!config || sportKey !== "nba") return null; // Pace most relevant for NBA

  const cacheKey = `pace_${sportKey}_${teamName}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // NBA pace data from team stats
  const teamDef = await getTeamDefense(sportKey, teamName);
  if (!teamDef) return null;

  // Look for pace-related stats
  const paceStats = {};
  for (const [key, val] of Object.entries({ ...teamDef.offenseStats, ...teamDef.defenseStats })) {
    if (key.toLowerCase().includes("pace") || key.toLowerCase().includes("possession") ||
        key.toLowerCase().includes("points") || key.toLowerCase().includes("fastbreak")) {
      paceStats[key] = val;
    }
  }

  const result = { teamName, pace: paceStats };
  cache.set(cacheKey, result);
  return result;
}

// ─── Injury report ───
async function getInjuries(sportKey, teamName) {
  const config = SPORT_MAP[sportKey];
  if (!config) return [];

  // Find team ID
  const teamDef = await getTeamDefense(sportKey, teamName);
  if (!teamDef?.teamId) return [];

  const data = await espnGet(`${ESPN_BASE}/${config.sport}/${config.league}/teams/${teamDef.teamId}/injuries`);

  return (data?.injuries || data?.items || []).slice(0, 8).map(inj => ({
    player: inj.athlete?.displayName,
    position: inj.athlete?.position?.abbreviation,
    status: inj.status,
    type: inj.type,
    detail: inj.longComment || inj.shortComment,
  }));
}

// ─── Check if back-to-back game ───
async function checkScheduleContext(sportKey, teamName) {
  const config = SPORT_MAP[sportKey];
  if (!config) return null;

  const teamDef = await getTeamDefense(sportKey, teamName);
  if (!teamDef?.teamId) return null;

  const cacheKey = `schedule_${sportKey}_${teamDef.teamId}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // Get team's recent schedule
  const data = await espnGet(`${ESPN_BASE}/${config.sport}/${config.league}/teams/${teamDef.teamId}/schedule`);

  if (!data?.events?.length) return null;

  const now = new Date();
  const today = now.toISOString().split("T")[0];

  // Find today's game and yesterday's game
  const sortedEvents = data.events
    .map(e => ({ date: e.date?.split("T")[0] || "", status: e.competitions?.[0]?.status?.type?.name }))
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  const todayGame = sortedEvents.find(e => e.date === today);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];
  const yesterdayGame = sortedEvents.find(e => e.date === yesterdayStr);

  const result = {
    isBackToBack: !!(todayGame && yesterdayGame),
    gamesInLast5Days: sortedEvents.filter(e => {
      const d = new Date(e.date);
      return (now - d) / (1000 * 60 * 60 * 24) <= 5;
    }).length,
  };

  cache.set(cacheKey, result);
  return result;
}

// ─── Build complete prediction context ───
async function buildPredictionContext(playerName, sportKey, propMarket, propLine, gameInfo) {
  console.log(`[PlayerData] Building full context for ${playerName} (${sportKey})`);

  // Determine opponent name
  const opponentName = gameInfo?.awayTeam || gameInfo?.homeTeam || null;

  // Fetch ALL data in parallel
  const [playerStats, opponentDefense, opponentPace, playerTeamPace, playerTeamInjuries, opponentInjuries, scheduleCtx] = await Promise.all([
    getPlayerStats(playerName, sportKey),
    opponentName ? getTeamDefense(sportKey, opponentName) : null,
    opponentName ? getTeamPace(sportKey, opponentName) : null,
    playerStats?.team ? getTeamPace(sportKey, playerStats?.team) : null,
    gameInfo?.homeTeam ? getInjuries(sportKey, gameInfo.homeTeam) : Promise.resolve([]),
    gameInfo?.awayTeam ? getInjuries(sportKey, gameInfo.awayTeam) : Promise.resolve([]),
    playerStats?.team ? checkScheduleContext(sportKey, playerStats?.team) : null,
  ]);

  // ─── Compute vs opponent history from game log ───
  let vsOpponent = null;
  if (playerStats?.recentGames?.length && opponentName) {
    const opponentShort = opponentName.split(" ").pop().toLowerCase(); // "Lakers" from "Los Angeles Lakers"
    const vsGames = playerStats.recentGames.filter(g =>
      g.opponent && (
        g.opponent.toLowerCase().includes(opponentShort) ||
        opponentShort.includes(g.opponent.toLowerCase())
      )
    );

    if (vsGames.length) {
      const keys = Object.keys(vsGames[0]?.stats || {}).filter(k => !isNaN(parseFloat(vsGames[0].stats[k])));
      const avgs = {};
      keys.forEach(k => {
        const vals = vsGames.map(g => parseFloat(g.stats[k])).filter(v => !isNaN(v));
        if (vals.length) avgs[k] = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
      });
      vsOpponent = { games: vsGames.length, averages: avgs, results: vsGames.map(g => g.result) };
    }
  }

  // ─── Home/away context for THIS game ───
  let venueContext = null;
  if (playerStats?.homeAwayStats && gameInfo) {
    // Determine if player is home or away
    const playerTeam = playerStats.team?.toLowerCase() || "";
    const isHome = gameInfo.homeTeam?.toLowerCase().includes(playerTeam.split(" ").pop()) ||
                   playerTeam.includes(gameInfo.homeTeam?.toLowerCase().split(" ").pop() || "");
    venueContext = {
      playing: isHome ? "HOME" : "AWAY",
      homeStats: playerStats.homeAwayStats.home,
      awayStats: playerStats.homeAwayStats.away,
      relevantStats: isHome ? playerStats.homeAwayStats.home : playerStats.homeAwayStats.away,
    };
  }

  // ─── Hit rate calculation ───
  let hitRate = null;
  if (playerStats?.recentGames?.length && propLine != null) {
    const statKeyMap = {
      player_points: ["PTS", "Points"], player_rebounds: ["REB", "Rebounds"], player_assists: ["AST", "Assists"],
      player_threes: ["3PM", "3PT", "ThreePointers"], player_blocks: ["BLK", "Blocks"], player_steals: ["STL", "Steals"],
      player_points_rebounds_assists: null, // composite
      player_pass_yds: ["PYDS", "PassYds"], player_rush_yds: ["RYDS", "RushYds"],
      player_receptions: ["REC", "Receptions"], player_reception_yds: ["RECYDS"],
      batter_hits: ["H", "Hits"], pitcher_strikeouts: ["K", "SO", "Strikeouts"],
      player_goals: ["G", "Goals"], player_shots_on_goal: ["SOG"],
    };

    const possibleKeys = statKeyMap[propMarket] || [propMarket];

    if (possibleKeys) {
      const values = playerStats.recentGames.map(g => {
        for (const k of possibleKeys) {
          const match = Object.entries(g.stats || {}).find(([sk]) =>
            sk.toUpperCase() === k.toUpperCase() || sk.toUpperCase().includes(k.toUpperCase())
          );
          if (match) return parseFloat(match[1]);
        }
        return null;
      }).filter(v => v !== null);

      if (values.length) {
        const overs = values.filter(v => v > propLine).length;
        hitRate = {
          overRate: Math.round((overs / values.length) * 100),
          underRate: Math.round(((values.length - overs) / values.length) * 100),
          sample: values.length,
          values: values.slice(0, 10),
          streak: getStreak(values, propLine),
        };
      }
    }
  }

  return {
    player: playerStats ? {
      name: playerStats.name, position: playerStats.position, team: playerStats.team,
      age: playerStats.age, experience: playerStats.experience,
      seasonAverages: playerStats.seasonAverages,
      recentAverages: playerStats.recentAverages,
      last5Games: playerStats.recentGames?.slice(0, 5),
      gamesPlayed: playerStats.gamesPlayed,
    } : { name: playerName, note: "Could not find detailed stats" },
    prop: { market: propMarket, line: propLine, hitRate },
    venue: venueContext,
    vsOpponent,
    opponent: {
      name: opponentName,
      defense: opponentDefense ? {
        teamName: opponentDefense.teamName,
        keyStats: Object.entries(opponentDefense.defenseStats || {}).slice(0, 10).reduce((o, [k, v]) => { o[k] = v; return o; }, {}),
      } : null,
      pace: opponentPace?.pace || null,
      injuries: opponentInjuries?.slice(0, 5) || [],
    },
    team: {
      pace: playerTeamPace?.pace || null,
      injuries: playerTeamInjuries?.slice(0, 5) || [],
    },
    schedule: scheduleCtx,
    game: gameInfo,
  };
}

// ─── Helper: calculate over/under streak ───
function getStreak(values, line) {
  if (!values.length) return null;
  let streakType = values[0] > line ? "OVER" : "UNDER";
  let count = 0;
  for (const v of values) {
    if ((streakType === "OVER" && v > line) || (streakType === "UNDER" && v <= line)) {
      count++;
    } else break;
  }
  return { type: streakType, count };
}

module.exports = { findPlayer, getPlayerStats, getTeamDefense, getTeamPace, getInjuries, checkScheduleContext, buildPredictionContext };
