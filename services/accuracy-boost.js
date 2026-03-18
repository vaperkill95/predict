/**
 * accuracy-boost.js — Additional Accuracy Improvement Factors
 * 
 * Factors:
 *   1. Pace × Usage Interaction — exponential boost when high-usage player meets fast pace
 *   2. Rest Days — players with 2+ days rest perform 3-5% better
 *   3. Clutch/Garbage Time Filter — weight late-blowout stats less
 *   4. Weather Impact (NFL/MLB outdoor sports) — wind, rain, temp
 *   5. Travel Distance — coast-to-coast travel = fatigue penalty
 *   6. Real-Time Lineup Monitor — detect late scratches and auto-adjust
 *   7. Defensive Efficiency Rating — precise DvP using pts allowed per 100 possessions
 *   8. Usage Rate Projection — project usage% changes from injuries/trades
 * 
 * Setup:
 *   const accuracyBoost = require('./services/accuracy-boost');
 *   app.use('/api/accuracy', accuracyBoost.router);
 *   accuracyBoost.startMonitoring();
 */

const express = require('express');
const axios = require('axios');
const router = express.Router();

const PORT = process.env.PORT || 3001;

// ============================================================
// NBA Team Data (pace, defensive ratings, locations)
// ============================================================

const TEAM_DATA = {
  // Team pace ratings (possessions per 48 min, 2025-26 season estimates)
  pace: {
    IND: 103.5, ATL: 102.8, MIL: 101.5, SAC: 101.2, MIN: 100.8,
    PHX: 100.5, NOP: 100.3, CHA: 100.0, POR: 99.8, CHI: 99.5,
    DAL: 99.3, WAS: 99.0, DET: 98.8, HOU: 98.5, BKN: 98.3,
    OKC: 98.0, LAL: 97.8, TOR: 97.5, DEN: 97.3, BOS: 97.0,
    PHI: 96.8, NYK: 96.5, MIA: 96.3, GSW: 96.0, LAC: 95.8,
    SAS: 95.5, MEM: 95.3, CLE: 95.0, ORL: 94.8, UTA: 94.5,
  },
  // Defensive ratings (points allowed per 100 possessions — lower = better defense)
  defRating: {
    CLE: 106.5, BOS: 107.2, OKC: 107.8, ORL: 108.0, MIN: 108.5,
    NYK: 109.0, MEM: 109.3, HOU: 109.5, DEN: 109.8, MIA: 110.0,
    LAC: 110.2, GSW: 110.5, MIL: 110.8, DAL: 111.0, PHX: 111.3,
    SAC: 111.5, IND: 112.0, LAL: 112.3, PHI: 112.5, TOR: 112.8,
    BKN: 113.0, SAS: 113.5, NOP: 113.8, CHI: 114.0, ATL: 114.5,
    POR: 115.0, DET: 115.5, CHA: 116.0, WAS: 116.5, UTA: 117.0,
  },
  // Points allowed to position (guard/forward/center) — deviation from league avg
  defVsPosition: {
    // Weak vs guards (allow more points to guards)
    CHA: { guard: +3.5, forward: +1.5, center: +0.5 },
    WAS: { guard: +3.2, forward: +2.0, center: +1.0 },
    UTA: { guard: +2.8, forward: +1.8, center: +2.5 },
    POR: { guard: +2.5, forward: +2.2, center: +1.5 },
    DET: { guard: +2.0, forward: +1.0, center: +3.0 },
    // Average
    LAL: { guard: +0.5, forward: +0.3, center: -0.5 },
    DAL: { guard: +0.2, forward: +0.5, center: +0.2 },
    PHX: { guard: -0.3, forward: +1.0, center: +0.5 },
    // Strong vs guards (suppress guard scoring)
    CLE: { guard: -2.5, forward: -1.5, center: -1.0 },
    BOS: { guard: -2.0, forward: -1.8, center: -0.5 },
    OKC: { guard: -1.8, forward: -2.0, center: -1.5 },
    ORL: { guard: -1.5, forward: -0.8, center: -2.5 },
    MIN: { guard: -1.2, forward: -1.0, center: -2.0 },
  },
  // Team locations (city, timezone, lat/lon for distance calc)
  locations: {
    ATL: { city: 'Atlanta', tz: 'ET', lat: 33.757, lon: -84.396 },
    BOS: { city: 'Boston', tz: 'ET', lat: 42.366, lon: -71.062 },
    BKN: { city: 'Brooklyn', tz: 'ET', lat: 40.683, lon: -73.975 },
    CHA: { city: 'Charlotte', tz: 'ET', lat: 35.225, lon: -80.839 },
    CHI: { city: 'Chicago', tz: 'CT', lat: 41.881, lon: -87.674 },
    CLE: { city: 'Cleveland', tz: 'ET', lat: 41.496, lon: -81.688 },
    DAL: { city: 'Dallas', tz: 'CT', lat: 32.790, lon: -96.810 },
    DEN: { city: 'Denver', tz: 'MT', lat: 39.749, lon: -104.999 },
    DET: { city: 'Detroit', tz: 'ET', lat: 42.341, lon: -83.055 },
    GSW: { city: 'San Francisco', tz: 'PT', lat: 37.768, lon: -122.388 },
    HOU: { city: 'Houston', tz: 'CT', lat: 29.751, lon: -95.362 },
    IND: { city: 'Indianapolis', tz: 'ET', lat: 39.764, lon: -86.156 },
    LAC: { city: 'Los Angeles', tz: 'PT', lat: 34.043, lon: -118.267 },
    LAL: { city: 'Los Angeles', tz: 'PT', lat: 34.043, lon: -118.267 },
    MEM: { city: 'Memphis', tz: 'CT', lat: 35.138, lon: -90.051 },
    MIA: { city: 'Miami', tz: 'ET', lat: 25.781, lon: -80.187 },
    MIL: { city: 'Milwaukee', tz: 'CT', lat: 43.045, lon: -87.917 },
    MIN: { city: 'Minneapolis', tz: 'CT', lat: 44.980, lon: -93.276 },
    NOP: { city: 'New Orleans', tz: 'CT', lat: 29.949, lon: -90.082 },
    NYK: { city: 'New York', tz: 'ET', lat: 40.751, lon: -73.994 },
    OKC: { city: 'Oklahoma City', tz: 'CT', lat: 35.463, lon: -97.515 },
    ORL: { city: 'Orlando', tz: 'ET', lat: 28.539, lon: -81.384 },
    PHI: { city: 'Philadelphia', tz: 'ET', lat: 39.901, lon: -75.172 },
    PHX: { city: 'Phoenix', tz: 'MT', lat: 33.446, lon: -112.071 },
    POR: { city: 'Portland', tz: 'PT', lat: 45.532, lon: -122.667 },
    SAC: { city: 'Sacramento', tz: 'PT', lat: 38.580, lon: -121.500 },
    SAS: { city: 'San Antonio', tz: 'CT', lat: 29.427, lon: -98.438 },
    TOR: { city: 'Toronto', tz: 'ET', lat: 43.643, lon: -79.379 },
    UTA: { city: 'Salt Lake City', tz: 'MT', lat: 40.768, lon: -111.901 },
    WAS: { city: 'Washington', tz: 'ET', lat: 38.898, lon: -77.021 },
  },
};

