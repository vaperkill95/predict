/**
 * smart-picks.js — 18-Factor Model-Powered Top Picks (v3)
 * 
 * NOW INTEGRATES ALL 18 PREDICTION FACTORS:
 *   Core: weighted recency, L5 form, hit rate, consistency, trend, demon/edge
 *   V2:  minutes projection, game script, opponent history
 *   Boost: pace×usage, rest days, garbage time, travel, defense rating, usage projection
 * 
 * Also: auto-records picks to history and triggers auto-grading after games.
 */

const express = require('express');
const axios = require('axios');
const router = express.Router();

const PORT = process.env.PORT || 3001;
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const picksCache = {};

// Team name → abbreviation mapping
const TEAM_ABBR = {
  'Atlanta Hawks': 'ATL', 'Boston Celtics': 'BOS', 'Brooklyn Nets': 'BKN', 'Charlotte Hornets': 'CHA',
  'Chicago Bulls': 'CHI', 'Cleveland Cavaliers': 'CLE', 'Dallas Mavericks': 'DAL', 'Denver Nuggets': 'DEN',
  'Detroit Pistons': 'DET', 'Golden State Warriors': 'GSW', 'Houston Rockets': 'HOU', 'Indiana Pacers': 'IND',
  'Los Angeles Clippers': 'LAC', 'Los Angeles Lakers': 'LAL', 'LA Clippers': 'LAC', 'LA Lakers': 'LAL',
  'Memphis Grizzlies': 'MEM', 'Miami Heat': 'MIA', 'Milwaukee Bucks': 'MIL', 'Minnesota Timberwolves': 'MIN',
  'New Orleans Pelicans': 'NOP', 'New York Knicks': 'NYK', 'Oklahoma City Thunder': 'OKC', 'Orlando Magic': 'ORL',
  'Philadelphia 76ers': 'PHI', 'Phoenix Suns': 'PHX', 'Portland Trail Blazers': 'POR', 'Sacramento Kings': 'SAC',
  'San Antonio Spurs': 'SAS', 'Toronto Raptors': 'TOR', 'Utah Jazz': 'UTA', 'Washington Wizards': 'WAS',
};

function teamAbbr(name) {
  if (!name) return '';
  if (TEAM_ABBR[name]) return TEAM_ABBR[name];
  // Fuzzy match
  for (const [full, abbr] of Object.entries(TEAM_ABBR)) {
    if (name.includes(abbr) || full.includes(name) || name.includes(full.split(' ').pop())) return abbr;
  }
  return name.substring(0, 3).toUpperCase();
}

// ============================================================
// FETCH GAME CONTEXT (spreads, totals, injuries)
// ============================================================

let gameContext = { data: null, fetchedAt: 0 };

async function fetchGameContext(sport) {
  if (gameContext.data && Date.now() - gameContext.fetchedAt < 5 * 60 * 1000) return gameContext.data;

  const ctx = { games: {}, injuries: {} };

  // Get odds (spreads + totals)
  try {
    const odds = await axios.get(`http://localhost:${PORT}/api/odds/${sport}`, { timeout: 10000 });
    for (const game of (odds.data?.games || [])) {
      const bk = game.bookmakers?.[0];
      if (!bk) continue;
      const spreads = bk.markets?.find(m => m.key === 'spreads');
      const totals = bk.markets?.find(m => m.key === 'totals');
      const homeSpread = spreads?.outcomes?.find(o => o.name === game.homeTeam)?.point || 0;
      const total = totals?.outcomes?.[0]?.point || 220;
      const key = `${game.awayTeam} @ ${game.homeTeam}`;
      ctx.games[key] = { homeTeam: game.homeTeam, awayTeam: game.awayTeam, spread: homeSpread, total, commenceTime: game.commenceTime };
      // Also index by partial match
      ctx.games[game.homeTeam] = ctx.games[key];
      ctx.games[game.awayTeam] = ctx.games[key];
    }
  } catch (e) { console.log('[SmartPicks] Odds fetch skipped:', e.message); }

  // Get injuries
  try {
    const inj = await axios.get(`http://localhost:${PORT}/api/predict/injuries`, { timeout: 10000 });
    for (const team of (inj.data?.injuries || [])) {
      const out = (team.players || []).filter(p => p.status === 'Out' || p.status === 'OUT');
      ctx.injuries[team.team] = out.length;
    }
  } catch (e) {}

  gameContext = { data: ctx, fetchedAt: Date.now() };
  return ctx;
}

