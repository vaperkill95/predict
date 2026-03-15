require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const path = require("path");

const sportsRoutes = require("./routes/sports");
const predictionsRoutes = require("./routes/predictions");
const oddsRoutes = require("./routes/odds");
const cdlRoutes = require("./routes/cdl");
const propsRoutes = require("./routes/props");
const liveRoutes = require("./routes/live");
const cdlPropsRoutes = require("./routes/cdl-props");
const { scrapeCDLStats } = require("./services/cdl-stats-scraper");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json());
app.use(cors({ origin: process.env.CLIENT_URL || "*", credentials: true }));
app.use("/api/", rateLimit({ windowMs: 15 * 60 * 1000, max: 500, message: { error: "Rate limited" } }));

app.use("/api/sports", sportsRoutes);
app.use("/api/predictions", predictionsRoutes);
app.use("/api/odds", oddsRoutes);
app.use("/api/cdl", cdlRoutes);
app.use("/api/props", propsRoutes);
app.use("/api/live", liveRoutes);
app.use("/api/cdl", cdlPropsRoutes);

// Start CDL stats scraper (every 30 min)
scrapeCDLStats().catch(err => console.log("Initial CDL scrape skipped:", err.message));
setInterval(() => scrapeCDLStats().catch(() => {}), 30 * 60 * 1000);

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok", uptime: process.uptime(), timestamp: new Date().toISOString(),
    services: {
      espn: "active",
      anthropic: process.env.ANTHROPIC_API_KEY ? "configured" : "missing",
      odds_api: process.env.ODDS_API_KEY ? "configured" : "missing",
      pandascore: process.env.PANDASCORE_API_KEY ? "configured" : "missing",
    },
  });
});

app.use(express.static(path.join(__dirname, "dist")));
app.get("*", (req, res) => { res.sendFile(path.join(__dirname, "dist", "index.html")); });

app.use((err, req, res, next) => {
  console.error("Server error:", err.message);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

app.listen(PORT, () => console.log(`⟁ ORACLE v2 running on port ${PORT}`));
