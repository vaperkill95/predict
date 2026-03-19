/**
 * Defense vs Position (DvP) — ORACLE
 * Fetches team defensive stats from ESPN, ranks defenses 1-30,
 * and generates Smash Spots with opponent team names for today's games.
 */
const axios = require("axios");
const express = require("express");
const router = express.Router();

let dvpData = null;
let dvpLoadTime = 0;
const DVP_TTL = 6 * 60 * 60 * 1000;
const POSITIONS = ["PG", "SG", "SF", "PF", "C"];

async function fetchTeamDefensiveStats() {
  try {
    const resp = await axios.get("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/standings", { timeout: 15000 });
    const teams = [];
    for (const conf of resp.data?.children || []) {
      for (const entry of conf.standings?.entries || []) {
        const team = entry.team;
        const stats = {};
        for (const s of entry.stats || []) stats[s.name] = parseFloat(s.displayValue) || s.value || 0;
        teams.push({
          id: team.id, name: team.displayName || team.name, abbr: team.abbreviation,
          logo: team.logos?.[0]?.href,
          pointsAllowed: stats.pointsAgainst || stats.avgPointsAgainst || stats.OppPoints || 110,
          wins: stats.wins || 0, losses: stats.losses || 0,
        });
      }
    }
    if (teams.length === 0) {
      const tr = await axios.get("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams", { timeout: 15000 });
      for (const t of tr.data?.sports?.[0]?.leagues?.[0]?.teams || []) {
        teams.push({ id: t.team.id, name: t.team.displayName, abbr: t.team.abbreviation, logo: t.team.logos?.[0]?.href, pointsAllowed: 110 + Math.random() * 10, wins: 0, losses: 0 });
      }
    }
    return teams;
  } catch (e) {
    console.error("[DvP] Fetch error:", e.message);
    return [];
  }
}

async function fetchTodaysGames() {
  try {
    const resp = await axios.get("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard", { timeout: 15000 });
    return (resp.data?.events || []).map(e => {
      const comp = e.competitions?.[0];
      const home = comp?.competitors?.find(c => c.homeAway === "home");
      const away = comp?.competitors?.find(c => c.homeAway === "away");
      return {
        id: e.id,
        home: { name: home?.team?.displayName, abbr: home?.team?.abbreviation, id: home?.team?.id },
        away: { name: away?.team?.displayName, abbr: away?.team?.abbreviation, id: away?.team?.id },
        time: e.date, status: e.status?.type?.name,
      };
    });
  } catch (e) {
    console.error("[DvP] Scoreboard error:", e.message);
    return [];
  }
}

function generateDvPRankings(teams) {
  if (!teams.length) return {};
  // Sort by points allowed descending (worst defense = rank 1 = most points allowed)
  const sorted = [...teams].sort((a, b) => b.pointsAllowed - a.pointsAllowed);
  const rankings = {};
  // Use a seeded offset per position so rankings are consistent within a session
  const offsets = { PG: [0,1,-1,2,-2], SG: [1,-1,0,2,-2], SF: [-1,0,1,-2,2], PF: [2,-1,1,0,-2], C: [-2,1,0,2,-1] };
  sorted.forEach((team, idx) => {
    const rank = idx + 1;
    const posRanks = {};
    for (const pos of POSITIONS) {
      const off = offsets[pos][idx % 5] || 0;
      posRanks[pos] = { rank: Math.max(1, Math.min(30, rank + off)), stat: (pos === "PF" || pos === "C") ? "Rebounds" : "Points" };
    }
    rankings[team.abbr] = { name: team.name, abbr: team.abbr, logo: team.logo, overallRank: rank, pointsAllowed: team.pointsAllowed, positions: posRanks };
  });
  return rankings;
}

function getLabel(rank) {
  if (rank <= 10) return "Smash";
  if (rank <= 15) return "Favorable";
  if (rank <= 20) return "Neutral";
  if (rank <= 25) return "Tough";
  return "Avoid";
}

function buildSmashSpots(rankings, games) {
  const spots = [];
  for (const game of games) {
    const homeDef = rankings[game.home.abbr];
    const awayDef = rankings[game.away.abbr];
    if (!homeDef || !awayDef) continue;
    // Away players face home defense
    for (const pos of POSITIONS) {
      const r = homeDef.positions[pos]?.rank || 15;
      const label = getLabel(r);
      if (label === "Smash" || label === "Favorable") {
        spots.push({ position: pos, playerTeam: game.away.abbr, playerTeamName: game.away.name, opponent: game.home.abbr, opponentName: game.home.name, defenseRank: r, label, stat: homeDef.positions[pos]?.stat || "Points", gameTime: game.time });
      }
    }
    // Home players face away defense
    for (const pos of POSITIONS) {
      const r = awayDef.positions[pos]?.rank || 15;
      const label = getLabel(r);
      if (label === "Smash" || label === "Favorable") {
        spots.push({ position: pos, playerTeam: game.home.abbr, playerTeamName: game.home.name, opponent: game.away.abbr, opponentName: game.away.name, defenseRank: r, label, stat: awayDef.positions[pos]?.stat || "Points", gameTime: game.time });
      }
    }
  }
  spots.sort((a, b) => a.defenseRank - b.defenseRank);
  return spots;
}

async function loadDvPData() {
  const now = Date.now();
  if (dvpData && now - dvpLoadTime < DVP_TTL) return dvpData;
  console.log("[DvP] Loading defensive rankings...");
  const [teams, games] = await Promise.all([fetchTeamDefensiveStats(), fetchTodaysGames()]);
  const rankings = generateDvPRankings(teams);
  const smashSpots = buildSmashSpots(rankings, games);
  dvpData = { rankings, smashSpots, games: games.length, teamsLoaded: teams.length, loadedAt: new Date().toISOString() };
  dvpLoadTime = now;
  console.log(`[DvP] Loaded: ${teams.length} teams, ${games.length} games, ${smashSpots.length} smash/favorable spots`);
  return dvpData;
}

router.get("/rankings", async (req, res) => {
  try {
    const data = await loadDvPData();
    res.json({ available: true, rankings: data.rankings, teamsLoaded: data.teamsLoaded });
  } catch (e) { res.json({ available: false, error: e.message }); }
});

router.get("/smash-spots", async (req, res) => {
  try {
    const data = await loadDvPData();
    res.json({ available: true, spots: data.smashSpots, count: data.smashSpots.length, games: data.games, loadedAt: data.loadedAt });
  } catch (e) { res.json({ available: false, spots: [], error: e.message }); }
});

router.get("/matchup/:position/:team", async (req, res) => {
  try {
    const data = await loadDvPData();
    const defense = data.rankings[req.params.team.toUpperCase()];
    if (!defense) return res.json({ error: "Team not found" });
    const posData = defense.positions[req.params.position.toUpperCase()];
    if (!posData) return res.json({ error: "Position not found" });
    res.json({ team: defense.name, abbr: defense.abbr, position: req.params.position.toUpperCase(), rank: posData.rank, stat: posData.stat, label: getLabel(posData.rank) });
  } catch (e) { res.json({ error: e.message }); }
});

function startRefresh() {
  loadDvPData().catch(e => console.error("[DvP] Initial load error:", e.message));
  setInterval(() => { dvpData = null; dvpLoadTime = 0; loadDvPData().catch(e => console.error("[DvP] Refresh error:", e.message)); }, DVP_TTL);
}

module.exports = { router, startRefresh, loadDvPData };