const LEAGUE_AVG_PACE = 98.5;
const LEAGUE_AVG_DEF_RATING = 111.0;

// ============================================================
// 1. PACE × USAGE INTERACTION
// ============================================================

function paceUsageInteraction(teamAbbr, opponentAbbr, playerUsageRate) {
  const teamPace = TEAM_DATA.pace[teamAbbr] || LEAGUE_AVG_PACE;
  const oppPace = TEAM_DATA.pace[opponentAbbr] || LEAGUE_AVG_PACE;
  const gamePace = (teamPace + oppPace) / 2;
  const paceDeviation = (gamePace - LEAGUE_AVG_PACE) / LEAGUE_AVG_PACE;

  // Usage rate typically 15-35% for NBA players
  const usage = playerUsageRate || 25;
  const usageDeviation = (usage - 25) / 25;

  // Interaction effect: high usage + high pace = exponential boost
  // Low usage + low pace = compound reduction
  const interactionMultiplier = 1 + (paceDeviation * usageDeviation * 0.5);

  return {
    gamePace: +gamePace.toFixed(1),
    paceDeviation: +(paceDeviation * 100).toFixed(1) + '%',
    usageRate: usage,
    interactionMultiplier: +interactionMultiplier.toFixed(4),
    impact: Math.abs(interactionMultiplier - 1) > 0.03 ? 'significant' : 'minor',
    analysis: interactionMultiplier > 1.02
      ? `High pace (${gamePace}) × high usage (${usage}%) = boosted projection`
      : interactionMultiplier < 0.98
        ? `Low pace (${gamePace}) × moderate usage = suppressed projection`
        : `Neutral pace/usage interaction`,
  };
}