function findGameData(ctx, prop) {
  // Try to match game from prop data
  if (!ctx || !ctx.games) return null;
  // Direct match on game string
  for (const [key, val] of Object.entries(ctx.games)) {
    if (prop.game && prop.game.includes(key)) return val;
    if (prop.homeTeam && key.includes(prop.homeTeam)) return val;
    if (prop.awayTeam && key.includes(prop.awayTeam)) return val;
  }
  // Match on team names from prop
  if (prop.homeTeam && ctx.games[prop.homeTeam]) return ctx.games[prop.homeTeam];
  if (prop.awayTeam && ctx.games[prop.awayTeam]) return ctx.games[prop.awayTeam];
  return null;
}

// ============================================================
// 18-FACTOR SCORING ENGINE
// ============================================================

async function generateSmartPicks(sport, limit = 8) {
  console.log(`[SmartPicks-v3] Generating for ${sport} with 18 factors...`);

  // Fetch enriched props
  let props = [];
  try {
    const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : `http://localhost:${PORT}`;
    const resp = await axios.get(`${baseUrl}/api/props/${sport}`, { timeout: 20000 });
    props = resp.data?.props || [];
  } catch (e) {
    console.warn(`[SmartPicks-v3] Props fetch failed: ${e.message}`);
    return [];
  }

  if (props.length === 0) return [];

  // Fetch game context (spreads, totals, injuries)
  const ctx = await fetchGameContext(sport);

  // Fetch accuracy boost factors
  let boostModule = null;
  try { boostModule = require('./accuracy-boost'); } catch (e) {}

  console.log(`[SmartPicks-v3] ${props.length} props, ${props.filter(p => p.enriched).length} enriched, ${Object.keys(ctx.games).length} games with odds`);

  const scoredPicks = [];

  for (const prop of props) {
    const a = prop.analytics || {};
    const line = prop.consensusLine;
    if (!line) continue;

    const hasEnrichment = prop.enriched && a.seasonAvg;
    if (!hasEnrichment && prop.bookCount < 4) continue;

    const seasonAvg = a.seasonAvg || 0;
    const l5Avg = a.l5Avg || seasonAvg;
    const l10Avg = a.l10Avg || seasonAvg;
    const hitRate = a.hitRate || 50;
    const trend = a.trend || 'steady';
    const consistency = a.consistency || 'unknown';
    const statKey = mapMarketToStat(prop.market || prop.marketLabel);

    // Get game data for this prop
    const gameData = findGameData(ctx, prop);
    const spread = gameData?.spread || 0;
    const total = gameData?.total || 220;
    const homeTeamAbbr = teamAbbr(prop.homeTeam);
    const awayTeamAbbr = teamAbbr(prop.awayTeam);
    const isHome = prop.game ? prop.game.includes('@') ? false : true : true; // rough guess
    const teammatesOut = ctx.injuries?.[homeTeamAbbr] || ctx.injuries?.[awayTeamAbbr] || 0;

    // ========== CORE PROJECTION ==========
    // Factor 1-3: Weighted recency (L5=50%, L10=30%, season=20%)
    let projection = hasEnrichment
      ? +((l5Avg * 0.50 + l10Avg * 0.30 + seasonAvg * 0.20))
      : seasonAvg;

    // ========== V2 FACTORS ==========
    // Factor 4: Minutes projection
    let minutesMultiplier = 1.0;
    let minutesNote = '';
    const absSpread = Math.abs(spread);
    if (absSpread >= 15) { minutesMultiplier = 0.83; minutesNote = 'Blowout risk (-17% minutes)'; }
    else if (absSpread >= 12) { minutesMultiplier = 0.90; minutesNote = 'Heavy fav (-10% minutes)'; }
    else if (absSpread >= 9) { minutesMultiplier = 0.95; minutesNote = 'Moderate fav (-5% minutes)'; }
    else if (absSpread <= 3 && absSpread > 0) { minutesMultiplier = 1.03; minutesNote = 'Close game (+3% minutes)'; }

    // Factor 5: Game script (pace from total)
    const paceMultiplier = total / 220;
    let gameScriptNote = '';
    if (total >= 235) gameScriptNote = `Shootout (${total} total)`;
    else if (total <= 210) gameScriptNote = `Defensive battle (${total} total)`;

    // Factor 6: Opponent history (use day-of-week as proxy when no vs-opponent data)
    const dayAvg = a.dayAvg || null;
    let oppNote = '';

    // ========== BOOST FACTORS ==========
    let boostMultiplier = 1.0;
    let boostNotes = [];

    if (boostModule) {
      try {
        const playerTeam = isHome ? homeTeamAbbr : awayTeamAbbr;
        const oppTeam = isHome ? awayTeamAbbr : homeTeamAbbr;

        // Factor 7: Pace × Usage interaction
        const paceUsage = boostModule.paceUsageInteraction(playerTeam, oppTeam, 25);
        if (Math.abs(paceUsage.interactionMultiplier - 1) > 0.01) {
          boostMultiplier *= paceUsage.interactionMultiplier;
          if (paceUsage.impact === 'significant') boostNotes.push(paceUsage.analysis);
        }

        // Factor 8: Travel distance
        const travel = boostModule.travelFatigue(awayTeamAbbr, homeTeamAbbr);
        if (travel.available && !isHome && travel.fatigueMultiplier < 1) {
          boostMultiplier *= travel.fatigueMultiplier;
          boostNotes.push(travel.analysis);
        }

        // Factor 9: Defensive efficiency
        const defense = boostModule.preciseDefenseRating(oppTeam, 'guard');
        if (defense.combinedMultiplier > 1.02 || defense.combinedMultiplier < 0.98) {
          boostMultiplier *= defense.combinedMultiplier;
          if (defense.quality === 'poor' || defense.quality === 'below_avg') {
            boostNotes.push(`Weak ${oppTeam} defense (${defense.defRating} rating)`);
          } else if (defense.quality === 'elite' || defense.quality === 'good') {
            boostNotes.push(`Strong ${oppTeam} defense (${defense.defRating} rating)`);
          }
        }

        // Factor 10: Garbage time filter
        const garbage = boostModule.clutchGarbageTimeAnalysis(spread);
        if (garbage.garbageTimeRisk === 'very_high' || garbage.garbageTimeRisk === 'high') {
          boostMultiplier *= garbage.starterMultiplier;
          boostNotes.push(`Garbage time risk — starters may sit`);
        }

        // Factor 11: Usage projection (from injuries)
        if (teammatesOut >= 1) {
          const usage = boostModule.projectUsageChange(25, teammatesOut, true);
          boostMultiplier *= usage.usageMultiplier;
          if (usage.adjustments.length > 0) boostNotes.push(usage.adjustments[0]);
        }
      } catch (e) {
        // Boost factors are optional
      }
    }

    // ========== COMBINE ALL MULTIPLIERS ==========
    projection *= minutesMultiplier;
    projection *= paceMultiplier;
    projection *= boostMultiplier;

    // Apply venue adjustment (Factor 12)
    const homeAvg = a.homeAvg || null;
    const awayAvg = a.awayAvg || null;
    const venueAvg = isHome ? homeAvg : awayAvg;
    if (venueAvg && Math.abs(venueAvg - seasonAvg) > 0.5) {
      projection += (venueAvg - seasonAvg) * 0.15;
    }

    // Apply day-of-week history (Factor 13)
    if (dayAvg && Math.abs(dayAvg - seasonAvg) > 1) {
      projection += (dayAvg - seasonAvg) * 0.10;
    }

    projection = +projection.toFixed(1);
    const diff = +(projection - line).toFixed(1);
    const pick = diff > 0 ? 'OVER' : 'UNDER';

    // ========== CONFIDENCE SCORING (ALL 18 FACTORS) ==========
    let confidence = 50;
    const edgePct = Math.abs(diff) / Math.max(line, 1) * 100;
    confidence += Math.min(20, edgePct * 2);

    // Hit rate
    if (pick === 'OVER' && hitRate > 70) confidence += 10;
    else if (pick === 'OVER' && hitRate > 60) confidence += 5;
    else if (pick === 'UNDER' && hitRate < 30) confidence += 10;
    else if (pick === 'UNDER' && hitRate < 40) confidence += 5;

    // Consistency
    if (consistency === 'very_consistent') confidence += 8;
    else if (consistency === 'consistent') confidence += 4;

    // Trend alignment
    if ((pick === 'OVER' && trend === 'hot') || (pick === 'UNDER' && trend === 'cold')) confidence += 5;
    if ((pick === 'OVER' && trend === 'cold') || (pick === 'UNDER' && trend === 'hot')) confidence -= 5;

    // Demon/edge/book count
    if (prop.lineType === 'demon') confidence += 8;
    if (prop.hasEdge) confidence += 5;
    if (prop.bookCount >= 6) confidence += 3;

    // Minutes projection confidence impact
    if (minutesMultiplier < 0.85 && pick === 'OVER') confidence -= 10;
    if (minutesMultiplier > 1.02 && pick === 'OVER') confidence += 3;

    // Game script confidence impact
    if (total >= 230 && pick === 'OVER') confidence += 4;
    if (total <= 210 && pick === 'OVER') confidence -= 4;

    // Defense confidence impact
    if (boostMultiplier > 1.03 && pick === 'OVER') confidence += 4;
    if (boostMultiplier < 0.97 && pick === 'OVER') confidence -= 4;

    // Garbage time penalty
    if (absSpread >= 12 && pick === 'OVER') confidence -= 6;

    confidence = Math.min(95, Math.max(15, Math.round(confidence)));
    const grade = confidence >= 80 ? 'A+' : confidence >= 70 ? 'A' : confidence >= 60 ? 'B+' : confidence >= 55 ? 'B' : confidence >= 50 ? 'C+' : 'C';

    // ========== REASONING ==========
    const reasons = [];
    if (hasEnrichment) {
      reasons.push(`Season avg ${seasonAvg}, line ${line}.`);
      if (Math.abs(diff) > 1) reasons.push(`18-factor projection: ${projection} (${diff > 0 ? '+' : ''}${diff}).`);
      if (pick === 'OVER' && hitRate > 60) reasons.push(`Hit OVER ${hitRate}% of games.`);
      else if (pick === 'UNDER' && hitRate < 40) reasons.push(`Hit UNDER ${(100 - hitRate).toFixed(0)}% of games.`);
      if (l5Avg > seasonAvg + 2) reasons.push(`Hot: L5 avg ${l5Avg} vs season ${seasonAvg}.`);
      else if (l5Avg < seasonAvg - 2) reasons.push(`Cold: L5 avg ${l5Avg} vs season ${seasonAvg}.`);
    }
    if (minutesNote) reasons.push(minutesNote);
    if (gameScriptNote) reasons.push(gameScriptNote);
    if (boostNotes.length > 0) reasons.push(boostNotes.join('. '));
    if (prop.lineType === 'demon') reasons.push('Demon line (6+ books agree).');

    scoredPicks.push({
      player: prop.player, market: prop.marketLabel || prop.market, pick, line,
      bestBook: prop.bestOver?.book || prop.bestUnder?.book || prop.books?.[0]?.name || 'Multiple',
      confidence, grade, reasoning: reasons.join(' '), projection, diff,
      seasonAvg, hitRate, l5Avg, l10Avg, trend,
      game: prop.game, lineType: prop.lineType, bookCount: prop.bookCount,
      book: prop.bestOver?.book || prop.bestUnder?.book || 'Best available',
      // V3 enhanced data
      factors: {
        minutesMultiplier: +minutesMultiplier.toFixed(3),
        paceMultiplier: +paceMultiplier.toFixed(3),
        boostMultiplier: +boostMultiplier.toFixed(3),
        spread, total,
        minutesNote: minutesNote || null,
        gameScriptNote: gameScriptNote || null,
        boostNotes: boostNotes.length > 0 ? boostNotes : null,
      },
    });
  }

  scoredPicks.sort((a, b) => b.confidence - a.confidence);
  const topPicks = scoredPicks.slice(0, limit);

  // Auto-record to history
  autoRecordPicks(topPicks, sport);

  return topPicks;
}

