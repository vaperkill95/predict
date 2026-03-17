/**
 * prediction-model.js — Comprehensive Prediction Accuracy Engine
 * 
 * 5 accuracy upgrades to push ORACLE toward 70%+:
 * 
 *   1. INJURY REPORTS — teammate out = usage spike, minutes shift
 *   2. VEGAS GAME ENVIRONMENT — game total/spread predicts pace + blowout risk
 *   3. PACE/TEMPO — fast teams inflate volume stats
 *   4. USAGE RATE + TEAMMATE EFFECTS — redistribute when players are out
 *   5. WEIGHTED RECENCY + REGRESSION — recent games weighted heavier + mean reversion
 * 
 * All data from free ESPN APIs + your existing Odds API.
 * 
 * Setup:
 *   const predictionModel = require('./services/prediction-model');
 *   app.use('/api/predict', predictionModel.router);
 *   predictionModel.startRefresh();
 */

const express = require('express');
const axios = require('axios');
const router = express.Router();

// ============================================================
// Config & Cache
// ============================================================

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min for injuries/odds
const LONG_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours for pace/team stats

const cache = {
  injuries: { data: null, fetchedAt: 0 },
  teamStats: { data: null, fetchedAt: 0 },
  todayGames: { data: null, fetchedAt: 0 },
  gameOdds: { data: null, fetchedAt: 0 },
};

// League average constants (2025-26 season approximate)
const LEAGUE_AVG = {
  pace: 100.5,        // possessions per 48 min
  totalPoints: 224,    // average game total
  pts: 24.5,           // average starter PPG
  reb: 6.0,
  ast: 4.5,
};

// ============================================================
// 1. INJURY REPORTS
// ============================================================

/**
 * Fetch current NBA injuries from ESPN
 * Returns: { teamAbbr: [{ player, status, detail }] }
 */
async function fetchInjuries() {
  if (cache.injuries.data && Date.now() - cache.injuries.fetchedAt < CACHE_TTL_MS) {
    return cache.injuries.data;
  }

  try {
    // ESPN injuries endpoint: returns all teams with injury lists
    const resp = await axios.get(
      'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries',
      { timeout: 10000 }
    );

    const injuries = {};
    for (const team of (resp.data?.items || [])) {
      const abbr = team.team?.abbreviation;
      if (!abbr) continue;

      injuries[abbr] = (team.injuries || []).map(inj => ({
        player: inj.athlete?.displayName || inj.athlete?.fullName,
        playerId: inj.athlete?.id,
        position: inj.athlete?.position?.abbreviation,
        status: inj.status, // "Out", "Day-To-Day", "Injured Reserve"
        detail: inj.details?.detail || inj.details?.type,
        returnDate: inj.details?.returnDate,
        isOut: inj.status === 'Out' || inj.status === 'Injured Reserve',
        isDayToDay: inj.status === 'Day-To-Day',
      }));
    }

    cache.injuries.data = injuries;
    cache.injuries.fetchedAt = Date.now();
    console.log(`Injuries refreshed: ${Object.keys(injuries).length} teams`);
    return injuries;
  } catch (err) {
    console.warn('Injuries fetch failed:', err.message);
    return cache.injuries.data || {};
  }
}

/**
 * Get injury impact for a specific game
 * Returns which key players are out and the projected usage redistribution
 */
function getInjuryImpact(teamAbbr, injuries) {
  const teamInjuries = injuries[teamAbbr] || [];
  const outPlayers = teamInjuries.filter(i => i.isOut);
  const dayToDay = teamInjuries.filter(i => i.isDayToDay);

  // Estimate combined minutes of out players
  // Stars typically play 32-36 min, role players 20-28 min
  let minutesVacated = 0;
  let usageVacated = 0;
  const outNames = [];

  for (const p of outPlayers) {
    outNames.push(p.player);
    // Rough estimate based on position
    if (['PG', 'SG'].includes(p.position)) {
      minutesVacated += 30;
      usageVacated += 0.20; // guards typically 20-25% usage
    } else if (['SF', 'PF'].includes(p.position)) {
      minutesVacated += 28;
      usageVacated += 0.18;
    } else {
      minutesVacated += 26;
      usageVacated += 0.16;
    }
  }

  return {
    outPlayers: outNames,
    dayToDay: dayToDay.map(d => d.player),
    minutesVacated,
    usageVacated,
    // Remaining starters absorb ~60% of vacated usage
    usageBoostPerStarter: outPlayers.length > 0 ? +(usageVacated * 0.6 / 4).toFixed(3) : 0,
    minutesBoostPerStarter: outPlayers.length > 0 ? +(minutesVacated * 0.4 / 4).toFixed(1) : 0,
    hasSignificantInjury: outPlayers.length > 0,
    impactLevel: outPlayers.length >= 2 ? 'major' : outPlayers.length === 1 ? 'moderate' : 'none',
  };
}