// ============================================================
// 2. REST DAYS FACTOR
// ============================================================

function restDaysFactor(restDays) {
  // NBA research: 2+ rest days = 3-5% stat improvement
  // B2B (0 rest) = 3-5% stat decline (handled in minutes projection too)
  let multiplier = 1.0;
  let analysis = '';

  if (restDays === 0) {
    multiplier = 0.96; // B2B penalty
    analysis = 'Back-to-back (0 rest days) — expect 4% stat reduction from fatigue';
  } else if (restDays === 1) {
    multiplier = 1.0; // Standard
    analysis = 'Standard 1 day rest — no adjustment';
  } else if (restDays === 2) {
    multiplier = 1.02; // Slight boost
    analysis = '2 days rest — slight 2% boost from recovery';
  } else if (restDays >= 3 && restDays <= 5) {
    multiplier = 1.04; // Good rest
    analysis = `${restDays} days rest — 4% boost from full recovery`;
  } else if (restDays > 5) {
    multiplier = 1.01; // Rust factor counteracts rest benefit
    analysis = `${restDays} days rest — minimal boost (rust factor offsets rest benefit)`;
  }

  return {
    restDays,
    multiplier: +multiplier.toFixed(3),
    change: +((multiplier - 1) * 100).toFixed(1) + '%',
    analysis,
  };
}

// ============================================================
// 3. CLUTCH / GARBAGE TIME FILTER
// ============================================================

function clutchGarbageTimeAnalysis(spread) {
  const absSpread = Math.abs(spread || 0);

  // Garbage time risk: big favorites → starters sit → bench inflates stats
  // This affects AGAINST betting favorite starters for high stats
  let garbageTimeRisk = 'low';
  let benchBoost = 1.0;
  let starterPenalty = 1.0;

  if (absSpread >= 15) {
    garbageTimeRisk = 'very_high';
    starterPenalty = 0.88; // Starters lose ~12% of production
    benchBoost = 1.25; // Bench gets 25% more opportunity
  } else if (absSpread >= 12) {
    garbageTimeRisk = 'high';
    starterPenalty = 0.93;
    benchBoost = 1.15;
  } else if (absSpread >= 8) {
    garbageTimeRisk = 'moderate';
    starterPenalty = 0.97;
    benchBoost = 1.05;
  }

  return {
    spread,
    garbageTimeRisk,
    starterMultiplier: +starterPenalty.toFixed(3),
    benchMultiplier: +benchBoost.toFixed(3),
    analysis: garbageTimeRisk === 'very_high'
      ? `Blowout likely (spread ${absSpread}). Starters will sit Q4 — reduce projections 12%. Bench players get 25% boost.`
      : garbageTimeRisk === 'high'
        ? `Large spread (${absSpread}). Some garbage time expected — starters may lose 7% of production.`
        : `Competitive game — full minutes expected for starters.`,
    tip: garbageTimeRisk !== 'low'
      ? 'Consider UNDER on favorite starters and OVER on their bench players.'
      : null,
  };
}

// ============================================================
// 4. WEATHER IMPACT (NFL / MLB)
// ============================================================

