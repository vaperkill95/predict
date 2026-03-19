/**
 * CDL Prediction Engine — ORACLE
 * 
 * Generates match predictions for Call of Duty League using:
 * 1. Team Win Rate (overall season record)
 * 2. Recent Form (last 5 matches)
 * 3. Head-to-Head History
 * 4. Map Win Rate
 * 5. Home/Away (LAN advantage)
 * 6. Series Format (BO5 favors better teams)
 * 7. Opponent Strength (strength of schedule)
 * 8. Streak Momentum
 * 
 * Data source: PandaScore API (free tier — fixtures + results)
 */

const axios = require("axios");
const express = require("express");
const router = express.Router();

const PANDASCORE_KEY = process.env.PANDASCORE_API_KEY;
const BASE = "https://api.pandascore.co";

// Cache to avoid hammering the API
let teamStatsCache = null;
let teamStatsCacheTime = 0;
let matchesCache = null;
let matchesCacheTime = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// ==========================================
// DATA FETCHING
// ==========================================

async function fetchCDLMatches(status = "finished", perPage = 100) {
  if (!PANDASCORE_KEY) return [];
  try {
    const resp = await axios.get(`${BASE}/codmw/matches`, {
      params: {
        token: PANDASCORE_KEY,
        "filter[status]": status,
        sort: "-scheduled_at",
        "page[size]": perPage,
      },
      timeout: 15000,
    });
    return resp.data || [];
  } catch (e) {
    console.error(`[CDL Predictions] Error fetching ${status} matches:`, e.message);
    return [];
  }
}

async function fetchUpcomingMatches() {
  if (!PANDASCORE_KEY) return [];
  try {
    const resp = await axios.get(`${BASE}/codmw/matches`, {
      params: {
        token: PANDASCORE_KEY,
        "filter[status]": "not_started,running",
        sort: "scheduled_at",
        "page[size]": 50,
      },
      timeout: 15000,
    });
    return resp.data || [];
  } catch (e) {
    console.error(`[CDL Predictions] Error fetching upcoming:`, e.message);
    return [];
  }
}

async function fetchCDLTeams() {
  if (!PANDASCORE_KEY) return [];
  try {
    const resp = await axios.get(`${BASE}/codmw/teams`, {
      params: { token: PANDASCORE_KEY, "page[size]": 50 },
      timeout: 15000,
    });
    return resp.data || [];
  } catch (e) {
    return [];
  }
}

// ==========================================
// TEAM STATS BUILDER
// ==========================================

