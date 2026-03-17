/**
 * prediction-model.js — FIXED VERSION
 * 
 * Fix: ESPN injuries endpoint returns data.injuries[] not data.items[]
 * Fix: Team injury entries have .injuries[] not direct array
 * 
 * 5 accuracy upgrades:
 *   1. INJURY REPORTS — teammate out = usage spike
 *   2. VEGAS GAME ENVIRONMENT — game total/spread
 *   3. PACE/TEMPO — fast teams inflate stats
 *   4. USAGE RATE + TEAMMATE EFFECTS — redistribute when players out
 *   5. WEIGHTED RECENCY + REGRESSION — recent games weighted heavier
 */

const express = require('express');
const axios = require('axios');
const router = express.Router();

const CACHE_TTL_MS = 30 * 60 * 1000;
const LONG_CACHE_TTL = 6 * 60 * 60 * 1000;

const cache = {
  injuries: { data: null, fetchedAt: 0 },
  teamStats: { data: null, fetchedAt: 0 },
  gameOdds: { data: null, fetchedAt: 0 },
};

const LEAGUE_AVG = { pace: 100.5, totalPoints: 224, pts: 24.5, reb: 6.0, ast: 4.5 };

// ============================================================
// 1. INJURY REPORTS (FIXED ESPN parsing)
// ============================================================

async function fetchInjuries() {
  if (cache.injuries.data && Date.now() - cache.injuries.fetchedAt < CACHE_TTL_MS) {
    return cache.injuries.data;
  }

  try {
    const resp = await axios.get(
      'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries',
      { timeout: 10000 }
    );

    const injuries = {};
    // ESPN returns: { injuries: [ { id, displayName, injuries: [...] } ] }
    const teamEntries = resp.data?.injuries || resp.data?.items || [];

    for (const team of teamEntries) {
      // Get team abbreviation from displayName or team object
      const teamName = team.displayName || team.team?.displayName || '';
      const abbr = team.team?.abbreviation || guessAbbreviation(teamName);
      if (!abbr) continue;

      const playerInjuries = team.injuries || [];
      injuries[abbr] = playerInjuries.map(inj => {
        const athlete = inj.athlete || {};
        return {
          player: athlete.displayName || athlete.fullName || 'Unknown',
          playerId: athlete.id,
          position: athlete.position?.abbreviation || athlete.position || '',
          status: inj.status || inj.type?.description || 'Unknown',
          detail: inj.details?.detail || inj.type?.description || inj.longComment?.substring(0, 80) || '',
          isOut: ['Out', 'Injured Reserve', 'O'].includes(inj.status),
          isDayToDay: ['Day-To-Day', 'DTD', 'Questionable', 'Doubtful'].includes(inj.status),
        };
      });
    }

    cache.injuries.data = injuries;
    cache.injuries.fetchedAt = Date.now();
    console.log(`Injuries refreshed: ${Object.keys(injuries).length} teams, ${Object.values(injuries).reduce((s, t) => s + t.length, 0)} players`);
    return injuries;
  } catch (err) {
    console.warn('Injuries fetch failed:', err.message);
    return cache.injuries.data || {};
  }
}

// Map common team names to abbreviations
function guessAbbreviation(name) {
  const map = {
    'Atlanta Hawks': 'ATL', 'Boston Celtics': 'BOS', 'Brooklyn Nets': 'BKN',
    'Charlotte Hornets': 'CHA', 'Chicago Bulls': 'CHI', 'Cleveland Cavaliers': 'CLE',
    'Dallas Mavericks': 'DAL', 'Denver Nuggets': 'DEN', 'Detroit Pistons': 'DET',
    'Golden State Warriors': 'GS', 'Houston Rockets': 'HOU', 'Indiana Pacers': 'IND',
    'Los Angeles Clippers': 'LAC', 'Los Angeles Lakers': 'LAL', 'Memphis Grizzlies': 'MEM',
    'Miami Heat': 'MIA', 'Milwaukee Bucks': 'MIL', 'Minnesota Timberwolves': 'MIN',
    'New Orleans Pelicans': 'NO', 'New York Knicks': 'NY', 'Oklahoma City Thunder': 'OKC',
    'Orlando Magic': 'ORL', 'Philadelphia 76ers': 'PHI', 'Phoenix Suns': 'PHX',
    'Portland Trail Blazers': 'POR', 'Sacramento Kings': 'SAC', 'San Antonio Spurs': 'SA',
    'Toronto Raptors': 'TOR', 'Utah Jazz': 'UTA', 'Washington Wizards': 'WAS',
  };
  return map[name] || null;
}

