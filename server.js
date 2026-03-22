require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const path = require("path");

// === Route imports ===
const sportsRoutes = require("./routes/sports");
const predictionsRoutes = require("./routes/predictions");
const oddsRoutes = require("./routes/odds");
const cdlRoutes = require("./routes/cdl");
const propsRoutes = require("./routes/props");
const liveRoutes = require("./routes/live");
const cdlPropsRoutes = require("./routes/cdl-props");

// === Service imports (ALL at top level) ===
const { scrapeCDLStats } = require("./services/cdl-stats-scraper");
const lineMovement = require("./services/line-movement");
const trendingPicks = require("./services/trending-picks");
const discordAlerts = require("./services/discord-alerts");
const analytics = require("./services/enhanced-analytics");
const dvp = require("./services/defense-vs-position");
const esports = require("./services/esports-expansion");
const predictionModel = require("./services/prediction-model");

// === Optional services (won't crash if file is missing) ===
let enrichment = null;
try {
  enrichment = require("./services/prop-enrichment");
} catch (e) {
  console.log("prop-enrichment not found, skipping enriched props endpoint");
}

let smartPicks = null;
try {
  smartPicks = require("./services/smart-picks");
} catch (e) {
  console.log("smart-picks not found, skipping model-powered picks");
}

let autoGrader = null;
try {
  autoGrader = require("./services/auto-grader");
} catch (e) {
  console.log("auto-grader not found, skipping pick grading");
}

let backtester = null;
try {
  backtester = require("./services/backtester");
} catch (e) {
  console.log("backtester not found, skipping backtest endpoint");
}

let refData = null;
try {
  refData = require("./services/referee-data");
} catch (e) {
  console.log("referee-data not found, skipping ref tracking");
}

let enhancedPropsMiddleware = null;
try {
  enhancedPropsMiddleware = require("./services/enhanced-props-middleware");
} catch (e) {
  console.log("enhanced-props-middleware not found, props served without enrichment");
}

let wnba = null;
try {
  wnba = require("./services/wnba");
} catch (e) {
  console.log("wnba not found, skipping WNBA endpoints");
}

let modelTuner = null;
try {
  modelTuner = require("./services/model-tuner");
} catch (e) {
  console.log("model-tuner not found, skipping tuner endpoint");
}

let evEngine = null;
try {
  evEngine = require("./services/ev-engine");
} catch (e) {
  console.log("ev-engine not found, skipping +EV scanner");
}

let sharpTools = null;
try {
  sharpTools = require("./services/sharp-tools");
} catch (e) {
  console.log("sharp-tools not found, skipping pro bettor tools");
}

// Multi-API Odds Provider (Odds API + SharpAPI failover)
let multiOdds = null;
try {
  multiOdds = require("./services/multi-odds-provider");
  console.log("[MultiOdds] Provider loaded — Odds API + SharpAPI failover active");
} catch (e) {
  console.log("multi-odds-provider not found, using single API mode");
}

// SharpAPI-powered routes for Sharp Dashboard
let sharpRoutes = null;
try {
  sharpRoutes = require("./services/sharp-routes");
} catch (e) {
  console.log("sharp-routes not found, using legacy sharp tools");
}

let potd = null;
try {
  potd = require("./services/pick-of-the-day");
} catch (e) {
  console.log("pick-of-the-day not found, skipping POTD engine");
}

let advancedTools = null;
try {
  advancedTools = require("./services/advanced-tools");
} catch (e) {
  console.log("advanced-tools not found, skipping middling/arb scanner");
}

let predV2 = null;
try {
  predV2 = require("./services/prediction-engine-v2");
} catch (e) {
  console.log("prediction-engine-v2 not found, skipping enhanced predictions");
}

let accuracyBoost = null;
try {
  accuracyBoost = require("./services/accuracy-boost");
} catch (e) {
  console.log("accuracy-boost not found, skipping additional accuracy factors");
}

let parlayBuilder = null;
try {
  parlayBuilder = require("./services/parlay-builder");
} catch (e) {
  console.log("parlay-builder not found, skipping parlay/history features");
}

let stability = null;
try {
  stability = require("./services/stability");
} catch (e) {
  console.log("stability module not found, running without stability features");
}

let bookmakersConfig = null;
try {
  bookmakersConfig = require("./services/bookmakers-config");
} catch (e) {
  console.log("bookmakers-config not found, using defaults");
}

let gamePredictions = null;
try {
  gamePredictions = require("./services/game-predictions");
} catch (e) {
  console.log("game-predictions not found, skipping game picks");
}

let cdlPredictions = null;
try {
  cdlPredictions = require("./services/cdl-predictions");
} catch (e) {
  console.log("cdl-predictions not found, skipping CDL predictions");
}

let playerHeadshots = null;
try {
  playerHeadshots = require("./services/player-headshots");
} catch (e) {
  console.log("player-headshots not found, skipping headshots");
}

const app = express();
const PORT = process.env.PORT || 3001;

// === Middleware ===
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json());
app.use(cors({ origin: process.env.CLIENT_URL || "*", credentials: true }));
app.use("/api/", rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
  message: { error: "Rate limited" },
  skip: function(req) {
    // Skip rate limiting for internal requests (localhost, 127.0.0.1)
    var ip = req.ip || req.connection.remoteAddress || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.includes('localhost');
  },
  standardHeaders: true,
  legacyHeaders: false,
}));

// === API Routes ===
app.use("/api/sports", sportsRoutes);

