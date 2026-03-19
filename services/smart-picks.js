/**
 * smart-picks.js — 18-Factor Model-Powered Top Picks (v3.1)
 * 
 * FIXES from v3:
 *   - picksCache always returns arrays (prevents "picks is not iterable" crash)
 *   - Auto-record uses direct function call instead of HTTP POST (prevents rate limits)
 *   - Auto-grade is lighter (uses parlay-builder endpoint, not heavy ESPN scraping)
 *   - All try/catch wrapped to prevent server crashes
 */

const express = require('express');
const axios = require('axios');
const router = express.Router();

const PORT = process.env.PORT || 3001;
const REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const CACHE_TTL_MS = 10 * 60 * 1000;

// IMPORTANT: Initialize cache with empty arrays so trending/line-movement never get undefined
const picksCache = {
  nba: { picks: [], lastUpdated: null, sport: 'nba' },
  nhl: { picks: [], lastUpdated: null, sport: 'nhl' },
  mlb: { picks: [], lastUpdated: null, sport: 'mlb' },
};

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
  for (const [full, abbr] of Object.entries(TEAM_ABBR)) {
    if (name.includes(abbr) || full.includes(name) || name.includes(full.split(' ').pop())) return abbr;
  }
  return name.substring(0, 3).toUpperCase();
}

// ============================================================
// FETCH GAME CONTEXT (spreads, totals)
// ============================================================

let gameContext = { data: null, fetchedAt: 0 };

async function fetchGameContext(sport) {
  if (gameContext.data && Date.now() - gameContext.fetchedAt < 5 * 60 * 1000) return gameContext.data;
  const ctx = { games: {}, injuries: {} };

  try {
    const odds = await axios.get(`http://localhost:${PORT}/api/odds/${sport}`, { timeout: 10000 });
    for (const game of (odds.data?.games || [])) {
      const bk = game.bookmakers?.[0];
      if (!bk) continue;
      const spreads = bk.markets?.find(m => m.key === 'spreads');
      const totals = bk.markets?.find(m => m.key === 'totals');
      const homeSpread = spreads?.outcomes?.find(o => o.name === game.homeTeam)?.point || 0;
      const total = totals?.outcomes?.[0]?.point || 220;
      ctx.games[game.homeTeam] = { homeTeam: game.homeTeam, awayTeam: game.awayTeam, spread: homeSpread, total };
      ctx.games[game.awayTeam] = ctx.games[game.homeTeam];
    }
  } catch (e) {}

  try {
    const inj = await axios.get(`http://localhost:${PORT}/api/predict/injuries`, { timeout: 8000 });
    for (const team of (inj.data?.injuries || [])) {
      const out = (team.players || []).filter(p => ['Out', 'OUT'].includes(p.status));
      ctx.injuries[team.team] = out.length;
    }
  } catch (e) {}

  gameContext = { data: ctx, fetchedAt: Date.now() };
  return ctx;
}

// ============================================================
// 18-FACTOR SCORING ENGINE
// ============================================================

