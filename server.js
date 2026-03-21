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

  // Sync memory caches TO Redis every 30 seconds
  setInterval(async function() {
    try {
      var synced = 0;
      
      // Sync RAW props from Odds API (the actual props with odds from all books)
      for (const sport of ['nba', 'nhl', 'mlb', 'nfl']) {
        try {
          // Use the same function that serves /api/props/:sport
          var rawProps = null;
          if (typeof getCachedProps === 'function') {
            rawProps = await getCachedProps(sport);
          }
          if (rawProps && rawProps.props && rawProps.props.length > 0) {
            await redisCache.setProps(sport, { props: rawProps.props, picks: rawProps.props, count: rawProps.props.length, timestamp: Date.now() });
            synced++;
          }
        } catch(e) {}
      }

      // Sync smart picks (AI-analyzed picks with grades)
      if (smartPicks && smartPicks.picksCache) {
        for (const sport of Object.keys(smartPicks.picksCache)) {
          const cached = smartPicks.picksCache[sport];
          const items = (cached && cached.picks) || (cached && cached.props) || [];
          if (items.length > 0) {
            await redisCache.setPicks(sport, { picks: items, timestamp: cached.timestamp || Date.now() });
            synced++;
          }
        }
      }
      // Sync games
      if (gamePredictions && gamePredictions.gamesCache) {
        for (const sport of Object.keys(gamePredictions.gamesCache)) {
          const cached = gamePredictions.gamesCache[sport];
          if (cached && cached.games && cached.games.length > 0) {
            await redisCache.setGames(sport, cached);
            synced++;
          }
        }
      }
      // Sync EV bets — direct from evEngine cache (NO HTTP)
      if (evEngine && evEngine.cache && evEngine.cache.evBets && evEngine.cache.evBets.length > 0) {
        await redisCache.setEV(evEngine.cache.evBets);
        synced++;
      }
      // Sync sharp snapshot — build directly from memory (NO HTTP)
      try {
        var sharpData = {
          evBets: evEngine && evEngine.cache && evEngine.cache.evBets ? evEngine.cache.evBets : [],
          movements: [],
          timestamp: new Date().toISOString(),
        };
        if (lineMovement && lineMovement.getSnapshot) {
          sharpData.movements = lineMovement.getSnapshot('nba') || [];
        }
        if (sharpData.evBets.length > 0 || sharpData.movements.length > 0) {
          await redisCache.set("oracle:sharp_snapshot", sharpData, 1800);
          synced++;
        }
      } catch(e) {}
      // Sync line movement — direct from lineMovement module (NO HTTP)
      if (lineMovement && lineMovement.getSnapshot) {
        for (var mvSport of ['nba', 'nhl', 'mlb', 'nfl']) {
          try {
            var snap = lineMovement.getSnapshot(mvSport);
            if (snap && snap.length > 0) {
              await redisCache.setMovement(mvSport, { movements: snap, count: snap.length, timestamp: Date.now() });
              synced++;
            }
          } catch(e) {}
        }
      }
      // Sync POTD — direct from potd cache (NO HTTP)
      if (potd && potd.cache && potd.cache.picks) {
        await redisCache.setPOTD(potd.cache.picks);
        synced++;
      }
      // Sync accuracy / pick history
      if (parlayBuilder) {
        try {
          const stats = parlayBuilder.getHistoricalStats();
          if (stats) { await redisCache.setAccuracy(stats); synced++; }
          const history = parlayBuilder.getPickHistory ? parlayBuilder.getPickHistory() : null;
          if (history) { await redisCache.setPickHistory(history); synced++; }
        } catch(e) {}
      }
      // Sync game grades
      try {
        const gameGrader = require("./services/game-grader");
        if (gameGrader && gameGrader.getAccuracy) {
          const grades = gameGrader.getAccuracy();
          if (grades) { await redisCache.setGameGrades(grades); synced++; }
        }
      } catch(e) {}

      // Sync live scores for ticker (ESPN)
      try {
        const axios = require("axios");
        const sports = { nba: 'basketball/nba', nhl: 'hockey/nhl', mlb: 'baseball/mlb', nfl: 'football/nfl' };
        for (const [sport, espnPath] of Object.entries(sports)) {
          try {
            const resp = await axios.get("https://site.api.espn.com/apis/site/v2/sports/" + espnPath + "/scoreboard", { timeout: 8000 });
            if (resp.data) {
              await redisCache.set("oracle:scores:" + sport, resp.data, 300); // 5 min TTL
              synced++;
            }
          } catch(e) {}
        }
      } catch(e) {}

      // Sync CDL matches — direct from cdlPredictions module (NO HTTP)
      try {
        if (cdlPredictions && cdlPredictions.cache && cdlPredictions.cache.matches) {
          var cdlData = cdlPredictions.cache.matches;
          if (cdlData && cdlData.length > 0) {
            await redisCache.set("oracle:cdl_matches", { available: true, matches: cdlData, liveCount: 0, upcomingCount: cdlData.filter(function(m){return m.status==='upcoming'}).length, recentCount: cdlData.filter(function(m){return m.status==='completed'}).length }, 1800);
            synced++;
          }
        }
      } catch(e) {
        // Fallback: try the esports module
        try {
          var esportsModule = require("./services/esports");
          if (esportsModule && esportsModule.getMatches) {
            var matches = await esportsModule.getMatches('cod');
            if (matches && matches.length > 0) {
              await redisCache.set("oracle:cdl_matches", { available: true, matches: matches }, 1800);
              synced++;
            }
          }
        } catch(e2) {}
      }

      // Sync DVP data
      try {
        if (dvp && dvp.getSmashSpots) {
          for (var dvpSport of ['nba']) {
            var smashData = dvp.getSmashSpots(dvpSport);
            if (smashData) {
              await redisCache.set("oracle:dvp:" + dvpSport, { smash: smashData, matchups: smashData }, 1800);
              synced++;
            }
          }
        }
      } catch(e) {}
      
      if (synced > 0) {
        console.log("[Redis] Synced " + synced + " cache entries");
      }
    } catch(e) {
      // Silent fail — Redis sync is best-effort
    }
  }, 60000); // Every 60 seconds (was 30s — reduced to lower memory pressure)

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