// === Intercept game predictions — ALWAYS use ORACLE's 18-factor engine ===
app.post("/api/predictions/game", async (req, res, next) => {
  let { sport, gameId, homeTeam, awayTeam } = req.body;
  if (!sport || !gameId) return res.json({ error: "sport and gameId are required" });

  try {
    const axios = require("axios");

    // Step 1: If team names not provided, look them up from ESPN
    if (!homeTeam || !awayTeam) {
      const espnSportMap = { nba: 'basketball/nba', nfl: 'football/nfl', mlb: 'baseball/mlb', nhl: 'hockey/nhl' };
      const espnSport = espnSportMap[sport];
      if (espnSport) {
        try {
          const espnResp = await axios.get(
            `https://site.api.espn.com/apis/site/v2/sports/${espnSport}/summary?event=${gameId}`,
            { timeout: 10000 }
          );
          const header = espnResp.data?.header?.competitions?.[0];
          if (header?.competitors) {
            for (const c of header.competitors) {
              if (c.homeAway === 'home') homeTeam = c.team?.displayName || c.team?.name;
              else awayTeam = c.team?.displayName || c.team?.name;
            }
          }
          if (!homeTeam || !awayTeam) {
            const boxTeams = espnResp.data?.boxscore?.teams || [];
            if (boxTeams.length === 2) {
              homeTeam = homeTeam || boxTeams[0]?.team?.displayName;
              awayTeam = awayTeam || boxTeams[1]?.team?.displayName;
            }
          }
          console.log(`[AI Predict] ESPN lookup for ${gameId}: ${awayTeam} @ ${homeTeam}`);
        } catch (espnErr) {
          console.log(`[AI Predict] ESPN lookup failed for ${gameId}: ${espnErr.message}`);
        }
      }
    }

    // Step 1b: CDL/Esports — look up team names from PandaScore match ID
    if ((!homeTeam || !awayTeam) && (sport === 'cdl' || sport === 'codmw' || sport === 'cod')) {
      const PS_KEY = process.env.PANDASCORE_API_KEY;
      if (PS_KEY) {
        try {
          const psResp = await axios.get(`https://api.pandascore.co/matches/${gameId}`, {
            params: { token: PS_KEY }, timeout: 10000,
          });
          const opponents = psResp.data?.opponents || [];
          if (opponents.length === 2) {
            homeTeam = opponents[0]?.opponent?.name;
            awayTeam = opponents[1]?.opponent?.name;
            console.log(`[AI Predict] PandaScore lookup for CDL ${gameId}: ${homeTeam} vs ${awayTeam}`);
          }
        } catch (psErr) {
          console.log(`[AI Predict] PandaScore lookup failed for ${gameId}: ${psErr.message}`);
        }
      }
    }

    // Step 2: CDL / Esports — use CDL prediction engine
    if (cdlPredictions && (sport === 'cdl' || sport === 'codmw' || sport === 'cod')) {
      try {
        const teamStats = await cdlPredictions.buildTeamStats();
        const findTeam = (name) => {
          if (!name) return null;
          const lower = name.toLowerCase();
          return Object.values(teamStats).find(t =>
            t.name.toLowerCase() === lower ||
            t.name.toLowerCase().includes(lower.split(' ').pop()) ||
            lower.includes(t.name.toLowerCase().split(' ').pop())
          );
        };
        const t1 = findTeam(homeTeam);
        const t2 = findTeam(awayTeam);
        if (t1 && t2) {
          const pred = cdlPredictions.predictMatch(t1, t2);
          return res.json({
            gameId, sport,
            prediction: {
              homeTeam: t1.name, awayTeam: t2.name,
              homeWinProb: pred.team1Prob, awayWinProb: pred.team2Prob,
              predictedWinner: pred.predictedWinner.name,
              confidence: pred.confidence,
              keyFactors: pred.factors.map(f => `${f.name}: ${f.team1} vs ${f.team2} → ${f.advantage}`),
              hotTake: `ORACLE CDL: ${pred.predictedWinner.name} (${pred.winnerProb}%) based on win rate, form, H2H, map record, and streaks.`,
              fallback: false, poweredBy: 'ORACLE CDL Prediction Engine',
            },
          });
        }
      } catch (cdlErr) {
        console.error(`[AI Predict] CDL error: ${cdlErr.message}`);
      }
    }

    // Step 3: Traditional sports — use Odds API + game predictions engine
    if (gamePredictions && homeTeam) {
      const ODDS_KEY = process.env.ODDS_API_KEY;
      const PROP_SPORTS = { nba: 'basketball_nba', nfl: 'americanfootball_nfl', mlb: 'baseball_mlb', nhl: 'icehockey_nhl' };
      const oddsSport = PROP_SPORTS[sport];

      let games = [];
      if (ODDS_KEY && oddsSport) {
        try {
          const oddsResp = await axios.get(`https://api.the-odds-api.com/v4/sports/${oddsSport}/odds`, {
            params: { apiKey: ODDS_KEY, regions: 'us,us2', markets: 'spreads,totals,h2h', oddsFormat: 'american' },
            timeout: 15000,
          });
          games = (oddsResp.data || []).map(g => gamePredictions.analyzeGame({
            id: g.id, homeTeam: g.home_team, awayTeam: g.away_team, commenceTime: g.commence_time,
            bookmakers: g.bookmakers?.map(b => ({ title: b.title, key: b.key, markets: b.markets })) || [],
          }));
          console.log(`[AI Predict] Got ${games.length} ${sport} games, matching: ${awayTeam} @ ${homeTeam}`);
        } catch (oddsErr) {
          console.error(`[AI Predict] Odds API error: ${oddsErr.message}`);
        }
      }

      // Match by team name — use last word of team name (e.g. "Rockets", "Lakers")
      const game = games.find(g => {
        const hLast = homeTeam?.split(' ').pop()?.toLowerCase();
        const aLast = awayTeam?.split(' ').pop()?.toLowerCase();
        const gHome = g.homeTeam?.toLowerCase() || '';
        const gAway = g.awayTeam?.toLowerCase() || '';
        return (hLast && (gHome.includes(hLast) || gAway.includes(hLast))) ||
               (aLast && (gHome.includes(aLast) || gAway.includes(aLast)));
      });

      if (game) {
        const sp = game.predictions?.spread || {};
        const tp = game.predictions?.total || {};
        const w = game.predictions?.winner || {};
        const homeWin = w.team === game.homeTeam ? w.confidence : 100 - w.confidence;

        return res.json({
          gameId, sport,
          prediction: {
            homeTeam: game.homeTeam, awayTeam: game.awayTeam,
            homeWinProb: homeWin, awayWinProb: 100 - homeWin,
            predictedWinner: w.team || game.homeTeam,
            confidence: Math.max(sp.confidence || 0, w.confidence || 0),
            spread: game.consensus?.spread || 0, total: game.consensus?.total || 220,
            keyFactors: [
              `${game.environment} game environment`,
              `Spread: ${game.homeAbbr} ${game.consensus?.spread || 0} (${sp.confidence || 50}% confidence)`,
              `Total: ${tp.side || 'OVER'} ${game.consensus?.total || 220} (${tp.confidence || 50}% confidence)`,
              `${game.bookCount || 0} sportsbooks compared`,
              sp.bestOdds ? `Best odds: ${sp.bestOdds.book} (${sp.bestOdds.price > 0 ? '+' : ''}${sp.bestOdds.price})` : null,
            ].filter(Boolean),
            hotTake: `ORACLE picks ${w.abbr || w.team} to win. ${tp.side || 'OVER'} ${game.consensus?.total || 220} total. ${game.environment} game.`,
            fallback: false, poweredBy: 'ORACLE 18-Factor Model',
          },
        });
      }
    }

    // Fallback
    return res.json({
      gameId, sport,
      prediction: {
        homeTeam: homeTeam || "Home Team", awayTeam: awayTeam || "Away Team",
        homeWinProb: 50, awayWinProb: 50, confidence: 0,
        keyFactors: [homeTeam ? `No odds data found for ${awayTeam} @ ${homeTeam}` : "Could not identify teams for this game"],
        hotTake: homeTeam ? `No active odds for this game. Visit /games for today's predictions.` : "Game data unavailable.",
        fallback: true,
      },
    });
  } catch (e) {
    console.error(`[AI Predict] Error: ${e.message}`);
    return res.json({
      gameId, sport,
      prediction: {
        homeTeam: homeTeam || "Home", awayTeam: awayTeam || "Away",
        homeWinProb: 50, awayWinProb: 50, confidence: 0,
        keyFactors: ["Prediction engine error — try again"],
        hotTake: "Visit /games for full predictions.", fallback: true, poweredBy: 'ORACLE',
      },
    });
  }
});

