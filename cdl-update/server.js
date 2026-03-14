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

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json());
app.use(cors({ origin: process.env.CLIENT_URL || "*", credentials: true }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: "Too many requests, please try again later." },
});
app.use("/api/", limiter);

// API Routes
app.use("/api/sports", sportsRoutes);
app.use("/api/predictions", predictionsRoutes);
app.use("/api/odds", oddsRoutes);
app.use("/api/cdl", cdlRoutes);

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    services: {
      espn: "active",
      anthropic: process.env.ANTHROPIC_API_KEY ? "configured" : "missing",
      odds_api: process.env.ODDS_API_KEY ? "configured" : "missing",
      pandascore: process.env.PANDASCORE_API_KEY ? "configured" : "missing",
    },
  });
});

// Serve React frontend (built files in /dist)
app.use(express.static(path.join(__dirname, "dist")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

// Error handling
app.use((err, req, res, next) => {
  console.error("Server error:", err.message);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`⟁ ORACLE running on port ${PORT}`);
});