function getInjuryImpact(teamAbbr, injuries) {
  const teamInjuries = injuries[teamAbbr] || [];
  const outPlayers = teamInjuries.filter(i => i.isOut);
  const dayToDay = teamInjuries.filter(i => i.isDayToDay);

  let minutesVacated = 0, usageVacated = 0;
  for (const p of outPlayers) {
    if (['PG', 'SG'].includes(p.position)) { minutesVacated += 30; usageVacated += 0.20; }
    else if (['SF', 'PF'].includes(p.position)) { minutesVacated += 28; usageVacated += 0.18; }
    else { minutesVacated += 26; usageVacated += 0.16; }
  }

  return {
    outPlayers: outPlayers.map(p => p.player),
    dayToDay: dayToDay.map(d => d.player),
    minutesVacated,
    usageVacated,
    usageBoostPerStarter: outPlayers.length > 0 ? +(usageVacated * 0.6 / 4).toFixed(3) : 0,
    minutesBoostPerStarter: outPlayers.length > 0 ? +(minutesVacated * 0.4 / 4).toFixed(1) : 0,
    hasSignificantInjury: outPlayers.length > 0,
    impactLevel: outPlayers.length >= 2 ? 'major' : outPlayers.length === 1 ? 'moderate' : 'none',
  };
}

// ============================================================
// 2. VEGAS GAME ENVIRONMENT
// ============================================================