app.use("/api/predictions", predictionsRoutes);
app.use("/api/odds", oddsRoutes);
app.use("/api/cdl", cdlRoutes);
app.use("/api/dvp", dvp.router);
app.use("/api/esports", esports.router);
app.use("/api/analytics", analytics.router);
app.use("/api/predict", predictionModel.router);

// === Expand sportsbook regions for props — adds us2 region for more books ===
process.env.ODDS_REGIONS = process.env.ODDS_REGIONS || 'us,us2';
// === Enhanced props middleware — auto-enriches props with analytics data ===
if (enhancedPropsMiddleware) {
  enhancedPropsMiddleware.applyMiddleware(app);
}
// === Smart picks fallback — if /api/props/:sport/picks fails, use model picks ===
app.get("/api/props/:sport/picks", async (req, res, next) => {
  // Let the original handler try first
  const originalJson = res.json.bind(res);
  res.json = function(data) {
    // If original picks failed, try smart picks
    if (data && data.available === false && smartPicks) {
      const cached = smartPicks.picksCache[req.params.sport];
      if (cached && cached.picks && cached.picks.length > 0) {
        return originalJson({
          available: true,
          picks: cached.picks,
          summary: `${cached.picks.length} model-powered picks`,
          sport: req.params.sport,
          timestamp: cached.lastUpdated,
          source: 'prediction-model',
        });
      }
    }
    return originalJson(data);
  };
  next();
});
app.use("/api/props", propsRoutes);
app.use("/api/live", liveRoutes);
app.use("/api/cdl", cdlPropsRoutes);
app.use("/api/movement", lineMovement.router);
app.use("/api/trending", trendingPicks.router);
if (enrichment) {
  app.use("/api/enriched", enrichment.router);
}
if (smartPicks) {
  app.use("/api/picks", smartPicks.router);
}
if (autoGrader) {
  app.use("/api/grades", autoGrader.router);
}
if (backtester) {
  app.use("/api/backtest", backtester.router);
}
if (refData) {
  app.use("/api/refs", refData.router);
}
if (wnba) {
  app.use("/api/wnba", wnba.router);
}
if (modelTuner) {
  app.use("/api/tuner", modelTuner.router);
}
if (evEngine) {
  app.use("/api/ev", evEngine.router);
}
if (sharpTools) {
  app.use("/api/sharp", sharpTools.router);
}
if (potd) {
  app.use("/api/potd", potd.router);
}
if (advancedTools) {
  app.use("/api/advanced", advancedTools.router);
}
if (predV2) {
  app.use("/api/predict-v2", predV2.router);
}
if (accuracyBoost) {
  app.use("/api/accuracy", accuracyBoost.router);
}
if (parlayBuilder) {
  app.use("/api/parlay", parlayBuilder.router);
}
if (bookmakersConfig) {
  app.use("/api/bookmakers", bookmakersConfig.router);
}
if (gamePredictions) {
  app.use("/api/games", gamePredictions.router);
}
if (cdlPredictions) {
  app.use("/api/cdl-predictions", cdlPredictions.router);
}
if (playerHeadshots) {
  app.use("/api/headshots", playerHeadshots.router);
}

// === SharpAPI-powered routes (EV, Arbs, Middles, Splits) ===
if (sharpRoutes) {
  app.use("/api/sharp-v2", sharpRoutes.router);
}

// === Multi-API Provider status ===
app.get("/api/providers", (req, res) => {
  if (multiOdds) {
    res.json(multiOdds.getProviderStatus());
  } else {
    res.json({ multiOdds: false, note: "Single API mode" });
  }
});

// === ORACLE Bot API (Claude Haiku powered) ===
let botApi = null;
try {
  botApi = require("./services/oracle-bot-api");
  app.use("/api/bot", botApi.router);
} catch (e) {
  console.log("oracle-bot-api not found, bot will use fallback mode");
}

// === Start services ===

// Pre-warm caches from disk FIRST — site shows data immediately after restart
try {
  const stability = require("./services/stability");
  stability.preWarmCaches(smartPicks, gamePredictions, evEngine);
  stability.startPersistence(smartPicks, gamePredictions, evEngine);
} catch(e) {
  console.log("Stability module not loaded:", e.message);
}