// ============================================================
// 2. VEGAS GAME ENVIRONMENT
// ============================================================

/**
 * Fetch game odds from your existing Odds API data
 * Uses the same endpoint your props service already calls
 */
async function fetchGameOdds(sport = 'nba') {
  if (cache.gameOdds.data && Date.now() - cache.gameOdds.fetchedAt < CACHE_TTL_MS) {
    return cache.gameOdds.data;
  }

  const PORT = process.env.PORT || 3001;
  try {
    const resp = await axios.get(
      `http://localhost:${PORT}/api/odds/${sport}`,
      { timeout: 10000 }
    );

    const odds = resp.data;
    cache.gameOdds.data = odds;
    cache.gameOdds.fetchedAt = Date.now();
    return odds;
  } catch (err) {
    // Fallback: try direct Odds API call
    try {
      const ODDS_KEY = process.env.ODDS_API_KEY;
      if (!ODDS_KEY) return {};

      const resp = await axios.get(
        `https://api.the-odds-api.com/v4/sports/basketball_nba/odds`,
        {
          params: {
            apiKey: ODDS_KEY,
            regions: 'us',
            markets: 'totals,spreads',
            oddsFormat: 'american',
          },
          timeout: 10000,
        }
      );

      const gameOdds = {};
      for (const game of (resp.data || [])) {
        const key = `${game.away_team}@${game.home_team}`;
        gameOdds[key] = {
          homeTeam: game.home_team,
          awayTeam: game.away_team,
          commence: game.commence_time,
          totals: null,
          spread: null,
        };

        for (const book of (game.bookmakers || [])) {
          for (const market of (book.markets || [])) {
            if (market.key === 'totals' && !gameOdds[key].totals) {
              const overOutcome = market.outcomes?.find(o => o.name === 'Over');
              if (overOutcome) gameOdds[key].totals = overOutcome.point;
            }
            if (market.key === 'spreads' && !gameOdds[key].spread) {
              const homeSpread = market.outcomes?.find(o => o.name === game.home_team);
              if (homeSpread) gameOdds[key].spread = homeSpread.point;
            }
          }
        }
      }

      cache.gameOdds.data = gameOdds;
      cache.gameOdds.fetchedAt = Date.now();
      return gameOdds;
    } catch (e) {
      return cache.gameOdds.data || {};
    }
  }
}

/**
 * Get game environment factors from Vegas lines
 */
function getGameEnvironment(gameTotal, spread) {
  if (!gameTotal) return { paceMultiplier: 1.0, blowoutRisk: 'low' };

  // Game total tells us expected pace
  // League average ~224 total. Higher = more possessions = more stats
  const paceMultiplier = +(gameTotal / LEAGUE_AVG.totalPoints).toFixed(3);

  // Spread tells us blowout risk
  // Large spreads = starters sit 4th quarter = fewer minutes
  const absSpread = Math.abs(spread || 0);
  let blowoutRisk = 'low';
  let minutesReduction = 0;
  if (absSpread >= 15) { blowoutRisk = 'very_high'; minutesReduction = 6; }
  else if (absSpread >= 10) { blowoutRisk = 'high'; minutesReduction = 3; }
  else if (absSpread >= 7) { blowoutRisk = 'moderate'; minutesReduction = 1; }

  // Underdog starters actually play MORE in blowouts (chasing)
  // Favorite starters play LESS (resting with lead)
  return {
    gameTotal,
    spread,
    paceMultiplier,
    blowoutRisk,
    favoriteMinutesReduction: minutesReduction,
    underdogMinutesBoost: Math.round(minutesReduction * 0.3), // slight boost for dogs
    expectedPossessions: Math.round(gameTotal / 2.08), // ~2.08 points per possession
    isHighScoring: gameTotal > 230,
    isLowScoring: gameTotal < 215,
  };
}

// ============================================================
// 3. PACE / TEMPO
// ============================================================

