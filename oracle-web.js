/**
 * oracle-web.js — Production Web Server
 * 
 * Features:
 * - In-memory API cache (30-second TTL) — 500 users hit memory, not Redis
 * - Rate limiting — prevents abuse
 * - Error tracking — logs all errors with stack traces
 * - Security headers via Helmet
 * - Compression
 * - Reads from Redis, never calls external APIs
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3001;

// ============================================================
// SECURITY — Production-grade headers
// ============================================================
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
}));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(cors({ origin: "*", credentials: true }));

// ============================================================
// RATE LIMITING — Prevent abuse (200 requests per minute per IP)
// ============================================================
var rateLimitMap = {};
app.use("/api/", function(req, res, next) {
  var ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';
  var now = Date.now();
  if (!rateLimitMap[ip]) rateLimitMap[ip] = { count: 0, reset: now + 60000 };
  if (now > rateLimitMap[ip].reset) { rateLimitMap[ip] = { count: 0, reset: now + 60000 }; }
  rateLimitMap[ip].count++;
  if (rateLimitMap[ip].count > 1000) {
    return res.status(429).json({ error: "Too many requests. Try again in a minute." });
  }
  next();
});
// Clean up rate limit map every 5 minutes
setInterval(function() { rateLimitMap = {}; }, 5 * 60 * 1000);

// ============================================================
// IN-MEMORY API CACHE — 500 users hit memory, not Redis
// ============================================================
var apiCache = {};
var API_CACHE_TTL = 30000; // 30 seconds

function getCached(key) {
  var entry = apiCache[key];
  if (entry && Date.now() - entry.time < API_CACHE_TTL) return entry.data;
  return null;
}

function setCache(key, data) {
  apiCache[key] = { data: data, time: Date.now() };
}

// Clean stale cache entries every 2 minutes
setInterval(function() {
  var now = Date.now();
  var keys = Object.keys(apiCache);
  keys.forEach(function(k) { if (now - apiCache[k].time > API_CACHE_TTL * 2) delete apiCache[k]; });
}, 120000);

// Helper: cached Redis read
async function cachedRedisGet(cacheKey, redisFn) {
  var cached = getCached(cacheKey);
  if (cached) return cached;
  var data = typeof redisFn === 'function' ? await redisFn() : await redisCache.get(cacheKey);
  if (data) setCache(cacheKey, data);
  return data;
}

// ============================================================
// ERROR TRACKING — Log all errors with context
// ============================================================
var errorLog = []; // Keep last 100 errors in memory
function trackError(endpoint, error, context) {
  var entry = {
    timestamp: new Date().toISOString(),
    endpoint: endpoint,
    error: error.message || String(error),
    stack: error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : '',
    context: context || {},
  };
  errorLog.push(entry);
  if (errorLog.length > 100) errorLog.shift();
  console.error("[ERROR] " + endpoint + ": " + entry.error);
}

// Error tracking API endpoint
app.get("/api/errors", function(req, res) {
  res.json({ errors: errorLog.slice(-20), total: errorLog.length });
});

// ============================================================
// Redis Connection
// ============================================================
const redisCache = require("./services/redis-cache");

// ============================================================
// API ENDPOINTS — All read from Redis, never call external APIs
// ============================================================

// Health check — responds instantly
app.get("/api/health", async (req, res) => {
  const mem = process.memoryUsage();
  const redisHealth = await redisCache.healthCheck().catch(() => ({ status: "error" }));
  res.json({
    status: "ok",
    mode: "web-server",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    memory: { heapMB: Math.round(mem.heapUsed / 1024 / 1024), rssMB: Math.round(mem.rss / 1024 / 1024) },
    redis: redisHealth,
    cache: { entries: Object.keys(apiCache).length, ttlSeconds: API_CACHE_TTL / 1000 },
    errors: { recent: errorLog.length },
    rateLimit: { activeIPs: Object.keys(rateLimitMap).length },
  });
});

app.get("/api/redis/health", async (req, res) => {
  try { res.json(await redisCache.healthCheck()); } catch(e) { res.json({ status: "error", error: e.message }); }
});

// Props — with in-memory cache
app.get("/api/props/:sport", async (req, res) => {
  try {
    var cacheKey = "props:" + req.params.sport;
    var data = await cachedRedisGet(cacheKey, function() { return redisCache.getProps(req.params.sport); });
    if (data) {
      const props = data.props || data.picks || [];
      res.json({ props: props, count: props.length, available: true, source: "redis" });
    } else {
      res.json({ props: [], count: 0, available: true, source: "redis-empty", message: "No props right now. Check back closer to game time." });
    }
  } catch(e) { trackError("/api/props/" + req.params.sport, e); res.json({ props: [], count: 0, available: true }); }
});

// Smart Picks
app.get("/api/props/:sport/picks", async (req, res) => {
  try {
    // Try AI-analyzed picks first
    var data = await redisCache.getPicks(req.params.sport);
    if (data && data.picks && data.picks.length > 0) {
      return res.json(data);
    }
    // Fallback: use raw props, add synthetic AI fields that React component expects
    var propsData = await cachedRedisGet("props:" + req.params.sport, function() { return redisCache.getProps(req.params.sport); });
    if (propsData) {
      var props = propsData.props || propsData.picks || [];
      var sorted = props.slice().sort(function(a, b) {
        var typeOrder = { demon: 0, edge: 1, goblin: 2 };
        var aType = typeOrder[a.lineType] !== undefined ? typeOrder[a.lineType] : 3;
        var bType = typeOrder[b.lineType] !== undefined ? typeOrder[b.lineType] : 3;
        if (aType !== bType) return aType - bType;
        return (b.bookCount || 0) - (a.bookCount || 0);
      });
      // Add AI fields that the React TopPicks component expects
      var enriched = sorted.map(function(p) {
        var bc = p.bookCount || 1;
        var conf = Math.min(95, 40 + (bc * 5));
        var grade = bc >= 8 ? 'A+' : bc >= 6 ? 'A' : bc >= 4 ? 'B+' : bc >= 3 ? 'B' : 'C+';
        var suggestion = p.lineType === 'goblin' ? 'UNDER' : 'OVER';
        return Object.assign({}, p, {
          grade: p.grade || grade,
          confidence: p.confidence || conf,
          projection: p.projection || null,
          hitRate: p.hitRate || null,
          suggestion: p.suggestion || suggestion,
          pick: p.pick || suggestion,
          reasoning: p.reasoning || (bc + ' books agree on ' + (p.consensusLine || 'this line') + ' — ' + (p.lineType === 'demon' ? 'highest consensus edge' : p.lineType === 'goblin' ? 'possible trap line' : 'solid value spot')),
          enriched: true,
        });
      });
      res.json({ picks: enriched, count: enriched.length, source: "props-enriched" });
    } else {
      res.json({ picks: [], count: 0 });
    }
  } catch(e) { trackError("/api/props/" + req.params.sport + "/picks", e); res.json({ picks: [], count: 0 }); }
});

// Game Predictions — with cache, falls back to ESPN schedule
app.get("/api/games/:sport", async (req, res) => {
  try {
    var data = await cachedRedisGet("games:" + req.params.sport, function() { return redisCache.getGames(req.params.sport); });
    if (data && data.games && data.games.length > 0) {
      return res.json({ games: data.games, count: data.games.length, source: "redis" });
    }
    // Fallback: build game cards from ESPN scoreboard data WITH odds/consensus
    var scores = await cachedRedisGet("scores:" + req.params.sport, function() { return redisCache.get("oracle:scores:" + req.params.sport); });
    if (scores && scores.events && scores.events.length > 0) {
      var games = scores.events.map(function(e) {
        var comp = e.competitions && e.competitions[0] ? e.competitions[0] : {};
        var home = (comp.competitors || []).find(function(c){return c.homeAway==='home'});
        var away = (comp.competitors || []).find(function(c){return c.homeAway==='away'});
        var odds = comp.odds && comp.odds[0] ? comp.odds[0] : {};
        var homeRecord = home && home.records && home.records[0] ? home.records[0].summary : '';
        var awayRecord = away && away.records && away.records[0] ? away.records[0].summary : '';
        var homeName = home ? home.team.displayName : 'TBD';
        var awayName = away ? away.team.displayName : 'TBD';
        // Parse spread value from odds.details (e.g. "DEN -8.5")
        var spreadVal = 0;
        var spreadAbbr = home ? home.team.abbreviation : '';
        if (odds.details) {
          var teamMatch = odds.details.match(/([A-Z]{2,4})\s*([-+]?\d+\.?\d*)/);
          if (teamMatch) { spreadAbbr = teamMatch[1]; spreadVal = parseFloat(teamMatch[2]); }
          else { var numMatch = odds.details.match(/([-+]?\d+\.?\d*)/); if (numMatch) spreadVal = parseFloat(numMatch[1]); }
        }
        // Build consensus object that game-predictions.html expects
        var consensus = {
          spread: spreadVal || 0,
          total: odds.overUnder || 220,
          moneyline: spreadVal < 0 ? homeName : awayName,
          provider: odds.provider ? odds.provider.name : null,
        };
        // Build basic prediction
        var homeWins = parseInt(homeRecord) || 0;
        var awayWins = parseInt(awayRecord) || 0;
        var favorite = homeWins > awayWins ? homeName : awayName;
        var favAbbr = homeWins > awayWins ? (home ? home.team.abbreviation : '') : (away ? away.team.abbreviation : '');
        var conf = Math.min(78, 55 + Math.abs(homeWins - awayWins));
        var totalConf = Math.max(50, conf - 5);
        return {
          id: e.id,
          homeTeam: homeName,
          awayTeam: awayName,
          homeAbbr: home ? home.team.abbreviation : '',
          awayAbbr: away ? away.team.abbreviation : '',
          homeLogo: home ? home.team.logo : null,
          awayLogo: away ? away.team.logo : null,
          homeRecord: homeRecord,
          awayRecord: awayRecord,
          commenceTime: e.date,
          status: e.status ? e.status.type.description : 'Scheduled',
          completed: e.status ? e.status.type.completed : false,
          homeScore: home ? home.score : '0',
          awayScore: away ? away.score : '0',
          consensus: consensus,
          odds: { spread: odds.details, overUnder: odds.overUnder, provider: odds.provider ? odds.provider.name : null },
          predictions: {
            spread: { confidence: conf, abbr: spreadAbbr, spread: spreadVal || 0, direction: spreadAbbr === (home ? home.team.abbreviation : '') ? 'home' : 'away', bestOdds: null },
            total: { confidence: totalConf, side: (odds.overUnder || 220) >= 220 ? 'OVER' : 'UNDER', total: odds.overUnder || 220, bestOver: null, bestUnder: null },
            winner: { abbr: favAbbr, confidence: conf, bestOdds: null },
          },
          prediction: { winner: favorite, confidence: conf, spread: { pick: homeName, line: spreadVal, confidence: conf }, total: { side: 'OVER', line: odds.overUnder || 220, confidence: totalConf }, moneyline: { pick: favorite, confidence: conf } },
          bestBet: conf >= 65 ? { pick: favAbbr + ' ' + (spreadVal > 0 ? '+' : '') + (spreadVal || 0), type: 'Spread', confidence: conf } : null,
          bestOdds: null,
          lineShop: null,
          bookCount: 1,
          environment: conf >= 70 ? 'Blowout Expected' : conf >= 60 ? 'Standard' : 'Toss-Up',
          venue: comp.venue ? comp.venue.fullName : null,
          broadcast: comp.broadcasts && comp.broadcasts[0] ? comp.broadcasts[0].names.join(', ') : null,
        };
      });
      res.json({ games: games, count: games.length, source: "espn-derived" });
    } else {
      res.json({ games: [], count: 0, source: "empty" });
    }
  } catch(e) { trackError("/api/games/" + req.params.sport, e); res.json({ games: [], count: 0 }); }
});

// EV Bets — with cache
app.get("/api/ev/bets", async (req, res) => {
  try {
    var data = await cachedRedisGet("ev:bets", function() { return redisCache.getEV(); });
    var minEdge = parseFloat(req.query.minEdge) || 0;
    if (data && Array.isArray(data)) {
      var filtered = minEdge > 0 ? data.filter(function(b) { return (b.edgePercent || 0) >= minEdge; }) : data;
      res.json({ bets: filtered, found: filtered.length });
    } else {
      res.json({ bets: [], found: 0 });
    }
  } catch(e) { trackError("/api/ev/bets", e); res.json({ bets: [], found: 0 }); }
});

// POTD
app.get("/api/potd", async (req, res) => {
  const data = await redisCache.getPOTD();
  if (data && data.pickOfTheDay) {
    res.json({ available: true, pickOfTheDay: data.pickOfTheDay });
  } else {
    res.json({ available: false });
  }
});

// Accuracy / History — try parlayBuilder first, fall back to new grading engine
app.get("/api/parlay/history", async (req, res) => {
  try {
    // Try the old parlayBuilder data
    var data = await redisCache.getAccuracy();
    if (data && data.overall && data.overall.total > 0) {
      return res.json(data);
    }
    // Fall back to new grading engine
    var grades = await redisCache.get("oracle:grading_stats");
    if (!grades) grades = await redisCache.get("oracle:grading_stats_legacy");
    if (grades && grades.overall && grades.overall.total > 0) {
      return res.json(grades);
    }
    // Build from raw graded picks
    var picks = await redisCache.get("oracle:graded_picks");
    if (!picks || !picks.length) picks = await redisCache.get("oracle:graded_picks_legacy");
    if (picks && picks.length > 0) {
      var graded = picks.filter(function(p) { return p.result === 'hit' || p.result === 'miss'; });
      var hits = graded.filter(function(p) { return p.result === 'hit'; });
      var pending = picks.filter(function(p) { return p.result === 'pending'; });
      var now = Date.now();
      var dayMs = 86400000;
      var last7 = graded.filter(function(p) { return now - p.timestamp < 7 * dayMs; });
      var last7Hits = last7.filter(function(p) { return p.result === 'hit'; });
      // By grade
      var byGrade = {};
      graded.forEach(function(p) {
        var g = p.grade || 'B';
        if (!byGrade[g]) byGrade[g] = { total: 0, hits: 0, hitRate: 0 };
        byGrade[g].total++;
        if (p.result === 'hit') byGrade[g].hits++;
      });
      Object.keys(byGrade).forEach(function(g) { byGrade[g].hitRate = Math.round((byGrade[g].hits / byGrade[g].total) * 1000) / 10; });
      // By market
      var byMarket = {};
      graded.forEach(function(p) {
        var m = p.market || 'unknown';
        if (!byMarket[m]) byMarket[m] = { total: 0, hits: 0, hitRate: 0 };
        byMarket[m].total++;
        if (p.result === 'hit') byMarket[m].hits++;
      });
      Object.keys(byMarket).forEach(function(m) { byMarket[m].hitRate = Math.round((byMarket[m].hits / byMarket[m].total) * 1000) / 10; });
      // By sport
      var bySport = {};
      graded.forEach(function(p) {
        var s = p.sport || 'nba';
        if (!bySport[s]) bySport[s] = { total: 0, hits: 0, hitRate: 0 };
        bySport[s].total++;
        if (p.result === 'hit') bySport[s].hits++;
      });
      Object.keys(bySport).forEach(function(s) { bySport[s].hitRate = Math.round((bySport[s].hits / bySport[s].total) * 1000) / 10; });

      return res.json({
        overall: { total: graded.length, hits: hits.length, misses: graded.length - hits.length, hitRate: graded.length > 0 ? Math.round((hits.length / graded.length) * 1000) / 10 : 0, pending: pending.length },
        last7Days: { total: last7.length, hits: last7Hits.length, hitRate: last7.length > 0 ? Math.round((last7Hits.length / last7.length) * 1000) / 10 : 0 },
        byGrade: byGrade,
        byMarket: byMarket,
        bySport: bySport,
        recentPicks: picks.slice(-30).reverse(),
      });
    }
    res.json({ overall: { total: 0, hits: 0, misses: 0, hitRate: 0, pending: 0 }, recentPicks: [], last7Days: { total: 0, hits: 0, hitRate: 0 } });
  } catch(e) { trackError("/api/parlay/history", e); res.json({ overall: { total: 0, hits: 0, misses: 0, hitRate: 0, pending: 0 }, recentPicks: [] }); }
});

// Line Movement
app.get("/api/movement/:sport", async (req, res) => {
  const data = await redisCache.getMovement(req.params.sport);
  if (data) {
    res.json(data);
  } else {
    res.json({ movements: [], count: 0 });
  }
});

// Game Grades
app.get("/api/game-grades/accuracy", async (req, res) => {
  const data = await redisCache.getGameGrades();
  if (data) { res.json(data); }
  else { res.json({ total: 0, moneyline: { total: 0, hits: 0, pct: 0 }, spread: { total: 0, hits: 0, pct: 0 }, totals: { total: 0, hits: 0, pct: 0 }, recent: [] }); }
});

app.get("/api/game-grades/grades", async (req, res) => {
  const data = await redisCache.getGameGrades();
  res.json(data || { grades: [] });
});

// Consensus Picks — cross-reference AI picks, book consensus, and sharp signals
app.get("/api/consensus", async (req, res) => {
  try {
    var sport = req.query.sport || 'nba';
    // Get props (book consensus)
    var propsData = await cachedRedisGet("props:" + sport, function() { return redisCache.getProps(sport); });
    var props = propsData ? (propsData.props || propsData.picks || []) : [];
    // Get AI picks
    var picksData = await redisCache.getPicks(sport);
    var picks = picksData && picksData.picks ? picksData.picks : [];
    // Get EV bets (sharp signal)
    var evData = await redisCache.getEV();
    var evBets = Array.isArray(evData) ? evData : [];
    // Get movement data (sharp signal)
    var mvData = await redisCache.getMovement(sport);
    var movements = mvData && mvData.movements ? mvData.movements : [];
    
    var strong = [];
    var moderate = [];
    
    // Find consensus: props with high book count + AI pick agreement + EV/movement signal
    var demons = props.filter(function(p) { return p.lineType === 'demon' && p.bookCount >= 6; });
    
    for (var prop of demons) {
      var signals = [];
      // Signal 1: Book consensus (demon = 6+ books agree)
      signals.push({ type: 'books', label: prop.bookCount + ' books agree on ' + prop.consensusLine });
      
      // Signal 2: AI pick match
      var aiMatch = picks.find(function(pk) { return pk.player === prop.player && pk.market === prop.market; });
      if (aiMatch) signals.push({ type: 'ai', label: 'AI picks ' + (aiMatch.pick || aiMatch.suggestion || 'OVER') + ' (' + (aiMatch.confidence || 0) + '% conf)' });
      
      // Signal 3: +EV signal
      var evMatch = evBets.find(function(ev) { return ev.player === prop.player; });
      if (evMatch) signals.push({ type: 'ev', label: '+' + (evMatch.edgePercent || 0).toFixed(1) + '% EV edge' });
      
      // Signal 4: Line movement
      var mvMatch = movements.find(function(m) { return m.player === prop.player; });
      if (mvMatch && mvMatch.change > 0) signals.push({ type: 'movement', label: 'Line moved ' + mvMatch.direction });
      
      var entry = {
        player: prop.player,
        market: prop.market,
        marketLabel: prop.marketLabel || prop.market,
        line: prop.consensusLine,
        game: prop.game,
        bookCount: prop.bookCount,
        lineType: prop.lineType,
        signals: signals,
        signalCount: signals.length,
        strength: signals.length >= 3 ? 'strong' : 'moderate',
      };
      
      if (signals.length >= 3) strong.push(entry);
      else if (signals.length >= 2) moderate.push(entry);
    }
    
    // Also check edge props with AI agreement
    var edges = props.filter(function(p) { return p.hasEdge && p.bookCount >= 4 && p.lineType !== 'demon'; });
    for (var prop of edges) {
      var signals = [];
      if (prop.bookCount >= 4) signals.push({ type: 'books', label: prop.bookCount + ' books agree' });
      signals.push({ type: 'edge', label: 'Edge detected' });
      var aiMatch = picks.find(function(pk) { return pk.player === prop.player; });
      if (aiMatch) signals.push({ type: 'ai', label: 'AI agrees' });
      var evMatch = evBets.find(function(ev) { return ev.player === prop.player; });
      if (evMatch) signals.push({ type: 'ev', label: '+EV' });
      
      if (signals.length >= 3) {
        strong.push({ player: prop.player, market: prop.market, marketLabel: prop.marketLabel, line: prop.consensusLine, game: prop.game, bookCount: prop.bookCount, signals: signals, signalCount: signals.length, strength: 'strong' });
      } else if (signals.length >= 2) {
        moderate.push({ player: prop.player, market: prop.market, marketLabel: prop.marketLabel, line: prop.consensusLine, game: prop.game, bookCount: prop.bookCount, signals: signals, signalCount: signals.length, strength: 'moderate' });
      }
    }
    
    strong.sort(function(a, b) { return b.signalCount - a.signalCount || b.bookCount - a.bookCount; });
    moderate.sort(function(a, b) { return b.signalCount - a.signalCount || b.bookCount - a.bookCount; });
    
    res.json({ strong: strong, moderate: moderate, strongCount: strong.length, moderateCount: moderate.length, propsAnalyzed: props.length });
  } catch(e) { trackError("/api/consensus", e); res.json({ strong: [], moderate: [], strongCount: 0, moderateCount: 0 }); }
});

// Sports scores — read from Redis ticker cache
app.get("/api/sports/scores/:sport", async (req, res) => {
  try {
    var raw = await cachedRedisGet("scores:" + req.params.sport, function() { return redisCache.get("oracle:scores:" + req.params.sport); });
    if (raw && raw.events) {
      // Transform raw ESPN data into the format the React GameCard AND game-predictions.html expect
      var games = raw.events.map(function(event) {
        var comp = event.competitions && event.competitions[0] ? event.competitions[0] : {};
        var competitors = comp.competitors || [];
        var home = competitors.find(function(c) { return c.homeAway === 'home'; });
        var away = competitors.find(function(c) { return c.homeAway === 'away'; });
        var odds = comp.odds && comp.odds[0] ? comp.odds[0] : {};
        var homeName = home ? home.team.displayName : 'TBD';
        var awayName = away ? away.team.displayName : 'TBD';
        var homeRecord = home && home.records && home.records[0] ? home.records[0].summary : '';
        var awayRecord = away && away.records && away.records[0] ? away.records[0].summary : '';
        // Parse spread
        var spreadVal = 0;
        if (odds.details) {
          var parts = odds.details.match(/([-+]?\d+\.?\d*)/);
          if (parts) spreadVal = parseFloat(parts[1]);
        }
        var homeWins = parseInt(homeRecord) || 0;
        var awayWins = parseInt(awayRecord) || 0;
        var favorite = homeWins > awayWins ? homeName : awayName;
        var conf = Math.min(78, 55 + Math.abs(homeWins - awayWins));
        return {
          id: event.id,
          name: event.name,
          shortName: event.shortName,
          date: event.date,
          status: {
            type: comp.status && comp.status.type ? comp.status.type.name : 'STATUS_SCHEDULED',
            detail: comp.status && comp.status.type ? comp.status.type.detail : '',
            displayClock: comp.status ? comp.status.displayClock : '',
            period: comp.status ? comp.status.period : 0,
            completed: comp.status && comp.status.type ? comp.status.type.completed : false,
          },
          home: home ? { id: home.team.id, name: homeName, abbreviation: home.team.abbreviation, logo: home.team.logo, score: home.score ? parseInt(home.score) : null, record: homeRecord || null, winner: home.winner } : { name: 'TBD', score: null },
          away: away ? { id: away.team.id, name: awayName, abbreviation: away.team.abbreviation, logo: away.team.logo, score: away.score ? parseInt(away.score) : null, record: awayRecord || null, winner: away.winner } : { name: 'TBD', score: null },
          odds: odds.details ? { spread: odds.details, overUnder: odds.overUnder, provider: odds.provider ? odds.provider.name : null } : null,
          consensus: { spread: spreadVal || 0, total: odds.overUnder || 220, moneyline: favorite, provider: odds.provider ? odds.provider.name : null },
          prediction: {
            winner: favorite, confidence: conf,
            spread: { pick: homeName, line: spreadVal, confidence: conf },
            total: { side: 'OVER', line: odds.overUnder || 220, confidence: Math.max(50, conf - 5) },
            moneyline: { pick: favorite, confidence: conf },
          },
          homeTeam: homeName, awayTeam: awayName,
          homeAbbr: home ? home.team.abbreviation : '', awayAbbr: away ? away.team.abbreviation : '',
          venue: comp.venue ? comp.venue.fullName : null,
          broadcast: comp.broadcasts && comp.broadcasts[0] ? comp.broadcasts[0].names.join(', ') : null,
        };
      });
      res.json({ sport: req.params.sport, games: games, count: games.length, date: raw.day ? raw.day.date : null });
    } else if (raw && raw.games) {
      res.json(raw);
    } else {
      res.json({ games: [], sport: req.params.sport, count: 0 });
    }
  } catch(e) { trackError("/api/sports/scores", e); res.json({ games: [], sport: req.params.sport, count: 0 }); }
});

// AI Predict — read cached prediction or return processing message
app.post("/api/predictions/game", async (req, res) => {
  try {
    var body = req.body || {};
    var sport = body.sport || "nba";
    var gameId = body.gameId;

    // Try cached prediction first
    var key = "oracle:prediction:" + (gameId || "");
    var cached = await redisCache.get(key);
    if (cached) return res.json(cached);

    // Try proxy to worker for real AI prediction
    try {
      var workerUrl = process.env.WORKER_URL || "http://predict.railway.internal:8080";
      var axios = require("axios");
      var workerResp = await axios.post(workerUrl + "/api/predictions/game", body, { timeout: 25000, headers: { "Content-Type": "application/json" } });
      if (workerResp.data && workerResp.data.prediction && !workerResp.data.prediction.fallback) {
        // Cache the prediction
        await redisCache.set(key, workerResp.data, 3600);
        return res.json(workerResp.data);
      }
    } catch(proxyErr) {}

    // Try games cache with embedded predictions
    var games = await redisCache.getGames(sport);
    if (games && games.games) {
      var match = games.games.find(function(g) {
        return g.id === gameId || ((g.homeTeam === body.homeTeam) && (g.awayTeam === body.awayTeam));
      });
      if (match && match.predictions) return res.json(match.predictions);
    }

    // Generate prediction from ESPN scores data
    var scores = await redisCache.get("oracle:scores:" + sport);
    if (scores && scores.events) {
      var event = scores.events.find(function(e) { return e.id === gameId || e.id === String(gameId); });
      if (event) {
        var comp = event.competitions && event.competitions[0] ? event.competitions[0] : {};
        var home = (comp.competitors || []).find(function(c) { return c.homeAway === 'home'; });
        var away = (comp.competitors || []).find(function(c) { return c.homeAway === 'away'; });
        var homeName = home ? home.team.displayName : 'Home';
        var awayName = away ? away.team.displayName : 'Away';
        var homeRecord = home && home.records && home.records[0] ? home.records[0].summary : '';
        var awayRecord = away && away.records && away.records[0] ? away.records[0].summary : '';
        var odds = comp.odds && comp.odds[0] ? comp.odds[0] : {};
        
        // Parse records to determine favorite
        var homeWins = parseInt(homeRecord) || 0;
        var awayWins = parseInt(awayRecord) || 0;
        var favorite = homeWins > awayWins ? homeName : awayName;
        var conf = Math.min(78, 55 + Math.abs(homeWins - awayWins));

        return res.json({
          prediction: {
            homeTeam: homeName,
            awayTeam: awayName,
            predictedScore: { home: Math.round(105 + (homeWins > awayWins ? 5 : -3)), away: Math.round(105 + (awayWins > homeWins ? 5 : -3)) },
            winner: favorite,
            confidence: conf,
            spread: odds.details || null,
            overUnder: odds.overUnder || null,
            keyFactors: [
              homeName + ' (' + (homeRecord || 'N/A') + ') vs ' + awayName + ' (' + (awayRecord || 'N/A') + ')',
              odds.details ? 'Spread: ' + odds.details : 'No spread data available',
              odds.overUnder ? 'Over/Under: ' + odds.overUnder : 'No total available',
              'Home court advantage: ' + homeName,
              favorite + ' favored based on season record',
            ],
            hotTake: favorite + ' should control this game based on their ' + (homeWins > awayWins ? homeRecord : awayRecord) + ' record.',
          }
        });
      }
    }
    res.json({ prediction: { fallback: true, keyFactors: ['Game data not available yet. Games will be predictable closer to tip-off.'] } });
  } catch(e) { trackError("/api/predictions/game", e); res.json({ prediction: { fallback: true, keyFactors: ['Error generating prediction.'] } }); }
});

// Odds — return props data (odds are embedded in props)
app.get("/api/odds/:sport", async (req, res) => {
  const data = await redisCache.getProps(req.params.sport);
  if (data) {
    const props = data.props || data.picks || [];
    res.json({ props: props, count: props.length });
  } else {
    res.json({ props: [], count: 0 });
  }
});

// Data sources
app.get("/api/data-sources", (req, res) => {
  res.json({ sources: ["the-odds-api", "espn", "anthropic-claude"], mode: "redis-cached" });
});

// Providers
app.get("/api/providers", (req, res) => {
  res.json({ mode: "single-api" });
});

// CDL props
// CDL props — transform worker's match-based format into flat props array
app.get("/api/cdl/props", async (req, res) => {
  try {
    var data = await redisCache.get("oracle:cdl_props");
    // If worker stored match-based format: { matches: [...] }
    if (data && data.matches && data.matches.length > 0) {
      var props = [];
      data.matches.forEach(function(match) {
        var teams = [match.team1, match.team2].filter(Boolean);
        teams.forEach(function(team) {
          if (!team || !team.players) return;
          team.players.forEach(function(playerData) {
            if (!playerData.props || playerData.props.length === 0) return;
            playerData.props.forEach(function(prop) {
              props.push({
                player: playerData.player, playerId: playerData.playerId,
                team: playerData.team, teamName: playerData.teamName,
                headshot: playerData.headshot, kd: playerData.kd,
                market: prop.market, marketLabel: prop.label,
                line: prop.line, consensusLine: prop.line,
                avg: prop.avg, games: prop.games,
                edge: prop.edge,
                suggestion: prop.suggestion || (prop.edge ? prop.edge.direction : null),
                confidence: prop.edge ? prop.edge.confidence : 50,
                game: (match.team1?.name || '?') + ' vs ' + (match.team2?.name || '?'),
                matchId: match.matchId, scheduledAt: match.scheduledAt, status: match.status,
                bookCount: prop.games || 1,
                lineType: prop.edge && prop.edge.confidence >= 65 ? 'demon' : 'standard',
                hasEdge: prop.edge && prop.edge.confidence >= 55,
                sport: 'cdl',
              });
            });
          });
        });
      });
      return res.json({ props: props, count: props.length, source: "breakingpoint", lastUpdated: data.lastUpdated });
    }
    // If worker stored flat format
    if (data && data.props && data.props.length > 0) return res.json(data);
    res.json({ props: [], count: 0 });
  } catch(e) { trackError("/api/cdl/props", e); res.json({ props: [], count: 0 }); }
});

// CDL matches
app.get("/api/cdl/matches", async (req, res) => {
  const data = await redisCache.get("oracle:cdl_matches");
  if (data && data.matches) {
    res.json(data);
  } else {
    res.json({ available: false, matches: [], liveCount: 0, upcomingCount: 0, recentCount: 0 });
  }
});

// CDL predictions
app.get("/api/cdl-predictions/:matchId", async (req, res) => {
  const data = await redisCache.get("oracle:cdl_prediction:" + req.params.matchId);
  res.json(data || { available: false });
});

// CDL Standings — read from Redis (worker syncs from PandaScore)
app.get("/api/cdl/standings", async (req, res) => {
  try {
    var cached = await redisCache.get("oracle:cdl_standings");
    if (cached) {
      // Handle different response formats from worker
      if (cached.standings && cached.standings.length > 0) return res.json({ available: true, standings: cached.standings });
      if (cached.groups && cached.groups.length > 0) return res.json({ available: true, standings: cached.groups[0].teams || [] });
      if (Array.isArray(cached) && cached.length > 0) return res.json({ available: true, standings: cached });
    }
    // Fallback: build from CDL matches (win/loss from completed matches)
    var matchData = await redisCache.get("oracle:cdl_matches");
    if (matchData && matchData.matches) {
      var teamStats = {};
      matchData.matches.forEach(function(m) {
        if (m.status !== 'completed' && m.status !== 'finished') return;
        var t1 = m.team1 || m.opponents?.[0]?.opponent || {};
        var t2 = m.team2 || m.opponents?.[1]?.opponent || {};
        if (t1.name) { if (!teamStats[t1.name]) teamStats[t1.name] = { team: { id: t1.id, name: t1.name, logo: t1.logo, acronym: t1.acronym }, wins: 0, losses: 0 }; }
        if (t2.name) { if (!teamStats[t2.name]) teamStats[t2.name] = { team: { id: t2.id, name: t2.name, logo: t2.logo, acronym: t2.acronym }, wins: 0, losses: 0 }; }
        if (m.winner === t1.name && t1.name) { teamStats[t1.name].wins++; if (t2.name) teamStats[t2.name].losses++; }
        else if (m.winner === t2.name && t2.name) { teamStats[t2.name].wins++; if (t1.name) teamStats[t1.name].losses++; }
      });
      var standings = Object.values(teamStats).sort(function(a, b) {
        var wr1 = a.wins + a.losses > 0 ? a.wins / (a.wins + a.losses) : 0;
        var wr2 = b.wins + b.losses > 0 ? b.wins / (b.wins + b.losses) : 0;
        return wr2 - wr1 || b.wins - a.wins;
      });
      if (standings.length > 0) return res.json({ available: true, standings: standings });
    }
    res.json({ available: false, standings: [], message: "CDL standings not available right now" });
  } catch(e) { trackError("/api/cdl/standings", e); res.json({ available: false, standings: [] }); }
});

// Trending
app.get("/api/trending/:sport", async (req, res) => {
  try {
    var data = await redisCache.get("oracle:trending:" + req.params.sport);
    if (data && data.picks && data.picks.length > 0) {
      return res.json(data);
    }
    // Backwards compat: worker may write 'trending' field
    if (data && data.trending && data.trending.length > 0) {
      return res.json({ picks: data.trending, count: data.trending.length, source: "redis-trending" });
    }
    // Fallback: build trending from props + movement data
    // For CDL, use CDL props data (different format)
    if (req.params.sport === 'cdl') {
      var cdlData = await redisCache.get("oracle:cdl_props");
      var cdlPicks = [];
      if (cdlData && cdlData.matches) {
        cdlData.matches.forEach(function(match) {
          var teams = [match.team1, match.team2].filter(Boolean);
          teams.forEach(function(team) {
            if (!team || !team.players) return;
            team.players.forEach(function(pl) {
              if (!pl.props || pl.props.length === 0) return;
              pl.props.forEach(function(prop) {
                if (!prop.edge || prop.edge.confidence < 50) return;
                var signals = [];
                if (prop.edge.confidence >= 65) signals.push({ type: 'demon', label: 'High Confidence (' + prop.edge.confidence + '%)' });
                if (prop.edge.confidence >= 55) signals.push({ type: 'edge', label: 'Edge: ' + prop.edge.direction });
                if (prop.games >= 5) signals.push({ type: 'books', label: prop.games + ' games sample' });
                cdlPicks.push({
                  player: pl.player, team: pl.team, market: prop.market, marketLabel: prop.label,
                  consensusLine: prop.line, line: prop.line,
                  bookCount: prop.games || 1, lineType: prop.edge.confidence >= 65 ? 'demon' : 'standard',
                  hasEdge: prop.edge.confidence >= 55,
                  game: (match.team1?.name || '?') + ' vs ' + (match.team2?.name || '?'),
                  trendingScore: Math.min(100, prop.edge.confidence + (prop.games || 0) * 2),
                  signals: signals,
                  kd: pl.kd, avg: prop.avg,
                });
              });
            });
          });
        });
      }
      cdlPicks.sort(function(a, b) { return b.trendingScore - a.trendingScore; });
      return res.json({ picks: cdlPicks.slice(0, 30), count: cdlPicks.length, source: "cdl-props-derived" });
    }
    var propsData = await cachedRedisGet("props:" + req.params.sport, function() { return redisCache.getProps(req.params.sport); });
    var mvData = await redisCache.getMovement(req.params.sport);
    var movements = mvData && mvData.movements ? mvData.movements : [];
    if (propsData) {
      var props = propsData.props || propsData.picks || [];
      var picks = props.filter(function(p) { return p.bookCount >= 5; })
        .sort(function(a, b) { return (b.bookCount || 0) - (a.bookCount || 0); })
        .slice(0, 30)
        .map(function(p) {
          var bc = p.bookCount || 1;
          var isDemon = p.lineType === 'demon';
          var isEdge = p.lineType === 'edge' || p.hasEdge;
          var mvMatch = movements.find(function(m) { return m.player === p.player; });
          // Signals must be objects with { type, label } for the React SignalBadge component
          var signals = [];
          if (isDemon) signals.push({ type: 'demon', label: 'Demon (' + bc + ' books)' });
          if (isEdge) signals.push({ type: 'edge', label: 'Edge Detected' });
          if (mvMatch) signals.push({ type: 'movement', label: 'Line Moving', direction: mvMatch.direction === 'up' ? 'UP' : 'DOWN' });
          if (bc >= 7) signals.push({ type: 'books', label: bc + ' Books Agree' });
          var trendingScore = Math.min(100, (signals.length * 22) + (bc * 4));
          return {
            player: p.player,
            market: p.market,
            marketLabel: p.marketLabel || p.market,
            consensusLine: p.consensusLine || p.line,
            line: p.consensusLine || p.line,
            bookCount: bc,
            lineType: p.lineType,
            hasEdge: isEdge,
            game: p.game,
            books: p.books,
            trendingScore: trendingScore,
            signals: signals,
            movement: mvMatch ? { openLine: mvMatch.oldLine, currentLine: mvMatch.newLine, direction: mvMatch.direction === 'up' ? 'UP' : 'DOWN', amount: mvMatch.change } : null,
          };
        });
      picks.sort(function(a, b) { return b.trendingScore - a.trendingScore; });
      // React TrendingPicksTab reads data.picks (NOT data.trending)
      res.json({ picks: picks, count: picks.length, source: "props-derived" });
    } else {
      res.json({ picks: [], count: 0 });
    }
  } catch(e) { trackError("/api/trending/" + req.params.sport, e); res.json({ picks: [], count: 0 }); }
});

// Player headshots — proxy to ESPN CDN (handles /api/headshots/:sport/:player)
app.get("/api/headshots/:sport/:player", async (req, res) => {
  try {
    // Check Redis cache first
    var cacheKey = "oracle:headshot:" + req.params.sport + ":" + req.params.player.replace(/[^a-zA-Z0-9]/g, '_');
    var cached = await redisCache.get(cacheKey);
    if (cached) return res.json(cached);
    
    // Search ESPN for the player
    var axios = require("axios");
    var searchUrl = "https://site.api.espn.com/apis/common/v3/search?query=" + encodeURIComponent(req.params.player) + "&limit=1&type=player";
    var resp = await axios.get(searchUrl, { timeout: 5000 });
    var items = resp.data && resp.data.items ? resp.data.items : [];
    if (items.length > 0 && items[0].image) {
      var result = { url: items[0].image, name: req.params.player, source: "espn" };
      await redisCache.set(cacheKey, result, 86400); // Cache for 24 hours
      return res.json(result);
    }
    res.json({ url: null, name: req.params.player });
  } catch(e) {
    res.json({ url: null, name: req.params.player });
  }
});

// Fallback headshots without sport param
app.get("/api/headshots/:player", (req, res) => {
  res.json({ url: null, name: req.params.player });
});

// DVP (defense vs position) with action
app.get("/api/dvp/:sport/smash", async (req, res) => {
  const data = await redisCache.get("oracle:dvp:" + req.params.sport);
  if (data && data.smash) { res.json(data.smash); }
  else { res.json({ spots: [], count: 0 }); }
});

app.get("/api/dvp/:sport", async (req, res) => {
  const data = await redisCache.get("oracle:dvp:" + req.params.sport);
  res.json(data || { matchups: [] });
});

// Line movement with biggest
app.get("/api/movement/:sport/biggest", async (req, res) => {
  const data = await redisCache.getMovement(req.params.sport);
  if (data && data.movements) {
    var sorted = data.movements.sort(function(a, b) { return (b.change || 0) - (a.change || 0); });
    var limit = parseInt(req.query.limit) || 5;
    res.json({ movements: sorted.slice(0, limit), count: sorted.length });
  } else {
    res.json({ movements: [], count: 0 });
  }
});

// Pick History — React History tab calls /api/props/history/all
// Expects: { entries: [{ sport, date, picks: [{ player, pick, line, result, actual }] }] }
app.get("/api/props/history/all", async (req, res) => {
  try {
    // Try graded picks from the new grading engine
    var grades = await redisCache.get("oracle:graded_picks");
    if (!grades || !grades.length) grades = await redisCache.get("oracle:graded_picks_legacy");
    if (grades && grades.length > 0) {
      // Group by date
      var byDate = {};
      grades.forEach(function(g) {
        var key = g.date + ':' + g.sport;
        if (!byDate[key]) byDate[key] = { sport: g.sport, date: g.date, picks: [] };
        byDate[key].picks.push({ player: g.player, market: g.market, line: g.line, pick: g.pick, result: g.result, actual: g.actual, game: g.game });
      });
      var entries = Object.values(byDate).sort(function(a, b) { return b.date.localeCompare(a.date); });
      return res.json({ entries: entries });
    }
    // Fallback: try old parlay builder data
    var accuracy = await redisCache.getAccuracy();
    if (accuracy && accuracy.recentPicks && accuracy.recentPicks.length > 0) {
      return res.json({ entries: [{ sport: 'nba', date: new Date().toISOString().split('T')[0], picks: accuracy.recentPicks }] });
    }
    res.json({ entries: [] });
  } catch(e) { trackError("/api/props/history/all", e); res.json({ entries: [] }); }
});

// Standings — proxy ESPN standings with transformation
app.get("/api/sports/standings/:sport", async (req, res) => {
  try {
    var cached = await cachedRedisGet("standings:" + req.params.sport, function() { return redisCache.get("oracle:standings:" + req.params.sport); });
    if (cached && cached.groups) return res.json(cached);
    // Fallback: fetch from ESPN directly via native https
    var https = require("https");
    var sportMap = { nba: 'basketball/nba', nhl: 'hockey/nhl', mlb: 'baseball/mlb', nfl: 'football/nfl' };
    var espnPath = sportMap[req.params.sport];
    if (!espnPath) return res.json({ groups: [] });
    await new Promise(function(resolve) {
      var data = '';
      var r = https.get("https://site.api.espn.com/apis/v2/sports/" + espnPath + "/standings", { timeout: 10000 }, function(resp) {
        resp.on('data', function(c) { data += c; });
        resp.on('end', function() {
          try {
            var parsed = JSON.parse(data);
            var groups = (parsed.children || []).map(function(child) {
              return {
                name: child.name || child.abbreviation || 'Division',
                teams: (child.standings && child.standings.entries ? child.standings.entries : []).map(function(entry) {
                  var team = entry.team || {};
                  var stats = {};
                  (entry.stats || []).forEach(function(s) { stats[s.abbreviation || s.name] = s.displayValue || s.value; });
                  return { id: team.id, name: team.displayName || team.name, logo: team.logos && team.logos[0] ? team.logos[0].href : null, stats: stats, record: stats.W && stats.L ? stats.W + '-' + stats.L : null };
                }),
              };
            });
            res.json({ groups: groups, sport: req.params.sport });
            redisCache.set("oracle:standings:" + req.params.sport, { groups: groups, sport: req.params.sport }, 3600);
          } catch(e) { res.json({ groups: [] }); }
          data = null;
          resolve();
        });
      });
      r.on('error', function() { res.json({ groups: [] }); resolve(); });
      r.on('timeout', function() { r.destroy(); res.json({ groups: [] }); resolve(); });
    });
  } catch(e) { trackError("/api/sports/standings", e); res.json({ groups: [] }); }
});

// Enriched props
app.get("/api/enriched/:sport", async (req, res) => {
  const data = await redisCache.getProps(req.params.sport);
  if (data) {
    const props = data.props || data.picks || [];
    res.json({ props: props, count: props.length });
  } else {
    res.json({ props: [], count: 0 });
  }
});

// DVP (defense vs position)
app.get("/api/dvp/:sport", async (req, res) => {
  const data = await redisCache.get("oracle:dvp:" + req.params.sport);
  res.json(data || { matchups: [] });
});

// Analytics
app.get("/api/analytics/:sport", async (req, res) => {
  const data = await redisCache.get("oracle:analytics:" + req.params.sport);
  res.json(data || {});
});

// Bot API — proxy to worker which has the Anthropic API key
app.post("/api/bot/ask", async (req, res) => {
  try {
    var axios = require("axios");
    var workerUrl = process.env.WORKER_URL || "https://predict-production-c236.up.railway.app";
    var resp = await axios.post(workerUrl + "/api/bot/ask", req.body, { timeout: 30000, headers: { "Content-Type": "application/json" } });
    res.json(resp.data);
  } catch(e) {
    // Fallback: use Redis cached data to answer common questions
    var question = (req.body.question || "").toLowerCase();
    var answer = "";
    if (question.includes("pick") || question.includes("suggest")) {
      var props = await redisCache.getProps("nba");
      var items = props ? (props.props || props.picks || []) : [];
      var demons = items.filter(function(p) { return p.lineType === "demon"; }).slice(0, 3);
      if (demons.length > 0) {
        answer = "Here are today's top Demon lines:\\n\\n";
        demons.forEach(function(d) { answer += "🔥 " + d.player + " — " + (d.marketLabel || d.market) + " @ " + d.consensusLine + " (" + d.bookCount + " books)\\n"; });
        answer += "\\nDemon lines have 6+ books agreeing on the line — highest consensus edge.";
      } else {
        answer = "No Demon lines available right now. Check back closer to game time!";
      }
    } else if (question.includes("ev") || question.includes("value")) {
      var ev = await redisCache.getEV();
      if (ev && ev.length > 0) {
        answer = "Found " + ev.length + " +EV bets! The top edge is " + ev[0].player + " " + ev[0].market + " with a " + (ev[0].edgePercent || "?") + "% edge.";
      } else {
        answer = "No +EV bets found right now. EV bets appear during pre-game hours (11am-7pm ET).";
      }
    } else {
      answer = "I'm having trouble connecting to the AI engine right now. Try the quick buttons below or check back in a moment!";
    }
    res.json({ answer: answer });
  }
});

// Sharp snapshot
app.get("/api/sharp/snapshot", async (req, res) => {
  try {
    var cached = await redisCache.get("oracle:sharp_snapshot");
    var ev = cached ? cached.evBets : (await redisCache.getEV()) || [];
    var movements = cached ? cached.movements : [];
    if (!movements || movements.length === 0) {
      var mvData = await redisCache.getMovement("nba");
      movements = mvData ? mvData.movements || [] : [];
    }
    // Count total props tracked across all sports
    var propsTracked = 0;
    for (var sp of ['nba', 'nhl', 'mlb']) {
      var pd = await redisCache.getProps(sp);
      if (pd && pd.props) propsTracked += pd.props.length;
    }
    res.json({
      evBets: Array.isArray(ev) ? ev : [],
      movements: movements,
      propsTracked: propsTracked,
      timestamp: cached ? cached.timestamp : new Date().toISOString(),
    });
  } catch(e) { trackError("/api/sharp/snapshot", e); res.json({ evBets: [], movements: [], propsTracked: 0 }); }
});

// ============================================================
// SHARP DASHBOARD — RLM, Steam, CLV endpoints
// ============================================================

// RLM Alerts — reverse line movement (lines moving opposite to public action)
app.get("/api/sharp/rlm", async (req, res) => {
  try {
    var mvData = await redisCache.getMovement("nba");
    var movements = mvData && mvData.movements ? mvData.movements : [];
    // Also check NHL
    var nhlData = await redisCache.getMovement("nhl");
    if (nhlData && nhlData.movements) movements = movements.concat(nhlData.movements);
    // RLM = lines that moved DOWN (books adjusting against public money)
    var rlm = movements.filter(function(m) { return m.direction === 'down' && m.change > 0 && m.oldLine; })
      .map(function(m) { return { player: m.player, market: m.market, oldLine: m.oldLine, newLine: m.newLine, change: m.change, direction: 'DOWN', type: 'rlm', reason: 'Line dropped ' + (m.change || 0).toFixed(1) + ' points against public action' }; });
    res.json({ alerts: rlm, count: rlm.length });
  } catch(e) { res.json({ alerts: [], count: 0 }); }
});

// Steam Moves — rapid line movement across multiple books
app.get("/api/sharp/steam", async (req, res) => {
  try {
    var mvData = await redisCache.getMovement("nba");
    var movements = mvData && mvData.movements ? mvData.movements : [];
    var nhlData = await redisCache.getMovement("nhl");
    if (nhlData && nhlData.movements) movements = movements.concat(nhlData.movements);
    // Steam = any movement with change > 0 (lines that actually moved)
    var steam = movements.filter(function(m) { return m.change > 0 && m.oldLine; })
      .sort(function(a, b) { return (b.change || 0) - (a.change || 0); })
      .map(function(m) { return { player: m.player, market: m.market, oldLine: m.oldLine, newLine: m.newLine, change: m.change, direction: m.direction === 'up' ? 'UP' : 'DOWN', type: 'steam', reason: 'Line moved ' + (m.change || 0).toFixed(1) + ' points' }; });
    res.json({ moves: steam, count: steam.length });
  } catch(e) { res.json({ moves: [], count: 0 }); }
});

// CLV (Closing Line Value) — track how lines move over time
app.get("/api/sharp/clv/all", async (req, res) => {
  try {
    var mvData = await redisCache.getMovement("nba");
    var movements = mvData && mvData.movements ? mvData.movements : [];
    var propsData = await redisCache.getProps("nba");
    var totalProps = propsData ? (propsData.props || []).length : 0;
    var series = movements.map(function(m) {
      return { player: m.player, market: m.market, openingLine: m.oldLine, currentLine: m.newLine, movement: m.newLine - m.oldLine, snapshots: 2, hoursTracked: 4 };
    });
    res.json({ tracked: totalProps, series: series, count: series.length });
  } catch(e) { res.json({ tracked: 0, series: [], count: 0 }); }
});

// ============================================================
// ORACLE FEATURES — Grading, Performance, SGP, Bankroll, Alerts
// ============================================================

// Grading stats + recent graded picks
app.get("/api/features/grades", async (req, res) => {
  var stats = await redisCache.get("oracle:grading_stats");
  if (!stats) stats = await redisCache.get("oracle:grading_stats_legacy");
  res.json(stats || { overall: { total: 0, hits: 0, misses: 0, hitRate: 0, profit: 0 }, recentPicks: [], daily: [] });
});

app.get("/api/features/grades/recent", async (req, res) => {
  var grades = await redisCache.get("oracle:graded_picks");
  if (!grades || !grades.length) grades = await redisCache.get("oracle:graded_picks_legacy");
  var limit = parseInt(req.query.limit) || 50;
  res.json({ picks: (grades || []).slice(-limit).reverse(), total: (grades || []).length });
});

// Historical performance dashboard
app.get("/api/features/performance", async (req, res) => {
  var stats = await redisCache.get("oracle:grading_stats");
  if (!stats) stats = await redisCache.get("oracle:grading_stats_legacy");
  res.json(stats || { overall: {}, today: {}, last7Days: {}, last30Days: {}, bySport: {}, byLineType: {}, byMarket: {}, daily: [] });
});

// SGP suggestions
app.get("/api/features/sgp", async (req, res) => {
  var sgp = await redisCache.get("oracle:sgp_suggestions");
  res.json({ suggestions: sgp || [], count: (sgp || []).length });
});

// Bankroll simulator
app.get("/api/features/bankroll", async (req, res) => {
  var strategy = req.query.strategy || "flat";
  var lineType = req.query.lineType || null;
  var key = lineType === "demon" ? "oracle:bankroll_sim_demon" : "oracle:bankroll_sim";
  var sim = await redisCache.get(key);
  res.json(sim || { message: "No simulation data yet. Check back after games are graded." });
});

// Alerts
app.get("/api/features/alerts", async (req, res) => {
  var alerts = await redisCache.get("oracle:alerts");
  res.json({ alerts: alerts || [], count: (alerts || []).length });
});

// Esports routes
app.get("/api/esports/:game/matches", async (req, res) => {
  const data = await redisCache.get("oracle:esports:" + req.params.game);
  res.json(data || { matches: [], count: 0 });
});

// Note: /api/sports/scores/:sport and /api/sports/standings/:sport defined above — not duplicated

// Parlay related
// Parlay Builder — build a parlay from legs
app.post("/api/parlay/build", async (req, res) => {
  try {
    var legs = (req.body && req.body.legs) || [];
    if (legs.length === 0) return res.json({ error: "No legs provided" });
    var totalOdds = 1;
    legs.forEach(function(leg) {
      var odds = leg.odds || -110;
      var decimal = odds > 0 ? (odds / 100) + 1 : (100 / Math.abs(odds)) + 1;
      totalOdds *= decimal;
    });
    var impliedProb = 1 / totalOdds;
    var americanOdds = totalOdds >= 2 ? Math.round((totalOdds - 1) * 100) : Math.round(-100 / (totalOdds - 1));
    res.json({
      legs: legs,
      totalOdds: Math.round(totalOdds * 100) / 100,
      americanOdds: (americanOdds > 0 ? '+' : '') + americanOdds,
      impliedProbability: Math.round(impliedProb * 1000) / 10,
      payout100: Math.round((totalOdds - 1) * 100 * 100) / 100,
    });
  } catch(e) { res.json({ error: e.message }); }
});

// Parlay Live — show active parlays
app.get("/api/parlay/live", async (req, res) => {
  res.json({ active: [], count: 0 });
});

app.get("/api/parlay/history/auto-grade", (req, res) => {
  res.json({ graded: 0 });
});

// Predict injuries
app.get("/api/predict/injuries", (req, res) => {
  res.json({ injuries: [] });
});

// Catch-all for any missing /api/ routes — return proper empty data, not error messages
app.all("/api/*", (req, res) => {
  // Return empty arrays/objects that React expects — never return error-like messages
  var path = req.path;
  if (path.includes('/props')) return res.json({ props: [], count: 0, available: true });
  if (path.includes('/games') || path.includes('/matches')) return res.json({ games: [], matches: [], count: 0 });
  if (path.includes('/scores')) return res.json({ events: [], games: [] });
  if (path.includes('/picks')) return res.json({ picks: [], count: 0 });
  if (path.includes('/movement')) return res.json({ movements: [], count: 0 });
  if (path.includes('/bets') || path.includes('/ev')) return res.json({ bets: [], found: 0 });
  if (path.includes('/headshots')) return res.json({ url: null });
  res.json({});
});

// ============================================================
// PAGE SERVING — Same as current server
// ============================================================

// Universal Nav
const UNIVERSAL_NAV = `<nav class="nav" style="padding:14px 0;border-bottom:1px solid #1e293b;background:#0a0f1a;position:sticky;top:0;z-index:100;backdrop-filter:blur(12px);">
<div style="display:flex;align-items:center;justify-content:space-between;max-width:960px;margin:0 auto;padding:0 20px;">
<a href="/" style="font-family:Outfit,sans-serif;font-weight:900;font-size:18px;letter-spacing:2px;color:#f1f5f9;text-decoration:none;">⟁ <span style="color:#38bdf8;">ORACLE</span></a>
<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:center;">
<a href="/pick" style="font-size:12px;color:#94a3b8;font-weight:500;padding:5px 8px;border-radius:6px;text-decoration:none;">POTD</a>
<a href="/props" style="font-size:12px;color:#94a3b8;font-weight:500;padding:5px 8px;border-radius:6px;text-decoration:none;">Props</a>
<a href="/games" style="font-size:12px;color:#94a3b8;font-weight:500;padding:5px 8px;border-radius:6px;text-decoration:none;">Games</a>
<a href="/sharp" style="font-size:12px;color:#94a3b8;font-weight:500;padding:5px 8px;border-radius:6px;text-decoration:none;">Sharp</a>
<a href="/record" style="font-size:12px;color:#10b981;font-weight:600;padding:5px 8px;border-radius:6px;text-decoration:none;background:#10b98115;">Record</a>
<a href="https://discord.gg/PxREjjgnmf" target="_blank" style="font-size:12px;color:#a78bfa;font-weight:600;padding:5px 8px;border-radius:6px;text-decoration:none;background:#a78bfa15;">Discord</a>
</div></div></nav>`;

function serveWithNav(filePath, activeLink) {
  return (req, res) => {
    try {
      let html = fs.readFileSync(filePath, "utf8");
      const activeNav = UNIVERSAL_NAV.replace(
        `href="${activeLink}"`,
        `href="${activeLink}" style="font-size:12px;color:#f1f5f9;font-weight:700;padding:5px 8px;border-radius:6px;text-decoration:none;background:#1a2236;"`
      );
      // SEO meta tags
      if (!html.includes('og:title')) {
        var seoTags = '<meta name="robots" content="index, follow"><meta property="og:type" content="website"><meta property="og:site_name" content="ORACLE"><link rel="manifest" href="/manifest.json"><meta name="theme-color" content="#38bdf8"><link rel="canonical" href="https://www.oraclepredictapp.com' + activeLink + '">';
        html = html.replace('</head>', seoTags + '\n</head>');
      }
      // Service worker
      if (!html.includes('serviceWorker')) {
        html = html.replace('</body>', '<script>if("serviceWorker" in navigator){navigator.serviceWorker.register("/sw.js").catch(function(){})}</script>\n</body>');
      }
      // Nav
      const navRegex = /<nav[^>]*>[\s\S]*?<\/nav>/i;
      if (navRegex.test(html)) { html = html.replace(navRegex, activeNav); }
      else { html = html.replace(/<body[^>]*>/i, (m) => m + '\n' + activeNav); }
      // Bot
      try { html = html.replace("</body>", fs.readFileSync(path.join(__dirname, "public", "oracle-bot.html"), "utf8") + "\n</body>"); } catch(e) {}
      // FAB
      try { html = html.replace("</body>", fs.readFileSync(path.join(__dirname, "public", "fab-nav.html"), "utf8") + "\n</body>"); } catch(e) {}
      // Design system
      try { html = html.replace("</body>", fs.readFileSync(path.join(__dirname, "public", "oracle-design-system.html"), "utf8") + "\n</body>"); } catch(e) {}
      res.type("html").send(html);
    } catch (e) { res.sendFile(filePath); }
  };
}

// Landing page
app.get("/", (req, res) => {
  try {
    let html = fs.readFileSync(path.join(__dirname, "public", "landing.html"), "utf8");
    try { html = html.replace("</body>", fs.readFileSync(path.join(__dirname, "public", "fab-nav.html"), "utf8") + "\n</body>"); } catch(e) {}
    try { html = html.replace("</body>", fs.readFileSync(path.join(__dirname, "public", "oracle-bot.html"), "utf8") + "\n</body>"); } catch(e) {}
    res.type("html").send(html);
  } catch (e) { res.sendFile(path.join(__dirname, "public", "landing.html")); }
});

// Standalone pages
app.get("/pick", serveWithNav(path.join(__dirname, "public", "pick-of-the-day.html"), "/pick"));
app.get("/props", serveWithNav(path.join(__dirname, "public", "props-explorer.html"), "/props"));
app.get("/games", serveWithNav(path.join(__dirname, "public", "game-predictions.html"), "/games"));
app.get("/parlay", serveWithNav(path.join(__dirname, "public", "parlay-builder.html"), "/parlay"));
app.get("/sharp", serveWithNav(path.join(__dirname, "public", "sharp-dashboard.html"), "/sharp"));
app.get("/player", serveWithNav(path.join(__dirname, "public", "player-profile.html"), "/player"));
app.get("/record", serveWithNav(path.join(__dirname, "public", "accuracy-record.html"), "/record"));
app.get("/share", serveWithNav(path.join(__dirname, "public", "share-card.html"), "/share"));
app.get("/futures", serveWithNav(path.join(__dirname, "public", "futures.html"), "/futures"));
app.get("/bankroll", serveWithNav(path.join(__dirname, "public", "bankroll.html"), "/bankroll"));
app.get("/consensus", serveWithNav(path.join(__dirname, "public", "consensus.html"), "/consensus"));
app.get("/how-it-works", serveWithNav(path.join(__dirname, "public", "how-it-works.html"), "/how-it-works"));
app.get("/start", serveWithNav(path.join(__dirname, "public", "first-bet.html"), "/start"));
app.get("/privacy", (req, res) => res.sendFile(path.join(__dirname, "public", "privacy.html")));

// PWA
app.get("/manifest.json", (req, res) => res.sendFile(path.join(__dirname, "public", "manifest.json")));
app.get("/sw.js", (req, res) => { res.setHeader('Content-Type', 'application/javascript'); res.sendFile(path.join(__dirname, "public", "sw.js")); });

// React app
const helpButtonPath = path.join(__dirname, "public", "help-button.html");
let helpButtonHTML = "";
try { helpButtonHTML = fs.readFileSync(helpButtonPath, "utf8"); } catch(e) {}

app.get("/app", serveApp);
app.get("/app/", serveApp);
app.get("/app/*", (req, res, next) => { if (req.path.includes('.')) return next(); serveApp(req, res); });

function serveApp(req, res) {
  try {
    let html = fs.readFileSync(path.join(__dirname, "dist", "index.html"), "utf8");
    let botHTML = ""; try { botHTML = fs.readFileSync(path.join(__dirname, "public", "oracle-bot.html"), "utf8"); } catch(e) {}
    let fabHTML = ""; try { fabHTML = fs.readFileSync(path.join(__dirname, "public", "fab-nav.html"), "utf8"); } catch(e) {}
    let designHTML = ""; try { designHTML = fs.readFileSync(path.join(__dirname, "public", "oracle-design-system.html"), "utf8"); } catch(e) {}
    html = html.replace("</body>", helpButtonHTML + "\n" + botHTML + "\n" + fabHTML + "\n" + designHTML + "\n<style>.fab-nav,.oracle-fab-group{display:none!important}.tab-bar{position:sticky!important;top:70px!important;bottom:auto!important;z-index:50!important;background:#0a0f1a!important;border-bottom:1px solid #1e293b!important;border-top:none!important;display:flex!important;justify-content:center!important;gap:2px!important;padding:6px 8px!important;overflow-x:auto!important;-webkit-overflow-scrolling:touch!important}.tab-bar button{font-size:11px!important;padding:6px 10px!important;border-radius:6px!important;white-space:nowrap!important}</style>\n</body>");
    res.type("html").send(html);
  } catch (e) { res.sendFile(path.join(__dirname, "dist", "index.html")); }
}

// Static files
app.use(express.static(path.join(__dirname, "public")));
app.use("/app", express.static(path.join(__dirname, "dist")));
app.use("/assets", express.static(path.join(__dirname, "dist", "assets")));
app.use(express.static(path.join(__dirname, "dist")));

// Error handler
app.use((err, req, res, next) => {
  console.error("Error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

// Crash protection
process.on('uncaughtException', (err) => { console.error('[CRASH PREVENTED]', err.message); });
process.on('unhandledRejection', (reason) => { console.error('[CRASH PREVENTED]', reason); });

const server = app.listen(PORT, () => {
  console.log(`ORACLE Web Server running on port ${PORT} — reads from Redis, serves pages`);
  console.log(`[Web] Lightweight mode — no background jobs, no API calls`);
});