// === Redis Cache Layer — shared data that survives restarts ===
let redisCache = null;
try {
  redisCache = require("./services/redis-cache");
  console.log("[Redis] Cache module loaded");

  // Pre-warm memory caches FROM Redis on startup (instant data)
  (async function preWarmFromRedis() {
    try {
      for (const sport of ['nba', 'nhl', 'mlb', 'nfl']) {
        const props = await redisCache.getProps(sport);
        if (props && smartPicks && smartPicks.picksCache) {
          if (!smartPicks.picksCache[sport] || !smartPicks.picksCache[sport].picks || smartPicks.picksCache[sport].picks.length === 0) {
            smartPicks.picksCache[sport] = props;
            console.log("[Redis] Pre-warmed " + sport + " props from Redis: " + (props.picks ? props.picks.length : 0));
          }
        }
        const games = await redisCache.getGames(sport);
        if (games && gamePredictions && gamePredictions.gamesCache) {
          if (!gamePredictions.gamesCache[sport] || !gamePredictions.gamesCache[sport].games || gamePredictions.gamesCache[sport].games.length === 0) {
            gamePredictions.gamesCache[sport] = games;
            console.log("[Redis] Pre-warmed " + sport + " games from Redis: " + (games.games ? games.games.length : 0));
          }
        }
      }
      const ev = await redisCache.getEV();
      if (ev && evEngine && Array.isArray(ev) && ev.length > 0) {
        if (!evEngine.evCache || evEngine.evCache.length === 0) {
          evEngine.evCache = ev;
          console.log("[Redis] Pre-warmed EV bets from Redis: " + ev.length);
        }
      }
    } catch(e) {
      console.log("[Redis] Pre-warm error (non-fatal):", e.message);
    }
  })();

  // === BUILT-IN LINE MOVEMENT TRACKER ===
  // The external lineMovement module snapshots 0 changes, so we track inline.
  // Each sync cycle: save current lines, compare to previous, write movements to Redis.
  var _prevLineSnapshots = {}; // { "player__market__sport": consensusLine }

  // === SYNC TO REDIS — Direct memory access, writes to Redis ===
  
  // Internal endpoint that dumps all data for Redis sync (not exposed publicly)
  app.get("/internal/sync-dump", async function(req, res) {
    var dump = {};
    try {
      // Props — use getCachedProps which works reliably
      for (var sport of ['nba', 'nhl', 'mlb']) {
        try {
          if (typeof getCachedProps === 'function') {
            var p = await getCachedProps(sport);
            if (p && p.props && p.props.length > 0) dump['props_' + sport] = p;
          }
        } catch(e) {}
      }
      // Smart picks
      if (smartPicks && smartPicks.picksCache) {
        for (var sp of Object.keys(smartPicks.picksCache)) {
          var c = smartPicks.picksCache[sp];
          if (c && ((c.picks && c.picks.length > 0) || (c.props && c.props.length > 0))) {
            dump['picks_' + sp] = c;
          }
        }
      }
      // Games
      if (gamePredictions && gamePredictions.gamesCache) {
        for (var gs of Object.keys(gamePredictions.gamesCache)) {
          var gc = gamePredictions.gamesCache[gs];
          if (gc && gc.games && gc.games.length > 0) dump['games_' + gs] = gc;
        }
      }
      // EV
      if (evEngine && evEngine.cache && evEngine.cache.evBets && evEngine.cache.evBets.length > 0) {
        dump.ev = evEngine.cache.evBets;
      }
      // POTD
      if (potd && potd.cache && potd.cache.picks) {
        dump.potd = potd.cache.picks;
      }
      // Line movement
      if (lineMovement && lineMovement.lineHistory) {
        dump.lineHistory = lineMovement.lineHistory;
      }
      // Trending
      try {
        var tp = require("./services/trending-picks");
        if (tp && tp.trendingCache) dump.trending = tp.trendingCache;
      } catch(e) {}
      // Accuracy
      if (parlayBuilder && parlayBuilder.getHistoricalStats) {
        try { dump.accuracy = parlayBuilder.getHistoricalStats(); } catch(e) {}
      }
      // Sharp
      if (sharpTools && sharpTools.getSnapshot) {
        try { dump.sharp = sharpTools.getSnapshot(); } catch(e) {}
      }
      res.json({ ok: true, keys: Object.keys(dump).length, dump: dump });
    } catch(e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // Sync loop — direct memory access (no HTTP self-calls that timeout)
  setInterval(async function() {
    try {
      var synced = 0;
      var http = require("http");
      var PORT = process.env.PORT || 8080;
      
      // Collect all data directly from memory — no HTTP call needed
      var d = {};
      try {
        for (var sport of ['nba', 'nhl', 'mlb']) {
          try {
            if (typeof getCachedProps === 'function') {
              var p = await getCachedProps(sport);
              if (p && p.props && p.props.length > 0) d['props_' + sport] = p;
            }
          } catch(e) {}
        }
        if (smartPicks && smartPicks.picksCache) {
          for (var sp of Object.keys(smartPicks.picksCache)) {
            var c = smartPicks.picksCache[sp];
            if (c && ((c.picks && c.picks.length > 0) || (c.props && c.props.length > 0))) d['picks_' + sp] = c;
          }
        }
        if (gamePredictions && gamePredictions.gamesCache) {
          for (var gs of Object.keys(gamePredictions.gamesCache)) {
            var gc = gamePredictions.gamesCache[gs];
            if (gc && gc.games && gc.games.length > 0) d['games_' + gs] = gc;
          }
        }
        if (evEngine && evEngine.cache && evEngine.cache.evBets && evEngine.cache.evBets.length > 0) d.ev = evEngine.cache.evBets;
        if (potd && potd.cache && potd.cache.picks) d.potd = potd.cache.picks;
        if (lineMovement && lineMovement.lineHistory) d.lineHistory = lineMovement.lineHistory;
        try { var tp = require("./services/trending-picks"); if (tp && tp.trendingCache) d.trending = tp.trendingCache; } catch(e) {}
        if (parlayBuilder && parlayBuilder.getHistoricalStats) { try { d.accuracy = parlayBuilder.getHistoricalStats(); } catch(e) {} }
        if (sharpTools && sharpTools.getSnapshot) { try { d.sharp = sharpTools.getSnapshot(); } catch(e) {} }
      } catch(e) {
        console.warn("[Redis] Data collection error:", e.message);
      }

      // Write props
      for (var sport of ['nba', 'nhl', 'mlb']) {
        if (d['props_' + sport]) {
          var p = d['props_' + sport];
          await redisCache.setProps(sport, { props: p.props, picks: p.props, count: p.props.length, timestamp: Date.now() });
          synced++;
        }
      }
      // Write picks
      for (var sp of ['nba', 'nhl', 'mlb']) {
        if (d['picks_' + sp]) {
          await redisCache.setPicks(sp, d['picks_' + sp]);
          synced++;
        }
      }
      // Write games
      for (var gs of ['nba', 'nhl', 'mlb']) {
        if (d['games_' + gs]) {
          await redisCache.setGames(gs, d['games_' + gs]);
          synced++;
        }
      }
      // Write EV
      if (d.ev && d.ev.length > 0) {
        await redisCache.setEV(d.ev);
        synced++;
      }
      // Write POTD
      if (d.potd) {
        await redisCache.setPOTD(d.potd);
        synced++;
      }
      // Write line movement — built-in tracker (compare current vs previous snapshot)
      var _currentSnapshots = {};
      var allMovements = {};
      for (var mvSport of ['nba', 'nhl', 'mlb']) {
        allMovements[mvSport] = [];
        if (d['props_' + mvSport]) {
          var mvProps = d['props_' + mvSport].props || [];
          for (var mp of mvProps) {
            if (!mp.player || !mp.market || !mp.consensusLine) continue;
            var snapKey = mp.player + '__' + mp.market + '__' + mvSport;
            _currentSnapshots[snapKey] = { line: mp.consensusLine, player: mp.player, market: mp.market, sport: mvSport, game: mp.game };
            // Compare to previous snapshot
            if (_prevLineSnapshots[snapKey] && _prevLineSnapshots[snapKey].line !== mp.consensusLine) {
              var oldLine = _prevLineSnapshots[snapKey].line;
              var newLine = mp.consensusLine;
              var change = Math.abs(newLine - oldLine);
              if (change > 0) {
                allMovements[mvSport].push({
                  player: mp.player, market: mp.market, sport: mvSport, game: mp.game,
                  oldLine: oldLine, newLine: newLine,
                  change: Math.round(change * 10) / 10,
                  direction: newLine > oldLine ? 'up' : 'down',
                });
              }
            }
          }
        }
        // Also merge in any from the external lineMovement module
        if (d.lineHistory) {
          Object.keys(d.lineHistory).forEach(function(key) {
            var entry = d.lineHistory[key];
            if (entry && entry.sport === mvSport && entry.snapshots && entry.snapshots.length >= 2) {
              var first = entry.snapshots[0];
              var last = entry.snapshots[entry.snapshots.length - 1];
              if (first.consensus !== last.consensus) {
                var exists = allMovements[mvSport].find(function(m) { return m.player === entry.player && m.market === entry.market; });
                if (!exists) {
                  allMovements[mvSport].push({ player: entry.player, market: entry.market, sport: mvSport, oldLine: first.consensus, newLine: last.consensus, change: Math.round(Math.abs(last.consensus - first.consensus) * 10) / 10, direction: last.consensus > first.consensus ? 'up' : 'down' });
                }
              }
            }
          });
        }
        allMovements[mvSport].sort(function(a, b) { return b.change - a.change; });
        await redisCache.setMovement(mvSport, { movements: allMovements[mvSport], count: allMovements[mvSport].length, timestamp: Date.now() });
        if (allMovements[mvSport].length > 0) synced++;
      }
      // Update previous snapshots for next cycle
      _prevLineSnapshots = _currentSnapshots;
      var totalMoves = Object.values(allMovements).reduce(function(sum, arr) { return sum + arr.length; }, 0);
      if (totalMoves > 0) console.log("Line movement: detected " + totalMoves + " changes across " + Object.keys(allMovements).length + " sports");
      // Write trending — web server reads data.picks NOT data.trending
      if (d.trending) {
        for (var ts of Object.keys(d.trending)) {
          var tArr = d.trending[ts];
          if (tArr && Array.isArray(tArr) && tArr.length > 0) {
            await redisCache.set("oracle:trending:" + ts, { picks: tArr, count: tArr.length }, 1800);
            synced++;
          }
        }
      }
      // Write accuracy
      if (d.accuracy) {
        await redisCache.setAccuracy(d.accuracy);
        synced++;
      }
      // Write sharp snapshot — include movements from our built-in tracker
      var sharpMovements = [];
      if (allMovements) {
        for (var shSport of Object.keys(allMovements)) {
          sharpMovements = sharpMovements.concat(allMovements[shSport]);
        }
      }
      // Also merge from external lineHistory if we have it
      if (sharpMovements.length === 0 && d.lineHistory) {
        Object.keys(d.lineHistory).forEach(function(key) {
          var entry = d.lineHistory[key];
          if (entry && entry.snapshots && entry.snapshots.length >= 2) {
            var first = entry.snapshots[0], last = entry.snapshots[entry.snapshots.length - 1];
            if (first.consensus !== last.consensus) sharpMovements.push({ player: entry.player, market: entry.market, oldLine: first.consensus, newLine: last.consensus, change: Math.round(Math.abs(last.consensus - first.consensus) * 10) / 10 });
          }
        });
      }
      sharpMovements.sort(function(a, b) { return (b.change || 0) - (a.change || 0); });
      var sharpData = { evBets: d.ev || [], movements: sharpMovements, propsTracked: Object.keys(_currentSnapshots || {}).length, timestamp: new Date().toISOString() };
      await redisCache.set("oracle:sharp_snapshot", sharpData, 1800);
      synced++;

      // ESPN scores — native https (no axios)
      var https = require("https");
      var espnSports = { nba: 'basketball/nba', nhl: 'hockey/nhl', mlb: 'baseball/mlb' };
      for (var [es, ep] of Object.entries(espnSports)) {
        try {
          await new Promise(function(resolve) {
            var sdata = '';
            var sreq = https.get("https://site.api.espn.com/apis/site/v2/sports/" + ep + "/scoreboard", { timeout: 8000 }, function(resp) {
              resp.on('data', function(chunk) { sdata += chunk; });
              resp.on('end', function() { try { redisCache.set("oracle:scores:" + es, JSON.parse(sdata), 300); synced++; } catch(e) {} sdata = null; resolve(); });
            });
            sreq.on('error', function() { resolve(); });
            sreq.on('timeout', function() { sreq.destroy(); resolve(); });
          });
        } catch(e) {}
      }

      // CDL matches — single native http call
      try {
        await new Promise(function(resolve) {
          var cdata = '';
          var creq = http.get("http://localhost:" + PORT + "/api/cdl/matches", { timeout: 10000 }, function(resp) {
            resp.on('data', function(chunk) { cdata += chunk; });
            resp.on('end', function() { try { var p = JSON.parse(cdata); if (p.matches && p.matches.length > 0) { redisCache.set("oracle:cdl_matches", p, 1800); synced++; } } catch(e) {} cdata = null; resolve(); });
          });
          creq.on('error', function() { resolve(); });
          creq.on('timeout', function() { creq.destroy(); resolve(); });
        });
      } catch(e) {}

      // CDL standings — sync from worker
      try {
        await new Promise(function(resolve) {
          var sdata = '';
          var sreq = http.get("http://localhost:" + PORT + "/api/cdl/standings", { timeout: 10000 }, function(resp) {
            resp.on('data', function(chunk) { sdata += chunk; });
            resp.on('end', function() { try { var p = JSON.parse(sdata); if (p && (p.standings || p.groups || p.length > 0)) { redisCache.set("oracle:cdl_standings", p, 3600); synced++; } } catch(e) {} sdata = null; resolve(); });
          });
          sreq.on('error', function() { resolve(); });
          sreq.on('timeout', function() { sreq.destroy(); resolve(); });
        });
      } catch(e) {}

      // CDL props — sync from worker
      try {
        await new Promise(function(resolve) {
          var pdata = '';
          var preq = http.get("http://localhost:" + PORT + "/api/cdl/props", { timeout: 10000 }, function(resp) {
            resp.on('data', function(chunk) { pdata += chunk; });
            resp.on('end', function() { try { var p = JSON.parse(pdata); if (p && ((p.props && p.props.length > 0) || (p.matches && p.matches.length > 0))) { redisCache.set("oracle:cdl_props", p, 1800); synced++; } } catch(e) {} pdata = null; resolve(); });
          });
          preq.on('error', function() { resolve(); });
          preq.on('timeout', function() { preq.destroy(); resolve(); });
        });
      } catch(e) {}

      // Parlay history / accuracy record — sync from parlayBuilder
      try {
        if (parlayBuilder && parlayBuilder.getHistoricalStats) {
          var stats = parlayBuilder.getHistoricalStats();
          if (stats && (stats.totalPicks > 0 || stats.overall.total > 0 || stats.overall.pending > 0)) {
            await redisCache.setAccuracy(stats);
            synced++;
          }
        }
        if (parlayBuilder && parlayBuilder.getPickHistory) {
          var history = parlayBuilder.getPickHistory();
          if (history && history.length > 0) {
            await redisCache.set("oracle:pick_history", history, 86400);
            synced++;
          }
        }
      } catch(e) {}

      // Auto-grader grades — sync to keys web server reads
      try {
        var autoGrader = require("./services/auto-grader");
        if (autoGrader && autoGrader.gradingStats) {
          await redisCache.set("oracle:grading_stats", autoGrader.gradingStats, 86400);
          await redisCache.set("oracle:grading_stats_legacy", autoGrader.gradingStats, 86400);
          synced++;
        }
        if (autoGrader && autoGrader.gradedPicks && autoGrader.gradedPicks.length > 0) {
          await redisCache.set("oracle:graded_picks", autoGrader.gradedPicks, 86400);
          await redisCache.set("oracle:graded_picks_legacy", autoGrader.gradedPicks, 86400);
          synced++;
        }
      } catch(e) {}

      var mem = process.memoryUsage();
      var heapMB = Math.round(mem.heapUsed / 1024 / 1024);
      var rssMB = Math.round(mem.rss / 1024 / 1024);
      console.log("[Redis] Synced " + synced + " entries | Heap: " + heapMB + "MB | RSS: " + rssMB + "MB");
      if (rssMB > 2048) console.warn("[Memory] WARNING: RSS at " + rssMB + "MB");
    } catch(e) {
      console.warn("[Redis] Sync error:", e.message);
    }
  }, 60000); // Every 60 seconds

  // Force garbage collection every 5 minutes to prevent memory creep
  if (global.gc) {
    setInterval(function() {
      var before = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      global.gc();
      var after = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
      console.log("[GC] Manual garbage collection: " + before + "MB → " + after + "MB (freed " + (before - after) + "MB)");
    }, 5 * 60 * 1000);
  }

  // === SCHEDULED RESTART — every 4 hours ===
  // Production pattern: predictable restarts prevent memory leaks from accumulating.
  // All data lives in Redis, so restarts are invisible to users.
  var RESTART_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours
  setTimeout(function() {
    console.log("[SCHEDULER] 4-hour scheduled restart. All data safe in Redis. Back in 30 seconds.");
    // Sync one final time before restarting
    (async function() {
      try {
        if (redisCache && redisCache.isConnected()) {
          console.log("[SCHEDULER] Final Redis sync before restart...");
          // Quick sync of essential data
          for (var sport of ['nba', 'nhl', 'mlb']) {
            try {
              var rawProps = typeof getCachedProps === 'function' ? await getCachedProps(sport) : null;
              if (rawProps && rawProps.props && rawProps.props.length > 0) {
                await redisCache.setProps(sport, { props: rawProps.props, picks: rawProps.props, count: rawProps.props.length, timestamp: Date.now() });
              }
            } catch(e) {}
          }
          if (evEngine && evEngine.cache && evEngine.cache.evBets) await redisCache.setEV(evEngine.cache.evBets);
          if (potd && potd.cache && potd.cache.picks) await redisCache.setPOTD(potd.cache.picks);
          console.log("[SCHEDULER] Final sync complete. Restarting now.");
        }
      } catch(e) {}
      process.exit(0);
    })();
  }, RESTART_INTERVAL);
  console.log("[SCHEDULER] Worker will auto-restart in 4 hours (at " + new Date(Date.now() + RESTART_INTERVAL).toISOString() + ")");

  // === MEMORY WATCHDOG — emergency restart if memory exceeds 3GB before scheduled restart ===
  setInterval(function() {
    var rss = process.memoryUsage().rss;
    var rssMB = Math.round(rss / 1024 / 1024);
    if (rssMB > 3072) {
      console.warn("[WATCHDOG] Memory at " + rssMB + "MB — emergency restart. All data safe in Redis.");
      process.exit(1);
    } else if (rssMB > 2048) {
      console.warn("[WATCHDOG] Memory at " + rssMB + "MB — approaching limit");
      if (global.gc) global.gc();
    }
  }, 60000);

  // Run advanced features every 5 minutes (grading, SGP, bankroll sim, alerts)
  try {
    var features = require("./services/oracle-features");
    setInterval(function() {
      features.runAllFeatures().catch(function(e) { console.warn("[Features] Error:", e.message); });
    }, 5 * 60 * 1000); // Every 5 minutes
    // Also run once after 60 seconds (give caches time to populate)
    setTimeout(function() {
      features.runAllFeatures().catch(function(e) { console.warn("[Features] Initial run error:", e.message); });
    }, 60000);
    console.log("[Features] Auto-grading, SGP, bankroll sim, alerts — running every 5 min");
  } catch(e) {
    console.log("[Features] Not loaded:", e.message);
  }

} catch(e) {
  console.log("[Redis] Not available:", e.message, "— using memory-only mode");
}

dvp.startRefresh();
analytics.startRefresh();
predictionModel.startRefresh();
if (enrichment && enrichment.startCache) {
  enrichment.startCache();
}
if (smartPicks && smartPicks.startRefresh) {
  smartPicks.startRefresh();
}
if (autoGrader && autoGrader.startGrading) {
  autoGrader.startGrading();
}
if (refData && refData.startRefresh) {
  refData.startRefresh();
}
if (evEngine && evEngine.startScanning) {
  // Give EV engine direct access to shared props cache (saves API credits)
  if (evEngine.setDirectFetcher) {
    evEngine.setDirectFetcher(async (sport) => {
      return await getCachedProps(sport);
    });
  }
  evEngine.startScanning();
}
if (sharpTools && sharpTools.startTracking) {
  sharpTools.startTracking();
}
if (potd && potd.startRefresh) {
  potd.startRefresh();
}
if (advancedTools && advancedTools.startScanning) {
  advancedTools.startScanning();
}
if (accuracyBoost && accuracyBoost.startMonitoring) {
  accuracyBoost.startMonitoring();
}

// Start game prediction grader (grades ML/spread/total against ESPN final scores)
try {
  const gameGrader = require("./services/game-grader");
  app.use("/api/game-grades", gameGrader.router);
  gameGrader.startGameGrading(function() {
    return gamePredictions && gamePredictions.gamesCache && gamePredictions.gamesCache['nba'] ? gamePredictions.gamesCache['nba'].games || [] : [];
  });
} catch(e) {
  console.log("Game grader not loaded:", e.message);
}

// ============================================================
// MULTI-API FAILOVER SYSTEM
// Routes between Odds API, SharpAPI, ESPN, PandaScore
// ============================================================
let multiApi = null;
try {
  multiApi = require("./services/multi-api");
  console.log("[MultiAPI] Loaded — Odds API + SharpAPI + ESPN + PandaScore");
} catch(e) {
  console.log("[MultiAPI] Not loaded:", e.message);
}

// Shared props function — all services use this
async function getCachedProps(sport) {
  if (multiApi) {
    return await multiApi.getProps(sport);
  }
  // Fallback to direct Odds API call
  try {
    const { getPlayerProps } = require("./services/props");
    return await getPlayerProps(sport);
  } catch(e) {
    return { props: [] };
  }
}

// API status endpoint — shows health of all data sources
app.get("/api/data-sources", (req, res) => {
  if (multiApi) {
    res.json(multiApi.getStatus());
  } else {
    res.json({ error: "multi-api not loaded" });
  }
});

// Start CDL stats scraper (every 30 min)
scrapeCDLStats().catch(err => console.log("Initial CDL scrape skipped:", err.message));
setInterval(() => scrapeCDLStats().catch(() => {}), 60 * 60 * 1000); // reduced to every 60 min

// Start line movement tracking (every 30 min instead of 15)
lineMovement.startTracking(async (sport) => {
  return await getCachedProps(sport);
});

// Helper functions for trending + discord services — USE CACHE
async function fetchPropsInternal(sport) {
  try {
    if (sport === "cdl") {
      const resp = await fetch(`http://localhost:${PORT}/api/cdl/props`);
      return await resp.json();
    }
    return await getCachedProps(sport);
  } catch (err) {
    console.error(`fetchPropsInternal failed for ${sport}:`, err.message);
    return { props: [] };
  }
}

async function fetchPicksInternal(sport) {
  try {
    const resp = await fetch(`http://localhost:${PORT}/api/props/${sport}/picks`);
    return await resp.json();
  } catch (err) {
    console.error(`fetchPicksInternal failed for ${sport}:`, err.message);
    return { picks: [] };
  }
}

async function getMovementInternal(sport) {
  try {
    const resp = await fetch(`http://localhost:${PORT}/api/movement/${sport}`);
    return await resp.json();
  } catch (err) {
    console.error(`getMovementInternal failed for ${sport}:`, err.message);
    return { props: [] };
  }
}

// Start trending picks refresh (every 10 min)
trendingPicks.startRefresh(fetchPropsInternal, fetchPicksInternal, getMovementInternal);

// Start Discord alerts (every 10 min)
discordAlerts.start(fetchPropsInternal, fetchPicksInternal);

// Start Discord auto-poster — ALL callbacks use direct memory/Redis, ZERO HTTP calls
try {
  const discordPoster = require("./services/discord-poster");
  discordPoster.startPosting(
    // Get picks — direct from smartPicks cache
    async (sport) => {
      try {
        if (smartPicks && smartPicks.picksCache && smartPicks.picksCache[sport]) {
          var cached = smartPicks.picksCache[sport];
          if (cached && cached.picks && cached.picks.length > 0) return { picks: cached.picks };
        }
        return { picks: [] };
      } catch(e) { return { picks: [] }; }
    },
    // Get EV bets — direct from evEngine cache
    async () => {
      try {
        if (evEngine && evEngine.cache && evEngine.cache.evBets && evEngine.cache.evBets.length > 0) {
          return { bets: evEngine.cache.evBets, found: evEngine.cache.evBets.length };
        }
        return { bets: [], found: 0 };
      } catch(e) { return { bets: [], found: 0 }; }
    },
    // Get games — direct from gamePredictions cache
    async () => {
      try {
        if (gamePredictions && gamePredictions.gamesCache) {
          var nbaGames = gamePredictions.gamesCache['nba'];
          if (nbaGames && nbaGames.games && nbaGames.games.length > 0) return { games: nbaGames.games };
          var nhlGames = gamePredictions.gamesCache['nhl'];
          if (nhlGames && nhlGames.games && nhlGames.games.length > 0) return { games: nhlGames.games };
        }
        return { games: [] };
      } catch(e) { return { games: [] }; }
    },
    // Get POTD — direct from potd cache
    async () => {
      try {
        if (potd && potd.cache && potd.cache.picks && potd.cache.picks.pickOfTheDay) {
          var p = potd.cache.picks.pickOfTheDay;
          return { pick: { player: p.player, market: p.market, game: p.game, line: p.line, pick: p.pick, grade: 'A+', confidence: p.convergence || 0, reasoning: p.reasoning }};
        }
        return {};
      } catch(e) { return {}; }
    },
    // Get history — direct from parlayBuilder
    async () => {
      try {
        if (parlayBuilder && parlayBuilder.getHistoricalStats) return parlayBuilder.getHistoricalStats();
        return {};
      } catch(e) { return {}; }
    }
  );
} catch(e) {
  console.log("Discord poster not loaded:", e.message);
}

// === PWA Manifest ===
app.get("/manifest.json", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "manifest.json"));
});