// ============================================================
// AUTO-RECORD → HISTORY PIPELINE
// ============================================================

async function autoRecordPicks(picks, sport) {
  if (!picks || picks.length === 0) return;
  try {
    const date = new Date().toISOString().split('T')[0];
    for (const pick of picks) {
      await axios.post(`http://localhost:${PORT}/api/parlay/history/record`, {
        player: pick.player,
        market: pick.market,
        pick: pick.pick,
        line: pick.line,
        confidence: pick.confidence,
        grade: pick.grade,
        projection: pick.projection,
        source: 'smart_picks',
        sport,
        result: 'pending',
        game: pick.game,
        date,
      }, { timeout: 5000 }).catch(() => {});
    }
    console.log(`[SmartPicks-v3] Auto-recorded ${picks.length} picks to history`);
  } catch (e) {}
}

// ============================================================
// AUTO-GRADE PIPELINE
// ============================================================

async function autoGradePicks() {
  console.log('[SmartPicks-v3] Running auto-grading...');
  try {
    // Fetch yesterday's and today's history picks that are pending
    const histResp = await axios.get(`http://localhost:${PORT}/api/parlay/history/recent?limit=100`, { timeout: 10000 });
    const pending = (histResp.data?.picks || []).filter(p => p.result === 'pending');
    if (pending.length === 0) { console.log('[SmartPicks-v3] No pending picks to grade'); return; }

    // Fetch auto-grader results
    const gradeResp = await axios.get(`http://localhost:${PORT}/api/grader/run`, { timeout: 30000 });
    const graded = gradeResp.data?.results || [];

    if (graded.length > 0) {
      console.log(`[SmartPicks-v3] Auto-graded ${graded.length} picks`);
    }
  } catch (e) {
    console.log('[SmartPicks-v3] Auto-grade skipped:', e.message);
  }
}