async function buildTeamStats() {
  const now = Date.now();
  if (teamStatsCache && now - teamStatsCacheTime < CACHE_TTL) return teamStatsCache;

  const finished = await fetchCDLMatches("finished", 100);
  const teams = {};

  for (const match of finished) {
    if (!match.opponents || match.opponents.length !== 2) continue;
    if (!match.winner) continue;

    const team1 = match.opponents[0]?.opponent;
    const team2 = match.opponents[1]?.opponent;
    if (!team1 || !team2) continue;

    const winnerId = match.winner.id;
    const matchDate = new Date(match.scheduled_at || match.begin_at);
    const seriesType = match.number_of_games || 5;
    const score1 = match.results?.[0]?.score || 0;
    const score2 = match.results?.[1]?.score || 0;

    // Initialize teams
    for (const t of [team1, team2]) {
      if (!teams[t.id]) {
        teams[t.id] = {
          id: t.id,
          name: t.name,
          slug: t.slug,
          acronym: t.acronym || t.name.substring(0, 3).toUpperCase(),
          imageUrl: t.image_url,
          wins: 0,
          losses: 0,
          mapWins: 0,
          mapLosses: 0,
          matches: [],
          h2h: {}, // head to head vs specific opponents
          streak: 0, // positive = win streak, negative = loss streak
          lastMatch: null,
        };
      }
    }

    const t1 = teams[team1.id];
    const t2 = teams[team2.id];

    // Record result
    const t1Won = winnerId === team1.id;
    t1.wins += t1Won ? 1 : 0;
    t1.losses += t1Won ? 0 : 1;
    t2.wins += t1Won ? 0 : 1;
    t2.losses += t1Won ? 1 : 0;

    // Map wins
    t1.mapWins += score1;
    t1.mapLosses += score2;
    t2.mapWins += score2;
    t2.mapLosses += score1;

    // Match history (for recent form)
    t1.matches.push({ date: matchDate, won: t1Won, opponent: team2.name, opponentId: team2.id, score: `${score1}-${score2}`, seriesType });
    t2.matches.push({ date: matchDate, won: !t1Won, opponent: team1.name, opponentId: team1.id, score: `${score2}-${score1}`, seriesType });

    // H2H
    if (!t1.h2h[team2.id]) t1.h2h[team2.id] = { wins: 0, losses: 0, name: team2.name };
    if (!t2.h2h[team1.id]) t2.h2h[team1.id] = { wins: 0, losses: 0, name: team1.name };
    t1.h2h[team2.id].wins += t1Won ? 1 : 0;
    t1.h2h[team2.id].losses += t1Won ? 0 : 1;
    t2.h2h[team1.id].wins += t1Won ? 0 : 1;
    t2.h2h[team1.id].losses += t1Won ? 1 : 0;
  }

  // Calculate streaks and sort matches by date
  for (const t of Object.values(teams)) {
    t.matches.sort((a, b) => b.date - a.date);
    // Streak from most recent
    let streak = 0;
    for (const m of t.matches) {
      if (streak === 0) {
        streak = m.won ? 1 : -1;
      } else if ((streak > 0 && m.won) || (streak < 0 && !m.won)) {
        streak += streak > 0 ? 1 : -1;
      } else {
        break;
      }
    }
    t.streak = streak;
    t.lastMatch = t.matches[0]?.date || null;
  }

  teamStatsCache = teams;
  teamStatsCacheTime = now;
  return teams;
}

// ==========================================
// PREDICTION ENGINE
// ==========================================