// === Service Worker ===
app.get("/sw.js", (req, res) => {
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(__dirname, "public", "sw.js"));
});

// === Health endpoint ===
app.get("/api/health", (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: "ok", uptime: process.uptime(), timestamp: new Date().toISOString(),
    memory: {
      heapMB: Math.round(mem.heapUsed / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
    },
    services: {
      espn: "active",
      anthropic: process.env.ANTHROPIC_API_KEY ? "configured" : "missing",
      odds_api: process.env.ODDS_API_KEY ? "configured" : "missing",
      pandascore: process.env.PANDASCORE_API_KEY ? "configured" : "missing",
      discord_alerts: process.env.DISCORD_WEBHOOK_URL ? "configured" : "missing",
      prediction_model: "active",
      smart_picks: smartPicks ? "active" : "not loaded",
      auto_grader: autoGrader ? "active" : "not loaded",
      backtester: backtester ? "available" : "not loaded",
      referee_data: refData ? "active" : "not loaded",
      wnba: wnba ? "active" : "not loaded",
      model_tuner: modelTuner ? "available" : "not loaded",
      ev_engine: evEngine ? "active" : "not loaded",
      sharp_tools: sharpTools ? "active" : "not loaded",
      pick_of_the_day: potd ? "active" : "not loaded",
      advanced_tools: advancedTools ? "active" : "not loaded",
      prediction_v2: predV2 ? "active" : "not loaded",
      accuracy_boost: accuracyBoost ? "active" : "not loaded",
      parlay_builder: parlayBuilder ? "active" : "not loaded",
      stability: stability ? "active" : "not loaded",
      game_predictions: gamePredictions ? "active" : "not loaded",
      cdl_predictions: cdlPredictions ? "active" : "not loaded",
      player_headshots: playerHeadshots ? "active" : "not loaded",
      enrichment: enrichment ? "active" : "not loaded",
      multi_odds_provider: multiOdds ? "active" : "not loaded",
      sharp_api: process.env.SHARP_API_KEY ? "configured" : "not configured",
      sharp_routes: sharpRoutes ? "active" : "not loaded",
      redis: redisCache ? (redisCache.isConnected() ? "connected" : "disconnected") : "not loaded",
    },
    providers: multiOdds ? multiOdds.getProviderStatus() : { mode: "single-api" },
  });
});