/**
 * Fetch team pace ratings from ESPN
 * Pace = possessions per 48 minutes
 */
async function fetchTeamStats() {
  if (cache.teamStats.data && Date.now() - cache.teamStats.fetchedAt < LONG_CACHE_TTL) {
    return cache.teamStats.data;
  }

  try {
    const resp = await axios.get(
      'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams?limit=30',
      { timeout: 10000 }
    );

    const teams = {};
    const teamList = (resp.data?.sports?.[0]?.leagues?.[0]?.teams || []).map(t => t.team);

    for (const team of teamList) {
      try {
        const statsResp = await axios.get(
          `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${team.id}/statistics`,
          { timeout: 8000 }
        );

        const stats = {};
        for (const cat of (statsResp.data?.splits?.categories || [])) {
          for (const stat of (cat.stats || [])) {
            stats[stat.name] = stat.value;
          }
        }

        teams[team.abbreviation] = {
          id: team.id,
          name: team.displayName,
          abbreviation: team.abbreviation,
          pace: stats.paceFactor || stats.possessions || LEAGUE_AVG.pace,
          offRating: stats.offensiveRating || stats.avgPoints || 112,
          defRating: stats.defensiveRating || stats.avgPointsAgainst || 112,
          avgPoints: stats.avgPoints || 112,
          avgPointsAllowed: stats.avgPointsAgainst || 112,
        };
      } catch (e) {
        teams[team.abbreviation] = {
          id: team.id,
          name: team.displayName,
          abbreviation: team.abbreviation,
          pace: LEAGUE_AVG.pace,
          offRating: 112,
          defRating: 112,
          avgPoints: 112,
          avgPointsAllowed: 112,
        };
      }
      // Rate limit
      await new Promise(r => setTimeout(r, 200));
    }

    cache.teamStats.data = teams;
    cache.teamStats.fetchedAt = Date.now();
    console.log(`Team stats refreshed: ${Object.keys(teams).length} teams`);
    return teams;
  } catch (err) {
    console.warn('Team stats fetch failed:', err.message);
    return cache.teamStats.data || {};
  }
}

/**
 * Calculate pace factor for a specific matchup
 * Game pace = average of both teams' pace
 */
function getMatchupPace(teamAbbr, opponentAbbr, teamStats) {
  const team = teamStats[teamAbbr];
  const opp = teamStats[opponentAbbr];

  if (!team || !opp) return { paceMultiplier: 1.0, matchupPace: LEAGUE_AVG.pace };

  const matchupPace = (team.pace + opp.pace) / 2;
  const paceMultiplier = +(matchupPace / LEAGUE_AVG.pace).toFixed(3);

  return {
    teamPace: team.pace,
    opponentPace: opp.pace,
    matchupPace: +matchupPace.toFixed(1),
    paceMultiplier,
    isFastPace: paceMultiplier > 1.03,
    isSlowPace: paceMultiplier < 0.97,
    opponentDefRating: opp.defRating,
  };
}

// ============================================================
// 4. USAGE RATE + TEAMMATE EFFECTS
// ============================================================

/**
 * Estimate usage redistribution when players are injured
 * Usage rate = % of team plays used by a player while on court
 */
function adjustForTeammateAbsence(playerSeasonAvg, injuryImpact, stat) {
  if (!injuryImpact.hasSignificantInjury) return { adjusted: playerSeasonAvg, boost: 0, reason: null };

  // When a teammate is out, remaining players see usage boost
  // Research shows ~60% of vacated usage redistributes to starters
  const usageBoost = injuryImpact.usageBoostPerStarter;

  // Different stats respond differently to usage boosts
  const statMultipliers = {
    pts: 1.0,   // Points directly proportional to usage
    reb: 0.3,   // Rebounds less affected by teammate absence
    ast: 0.6,   // Assists moderately affected
    fg3: 0.7,   // 3-pointers — more shots attempted
    stl: 0.1,   // Steals barely affected
    blk: 0.1,   // Blocks barely affected
  };

  const multiplier = statMultipliers[stat] || 0.5;
  const boost = +(playerSeasonAvg * usageBoost * multiplier * 5).toFixed(1); // Scale factor

  return {
    adjusted: +(playerSeasonAvg + boost).toFixed(1),
    boost: +boost.toFixed(1),
    reason: boost > 0.5 ? `+${boost.toFixed(1)} (${injuryImpact.outPlayers.join(', ')} out)` : null,
  };
}