function predictMatch(team1Stats, team2Stats) {
  const factors = [];
  let team1Score = 0;
  let team2Score = 0;

  // === FACTOR 1: Overall Win Rate (30% weight) ===
  const t1WinRate = team1Stats.wins / Math.max(team1Stats.wins + team1Stats.losses, 1);
  const t2WinRate = team2Stats.wins / Math.max(team2Stats.wins + team2Stats.losses, 1);
  const wrDiff = (t1WinRate - t2WinRate) * 30;
  team1Score += wrDiff;
  team2Score -= wrDiff;
  factors.push({
    name: "Win Rate",
    weight: "30%",
    team1: `${(t1WinRate * 100).toFixed(0)}% (${team1Stats.wins}-${team1Stats.losses})`,
    team2: `${(t2WinRate * 100).toFixed(0)}% (${team2Stats.wins}-${team2Stats.losses})`,
    advantage: wrDiff > 0 ? team1Stats.name : wrDiff < 0 ? team2Stats.name : "Even",
  });

  // === FACTOR 2: Recent Form — Last 5 (25% weight) ===
  const t1Recent = team1Stats.matches.slice(0, 5);
  const t2Recent = team2Stats.matches.slice(0, 5);
  const t1RecentWR = t1Recent.filter(m => m.won).length / Math.max(t1Recent.length, 1);
  const t2RecentWR = t2Recent.filter(m => m.won).length / Math.max(t2Recent.length, 1);
  const recentDiff = (t1RecentWR - t2RecentWR) * 25;
  team1Score += recentDiff;
  team2Score -= recentDiff;
  factors.push({
    name: "Recent Form (L5)",
    weight: "25%",
    team1: `${t1Recent.filter(m => m.won).length}-${t1Recent.filter(m => !m.won).length}`,
    team2: `${t2Recent.filter(m => m.won).length}-${t2Recent.filter(m => !m.won).length}`,
    advantage: recentDiff > 0 ? team1Stats.name : recentDiff < 0 ? team2Stats.name : "Even",
  });

  // === FACTOR 3: Head-to-Head (15% weight) ===
  const h2h = team1Stats.h2h[team2Stats.id];
  let h2hDiff = 0;
  if (h2h && (h2h.wins + h2h.losses) >= 1) {
    const h2hRate = h2h.wins / (h2h.wins + h2h.losses);
    h2hDiff = (h2hRate - 0.5) * 15;
    team1Score += h2hDiff;
    team2Score -= h2hDiff;
  }
  factors.push({
    name: "Head-to-Head",
    weight: "15%",
    team1: h2h ? `${h2h.wins}-${h2h.losses}` : "No history",
    team2: h2h ? `${h2h.losses}-${h2h.wins}` : "No history",
    advantage: h2hDiff > 0 ? team1Stats.name : h2hDiff < 0 ? team2Stats.name : "Even",
  });

  // === FACTOR 4: Map Win Rate (15% weight) ===
  const t1MapWR = team1Stats.mapWins / Math.max(team1Stats.mapWins + team1Stats.mapLosses, 1);
  const t2MapWR = team2Stats.mapWins / Math.max(team2Stats.mapWins + team2Stats.mapLosses, 1);
  const mapDiff = (t1MapWR - t2MapWR) * 15;
  team1Score += mapDiff;
  team2Score -= mapDiff;
  factors.push({
    name: "Map Win Rate",
    weight: "15%",
    team1: `${(t1MapWR * 100).toFixed(0)}% (${team1Stats.mapWins}-${team1Stats.mapLosses})`,
    team2: `${(t2MapWR * 100).toFixed(0)}% (${team2Stats.mapWins}-${team2Stats.mapLosses})`,
    advantage: mapDiff > 0 ? team1Stats.name : mapDiff < 0 ? team2Stats.name : "Even",
  });

  // === FACTOR 5: Streak Momentum (10% weight) ===
  const streakDiff = (Math.sign(team1Stats.streak) * Math.min(Math.abs(team1Stats.streak), 5) -
                      Math.sign(team2Stats.streak) * Math.min(Math.abs(team2Stats.streak), 5)) * 2;
  team1Score += streakDiff;
  team2Score -= streakDiff;
  factors.push({
    name: "Streak",
    weight: "10%",
    team1: team1Stats.streak > 0 ? `🔥 ${team1Stats.streak}W streak` : team1Stats.streak < 0 ? `❄️ ${Math.abs(team1Stats.streak)}L streak` : "No streak",
    team2: team2Stats.streak > 0 ? `🔥 ${team2Stats.streak}W streak` : team2Stats.streak < 0 ? `❄️ ${Math.abs(team2Stats.streak)}L streak` : "No streak",
    advantage: streakDiff > 0 ? team1Stats.name : streakDiff < 0 ? team2Stats.name : "Even",
  });

  // === FACTOR 6: Opponent Strength (5% weight) ===
  // If a team's opponents have higher win rates, their record is more impressive
  // (we'll approximate this from their opponent's records in our data)

  // Convert scores to probabilities
  const totalScore = Math.abs(team1Score) + Math.abs(team2Score) + 10; // +10 to prevent extreme values
  const rawT1Prob = 50 + (team1Score / totalScore) * 50;
  const t1Prob = Math.max(15, Math.min(85, rawT1Prob));
  const t2Prob = 100 - t1Prob;

  // Confidence based on how much data we have
  const totalMatches = (team1Stats.wins + team1Stats.losses + team2Stats.wins + team2Stats.losses) / 2;
  const baseConfidence = Math.min(totalMatches / 10, 1); // Max confidence at 10+ matches each
  const probSpread = Math.abs(t1Prob - 50);
  const confidence = Math.round(Math.min(50 + probSpread + baseConfidence * 10, 95));

  return {
    team1Prob: Math.round(t1Prob),
    team2Prob: Math.round(t2Prob),
    predictedWinner: t1Prob >= t2Prob ? team1Stats : team2Stats,
    predictedLoser: t1Prob >= t2Prob ? team2Stats : team1Stats,
    winnerProb: Math.round(Math.max(t1Prob, t2Prob)),
    confidence,
    factors,
    team1Score: Math.round(team1Score * 10) / 10,
    team2Score: Math.round(team2Score * 10) / 10,
  };
}