// === Landing page at root / (inject full nav + updated stats) ===

// Redis health check
app.get("/api/redis/health", async (req, res) => {
  if (!redisCache) return res.json({ status: "not loaded" });
  try {
    const health = await redisCache.healthCheck();
    res.json(health);
  } catch(e) {
    res.json({ status: "error", error: e.message });
  }
});

app.get("/", (req, res) => {
  const landingPath = path.join(__dirname, "public", "landing.html");
  const fs = require("fs");
  try {
    let html = fs.readFileSync(landingPath, "utf8");
    // Inject FAB nav
    try {
      const fabHTML = fs.readFileSync(path.join(__dirname, "public", "fab-nav.html"), "utf8");
      html = html.replace("</body>", fabHTML + "\n</body>");
    } catch(e) {}
    // Inject bot
    try {
      const botHTML = fs.readFileSync(path.join(__dirname, "public", "oracle-bot.html"), "utf8");
      html = html.replace("</body>", botHTML + "\n</body>");
    } catch(e) {}
    res.type("html").send(html);
  } catch (e) {
    res.sendFile(landingPath);
  }
});

// === Universal Nav for all standalone pages ===
const fs = require("fs");
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
      // Inject SEO meta tags if not present
      if (!html.includes('og:title')) {
        var seoTags = '<meta name="robots" content="index, follow">' +
          '<meta property="og:type" content="website">' +
          '<meta property="og:site_name" content="ORACLE — AI Sports Predictions">' +
          '<meta property="og:url" content="https://www.oraclepredictapp.com' + activeLink + '">' +
          '<meta property="og:image" content="https://www.oraclepredictapp.com/icons/icon-512.png">' +
          '<meta name="twitter:card" content="summary">' +
          '<meta name="twitter:site" content="@oraclepredicts">' +
          '<link rel="manifest" href="/manifest.json">' +
          '<meta name="theme-color" content="#38bdf8">' +
          '<link rel="canonical" href="https://www.oraclepredictapp.com' + activeLink + '">';
        html = html.replace('</head>', seoTags + '\n</head>');
      }
      // Inject service worker registration
      if (!html.includes('serviceWorker')) {
        var swScript = '<script>if("serviceWorker" in navigator){navigator.serviceWorker.register("/sw.js").catch(function(){})}</script>';
        html = html.replace('</body>', swScript + '\n</body>');
      }
      // Replace existing nav with universal nav
      const navRegex = /<nav[^>]*>[\s\S]*?<\/nav>/i;
      if (navRegex.test(html)) {
        html = html.replace(navRegex, activeNav);
      } else {
        html = html.replace(/<body[^>]*>/i, (match) => match + '\n' + activeNav);
      }
      // Inject bot before </body>
      try {
        const botHTML = fs.readFileSync(path.join(__dirname, "public", "oracle-bot.html"), "utf8");
        html = html.replace("</body>", botHTML + "\n</body>");
      } catch(e) {}
      // Inject floating navigation menu
      try {
        const fabHTML = fs.readFileSync(path.join(__dirname, "public", "fab-nav.html"), "utf8");
        html = html.replace("</body>", fabHTML + "\n</body>");
      } catch(e) {}
      // Inject design system (live ticker, glass effects, team logos)
      try {
        const designHTML = fs.readFileSync(path.join(__dirname, "public", "oracle-design-system.html"), "utf8");
        html = html.replace("</body>", designHTML + "\n</body>");
      } catch(e) {}
      res.type("html").send(html);
    } catch (e) {
      res.sendFile(filePath);
    }
  };
}

