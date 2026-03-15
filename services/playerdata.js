const axios = require("axios");
const NodeCache = require("node-cache");

const cache = new NodeCache({ stdTTL: 900 }); // 15min cache for player stats (was 10min)

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";

const SPORT_MAP = {
  nba: { sport: "basketball", league: "nba" },
  nfl: { sport: "football", league: "nfl" },
  mlb: { sport: "baseball", league: "mlb" },
  nhl: { sport: "hockey", league: "nhl" },
  ncaamb: { sport: "basketball", league: "mens-college-basketball" },
  ncaafb: { sport: "football", league: "college-football" },
};

// Fast ESPN fetch with short timeout
async function espnGet(url, timeout = 5000) {
  try {
    const { data } = await axios.get(url, { timeout });
    return data;
  } catch { return null; }
}

async function findPlayer(name, sportKey) {
  const ck = `find_${sportKey}_${name}`;
  const c = cache.get(ck);
  if (c) return c;
  const data = await espnGet(`https://site.web.api.espn.com/apis/common/v3/search?query=${encodeURIComponent(name)}&limit=2&type=player`);
  const players = (data?.items || []).map(p => ({ id: p.id, name: p.displayName, position: p.position, team: p.team?.displayName, teamId: p.team?.id }));
  cache.set(ck, players);
  return players;
}

async function getPlayerStats(playerName, sportKey) {
  const ck = `stats_${sportKey}_${playerName}`;
  const c = cache.get(ck);
  if (c) return c;

  const config = SPORT_MAP[sportKey];
  if (!config) return null;

  const players = await findPlayer(playerName, sportKey);
  if (!players.length) return null;

  const player = players[0];
  const id = player.id;
  const base = `${ESPN_BASE}/${config.sport}/${config.league}/athletes/${id}`;

  // Fetch overview, gamelog, stats ALL in parallel with fast timeouts
  const [overview, gamelog, stats] = await Promise.all([
    espnGet(base, 4000),
    espnGet(`${base}/gamelog`, 4000),
    espnGet(`${base}/statistics`, 4000),
  ]);

  let seasonAverages = {};
  if (stats?.statistics?.length) {
    const latest = stats.statistics[0];
    const labels = latest.labels || [];
    const vals = latest.stats?.[0]?.stats || [];
    labels.forEach((l, i) => { if (vals[i] !== undefined) seasonAverages[l] = vals[i]; });
  }

  let recentGames = [];
  if (gamelog?.events?.length) {
    const labels = gamelog.labels || [];
    recentGames = gamelog.events.slice(-12).reverse().map(ev => {
      const s = {};
      (ev.stats || []).forEach((v, i) => { if (labels[i]) s[labels[i]] = v; });
      return { date: ev.eventDate, opponent: ev.opponent?.displayName || ev.opponent?.abbreviation, homeAway: ev.homeAway, result: ev.gameResult, stats: s };
    });
  }
  if (!recentGames.length && gamelog?.seasonTypes?.length) {
    for (const st of gamelog.seasonTypes) {
      for (const cat of st.categories || []) {
        const labels = cat.labels || [];
        for (const ev of (cat.events || []).slice(-12).reverse()) {
          const s = {};
          (ev.stats || []).forEach((v, i) => { if (labels[i]) s[labels[i]] = v; });
          recentGames.push({ date: ev.eventDate, opponent: ev.opponent?.displayName || ev.opponent?.abbreviation, homeAway: ev.homeAway, result: ev.gameResult, stats: s });
        }
        if (recentGames.length) break;
      }
      if (recentGames.length) break;
    }
  }

  // Calculate averages
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

  const recentAverages = calcAvg(recentGames.slice(0, 10));
  const homeGames = recentGames.filter(g => g.homeAway === "home");
  const awayGames = recentGames.filter(g => g.homeAway === "away");
  const homeAwayStats = { home: { ...calcAvg(homeGames), games: homeGames.length }, away: { ...calcAvg(awayGames), games: awayGames.length } };

  const result = {
    id, name: player.name, position: player.position || overview?.athlete?.position?.abbreviation,
    team: player.team || overview?.athlete?.team?.displayName, teamId: player.teamId,
    age: overview?.athlete?.age, experience: overview?.athlete?.experience?.years,
    seasonAverages, recentAverages, homeAwayStats,
    recentGames: recentGames.slice(0, 12), gamesPlayed: recentGames.length,
  };
  cache.set(ck, result);
  return result;
}