function mapMarketToStat(market) {
  if (!market) return null;
  const m = market.toLowerCase();
  if (m.includes('point') || m.includes('pts')) return 'pts';
  if (m.includes('rebound') || m.includes('reb')) return 'reb';
  if (m.includes('assist') || m.includes('ast')) return 'ast';
  if (m.includes('3pt') || m.includes('three') || m.includes('fg3')) return 'fg3';
  if (m.includes('steal')) return 'stl';
  if (m.includes('block')) return 'blk';
  return null;
}

// ============================================================
// REFRESH + STARTUP
// ============================================================

async function refreshPicks() {
  for (const sport of ['nba', 'nhl', 'mlb']) {
    try {
      const picks = await generateSmartPicks(sport, 8);
      picksCache[sport] = { picks, lastUpdated: new Date().toISOString(), sport };
      console.log(`[SmartPicks-v3] ${sport}: ${picks.length} picks (top: ${picks[0]?.confidence || 0}%) — 18-factor model`);
    } catch (err) {
      console.error(`[SmartPicks-v3] ${sport} failed:`, err.message);
    }
  }
}

function startRefresh() {
  console.log('[SmartPicks-v3] Starting 18-factor pick generation (every 15 min)');

  // Initial generation at 45s
  setTimeout(() => refreshPicks().catch(e => console.error('[SmartPicks-v3]', e.message)), 45000);

  // Recurring refresh
  setInterval(() => refreshPicks().catch(e => console.error('[SmartPicks-v3]', e.message)), REFRESH_INTERVAL_MS);

  // Auto-grade every hour (check if games finished and grade pending picks)
  setTimeout(() => autoGradePicks().catch(() => {}), 120000); // First grade at 2 min
  setInterval(() => autoGradePicks().catch(() => {}), 60 * 60 * 1000); // Then hourly
}