// === How It Works page ===
app.get("/how-it-works", serveWithNav(path.join(__dirname, "public", "how-it-works.html"), "/how-it-works"));

// === Sharp Dashboard ===
app.get("/sharp", serveWithNav(path.join(__dirname, "public", "sharp-dashboard.html"), "/sharp"));

// === First Bet Walkthrough ===
app.get("/start", serveWithNav(path.join(__dirname, "public", "first-bet.html"), "/start"));

// === Pick of the Day ===
app.get("/pick", serveWithNav(path.join(__dirname, "public", "pick-of-the-day.html"), "/pick"));

// === Parlay Builder ===
app.get("/parlay", serveWithNav(path.join(__dirname, "public", "parlay-builder.html"), "/parlay"));

// === Privacy Policy (required for App Store) ===
app.get("/privacy", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "privacy.html"));
});

// === Game Predictions ===
app.get("/games", serveWithNav(path.join(__dirname, "public", "game-predictions.html"), "/games"));

// === Accuracy Record ===
app.get("/record", serveWithNav(path.join(__dirname, "public", "accuracy-record.html"), "/record"));

// === Share Pick Card ===
app.get("/share", serveWithNav(path.join(__dirname, "public", "share-card.html"), "/share"));

// === Futures Predictions ===
app.get("/futures", serveWithNav(path.join(__dirname, "public", "futures.html"), "/futures"));