// ============================================================
// 5. WEIGHTED RECENCY + REGRESSION TO MEAN
// ============================================================

/**
 * Compute exponentially weighted moving average
 * Recent games get much more weight than older games
 * 
 * Weights: last 3 games = 50%, games 4-10 = 30%, rest = 20%
 */
function weightedAverage(games, stat) {
  if (!games || games.length === 0) return 0;

  let weightedSum = 0;
  let totalWeight = 0;

  for (let i = games.length - 1; i >= 0; i--) {
    const gamesAgo = games.length - 1 - i;
    let weight;

    if (gamesAgo < 3) weight = 0.50 / 3;      // Last 3 games: 50% total weight
    else if (gamesAgo < 10) weight = 0.30 / 7;  // Games 4-10: 30% total weight
    else weight = 0.20 / Math.max(1, games.length - 10); // Rest: 20% total weight

    weightedSum += (games[i][stat] || 0) * weight;
    totalWeight += weight;
  }

  return totalWeight > 0 ? +(weightedSum / totalWeight).toFixed(1) : 0;
}

/**
 * Detect regression to mean
 * If a player is performing far above/below their average,
 * they're likely to regress
 */
function regressionAdjustment(recentAvg, seasonAvg, stdDev) {
  if (!stdDev || stdDev === 0) return { adjusted: recentAvg, regression: 0, signal: 'stable' };

  const deviations = (recentAvg - seasonAvg) / stdDev;

  // If performing 1.5+ standard deviations from mean, expect regression
  let regression = 0;
  let signal = 'stable';

  if (deviations > 1.5) {
    // Hot streak — expect to cool off
    regression = -((deviations - 1.0) * stdDev * 0.3);
    signal = 'regression_likely';
  } else if (deviations < -1.5) {
    // Cold streak — expect bounce back
    regression = -(deviations + 1.0) * stdDev * 0.3;
    signal = 'bounce_back_likely';
  } else if (deviations > 0.8) {
    signal = 'hot_streak';
  } else if (deviations < -0.8) {
    signal = 'cold_streak';
  }

  return {
    adjusted: +(recentAvg + regression).toFixed(1),
    regression: +regression.toFixed(1),
    signal,
    deviationsFromMean: +deviations.toFixed(2),
  };
}

// ============================================================
// COMBINED PREDICTION ENGINE
// ============================================================

/**
 * Generate a comprehensive prediction for a player prop
 * 
 * @param {object} params
 * @param {string} params.player - Player name
 * @param {string} params.stat - pts, reb, ast, fg3
 * @param {number} params.line - The prop line
 * @param {string} params.team - Player's team abbreviation
 * @param {string} params.opponent - Opponent abbreviation
 * @param {boolean} params.isHome - Is the player's team home
 * @param {array} params.gameLog - Array of recent games [{pts, reb, ast, ...}]
 */
