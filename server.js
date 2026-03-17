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

// === Health endpoint ===
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok", uptime: process.uptime(), timestamp: new Date().toISOString(),
    services: {
      espn: "active",
      anthropic: process.env.ANTHROPIC_API_KEY ? "configured" : "missing",
      odds_api: process.env.ODDS_API_KEY ? "configured" : "missing",
      pandascore: process.env.PANDASCORE_API_KEY ? "configured" : "missing",
      discord_alerts: process.env.DISCORD_WEBHOOK_URL ? "configured" : "missing",
      prediction_model: "active",
      smart_picks: smartPicks ? "active" : "not loaded",
      enrichment: enrichment ? "active" : "not loaded",
    },
  });
});

// === Landing page at root / ===
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "landing.html"));
});

// === Static files ===
app.use(express.static(path.join(__dirname, "public")));
app.use("/app", express.static(path.join(__dirname, "dist")));
app.use("/assets", express.static(path.join(__dirname, "dist", "assets")));

// === React SPA routes ===
app.get("/app", (req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});
app.get("/app/*", (req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

// === Fallback static ===
app.use(express.static(path.join(__dirname, "dist")));

// === Error handling ===
app.use((err, req, res, next) => {
  console.error("Server error:", err.message);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

app.listen(PORT, () => console.log(`ORACLE v2 running on port ${PORT}`));
