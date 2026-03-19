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

const app = express();
const PORT = process.env.PORT || 3001;

// === Middleware ===
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json());
app.use(cors({ origin: process.env.CLIENT_URL || "*", credentials: true }));
app.use("/api/", rateLimit({ windowMs: 15 * 60 * 1000, max: 500, message: { error: "Rate limited" } }));

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

// === Start services ===
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

// Start CDL stats scraper (every 30 min)
scrapeCDLStats().catch(err => console.log("Initial CDL scrape skipped:", err.message));
setInterval(() => scrapeCDLStats().catch(() => {}), 30 * 60 * 1000);

// Start line movement tracking (every 15 min)
lineMovement.startTracking(async (sport) => {
  try {
    const { getPlayerProps } = require("./services/props");
    return await getPlayerProps(sport);
  } catch (err) {
    console.error(`Movement: failed to fetch ${sport}:`, err.message);
    return { props: [] };
  }
});

// Helper functions for trending + discord services
async function fetchPropsInternal(sport) {
  try {
    if (sport === "cdl") {
      const resp = await fetch(`http://localhost:${PORT}/api/cdl/props`);
      return await resp.json();
    }
    const resp = await fetch(`http://localhost:${PORT}/api/props/${sport}`);
    return await resp.json();
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

// === PWA Manifest ===
app.get("/manifest.json", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "manifest.json"));
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
      enrichment: enrichment ? "active" : "not loaded",
    },
  });
});

// === Landing page at root / (inject full nav + updated stats) ===
app.get("/", (req, res) => {
  const landingPath = path.join(__dirname, "public", "landing.html");
  const fs = require("fs");
  try {
    let html = fs.readFileSync(landingPath, "utf8");
    const navLinks = '<a href="/pick" style="color:#f59e0b;font-size:14px;font-weight:700;text-decoration:none;padding:10px 16px;border-radius:8px;transition:all 0.2s;background:rgba(245,158,11,0.1);">🏆 POTD</a>\n    <a href="/games" style="color:#10b981;font-size:14px;font-weight:700;text-decoration:none;padding:10px 16px;border-radius:8px;transition:all 0.2s;background:rgba(16,185,129,0.1);">🏟️ Games</a>\n    <a href="/parlay" style="color:#a78bfa;font-size:14px;font-weight:700;text-decoration:none;padding:10px 16px;border-radius:8px;transition:all 0.2s;background:rgba(167,139,250,0.1);">🎲 Parlay</a>\n    <a href="/sharp" style="color:#94a3b8;font-size:14px;font-weight:500;text-decoration:none;padding:10px 16px;border-radius:8px;transition:all 0.2s;">⚡ Sharp</a>\n    <a href="/how-it-works" style="color:#94a3b8;font-size:14px;font-weight:500;text-decoration:none;padding:10px 16px;border-radius:8px;transition:all 0.2s;">Guide</a>';
    html = html.replace(
      '<a href="/app/" class="nav-cta">',
      navLinks + '\n    <a href="/app/" class="nav-cta">'
    );
    // Update stats: 8+ sportsbooks → 20+
    html = html.replace(/8\+/g, '20+');
    html = html.replace('8+ sportsbooks compared', '20+ sportsbooks compared');
    html = html.replace('Player props from 8+ sportsbooks', 'Player props from 20+ sportsbooks');
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
<a href="/games" style="font-size:12px;color:#94a3b8;font-weight:500;padding:5px 8px;border-radius:6px;text-decoration:none;">Games</a>
<a href="/app/" style="font-size:12px;color:#94a3b8;font-weight:500;padding:5px 8px;border-radius:6px;text-decoration:none;">App</a>
<a href="/parlay" style="font-size:12px;color:#94a3b8;font-weight:500;padding:5px 8px;border-radius:6px;text-decoration:none;">Parlay</a>
<a href="/sharp" style="font-size:12px;color:#94a3b8;font-weight:500;padding:5px 8px;border-radius:6px;text-decoration:none;">Sharp</a>
<a href="/how-it-works" style="font-size:12px;color:#94a3b8;font-weight:500;padding:5px 8px;border-radius:6px;text-decoration:none;">Guide</a>
<a href="/start" style="font-size:12px;color:#94a3b8;font-weight:500;padding:5px 8px;border-radius:6px;text-decoration:none;">Start</a>
</div></div></nav>`;

function serveWithNav(filePath, activeLink) {
  return (req, res) => {
    try {
      let html = fs.readFileSync(filePath, "utf8");
      // Replace existing nav with universal nav
      const navRegex = /<nav[^>]*>[\s\S]*?<\/nav>/i;
      if (navRegex.test(html)) {
        const activeNav = UNIVERSAL_NAV.replace(
          `href="${activeLink}"`,
          `href="${activeLink}" style="font-size:12px;color:#f1f5f9;font-weight:700;padding:5px 8px;border-radius:6px;text-decoration:none;background:#1a2236;"`
        );
        html = html.replace(navRegex, activeNav);
      }
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
  if (helpButtonHTML) {
    const fs = require("fs");
    try {
      let html = fs.readFileSync(indexPath, "utf8");
      html = html.replace("</body>", helpButtonHTML + "\n</body>");
      res.type("html").send(html);
    } catch (e) {
      res.sendFile(indexPath);
    }
  } else {
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
  if (stability) {
    stability.init(app, server);
  }
});