async function generatePrediction(params) {
  const { player, stat, line, team, opponent, isHome, gameLog } = params;

  if (!gameLog || gameLog.length < 5) {
    return { available: false, reason: 'Insufficient game log data' };
  }

  // Fetch all contextual data
  const [injuries, teamStats] = await Promise.all([
    fetchInjuries(),
    fetchTeamStats(),
  ]);

  const values = gameLog.map(g => g[stat] || 0);
  const seasonAvg = +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(1);
  const variance = values.reduce((s, v) => s + Math.pow(v - seasonAvg, 2), 0) / values.length;
  const stdDev = +Math.sqrt(variance).toFixed(1);

  // 1. WEIGHTED RECENCY — base projection
  const weightedProjection = weightedAverage(gameLog, stat);

  // 2. REGRESSION — adjust for hot/cold streaks
  const recent5Avg = +(gameLog.slice(-5).reduce((a, g) => a + (g[stat] || 0), 0) / 5).toFixed(1);
  const regression = regressionAdjustment(recent5Avg, seasonAvg, stdDev);

  // 3. INJURY IMPACT — teammate absence
  const opponentInjuryImpact = getInjuryImpact(opponent, injuries);
  const teamInjuryImpact = getInjuryImpact(team, injuries);
  const usageAdjustment = adjustForTeammateAbsence(weightedProjection, teamInjuryImpact, stat);

  // 4. PACE — matchup speed
  const paceData = getMatchupPace(team, opponent, teamStats);

  // 5. VEGAS ENVIRONMENT — game total & spread
  // Try to find odds for this game
  const gameOdds = await fetchGameOdds();
  let vegasEnv = { paceMultiplier: 1.0, blowoutRisk: 'low', favoriteMinutesReduction: 0 };
  if (gameOdds) {
    // Try to match the game
    for (const [key, odds] of Object.entries(gameOdds)) {
      if (key.includes(team) || key.includes(opponent)) {
        vegasEnv = getGameEnvironment(odds.totals, odds.spread);
        break;
      }
    }
  }

  // ============================================================
  // COMBINE ALL FACTORS INTO FINAL PROJECTION
  // ============================================================

  let projection = usageAdjustment.adjusted; // Start with usage-adjusted weighted avg

  // Apply regression
  projection += regression.regression;

  // Apply pace multiplier (only for volume stats)
  if (['pts', 'reb', 'ast', 'fg3'].includes(stat)) {
    projection = +(projection * paceData.paceMultiplier).toFixed(1);
  }

  // Apply Vegas pace multiplier (if different from team pace)
  if (vegasEnv.paceMultiplier !== 1.0 && stat === 'pts') {
    // Blend Vegas and team pace (Vegas is usually more accurate)
    const vegasAdj = (vegasEnv.paceMultiplier - 1.0) * projection * 0.5;
    projection = +(projection + vegasAdj).toFixed(1);
  }

  // Apply blowout minutes reduction for favorites
  if (vegasEnv.blowoutRisk !== 'low' && vegasEnv.favoriteMinutesReduction > 0) {
    // Check if this player's team is the favorite
    const isFavorite = vegasEnv.spread && (
      (isHome && vegasEnv.spread < 0) || (!isHome && vegasEnv.spread > 0)
    );
    if (isFavorite) {
      const minutesPct = vegasEnv.favoriteMinutesReduction / 36; // % of typical minutes lost
      projection = +(projection * (1 - minutesPct * 0.7)).toFixed(1);
    }
  }

  // Home/away adjustment (from game log)
  const homeGames = gameLog.filter(g => g.isHome);
  const awayGames = gameLog.filter(g => !g.isHome);
  const homeAvg = homeGames.length >= 3 ? +(homeGames.reduce((a, g) => a + (g[stat] || 0), 0) / homeGames.length).toFixed(1) : null;
  const awayAvg = awayGames.length >= 3 ? +(awayGames.reduce((a, g) => a + (g[stat] || 0), 0) / awayGames.length).toFixed(1) : null;
  const venueAvg = isHome ? homeAvg : awayAvg;
  if (venueAvg !== null) {
    const venueAdj = (venueAvg - seasonAvg) * 0.15; // 15% weight to venue
    projection = +(projection + venueAdj).toFixed(1);
  }

  // ============================================================
  // CONFIDENCE & PICK DIRECTION
  // ============================================================

  const diff = +(projection - line).toFixed(1);
  const pick = diff > 0 ? 'OVER' : 'UNDER';

  // Confidence: 0-100 based on signal alignment
  let confidence = 50;

  // Edge size (how far projection is from line)
  const edgePct = Math.abs(diff) / Math.max(line, 1) * 100;
  confidence += Math.min(20, edgePct * 2);

  // Consistency (low std dev = more predictable)
  if (stdDev < 3) confidence += 10;
  else if (stdDev < 5) confidence += 5;
  else if (stdDev > 8) confidence -= 5;

  // Factor alignment (how many factors agree on the same direction)
  let alignedFactors = 0;
  if (diff > 0 && recent5Avg > seasonAvg) alignedFactors++;
  if (diff > 0 && usageAdjustment.boost > 0) alignedFactors++;
  if (diff > 0 && paceData.isFastPace) alignedFactors++;
  if (diff < 0 && recent5Avg < seasonAvg) alignedFactors++;
  if (diff < 0 && paceData.isSlowPace) alignedFactors++;
  confidence += alignedFactors * 4;

  // Regression warning reduces confidence
  if (regression.signal === 'regression_likely' || regression.signal === 'bounce_back_likely') {
    confidence -= 5;
  }

  // Hit rate (how often this player has hit this line)
  const overCount = values.filter(v => v > line).length;
  const hitRate = +((overCount / values.length) * 100).toFixed(1);
  if (hitRate > 70 || hitRate < 30) confidence += 5; // Strong historical signal

  confidence = Math.min(95, Math.max(10, Math.round(confidence)));

  // Grade: A+ through F
  const grade = confidence >= 80 ? 'A+' : confidence >= 70 ? 'A' : confidence >= 60 ? 'B+' :
                confidence >= 55 ? 'B' : confidence >= 50 ? 'C+' : confidence >= 40 ? 'C' : 'D';

  return {
    available: true,
    player,
    stat,
    line,
    team,
    opponent,
    isHome,

    // Core prediction
    projection,
    pick,
    diff,
    confidence,
    grade,

    // Raw averages
    seasonAvg,
    weightedAvg: weightedProjection,
    recent5Avg,
    stdDev,
    hitRate,
    gamesPlayed: gameLog.length,

    // Factor breakdown
    factors: {
      recency: {
        weighted: weightedProjection,
        regression: regression.regression,
        signal: regression.signal,
        deviations: regression.deviationsFromMean,
      },
      injuries: {
        teamOut: teamInjuryImpact.outPlayers,
        opponentOut: opponentInjuryImpact.outPlayers,
        usageBoost: usageAdjustment.boost,
        impactLevel: teamInjuryImpact.impactLevel,
      },
      pace: {
        teamPace: paceData.teamPace,
        opponentPace: paceData.opponentPace,
        matchupPace: paceData.matchupPace,
        multiplier: paceData.paceMultiplier,
      },
      vegas: {
        gameTotal: vegasEnv.gameTotal || null,
        spread: vegasEnv.spread || null,
        blowoutRisk: vegasEnv.blowoutRisk,
        paceMultiplier: vegasEnv.paceMultiplier,
      },
      venue: {
        isHome,
        homeAvg,
        awayAvg,
      },
    },

    // Reasoning (human-readable)
    reasoning: buildReasoning(pick, diff, confidence, regression, teamInjuryImpact, paceData, vegasEnv, seasonAvg, line, stat),
  };
}