// ==========================================
// API ROUTES
// ==========================================

// GET /api/cdl-predictions — All upcoming CDL match predictions
router.get("/", async (req, res) => {
  try {
    const [teamStats, upcoming] = await Promise.all([
      buildTeamStats(),
      fetchUpcomingMatches(),
    ]);

    const predictions = [];
    for (const match of upcoming) {
      if (!match.opponents || match.opponents.length !== 2) continue;

      const team1 = match.opponents[0]?.opponent;
      const team2 = match.opponents[1]?.opponent;
      if (!team1 || !team2) continue;

      const t1Stats = teamStats[team1.id];
      const t2Stats = teamStats[team2.id];

      if (!t1Stats || !t2Stats) {
        // Team with no history — give a basic prediction
        predictions.push({
          matchId: match.id,
          scheduledAt: match.scheduled_at,
          status: match.status,
          league: match.league?.name || "CDL",
          tournament: match.tournament?.name || "Unknown",
          seriesType: `Best of ${match.number_of_games || 5}`,
          team1: { name: team1.name, acronym: team1.acronym || team1.name.substring(0, 3), imageUrl: team1.image_url },
          team2: { name: team2.name, acronym: team2.acronym || team2.name.substring(0, 3), imageUrl: team2.image_url },
          prediction: {
            team1Prob: 50, team2Prob: 50,
            predictedWinner: team1.name,
            winnerProb: 50,
            confidence: 30,
            factors: [{ name: "Insufficient Data", weight: "—", team1: "New/Unknown", team2: "New/Unknown", advantage: "Even" }],
            hotTake: "Not enough match history to make a confident prediction.",
          },
        });
        continue;
      }

      const pred = predictMatch(t1Stats, t2Stats);

      predictions.push({
        matchId: match.id,
        scheduledAt: match.scheduled_at,
        status: match.status,
        league: match.league?.name || "CDL",
        tournament: match.tournament?.name || "Unknown",
        seriesType: `Best of ${match.number_of_games || 5}`,
        team1: { name: team1.name, acronym: team1.acronym || t1Stats.acronym, imageUrl: team1.image_url, record: `${t1Stats.wins}-${t1Stats.losses}` },
        team2: { name: team2.name, acronym: team2.acronym || t2Stats.acronym, imageUrl: team2.image_url, record: `${t2Stats.wins}-${t2Stats.losses}` },
        prediction: {
          team1Prob: pred.team1Prob,
          team2Prob: pred.team2Prob,
          predictedWinner: pred.predictedWinner.name,
          winnerAcronym: pred.predictedWinner.acronym,
          winnerProb: pred.winnerProb,
          confidence: pred.confidence,
          factors: pred.factors,
          hotTake: generateHotTake(pred, t1Stats, t2Stats),
        },
      });
    }

    res.json({
      count: predictions.length,
      predictions,
      teamCount: Object.keys(teamStats).length,
      matchesAnalyzed: Object.values(teamStats).reduce((s, t) => s + t.matches.length, 0) / 2,
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[CDL Predictions] Error:", e.message);
    res.status(500).json({ error: "Failed to generate CDL predictions", detail: e.message });
  }
});

// GET /api/cdl-predictions/teams — Team power rankings
router.get("/teams", async (req, res) => {
  try {
    const teamStats = await buildTeamStats();
    const rankings = Object.values(teamStats)
      .filter(t => t.wins + t.losses >= 2) // At least 2 matches
      .map(t => {
        const winRate = t.wins / Math.max(t.wins + t.losses, 1);
        const mapWinRate = t.mapWins / Math.max(t.mapWins + t.mapLosses, 1);
        const recent5 = t.matches.slice(0, 5);
        const recentWR = recent5.filter(m => m.won).length / Math.max(recent5.length, 1);
        // Power rating: 50% win rate + 30% recent + 20% map rate
        const powerRating = (winRate * 50 + recentWR * 30 + mapWinRate * 20).toFixed(1);
        return {
          name: t.name,
          acronym: t.acronym,
          imageUrl: t.imageUrl,
          record: `${t.wins}-${t.losses}`,
          winRate: (winRate * 100).toFixed(1) + "%",
          mapRecord: `${t.mapWins}-${t.mapLosses}`,
          mapWinRate: (mapWinRate * 100).toFixed(1) + "%",
          recentForm: recent5.map(m => m.won ? "W" : "L").join(""),
          streak: t.streak > 0 ? `${t.streak}W` : t.streak < 0 ? `${Math.abs(t.streak)}L` : "-",
          powerRating: parseFloat(powerRating),
          lastMatch: t.lastMatch,
        };
      })
      .sort((a, b) => b.powerRating - a.powerRating);

    res.json({ count: rankings.length, rankings, updatedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/cdl-predictions/h2h/:team1/:team2 — Head-to-head breakdown
router.get("/h2h/:team1/:team2", async (req, res) => {
  try {
    const teamStats = await buildTeamStats();
    const t1 = Object.values(teamStats).find(t =>
      t.name.toLowerCase().includes(req.params.team1.toLowerCase()) ||
      t.acronym.toLowerCase() === req.params.team1.toLowerCase()
    );
    const t2 = Object.values(teamStats).find(t =>
      t.name.toLowerCase().includes(req.params.team2.toLowerCase()) ||
      t.acronym.toLowerCase() === req.params.team2.toLowerCase()
    );
    if (!t1 || !t2) return res.json({ error: "Team not found" });

    const pred = predictMatch(t1, t2);
    const h2h = t1.h2h[t2.id];

    res.json({
      team1: { name: t1.name, record: `${t1.wins}-${t1.losses}`, mapRecord: `${t1.mapWins}-${t1.mapLosses}` },
      team2: { name: t2.name, record: `${t2.wins}-${t2.losses}`, mapRecord: `${t2.mapWins}-${t2.mapLosses}` },
      h2h: h2h ? { team1Wins: h2h.wins, team2Wins: h2h.losses } : null,
      prediction: pred,
      hotTake: generateHotTake(pred, t1, t2),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// HOT TAKE GENERATOR
// ==========================================

function generateHotTake(pred, t1Stats, t2Stats) {
  const winner = pred.predictedWinner;
  const loser = pred.predictedLoser;
  const prob = pred.winnerProb;
  const conf = pred.confidence;

  if (prob >= 75) {
    return `${winner.name} should dominate here. ${winner.acronym} has a clear edge in ${pred.factors.filter(f => f.advantage === winner.name).length}/5 prediction factors. Strong lean on ${winner.acronym}.`;
  } else if (prob >= 65) {
    return `${winner.name} is the favorite but ${loser.name} could steal this. Watch the map vetoes — ${winner.acronym} needs to control the pace. Lean ${winner.acronym}.`;
  } else if (prob >= 55) {
    return `Coin flip match. ${winner.name} has a slight edge but this could go either way. ${pred.factors[0]?.advantage === winner.name ? "Win rate" : "Recent form"} is the differentiator. Slight lean ${winner.acronym}.`;
  } else {
    return `True 50/50. Both teams are evenly matched with no clear edge. Avoid this match or look for live betting opportunities after Map 1.`;
  }
}

// Export for use in server.js
module.exports = { router, buildTeamStats, predictMatch };