async function generateSmartPicks(sport, limit = 8) {
  console.log(`[SmartPicks-v3] Generating for ${sport}...`);

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

  if (!Array.isArray(props) || props.length === 0) return [];

  const ctx = await fetchGameContext(sport);

  // Try to load accuracy boost module (optional)
  let boostModule = null;
  try { boostModule = require('./accuracy-boost'); } catch (e) {}

  console.log(`[SmartPicks-v3] ${props.length} props, ${props.filter(p => p.enriched).length} enriched`);

  const scoredPicks = [];

  for (const prop of props) {
    try {
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

      // Get game context
      const gameData = ctx.games?.[prop.homeTeam] || ctx.games?.[prop.awayTeam] || {};
      const spread = gameData.spread || 0;
      const total = gameData.total || 220;
      const homeTeamAbbr = teamAbbr(prop.homeTeam);
      const awayTeamAbbr = teamAbbr(prop.awayTeam);
      const isHome = !(prop.game || '').includes('@');
      const teammatesOut = ctx.injuries?.[homeTeamAbbr] || ctx.injuries?.[awayTeamAbbr] || 0;

      // ===== BASE PROJECTION =====
      let projection = hasEnrichment
        ? (l5Avg * 0.50 + l10Avg * 0.30 + seasonAvg * 0.20)
        : seasonAvg;

      // ===== FACTOR: Minutes Projection =====
      let minutesMultiplier = 1.0;
      let minutesNote = '';
      const absSpread = Math.abs(spread);
      if (absSpread >= 15) { minutesMultiplier = 0.83; minutesNote = 'Blowout risk (-17% min)'; }
      else if (absSpread >= 12) { minutesMultiplier = 0.90; minutesNote = 'Heavy fav (-10% min)'; }
      else if (absSpread >= 9) { minutesMultiplier = 0.95; minutesNote = 'Moderate fav (-5% min)'; }
      else if (absSpread <= 3 && absSpread > 0) { minutesMultiplier = 1.03; minutesNote = 'Close game (+3% min)'; }

      // ===== FACTOR: Game Script (pace) =====
      const paceMultiplier = total / 220;
      let gameScriptNote = '';
      if (total >= 235) gameScriptNote = `Shootout (${total} total)`;
      else if (total <= 210) gameScriptNote = `Defensive battle (${total} total)`;

      // ===== BOOST FACTORS =====
      let boostMultiplier = 1.0;
      let boostNotes = [];

      if (boostModule) {
        try {
          const playerTeam = isHome ? homeTeamAbbr : awayTeamAbbr;
          const oppTeam = isHome ? awayTeamAbbr : homeTeamAbbr;

          const paceUsage = boostModule.paceUsageInteraction(playerTeam, oppTeam, 25);
          if (paceUsage && Math.abs(paceUsage.interactionMultiplier - 1) > 0.01) {
            boostMultiplier *= paceUsage.interactionMultiplier;
            if (paceUsage.impact === 'significant') boostNotes.push(paceUsage.analysis);
          }

          const travel = boostModule.travelFatigue(awayTeamAbbr, homeTeamAbbr);
          if (travel && travel.available && !isHome && travel.fatigueMultiplier < 1) {
            boostMultiplier *= travel.fatigueMultiplier;
            boostNotes.push(travel.analysis);
          }

          const defense = boostModule.preciseDefenseRating(oppTeam, 'guard');
          if (defense && (defense.combinedMultiplier > 1.02 || defense.combinedMultiplier < 0.98)) {
            boostMultiplier *= defense.combinedMultiplier;
            if (defense.quality === 'poor' || defense.quality === 'below_avg') {
              boostNotes.push(`Weak ${oppTeam} defense`);
            } else if (defense.quality === 'elite' || defense.quality === 'good') {
              boostNotes.push(`Strong ${oppTeam} defense`);
            }
          }

          const garbage = boostModule.clutchGarbageTimeAnalysis(spread);
          if (garbage && (garbage.garbageTimeRisk === 'very_high' || garbage.garbageTimeRisk === 'high')) {
            boostMultiplier *= garbage.starterMultiplier;
            boostNotes.push('Garbage time risk');
          }

          if (teammatesOut >= 1) {
            const usage = boostModule.projectUsageChange(25, teammatesOut, true);
            if (usage) boostMultiplier *= usage.usageMultiplier;
          }
        } catch (e) {}
      }

      // ===== COMBINE =====
      projection *= minutesMultiplier * paceMultiplier * boostMultiplier;

      // Venue adjustment
      const venueAvg = isHome ? (a.homeAvg || null) : (a.awayAvg || null);
      if (venueAvg && Math.abs(venueAvg - seasonAvg) > 0.5) {
        projection += (venueAvg - seasonAvg) * 0.15;
      }

      projection = +projection.toFixed(1);
      const diff = +(projection - line).toFixed(1);
      const pick = diff > 0 ? 'OVER' : 'UNDER';

      // ===== CONFIDENCE =====
      let confidence = 50;
      confidence += Math.min(20, (Math.abs(diff) / Math.max(line, 1) * 100) * 2);
      if (pick === 'OVER' && hitRate > 70) confidence += 10;
      else if (pick === 'OVER' && hitRate > 60) confidence += 5;
      else if (pick === 'UNDER' && hitRate < 30) confidence += 10;
      else if (pick === 'UNDER' && hitRate < 40) confidence += 5;
      if (consistency === 'very_consistent') confidence += 8;
      else if (consistency === 'consistent') confidence += 4;
      if ((pick === 'OVER' && trend === 'hot') || (pick === 'UNDER' && trend === 'cold')) confidence += 5;
      if ((pick === 'OVER' && trend === 'cold') || (pick === 'UNDER' && trend === 'hot')) confidence -= 5;
      if (prop.lineType === 'demon') confidence += 8;
      if (prop.hasEdge) confidence += 5;
      if (prop.bookCount >= 6) confidence += 3;
      if (minutesMultiplier < 0.85 && pick === 'OVER') confidence -= 10;
      if (total >= 230 && pick === 'OVER') confidence += 4;
      if (total <= 210 && pick === 'OVER') confidence -= 4;
      if (boostMultiplier > 1.03 && pick === 'OVER') confidence += 4;
      if (boostMultiplier < 0.97 && pick === 'OVER') confidence -= 4;
      if (absSpread >= 12 && pick === 'OVER') confidence -= 6;
      confidence = Math.min(95, Math.max(15, Math.round(confidence)));

      const grade = confidence >= 80 ? 'A+' : confidence >= 70 ? 'A' : confidence >= 60 ? 'B+' : confidence >= 55 ? 'B' : confidence >= 50 ? 'C+' : 'C';

      // ===== REASONING =====
      const reasons = [];
      if (hasEnrichment) {
        reasons.push(`Avg ${seasonAvg}, line ${line}.`);
        if (Math.abs(diff) > 1) reasons.push(`18-factor proj: ${projection} (${diff > 0 ? '+' : ''}${diff}).`);
        if (pick === 'OVER' && hitRate > 60) reasons.push(`OVER ${hitRate}% of games.`);
        else if (pick === 'UNDER' && hitRate < 40) reasons.push(`UNDER ${(100 - hitRate).toFixed(0)}% of games.`);
        if (l5Avg > seasonAvg + 2) reasons.push(`Hot: L5 ${l5Avg} vs season ${seasonAvg}.`);
        else if (l5Avg < seasonAvg - 2) reasons.push(`Cold: L5 ${l5Avg} vs season ${seasonAvg}.`);
      }
      if (minutesNote) reasons.push(minutesNote);
      if (gameScriptNote) reasons.push(gameScriptNote);
      if (boostNotes.length > 0) reasons.push(boostNotes.join('. '));
      if (prop.lineType === 'demon') reasons.push('Demon line.');

      scoredPicks.push({
        player: prop.player, market: prop.marketLabel || prop.market, pick, line,
        bestBook: prop.bestOver?.book || prop.bestUnder?.book || prop.books?.[0]?.name || 'Multiple',
        confidence, grade, reasoning: reasons.join(' '), projection, diff,
        seasonAvg, hitRate, l5Avg, l10Avg, trend,
        game: prop.game, lineType: prop.lineType, bookCount: prop.bookCount,
        book: prop.bestOver?.book || prop.bestUnder?.book || 'Best available',
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
    } catch (e) {
      // Skip individual prop errors — don't crash the whole generation
    }
  }

  scoredPicks.sort((a, b) => b.confidence - a.confidence);
  const topPicks = scoredPicks.slice(0, limit);

  // Auto-record to history (safe, no HTTP)
  safeAutoRecord(topPicks, sport);

  return topPicks;
}

// ============================================================
// SAFE AUTO-RECORD (no HTTP, direct require)
// ============================================================

function safeAutoRecord(picks, sport) {
  if (!picks || picks.length === 0) return;
  try {
    const parlayBuilder = require('./parlay-builder');
    if (parlayBuilder && parlayBuilder.recordPick) {
      const date = new Date().toISOString().split('T')[0];
      for (const pick of picks) {
        parlayBuilder.recordPick({
          player: pick.player, market: pick.market, pick: pick.pick, line: pick.line,
          confidence: pick.confidence, grade: pick.grade, projection: pick.projection,
          source: 'smart_picks', sport, result: 'pending', game: pick.game, date,
        });
      }
      console.log(`[SmartPicks-v3] Recorded ${picks.length} picks to history`);
    }
  } catch (e) {
    // parlay-builder not loaded yet — skip silently
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
      picksCache[sport] = { picks: picks || [], lastUpdated: new Date().toISOString(), sport };
      console.log(`[SmartPicks-v3] ${sport}: ${(picks || []).length} picks — 18-factor model`);
    } catch (err) {
      console.error(`[SmartPicks-v3] ${sport} failed:`, err.message);
      // Ensure cache always has an array even on failure
      if (!picksCache[sport] || !Array.isArray(picksCache[sport].picks)) {
        picksCache[sport] = { picks: [], lastUpdated: new Date().toISOString(), sport };
      }
    }
  }
}

function startRefresh() {
  console.log('[SmartPicks-v3] Starting 18-factor generation (every 15 min)');
  setTimeout(() => refreshPicks().catch(e => console.error('[SmartPicks-v3]', e.message)), 45000);
  setInterval(() => refreshPicks().catch(e => console.error('[SmartPicks-v3]', e.message)), REFRESH_INTERVAL_MS);

  // Light auto-grade check every 2 hours (not every hour — less load)
  setInterval(() => {
    try {
      axios.get(`http://localhost:${PORT}/api/parlay/history/auto-grade`, { timeout: 30000 }).catch(() => {});
    } catch (e) {}
  }, 2 * 60 * 60 * 1000);
}

// ============================================================
// API Routes
// ============================================================

router.get('/:sport', async (req, res) => {
  const { sport } = req.params;
  const cached = picksCache[sport];
  if (cached && cached.lastUpdated && Date.now() - new Date(cached.lastUpdated).getTime() < CACHE_TTL_MS) {
    return res.json({
      available: (cached.picks || []).length > 0,
      picks: cached.picks || [],
      summary: `${(cached.picks || []).length} picks (18-factor model)`,
      sport, lastUpdated: cached.lastUpdated, model: 'prediction-model-v3-18factor',
    });
  }
  try {
    const picks = await generateSmartPicks(sport, 8);
    picksCache[sport] = { picks: picks || [], lastUpdated: new Date().toISOString(), sport };
    res.json({
      available: (picks || []).length > 0, picks: picks || [],
      summary: (picks || []).length > 0 ? `${picks.length} picks (18-factor model)` : 'No picks available',
      sport, lastUpdated: new Date().toISOString(), model: 'prediction-model-v3-18factor',
    });
  } catch (err) {
    res.json({ available: false, message: err.message, picks: [], sport });
  }
});

router.get('/:sport/top', (req, res) => {
  const cached = picksCache[req.params.sport];
  const picks = cached?.picks || [];
  res.json({ picks: picks.filter(p => p.confidence >= 70), sport: req.params.sport });
});

module.exports = { router, startRefresh, generateSmartPicks, picksCache };