function weatherImpact(sport, conditions) {
  if (sport === 'nba') return { applicable: false, reason: 'NBA is indoor — weather has no effect' };

  const { temp, wind, precipitation, dome } = conditions || {};
  if (dome) return { applicable: false, reason: 'Game is in a dome — no weather impact' };

  let multiplier = 1.0;
  const factors = [];

  // Temperature (NFL: cold = more running, less passing)
  if (sport === 'nfl' && temp !== undefined) {
    if (temp < 25) {
      multiplier *= 0.90;
      factors.push({ factor: 'Extreme cold', change: -10, detail: `${temp}°F — expect more rushing, fewer passing yards` });
    } else if (temp < 40) {
      multiplier *= 0.95;
      factors.push({ factor: 'Cold weather', change: -5, detail: `${temp}°F — slight reduction in passing` });
    }
  }

  // Wind (affects passing, kicking, fly balls)
  if (wind !== undefined) {
    if (wind >= 20) {
      multiplier *= 0.85;
      factors.push({ factor: 'High wind', change: -15, detail: `${wind} mph — significantly affects passing and 3PT in outdoor` });
    } else if (wind >= 15) {
      multiplier *= 0.93;
      factors.push({ factor: 'Moderate wind', change: -7, detail: `${wind} mph — some effect on passing` });
    }
  }

  // Precipitation
  if (precipitation === 'rain' || precipitation === 'snow') {
    multiplier *= 0.92;
    factors.push({ factor: precipitation === 'snow' ? 'Snow' : 'Rain', change: -8, detail: `${precipitation} — slippery conditions reduce offense` });
  }

  return {
    applicable: true,
    sport,
    multiplier: +multiplier.toFixed(3),
    factors,
    analysis: factors.length > 0
      ? `Weather impact: ${factors.map(f => f.detail).join('. ')}`
      : 'Clear conditions — no weather impact.',
  };
}

// ============================================================
// 5. TRAVEL DISTANCE
// ============================================================

function calculateDistance(lat1, lon1, lat2, lon2) {
  // Haversine formula
  const R = 3959; // miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function travelFatigue(awayTeamAbbr, homeTeamAbbr) {
  const away = TEAM_DATA.locations[awayTeamAbbr];
  const home = TEAM_DATA.locations[homeTeamAbbr];
  if (!away || !home) return { available: false };

  const distance = Math.round(calculateDistance(away.lat, away.lon, home.lat, home.lon));
  const timezonesCrossed = Math.abs(
    ['ET','CT','MT','PT'].indexOf(away.tz) - ['ET','CT','MT','PT'].indexOf(home.tz)
  );

  let fatigueMultiplier = 1.0;
  let analysis = '';

  if (distance >= 2000) {
    fatigueMultiplier = 0.97;
    analysis = `Long travel (${distance} mi, ${timezonesCrossed} timezone${timezonesCrossed !== 1 ? 's' : ''}) — 3% fatigue penalty for away team`;
  } else if (distance >= 1000) {
    fatigueMultiplier = 0.985;
    analysis = `Moderate travel (${distance} mi) — slight 1.5% fatigue penalty`;
  } else {
    analysis = `Short travel (${distance} mi) — no fatigue impact`;
  }

  return {
    available: true,
    from: `${away.city} (${awayTeamAbbr})`,
    to: `${home.city} (${homeTeamAbbr})`,
    distance,
    timezonesCrossed,
    fatigueMultiplier: +fatigueMultiplier.toFixed(3),
    analysis,
  };
}

// ============================================================
// 6. REAL-TIME LINEUP MONITOR
// ============================================================

let lineupCache = { data: null, fetchedAt: 0 };