/**
 * Build human-readable reasoning string
 */
function buildReasoning(pick, diff, confidence, regression, injuries, pace, vegas, seasonAvg, line, stat) {
  const parts = [];

  parts.push(`Projection: ${(line + diff).toFixed(1)} ${stat.toUpperCase()} (line: ${line}). ${pick} by ${Math.abs(diff).toFixed(1)}.`);

  if (injuries.hasSignificantInjury) {
    parts.push(`Key teammate(s) out (${injuries.outPlayers.join(', ')}) — usage boost expected.`);
  }

  if (pace.isFastPace) {
    parts.push(`Fast matchup pace (${pace.matchupPace}) — volume stats inflated.`);
  } else if (pace.isSlowPace) {
    parts.push(`Slow matchup pace (${pace.matchupPace}) — volume stats suppressed.`);
  }

  if (regression.signal === 'regression_likely') {
    parts.push(`Hot streak detected — regression likely. Tempered projection.`);
  } else if (regression.signal === 'bounce_back_likely') {
    parts.push(`Cold streak detected — bounce-back likely. Boosted projection.`);
  }

  if (vegas.blowoutRisk === 'very_high' || vegas.blowoutRisk === 'high') {
    parts.push(`Blowout risk: ${vegas.blowoutRisk} (spread: ${vegas.spread}). Starters may rest late.`);
  }

  if (vegas.isHighScoring) {
    parts.push(`High-scoring environment projected (total: ${vegas.gameTotal}).`);
  }

  return parts.join(' ');
}

// ============================================================
// API Routes
// ============================================================

/**
 * GET /api/predict/player?name=Jalen+Brunson&stat=pts&line=27.5&team=NYK&opponent=BOS&home=true
 * Returns comprehensive prediction for a single player prop
 */
