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
app.use("/api/predictions", predictionsRoutes);
app.use("/api/odds", oddsRoutes);
app.use("/api/cdl", cdlRoutes);
app.use("/api/dvp", dvp.router);
app.use("/api/esports", esports.router);
app.use("/api/analytics", analytics.router);
app.use("/api/predict", predictionModel.router);
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
      enrichment: enrichment ? "active" : "not loaded",
    },
  });
});

// === Landing page at root / (inject How It Works + Sharp Tools links) ===
app.get("/", (req, res) => {
  const landingPath = path.join(__dirname, "public", "landing.html");
  const fs = require("fs");
  try {
    let html = fs.readFileSync(landingPath, "utf8");
    const navLinks = '<a href="/pick" style="color:#f59e0b;font-size:14px;font-weight:700;text-decoration:none;padding:10px 16px;border-radius:8px;transition:all 0.2s;background:rgba(245,158,11,0.1);">🏆 Pick of the Day</a>\n    <a href="/start" style="color:#10b981;font-size:14px;font-weight:700;text-decoration:none;padding:10px 16px;border-radius:8px;transition:all 0.2s;background:rgba(16,185,129,0.1);">🎯 Start Here</a>\n    <a href="/how-it-works" style="color:#94a3b8;font-size:14px;font-weight:500;text-decoration:none;padding:10px 16px;border-radius:8px;transition:all 0.2s;">How It Works</a>\n    <a href="/sharp" style="color:#94a3b8;font-size:14px;font-weight:500;text-decoration:none;padding:10px 16px;border-radius:8px;transition:all 0.2s;">⚡ Sharp Tools</a>';
    html = html.replace(
      '<a href="/app/" class="nav-cta">',
      navLinks + '\n    <a href="/app/" class="nav-cta">'
    );
    res.type("html").send(html);
  } catch (e) {
    res.sendFile(landingPath);
  }
});

// === How It Works page ===
app.get("/how-it-works", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "how-it-works.html"));
});

// === Sharp Dashboard ===
app.get("/sharp", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "sharp-dashboard.html"));
});

// === First Bet Walkthrough ===
app.get("/start", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "first-bet.html"));
});

// === Pick of the Day ===
app.get("/pick", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "pick-of-the-day.html"));
});

// === Parlay Builder ===
app.get("/parlay", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "parlay-builder.html"));
});

// === Privacy Policy (required for App Store) ===
app.get("/privacy", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "privacy.html"));
});

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