async function checkLineups() {
  if (lineupCache.data && Date.now() - lineupCache.fetchedAt < 5 * 60 * 1000) {
    return lineupCache.data;
  }

  try {
    // Get today's injuries/status from ESPN
    const resp = await axios.get(`http://localhost:${PORT}/api/predict/injuries`, { timeout: 10000 });
    const injuries = resp.data?.injuries || [];

    const lineups = {};
    for (const team of injuries) {
      const teamAbbr = team.team;
      const out = (team.players || []).filter(p => p.status === 'Out' || p.status === 'OUT');
      const questionable = (team.players || []).filter(p => p.status === 'Questionable' || p.status === 'Day-To-Day' || p.status === 'DTD');
      const probable = (team.players || []).filter(p => p.status === 'Probable');

      lineups[teamAbbr] = {
        out: out.map(p => ({ name: p.name, position: p.position })),
        questionable: questionable.map(p => ({ name: p.name, position: p.position })),
        probable: probable.map(p => ({ name: p.name, position: p.position })),
        outCount: out.length,
        questionableCount: questionable.length,
      };
    }

    lineupCache = { data: lineups, fetchedAt: Date.now() };
    return lineups;
  } catch (e) {
    return lineupCache.data || {};
  }
}

// ============================================================
// 7. DEFENSIVE EFFICIENCY RATING (Precise DvP)
// ============================================================

function preciseDefenseRating(opponentAbbr, playerPosition) {
  const defRating = TEAM_DATA.defRating[opponentAbbr] || LEAGUE_AVG_DEF_RATING;
  const defVsPos = TEAM_DATA.defVsPosition[opponentAbbr];

  // Overall defensive quality
  const overallMultiplier = defRating / LEAGUE_AVG_DEF_RATING;

  // Position-specific adjustment
  let posAdj = 0;
  if (defVsPos && playerPosition) {
    const pos = playerPosition.toLowerCase();
    if (pos.includes('guard') || pos === 'pg' || pos === 'sg') posAdj = defVsPos.guard || 0;
    else if (pos.includes('forward') || pos === 'sf' || pos === 'pf') posAdj = defVsPos.forward || 0;
    else if (pos.includes('center') || pos === 'c') posAdj = defVsPos.center || 0;
  }

  const combinedMultiplier = overallMultiplier + (posAdj / 100);

  return {
    opponent: opponentAbbr,
    defRating,
    leagueAvg: LEAGUE_AVG_DEF_RATING,
    overallMultiplier: +overallMultiplier.toFixed(3),
    positionAdjustment: posAdj,
    combinedMultiplier: +combinedMultiplier.toFixed(3),
    quality: defRating < 108 ? 'elite' : defRating < 110 ? 'good' : defRating < 113 ? 'average' : defRating < 116 ? 'below_avg' : 'poor',
    analysis: defRating < 108
      ? `${opponentAbbr} has elite defense (${defRating} rating). Expect suppressed stats.`
      : defRating > 115
        ? `${opponentAbbr} has weak defense (${defRating} rating). Expect boosted stats.`
        : `${opponentAbbr} has average defense (${defRating} rating).`,
  };
}

// ============================================================
// 8. USAGE RATE PROJECTION
// ============================================================

function projectUsageChange(playerUsage, teammatesOut, isStarter) {
  // When key players are out, usage redistributes
  // Starters absorb more usage than bench players
  let projectedUsage = playerUsage || 25;
  const adjustments = [];

  if (teammatesOut >= 3 && isStarter) {
    projectedUsage += 5;
    adjustments.push(`+5% usage: ${teammatesOut} key teammates OUT`);
  } else if (teammatesOut >= 1 && isStarter) {
    projectedUsage += 2.5;
    adjustments.push(`+2.5% usage: ${teammatesOut} teammate(s) OUT`);
  } else if (teammatesOut >= 1 && !isStarter) {
    projectedUsage += 4;
    adjustments.push(`+4% usage: ${teammatesOut} teammate(s) OUT — bench gets more opportunity`);
  }

  projectedUsage = Math.min(40, projectedUsage);
  const usageMultiplier = projectedUsage / Math.max(playerUsage || 25, 1);

  return {
    baseUsage: playerUsage || 25,
    projectedUsage: +projectedUsage.toFixed(1),
    usageMultiplier: +usageMultiplier.toFixed(3),
    adjustments,
  };
}

// ============================================================
// Monitoring loop
// ============================================================

function startMonitoring() {
  console.log('[AccuracyBoost] Starting lineup monitoring');
  // Pre-cache lineups
  setTimeout(() => checkLineups().catch(() => {}), 30000);
  setInterval(() => checkLineups().catch(() => {}), 5 * 60 * 1000);
}