async function fetchGameOdds() {
  if (cache.gameOdds.data && Date.now() - cache.gameOdds.fetchedAt < CACHE_TTL_MS) {
    return cache.gameOdds.data;
  }

  try {
    const ODDS_KEY = process.env.ODDS_API_KEY;
    if (!ODDS_KEY) return {};

    const resp = await axios.get('https://api.the-odds-api.com/v4/sports/basketball_nba/odds', {
      params: { apiKey: ODDS_KEY, regions: 'us', markets: 'totals,spreads', oddsFormat: 'american' },
      timeout: 10000,
    });

    const gameOdds = {};
    for (const game of (resp.data || [])) {
      const key = `${game.away_team}@${game.home_team}`;
      gameOdds[key] = { homeTeam: game.home_team, awayTeam: game.away_team, totals: null, spread: null };

      for (const book of (game.bookmakers || []).slice(0, 3)) {
        for (const market of (book.markets || [])) {
          if (market.key === 'totals' && !gameOdds[key].totals) {
            const over = market.outcomes?.find(o => o.name === 'Over');
            if (over) gameOdds[key].totals = over.point;
          }
          if (market.key === 'spreads' && !gameOdds[key].spread) {
            const home = market.outcomes?.find(o => o.name === game.home_team);
            if (home) gameOdds[key].spread = home.point;
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

function getGameEnvironment(gameTotal, spread) {
  if (!gameTotal) return { paceMultiplier: 1.0, blowoutRisk: 'low', favoriteMinutesReduction: 0, gameTotal: null, spread: null };

  const paceMultiplier = +(gameTotal / LEAGUE_AVG.totalPoints).toFixed(3);
  const absSpread = Math.abs(spread || 0);
  let blowoutRisk = 'low', minutesReduction = 0;
  if (absSpread >= 15) { blowoutRisk = 'very_high'; minutesReduction = 6; }
  else if (absSpread >= 10) { blowoutRisk = 'high'; minutesReduction = 3; }
  else if (absSpread >= 7) { blowoutRisk = 'moderate'; minutesReduction = 1; }

  return {
    gameTotal, spread, paceMultiplier, blowoutRisk,
    favoriteMinutesReduction: minutesReduction,
    underdogMinutesBoost: Math.round(minutesReduction * 0.3),
    isHighScoring: gameTotal > 230, isLowScoring: gameTotal < 215,
  };
}

// ============================================================
// 3. PACE / TEMPO
// ============================================================

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
          for (const stat of (cat.stats || [])) { stats[stat.name] = stat.value; }
        }
        teams[team.abbreviation] = {
          id: team.id, name: team.displayName, abbreviation: team.abbreviation,
          pace: stats.paceFactor || stats.possessions || LEAGUE_AVG.pace,
          offRating: stats.offensiveRating || stats.avgPoints || 112,
          defRating: stats.defensiveRating || stats.avgPointsAgainst || 112,
          avgPoints: stats.avgPoints || 112,
          avgPointsAllowed: stats.avgPointsAgainst || 112,
        };
      } catch (e) {
        teams[team.abbreviation] = {
          id: team.id, name: team.displayName, abbreviation: team.abbreviation,
          pace: LEAGUE_AVG.pace, offRating: 112, defRating: 112, avgPoints: 112, avgPointsAllowed: 112,
        };
      }
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

function getMatchupPace(teamAbbr, opponentAbbr, teamStats) {
  const team = teamStats[teamAbbr];
  const opp = teamStats[opponentAbbr];
  if (!team || !opp) return { paceMultiplier: 1.0, matchupPace: LEAGUE_AVG.pace };

  const matchupPace = (team.pace + opp.pace) / 2;
  return {
    teamPace: team.pace, opponentPace: opp.pace,
    matchupPace: +matchupPace.toFixed(1),
    paceMultiplier: +(matchupPace / LEAGUE_AVG.pace).toFixed(3),
    isFastPace: matchupPace / LEAGUE_AVG.pace > 1.03,
    isSlowPace: matchupPace / LEAGUE_AVG.pace < 0.97,
    opponentDefRating: opp.defRating,
  };
}

// ============================================================
// 4. USAGE RATE + TEAMMATE EFFECTS
// ============================================================

function adjustForTeammateAbsence(playerSeasonAvg, injuryImpact, stat) {
  if (!injuryImpact.hasSignificantInjury) return { adjusted: playerSeasonAvg, boost: 0, reason: null };
  const multipliers = { pts: 1.0, reb: 0.3, ast: 0.6, fg3: 0.7, stl: 0.1, blk: 0.1 };
  const boost = +(playerSeasonAvg * injuryImpact.usageBoostPerStarter * (multipliers[stat] || 0.5) * 5).toFixed(1);
  return {
    adjusted: +(playerSeasonAvg + boost).toFixed(1),
    boost: +boost.toFixed(1),
    reason: boost > 0.5 ? `+${boost.toFixed(1)} (${injuryImpact.outPlayers.join(', ')} out)` : null,
  };
}

// ============================================================
// 5. WEIGHTED RECENCY + REGRESSION
// ============================================================

function weightedAverage(games, stat) {
  if (!games || games.length === 0) return 0;
  let weightedSum = 0, totalWeight = 0;
  for (let i = games.length - 1; i >= 0; i--) {
    const gamesAgo = games.length - 1 - i;
    let weight;
    if (gamesAgo < 3) weight = 0.50 / 3;
    else if (gamesAgo < 10) weight = 0.30 / 7;
    else weight = 0.20 / Math.max(1, games.length - 10);
    weightedSum += (games[i][stat] || 0) * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? +(weightedSum / totalWeight).toFixed(1) : 0;
}

function regressionAdjustment(recentAvg, seasonAvg, stdDev) {
  if (!stdDev || stdDev === 0) return { adjusted: recentAvg, regression: 0, signal: 'stable' };
  const deviations = (recentAvg - seasonAvg) / stdDev;
  let regression = 0, signal = 'stable';
  if (deviations > 1.5) { regression = -((deviations - 1.0) * stdDev * 0.3); signal = 'regression_likely'; }
  else if (deviations < -1.5) { regression = -(deviations + 1.0) * stdDev * 0.3; signal = 'bounce_back_likely'; }
  else if (deviations > 0.8) signal = 'hot_streak';
  else if (deviations < -0.8) signal = 'cold_streak';
  return { adjusted: +(recentAvg + regression).toFixed(1), regression: +regression.toFixed(1), signal, deviationsFromMean: +deviations.toFixed(2) };
}

// ============================================================
// COMBINED PREDICTION ENGINE
// ============================================================

async function generatePrediction(params) {
  const { player, stat, line, team, opponent, isHome, gameLog } = params;
  if (!gameLog || gameLog.length < 5) return { available: false, reason: 'Insufficient game log data' };

  const [injuries, teamStats] = await Promise.all([fetchInjuries(), fetchTeamStats()]);

  const values = gameLog.map(g => g[stat] || 0);
  const seasonAvg = +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(1);
  const variance = values.reduce((s, v) => s + Math.pow(v - seasonAvg, 2), 0) / values.length;
  const stdDev = +Math.sqrt(variance).toFixed(1);

  const weightedProjection = weightedAverage(gameLog, stat);
  const recent5Avg = +(gameLog.slice(-5).reduce((a, g) => a + (g[stat] || 0), 0) / 5).toFixed(1);
  const regression = regressionAdjustment(recent5Avg, seasonAvg, stdDev);
  const teamInjuryImpact = getInjuryImpact(team, injuries);
  const opponentInjuryImpact = getInjuryImpact(opponent, injuries);
  const usageAdj = adjustForTeammateAbsence(weightedProjection, teamInjuryImpact, stat);
  const paceData = getMatchupPace(team, opponent, teamStats);
  const gameOdds = await fetchGameOdds();

  let vegasEnv = { paceMultiplier: 1.0, blowoutRisk: 'low', favoriteMinutesReduction: 0 };
  if (gameOdds) {
    for (const [key, odds] of Object.entries(gameOdds)) {
      if (key.includes(team) || key.includes(opponent)) {
        vegasEnv = getGameEnvironment(odds.totals, odds.spread);
        break;
      }
    }
  }

  // Combine all factors
  let projection = usageAdj.adjusted;
  projection += regression.regression;
  if (['pts', 'reb', 'ast', 'fg3'].includes(stat)) projection = +(projection * paceData.paceMultiplier).toFixed(1);
  if (vegasEnv.paceMultiplier !== 1.0 && stat === 'pts') {
    projection = +(projection + (vegasEnv.paceMultiplier - 1.0) * projection * 0.5).toFixed(1);
  }
  if (vegasEnv.blowoutRisk !== 'low' && vegasEnv.favoriteMinutesReduction > 0) {
    const isFavorite = vegasEnv.spread && ((isHome && vegasEnv.spread < 0) || (!isHome && vegasEnv.spread > 0));
    if (isFavorite) projection = +(projection * (1 - (vegasEnv.favoriteMinutesReduction / 36) * 0.7)).toFixed(1);
  }

  // Home/away
  const homeGames = gameLog.filter(g => g.isHome);
  const awayGames = gameLog.filter(g => !g.isHome);
  const homeAvg = homeGames.length >= 3 ? +(homeGames.reduce((a, g) => a + (g[stat] || 0), 0) / homeGames.length).toFixed(1) : null;
  const awayAvg = awayGames.length >= 3 ? +(awayGames.reduce((a, g) => a + (g[stat] || 0), 0) / awayGames.length).toFixed(1) : null;
  const venueAvg = isHome ? homeAvg : awayAvg;
  if (venueAvg !== null) projection = +(projection + (venueAvg - seasonAvg) * 0.15).toFixed(1);

  const diff = +(projection - line).toFixed(1);
  const pick = diff > 0 ? 'OVER' : 'UNDER';

  // Confidence
  let confidence = 50;
  confidence += Math.min(20, (Math.abs(diff) / Math.max(line, 1)) * 200);
  if (stdDev < 3) confidence += 10; else if (stdDev < 5) confidence += 5; else if (stdDev > 8) confidence -= 5;
  let aligned = 0;
  if (diff > 0 && recent5Avg > seasonAvg) aligned++;
  if (diff > 0 && usageAdj.boost > 0) aligned++;
  if (diff > 0 && paceData.isFastPace) aligned++;
  if (diff < 0 && recent5Avg < seasonAvg) aligned++;
  if (diff < 0 && paceData.isSlowPace) aligned++;
  confidence += aligned * 4;
  if (regression.signal === 'regression_likely' || regression.signal === 'bounce_back_likely') confidence -= 5;
  const overCount = values.filter(v => v > line).length;
  const hitRate = +((overCount / values.length) * 100).toFixed(1);
  if (hitRate > 70 || hitRate < 30) confidence += 5;
  confidence = Math.min(95, Math.max(10, Math.round(confidence)));
  const grade = confidence >= 80 ? 'A+' : confidence >= 70 ? 'A' : confidence >= 60 ? 'B+' : confidence >= 55 ? 'B' : confidence >= 50 ? 'C+' : confidence >= 40 ? 'C' : 'D';

  // Reasoning
  const reasons = [`Projection: ${projection} ${stat.toUpperCase()} (line: ${line}). ${pick} by ${Math.abs(diff).toFixed(1)}.`];
  if (teamInjuryImpact.hasSignificantInjury) reasons.push(`Key teammate(s) out (${teamInjuryImpact.outPlayers.join(', ')}) — usage boost expected.`);
  if (paceData.isFastPace) reasons.push(`Fast matchup pace (${paceData.matchupPace}) — volume stats inflated.`);
  else if (paceData.isSlowPace) reasons.push(`Slow matchup pace (${paceData.matchupPace}) — volume stats suppressed.`);
  if (regression.signal === 'regression_likely') reasons.push('Hot streak detected — regression likely.');
  else if (regression.signal === 'bounce_back_likely') reasons.push('Cold streak detected — bounce-back likely.');
  if (vegasEnv.blowoutRisk === 'very_high' || vegasEnv.blowoutRisk === 'high') reasons.push(`Blowout risk: ${vegasEnv.blowoutRisk} (spread: ${vegasEnv.spread}).`);

  return {
    available: true, player, stat, line, team, opponent, isHome,
    projection, pick, diff, confidence, grade,
    seasonAvg, weightedAvg: weightedProjection, recent5Avg, stdDev, hitRate, gamesPlayed: gameLog.length,
    factors: {
      recency: { weighted: weightedProjection, regression: regression.regression, signal: regression.signal, deviations: regression.deviationsFromMean },
      injuries: { teamOut: teamInjuryImpact.outPlayers, opponentOut: opponentInjuryImpact.outPlayers, usageBoost: usageAdj.boost, impactLevel: teamInjuryImpact.impactLevel },
      pace: { teamPace: paceData.teamPace, opponentPace: paceData.opponentPace, matchupPace: paceData.matchupPace, multiplier: paceData.paceMultiplier },
      vegas: { gameTotal: vegasEnv.gameTotal || null, spread: vegasEnv.spread || null, blowoutRisk: vegasEnv.blowoutRisk, paceMultiplier: vegasEnv.paceMultiplier },
      venue: { isHome, homeAvg, awayAvg },
    },
    reasoning: reasons.join(' '),
  };
}

// ============================================================
// API Routes
// ============================================================

router.get('/player', async (req, res) => {
  const { name, stat, line, team, opponent, home } = req.query;
  if (!name || !stat || !line) return res.status(400).json({ error: 'Required: ?name=Player&stat=pts&line=25.5&team=NYK&opponent=BOS' });

  try {
    const PORT = process.env.PORT || 3001;
    const analyticsResp = await axios.get(
      `http://localhost:${PORT}/api/analytics/player/${encodeURIComponent(name)}`,
      { timeout: 15000 }
    ).catch(() => ({ data: { found: false } }));

    const gameLog = analyticsResp.data?.gameLog || [];
    if (gameLog.length < 5) return res.json({ available: false, reason: 'Player game log not available or too short' });

    const prediction = await generatePrediction({
      player: name, stat, line: parseFloat(line),
      team: team?.toUpperCase(), opponent: opponent?.toUpperCase(),
      isHome: home === 'true', gameLog,
    });
    res.json(prediction);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/injuries', async (req, res) => {
  const injuries = await fetchInjuries();
  const teamCount = Object.keys(injuries).length;
  const totalOut = Object.values(injuries).reduce((sum, team) => sum + team.filter(i => i.isOut).length, 0);
  const totalDTD = Object.values(injuries).reduce((sum, team) => sum + team.filter(i => i.isDayToDay).length, 0);
  res.json({ teams: teamCount, totalOut, totalDTD, lastUpdated: new Date(cache.injuries.fetchedAt).toISOString(), injuries });
});

router.get('/injuries/:team', async (req, res) => {
  const injuries = await fetchInjuries();
  const impact = getInjuryImpact(req.params.team.toUpperCase(), injuries);
  const raw = injuries[req.params.team.toUpperCase()] || [];
  res.json({ ...impact, allInjuries: raw });
});

router.get('/pace/:team', async (req, res) => {
  const teamStats = await fetchTeamStats();
  const team = teamStats[req.params.team.toUpperCase()];
  res.json(team || { error: 'Team not found' });
});

router.get('/environment/:team1/:team2', async (req, res) => {
  const { team1, team2 } = req.params;
  const [injuries, teamStats] = await Promise.all([fetchInjuries(), fetchTeamStats()]);
  const pace = getMatchupPace(team1.toUpperCase(), team2.toUpperCase(), teamStats);
  const t1Inj = getInjuryImpact(team1.toUpperCase(), injuries);
  const t2Inj = getInjuryImpact(team2.toUpperCase(), injuries);
  res.json({
    pace, injuries: { [team1.toUpperCase()]: t1Inj, [team2.toUpperCase()]: t2Inj },
    teamStats: { [team1.toUpperCase()]: teamStats[team1.toUpperCase()], [team2.toUpperCase()]: teamStats[team2.toUpperCase()] },
  });
});

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    caches: {
      injuries: { fresh: Date.now() - cache.injuries.fetchedAt < CACHE_TTL_MS, age: Math.round((Date.now() - cache.injuries.fetchedAt) / 1000) + 's' },
      teamStats: { fresh: Date.now() - cache.teamStats.fetchedAt < LONG_CACHE_TTL, age: Math.round((Date.now() - cache.teamStats.fetchedAt) / 1000) + 's' },
    },
    model: { factors: ['injuries', 'vegas_environment', 'pace_tempo', 'usage_redistribution', 'weighted_recency', 'regression_to_mean', 'home_away'], version: '1.1' },
  });
});

function startRefresh() {
  console.log('Prediction model v1.1 started (injuries + vegas + pace + usage + regression)');
  fetchInjuries().catch(e => console.warn('Injury pre-warm failed:', e.message));
  fetchTeamStats().catch(e => console.warn('Team stats pre-warm failed:', e.message));
  setInterval(() => fetchInjuries().catch(e => console.warn('Injury refresh failed:', e.message)), 30 * 60 * 1000);
  setInterval(() => fetchTeamStats().catch(e => console.warn('Team stats refresh failed:', e.message)), 6 * 60 * 60 * 1000);
}

module.exports = { router, startRefresh, generatePrediction, fetchInjuries, fetchTeamStats, getInjuryImpact, getGameEnvironment, getMatchupPace, weightedAverage, regressionAdjustment };