// Lightweight team defense (cached aggressively)
const teamCache = new NodeCache({ stdTTL: 1800 }); // 30min
async function getTeamDefense(sportKey, teamName) {
  const ck = `defense_${sportKey}_${teamName}`;
  const c = teamCache.get(ck);
  if (c) return c;

  const config = SPORT_MAP[sportKey];
  if (!config) return null;

  const teamsData = await espnGet(`${ESPN_BASE}/${config.sport}/${config.league}/teams?limit=50`, 5000);
  if (!teamsData?.sports?.[0]?.leagues?.[0]?.teams) return null;

  const allTeams = teamsData.sports[0].leagues[0].teams.map(t => t.team);
  const short = teamName.split(" ").pop().toLowerCase();
  const team = allTeams.find(t => t.displayName?.toLowerCase().includes(short) || t.abbreviation?.toLowerCase() === short);
  if (!team) return null;

  const statsData = await espnGet(`${ESPN_BASE}/${config.sport}/${config.league}/teams/${team.id}/statistics`, 4000);
  let defenseStats = {};
  for (const cat of statsData?.statistics || []) {
    if (cat.name?.toLowerCase().includes("defense") || cat.name?.toLowerCase().includes("opponent")) {
      for (const stat of (cat.stats || []).slice(0, 8)) {
        defenseStats[stat.name || stat.label] = { value: stat.displayValue || stat.value, rank: stat.rankDisplayValue || stat.rank };
      }
    }
  }

  const result = { teamId: team.id, teamName: team.displayName, defenseStats };
  teamCache.set(ck, result);
  return result;
}

async function getInjuries(sportKey, teamName) {
  const config = SPORT_MAP[sportKey];
  if (!config) return [];
  const td = await getTeamDefense(sportKey, teamName);
  if (!td?.teamId) return [];
  const data = await espnGet(`${ESPN_BASE}/${config.sport}/${config.league}/teams/${td.teamId}/injuries`, 3000);
  return (data?.injuries || data?.items || []).slice(0, 5).map(i => ({ player: i.athlete?.displayName, status: i.status, position: i.athlete?.position?.abbreviation }));
}

// ─── Build context (optimized: fewer calls, parallel, fast timeouts) ───
async function buildPredictionContext(playerName, sportKey, propMarket, propLine, gameInfo) {
  const opponentName = gameInfo?.awayTeam || gameInfo?.homeTeam || null;

  // ALL fetches in parallel — this is the key speed improvement
  const [playerStats, opponentDefense, injuries] = await Promise.all([
    getPlayerStats(playerName, sportKey),
    opponentName ? getTeamDefense(sportKey, opponentName) : null,
    opponentName ? getInjuries(sportKey, opponentName) : Promise.resolve([]),
  ]);

  // Vs opponent from game log
  let vsOpponent = null;
  if (playerStats?.recentGames?.length && opponentName) {
    const short = opponentName.split(" ").pop().toLowerCase();
    const vsGames = playerStats.recentGames.filter(g => g.opponent?.toLowerCase().includes(short));
    if (vsGames.length) {
      const keys = Object.keys(vsGames[0]?.stats || {}).filter(k => !isNaN(parseFloat(vsGames[0].stats[k])));
      const avgs = {};
      keys.forEach(k => { const v = vsGames.map(g => parseFloat(g.stats[k])).filter(v => !isNaN(v)); if (v.length) avgs[k] = Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10; });
      vsOpponent = { games: vsGames.length, averages: avgs };
    }
  }

  // Venue context
  let venueContext = null;
  if (playerStats?.homeAwayStats && gameInfo) {
    const pt = playerStats.team?.toLowerCase() || "";
    const isHome = gameInfo.homeTeam?.toLowerCase().includes(pt.split(" ").pop());
    venueContext = { playing: isHome ? "HOME" : "AWAY", stats: isHome ? playerStats.homeAwayStats.home : playerStats.homeAwayStats.away };
  }

  // Hit rate
  let hitRate = null;
  if (playerStats?.recentGames?.length && propLine != null) {
    const keys = { player_points: ["PTS"], player_rebounds: ["REB"], player_assists: ["AST"], player_threes: ["3PM", "3PT"], player_pass_yds: ["PYDS"], player_rush_yds: ["RYDS"], player_receptions: ["REC"], batter_hits: ["H"], pitcher_strikeouts: ["K", "SO"], player_goals: ["G"] };
    const possible = keys[propMarket] || [propMarket];
    const values = playerStats.recentGames.map(g => {
      for (const k of possible) { const m = Object.entries(g.stats || {}).find(([sk]) => sk.toUpperCase().includes(k)); if (m) return parseFloat(m[1]); }
      return null;
    }).filter(v => v !== null);
    if (values.length) {
      const overs = values.filter(v => v > propLine).length;
      let streak = { type: values[0] > propLine ? "OVER" : "UNDER", count: 0 };
      for (const v of values) { if ((streak.type === "OVER" && v > propLine) || (streak.type === "UNDER" && v <= propLine)) streak.count++; else break; }
      hitRate = { overRate: Math.round((overs / values.length) * 100), sample: values.length, values: values.slice(0, 8), streak };
    }
  }

  return {
    player: playerStats ? { name: playerStats.name, position: playerStats.position, team: playerStats.team, seasonAverages: playerStats.seasonAverages, recentAverages: playerStats.recentAverages, last5Games: playerStats.recentGames?.slice(0, 5), gamesPlayed: playerStats.gamesPlayed } : { name: playerName },
    prop: { market: propMarket, line: propLine, hitRate },
    venue: venueContext,
    vsOpponent,
    opponent: { name: opponentName, defense: opponentDefense?.defenseStats || null, injuries: injuries?.slice(0, 3) },
    game: gameInfo,
  };
}

module.exports = { findPlayer, getPlayerStats, getTeamDefense, getInjuries, buildPredictionContext };