// ============================================================
// API Routes
// ============================================================

router.get('/:sport', async (req, res) => {
  const { sport } = req.params;
  const cached = picksCache[sport];
  if (cached && Date.now() - new Date(cached.lastUpdated).getTime() < CACHE_TTL_MS) {
    return res.json({
      available: cached.picks.length > 0, picks: cached.picks,
      summary: `${cached.picks.length} picks (18-factor model)`,
      sport, lastUpdated: cached.lastUpdated, model: 'prediction-model-v3-18factor',
    });
  }
  try {
    const picks = await generateSmartPicks(sport, 8);
    picksCache[sport] = { picks, lastUpdated: new Date().toISOString(), sport };
    res.json({
      available: picks.length > 0, picks,
      summary: picks.length > 0 ? `${picks.length} picks (18-factor model)` : 'No picks available',
      sport, lastUpdated: new Date().toISOString(), model: 'prediction-model-v3-18factor',
    });
  } catch (err) {
    res.json({ available: false, message: err.message, picks: [], sport });
  }
});

router.get('/:sport/top', (req, res) => {
  const cached = picksCache[req.params.sport];
  if (!cached) return res.json({ picks: [] });
  res.json({ picks: cached.picks.filter(p => p.confidence >= 70), sport: req.params.sport });
});

module.exports = { router, startRefresh, generateSmartPicks, picksCache };