// ============================================================
// API Routes
// ============================================================

router.get('/all-factors', async (req, res) => {
  const { team, opponent, position, usage, restDays, spread, isStarter, sport } = req.query;

  const results = {
    paceUsage: paceUsageInteraction(team, opponent, parseFloat(usage) || 25),
    restDays: restDaysFactor(parseInt(restDays) || 1),
    garbageTime: clutchGarbageTimeAnalysis(parseFloat(spread) || 0),
    travel: travelFatigue(team, opponent),
    defense: preciseDefenseRating(opponent, position),
    usageProjection: projectUsageChange(parseFloat(usage) || 25, 0, isStarter !== 'false'),
  };

  // Combined multiplier
  const combined = (
    results.paceUsage.interactionMultiplier *
    results.restDays.multiplier *
    (isStarter !== 'false' ? results.garbageTime.starterMultiplier : results.garbageTime.benchMultiplier) *
    results.travel.fatigueMultiplier *
    results.defense.combinedMultiplier *
    results.usageProjection.usageMultiplier
  );

  res.json({
    ...results,
    combinedMultiplier: +combined.toFixed(4),
    combinedImpact: +((combined - 1) * 100).toFixed(1) + '%',
    timestamp: new Date().toISOString(),
  });
});

router.get('/pace-usage', (req, res) => {
  const { team, opponent, usage } = req.query;
  res.json(paceUsageInteraction(team, opponent, parseFloat(usage)));
});

router.get('/rest', (req, res) => {
  const { days } = req.query;
  res.json(restDaysFactor(parseInt(days) || 1));
});

router.get('/garbage-time', (req, res) => {
  const { spread } = req.query;
  res.json(clutchGarbageTimeAnalysis(parseFloat(spread) || 0));
});

router.get('/weather', (req, res) => {
  const { sport, temp, wind, precip, dome } = req.query;
  res.json(weatherImpact(sport || 'nfl', { temp: parseFloat(temp), wind: parseFloat(wind), precipitation: precip, dome: dome === 'true' }));
});

router.get('/travel', (req, res) => {
  const { from, to } = req.query;
  res.json(travelFatigue(from, to));
});

router.get('/lineups', async (req, res) => {
  const lineups = await checkLineups();
  const team = req.query.team;
  if (team && lineups[team]) {
    return res.json({ team, ...lineups[team] });
  }
  res.json({ teams: Object.keys(lineups).length, lineups });
});

router.get('/defense', (req, res) => {
  const { opponent, position } = req.query;
  res.json(preciseDefenseRating(opponent, position));
});

router.get('/usage', (req, res) => {
  const { usage, teammatesOut, isStarter } = req.query;
  res.json(projectUsageChange(parseFloat(usage) || 25, parseInt(teammatesOut) || 0, isStarter !== 'false'));
});

router.get('/team-data', (req, res) => {
  const team = req.query.team;
  if (team) {
    return res.json({
      team,
      pace: TEAM_DATA.pace[team],
      defRating: TEAM_DATA.defRating[team],
      defVsPosition: TEAM_DATA.defVsPosition[team],
      location: TEAM_DATA.locations[team],
    });
  }
  res.json({
    teams: Object.keys(TEAM_DATA.pace).length,
    avgPace: LEAGUE_AVG_PACE,
    avgDefRating: LEAGUE_AVG_DEF_RATING,
    fastestTeams: Object.entries(TEAM_DATA.pace).sort(([,a],[,b]) => b - a).slice(0, 5).map(([t, p]) => `${t}: ${p}`),
    worstDefense: Object.entries(TEAM_DATA.defRating).sort(([,a],[,b]) => b - a).slice(0, 5).map(([t, r]) => `${t}: ${r}`),
  });
});

module.exports = {
  router,
  startMonitoring,
  paceUsageInteraction,
  restDaysFactor,
  clutchGarbageTimeAnalysis,
  weatherImpact,
  travelFatigue,
  preciseDefenseRating,
  projectUsageChange,
  checkLineups,
  TEAM_DATA,
};