// Start Discord auto-poster (posts picks, EV, games, POTD, results to channels)
try {
  const discordPoster = require("./services/discord-poster");
  discordPoster.startPosting(
    async (sport) => {
      try {
        if (smartPicks && smartPicks.picksCache) {
          var cached = smartPicks.picksCache[sport];
          if (cached && cached.picks && cached.picks.length > 0) return { picks: cached.picks };
        }
        const posterAxios = require("axios");
        const r = await posterAxios.get(`http://localhost:${PORT}/api/props/${sport}/picks`, { timeout: 10000 });
        return r.data;
      } catch(e) { return { picks: [] }; }
    },
    async () => {
      try {
        if (evEngine && evEngine.scanForEV) {
          const bets = await evEngine.scanForEV('nba');
          return { bets: bets || [], found: bets ? bets.length : 0 };
        }
        const posterAxios = require("axios");
        const r = await posterAxios.get(`http://localhost:${PORT}/api/ev/bets?minEdge=0`, { timeout: 10000 });
        return r.data;
      } catch(e) { return { bets: [] }; }
    },
    async () => {
      try {
        // Try cache first
        if (gamePredictions && gamePredictions.getCachedGames) {
          var cached = gamePredictions.getCachedGames('nba') || gamePredictions.getCachedGames('nhl');
          if (cached && cached.length > 0) return { games: cached };
        }
        // If no cache, fetch directly from Odds API and analyze
        if (gamePredictions && gamePredictions.analyzeGame && process.env.ODDS_API_KEY) {
          const posterAxios = require("axios");
          const ODDS_KEY = process.env.ODDS_API_KEY;
          // Fetch ESPN data + odds in parallel
          const [espnTeams, espnInjuries, b2bTeams, oddsResp] = await Promise.all([
            gamePredictions.fetchESPNTeams ? gamePredictions.fetchESPNTeams('nba') : Promise.resolve(null),
            gamePredictions.fetchESPNInjuries ? gamePredictions.fetchESPNInjuries('nba') : Promise.resolve({}),
            gamePredictions.fetchYesterdayGames ? gamePredictions.fetchYesterdayGames('nba') : Promise.resolve({}),
            posterAxios.get('https://api.the-odds-api.com/v4/sports/basketball_nba/odds', {
              params: { apiKey: ODDS_KEY, regions: 'us,us2', markets: 'spreads,totals,h2h', oddsFormat: 'american' },
              timeout: 15000,
            }),
          ]);
          const games = (oddsResp.data || []).map(g => gamePredictions.analyzeGame({
            id: g.id, homeTeam: g.home_team, awayTeam: g.away_team, commenceTime: g.commence_time,
            bookmakers: (g.bookmakers || []).map(b => ({ title: b.title, key: b.key, markets: b.markets })),
          }, 'nba', espnTeams, espnInjuries, b2bTeams));
          // Cache them for future use
          if (gamePredictions.gamesCache) {
            gamePredictions.gamesCache['nba'] = { games: games, timestamp: Date.now() };
          }
          console.log('[Discord] Fetched ' + games.length + ' NBA games directly from Odds API');
          return { games: games };
        }
        return { games: [] };
      } catch(e) { console.warn('[Discord] Games fetch error:', e.message); return { games: [] }; }
    },
    async () => {
      try {
        var potdData = null;
        // Try cache first (populated by startRefresh at 90sec)
        if (potd && potd.cache && potd.cache.picks && potd.cache.picks.pickOfTheDay) {
          potdData = potd.cache.picks.pickOfTheDay;
        }
        // Fallback: generate fresh
        if (!potdData && potd && potd.generatePickOfTheDay) {
          var potdResult = await potd.generatePickOfTheDay();
          potdData = potdResult ? potdResult.pickOfTheDay : null;
        }
        if (potdData) {
          return { pick: {
            player: potdData.player,
            market: potdData.market,
            game: potdData.game,
            line: potdData.line,
            pick: potdData.pick,
            grade: 'A+',
            confidence: potdData.convergence || 0,
            projection: potdData.analytics ? potdData.analytics.seasonAvg : null,
            hitRate: potdData.analytics ? potdData.analytics.hitRate : null,
            bestBook: potdData.bestBook ? potdData.bestBook.book : null,
            reasoning: potdData.reasoning,
          }};
        }
        return {};
      } catch(e) { console.warn('[Discord] POTD fetch error:', e.message); return {}; }
    },
    async () => {
      try {
        const { getHistoricalStats } = require("./services/parlay-builder");
        if (getHistoricalStats) return getHistoricalStats();
        const posterAxios = require("axios");
        const r = await posterAxios.get(`http://localhost:${PORT}/api/parlay/history`, { timeout: 10000 });
        return r.data;
      } catch(e) { return {}; }
    }
  );
} catch(e) {
  console.log("Discord poster not loaded:", e.message, e.stack?.split('\n')[1]);
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