// === Bankroll Tracker ===
app.get("/bankroll", serveWithNav(path.join(__dirname, "public", "bankroll.html"), "/bankroll"));

// === Consensus Picks ===
app.get("/consensus", serveWithNav(path.join(__dirname, "public", "consensus.html"), "/consensus"));

// === Player Profile ===
app.get("/player", serveWithNav(path.join(__dirname, "public", "player-profile.html"), "/player"));

// === Props Explorer ===
app.get("/props", serveWithNav(path.join(__dirname, "public", "props-explorer.html"), "/props"));

// === Discrepancies ===
app.get("/discrepancies", serveWithNav(path.join(__dirname, "public", "discrepancies.html"), "/discrepancies"));

// === React SPA routes (inject help + sharp buttons) ===
const helpButtonPath = path.join(__dirname, "public", "help-button.html");
let helpButtonHTML = "";
try {
  helpButtonHTML = require("fs").readFileSync(helpButtonPath, "utf8");
} catch (e) {
  console.log("help-button.html not found, app served without help button");
}

function serveAppWithHelp(req, res) {
  const indexPath = path.join(__dirname, "dist", "index.html");
  const botPath = path.join(__dirname, "public", "oracle-bot.html");
  const fabPath = path.join(__dirname, "public", "fab-nav.html");
  const fs = require("fs");
  try {
    let html = fs.readFileSync(indexPath, "utf8");
    // Read help button + bot + FAB fresh each time
    const helpHTML = fs.readFileSync(helpButtonPath, "utf8");
    let botHTML = "";
    try { botHTML = fs.readFileSync(botPath, "utf8"); } catch(e) {}
    let fabHTML = "";
    try { fabHTML = fs.readFileSync(fabPath, "utf8"); } catch(e) {}
    let designHTML = "";
    try { designHTML = fs.readFileSync(path.join(__dirname, "public", "oracle-design-system.html"), "utf8"); } catch(e) {}
    html = html.replace("</body>", helpHTML + "\n" + botHTML + "\n" + fabHTML + "\n" + designHTML + "\n<style>.tab-bar,.fab-nav,.oracle-fab-group{display:none!important}</style>\n<script>!function(){var currentSport=null;function init(){var sb=document.querySelector('.sports-bar');if(!sb){setTimeout(init,500);return}var btns=sb.querySelectorAll('button');btns.forEach(function(b){if(b.className.indexOf('active')>=0||b.getAttribute('aria-selected')==='true'){currentSport=b.textContent.trim()}});sb.addEventListener('click',function(e){var btn=e.target.closest('button');if(!btn)return;var clicked=btn.textContent.trim();if(currentSport&&clicked!==currentSport){currentSport=clicked;setTimeout(function(){window.location.reload()},150)}else if(!currentSport){currentSport=clicked}},true)}setTimeout(init,1500)}()</script>\n</body>");
    res.type("html").send(html);
  } catch (e) {
    res.sendFile(indexPath);
  }
}

app.get("/app", serveAppWithHelp);
app.get("/app/", serveAppWithHelp);
app.get("/app/*", (req, res, next) => {
  // Only serve index.html for non-asset requests
  if (req.path.includes('.')) return next();
  serveAppWithHelp(req, res);
});

// === Static files ===
app.use(express.static(path.join(__dirname, "public")));
app.use("/app", express.static(path.join(__dirname, "dist")));
app.use("/assets", express.static(path.join(__dirname, "dist", "assets")));

// === Fallback static ===
app.use(express.static(path.join(__dirname, "dist")));

// === Error handling ===
app.use((err, req, res, next) => {
  console.error("Server error:", err.message);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

const server = app.listen(PORT, () => {
  console.log(`ORACLE v3 running on port ${PORT} — 18-factor model`);
  console.log(`[Stability] Server ready. Caches will fully populate within 2 minutes.`);
});

// Prevent crashes from killing the server
process.on('uncaughtException', function(err) {
  console.error('[CRASH PREVENTED] Uncaught exception:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', function(reason) {
  console.error('[CRASH PREVENTED] Unhandled rejection:', reason);
});