router.get('/player', async (req, res) => {
  const { name, stat, line, team, opponent, home } = req.query;

  if (!name || !stat || !line) {
    return res.status(400).json({ error: 'Required: ?name=Player&stat=pts&line=25.5&team=NYK&opponent=BOS' });
  }

  try {
    // Fetch player game log from analytics service
    const PORT = process.env.PORT || 3001;
    const analyticsResp = await axios.get(
      `http://localhost:${PORT}/api/analytics/player/${encodeURIComponent(name)}`,
      { timeout: 15000 }
    );

    const playerData = analyticsResp.data;
    if (!playerData.found || !playerData.gameLog || playerData.gameLog.length === 0) {
      // Try enrichment service
      const enrichResp = await axios.get(
        `http://localhost:${PORT}/api/enriched/player/${encodeURIComponent(name)}`,
        { timeout: 15000 }
      ).catch(() => ({ data: { found: false } }));

      if (!enrichResp.data?.found) {
        return res.json({ available: false, reason: 'Player game log not available' });
      }
    }

    // Use the full game log from the analytics profile
    const gameLog = playerData.splits ? 
      // Reconstruct game log from splits (we need the raw game data)
      playerData.gameLog || [] :
      [];

    const prediction = await generatePrediction({
      player: name,
      stat,
      line: parseFloat(line),
      team: team?.toUpperCase(),
      opponent: opponent?.toUpperCase(),
      isHome: home === 'true',
      gameLog,
    });

    res.json(prediction);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/predict/injuries
 * Returns current injury report for all NBA teams
 */
router.get('/injuries', async (req, res) => {
  const injuries = await fetchInjuries();
  const teamCount = Object.keys(injuries).length;
  const totalOut = Object.values(injuries).reduce((sum, team) => sum + team.filter(i => i.isOut).length, 0);

  res.json({
    teams: teamCount,
    totalOut,
    lastUpdated: new Date(cache.injuries.fetchedAt).toISOString(),
    injuries,
  });
});

/**
 * GET /api/predict/injuries/:team
 * Returns injury impact for a specific team
 */
router.get('/injuries/:team', async (req, res) => {
  const injuries = await fetchInjuries();
  const impact = getInjuryImpact(req.params.team.toUpperCase(), injuries);
  res.json(impact);
});

/**
 * GET /api/predict/pace/:team
 * Returns pace data for a team
 */
router.get('/pace/:team', async (req, res) => {
  const teamStats = await fetchTeamStats();
  const team = teamStats[req.params.team.toUpperCase()];
  res.json(team || { error: 'Team not found' });
});

/**
 * GET /api/predict/environment/:team1/:team2
 * Returns full game environment prediction
 */
router.get('/environment/:team1/:team2', async (req, res) => {
  const { team1, team2 } = req.params;
  const [injuries, teamStats] = await Promise.all([fetchInjuries(), fetchTeamStats()]);

  const pace = getMatchupPace(team1.toUpperCase(), team2.toUpperCase(), teamStats);
  const team1Injuries = getInjuryImpact(team1.toUpperCase(), injuries);
  const team2Injuries = getInjuryImpact(team2.toUpperCase(), injuries);

  res.json({
    pace,
    injuries: { [team1.toUpperCase()]: team1Injuries, [team2.toUpperCase()]: team2Injuries },
    teamStats: {
      [team1.toUpperCase()]: teamStats[team1.toUpperCase()],
      [team2.toUpperCase()]: teamStats[team2.toUpperCase()],
    },
  });
});

/**
 * GET /api/predict/health
 * Returns prediction model status
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    caches: {
      injuries: { fresh: Date.now() - cache.injuries.fetchedAt < CACHE_TTL_MS, age: Math.round((Date.now() - cache.injuries.fetchedAt) / 1000) + 's' },
      teamStats: { fresh: Date.now() - cache.teamStats.fetchedAt < LONG_CACHE_TTL, age: Math.round((Date.now() - cache.teamStats.fetchedAt) / 1000) + 's' },
    },
    model: {
      factors: ['injuries', 'vegas_environment', 'pace_tempo', 'usage_redistribution', 'weighted_recency', 'regression_to_mean', 'home_away'],
      version: '1.0',
    },
  });
});

// ============================================================
// Startup
// ============================================================

function startRefresh() {
  console.log('Prediction model engine started');
  console.log('  Factors: injuries, vegas, pace, usage, recency, regression');

  // Pre-warm caches
  fetchInjuries().catch(e => console.warn('Injury pre-warm failed:', e.message));
  fetchTeamStats().catch(e => console.warn('Team stats pre-warm failed:', e.message));

  // Refresh injuries every 30 min
  setInterval(() => {
    fetchInjuries().catch(e => console.warn('Injury refresh failed:', e.message));
  }, 30 * 60 * 1000);

  // Refresh team stats every 6 hours
  setInterval(() => {
    fetchTeamStats().catch(e => console.warn('Team stats refresh failed:', e.message));
  }, 6 * 60 * 60 * 1000);
}

module.exports = {
  router,
  startRefresh,
  generatePrediction,
  fetchInjuries,
  fetchTeamStats,
  getInjuryImpact,
  getGameEnvironment,
  getMatchupPace,
  weightedAverage,
  regressionAdjustment,
};
