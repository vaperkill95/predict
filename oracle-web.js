/**
 * oracle-web.js — Lightweight Web Server
 * 
 * ONLY serves pages and reads from Redis. No API calls, no background jobs.
 * Starts in 2 seconds. Never crashes from heavy work.
 * 
 * The worker (server.js) handles ALL heavy lifting and writes to Redis.
 * This server reads from Redis and serves pages to users.
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

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.json());
app.use(cors({ origin: "*", credentials: true }));

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
  });
});

app.get("/api/redis/health", async (req, res) => {
  try { res.json(await redisCache.healthCheck()); } catch(e) { res.json({ status: "error", error: e.message }); }
});

// Props
app.get("/api/props/:sport", async (req, res) => {
  const data = await redisCache.getProps(req.params.sport);
  if (data) {
    const props = data.props || data.picks || [];
    res.json({ props: props, count: props.length, available: true, source: "redis" });
  } else {
    res.json({ props: [], count: 0, available: true, source: "redis-empty", message: "No props right now. Check back closer to game time." });
  }
});

// Smart Picks
app.get("/api/props/:sport/picks", async (req, res) => {
  const data = await redisCache.getPicks(req.params.sport);
  if (data) {
    res.json(data);
  } else {
    res.json({ picks: [], count: 0 });
  }
});

// Game Predictions
app.get("/api/games/:sport", async (req, res) => {
  const data = await redisCache.getGames(req.params.sport);
  if (data) {
    res.json({ games: data.games || [], count: (data.games || []).length, source: "redis" });
  } else {
    res.json({ games: [], count: 0, source: "empty" });
  }
});

// EV Bets
app.get("/api/ev/bets", async (req, res) => {
  const data = await redisCache.getEV();
  const minEdge = parseFloat(req.query.minEdge) || 0;
  if (data && Array.isArray(data)) {
    const filtered = minEdge > 0 ? data.filter(b => (b.edgePercent || 0) >= minEdge) : data;
    res.json({ bets: filtered, found: filtered.length });
  } else {
    res.json({ bets: [], found: 0 });
  }
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

// Accuracy / History
app.get("/api/parlay/history", async (req, res) => {
  const data = await redisCache.getAccuracy();
  if (data) {
    res.json(data);
  } else {
    res.json({ overall: { total: 0, hits: 0, misses: 0, hitRate: 0, pending: 0 }, recentPicks: [] });
  }
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

// Sports scores — read from Redis ticker cache
app.get("/api/sports/scores/:sport", async (req, res) => {
  const data = await redisCache.get("oracle:scores:" + req.params.sport);
  if (data) { res.json(data); }
  else { res.json({ games: [], sport: req.params.sport }); }
});

// AI Predict — read cached prediction or return processing message
app.post("/api/predictions/game", async (req, res) => {
  const body = req.body || {};
  const key = "oracle:prediction:" + (body.homeTeam || "") + ":" + (body.awayTeam || "");
  const cached = await redisCache.get(key);
  if (cached) { res.json(cached); }
  else {
    // Return the game predictions data which has predictions embedded
    const sport = body.sport || "nba";
    const games = await redisCache.getGames(sport);
    if (games && games.games) {
      const match = games.games.find(function(g) {
        return (g.homeTeam === body.homeTeam || g.homeAbbr === body.homeTeam) &&
               (g.awayTeam === body.awayTeam || g.awayAbbr === body.awayTeam);
      });
      if (match && match.predictions) { return res.json(match.predictions); }
    }
    res.json({ error: "Prediction not available yet — worker is processing", retryAfter: 30 });
  }
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
app.get("/api/cdl/props", async (req, res) => {
  const data = await redisCache.get("oracle:cdl_props");
  res.json(data || { props: [], count: 0 });
});

// Trending
app.get("/api/trending/:sport", async (req, res) => {
  const data = await redisCache.get("oracle:trending:" + req.params.sport);
  res.json(data || { trending: [], count: 0 });
});

// Player headshots — proxy to ESPN CDN
app.get("/api/headshots/:player", (req, res) => {
  res.json({ url: null, source: "not-cached" });
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

// Bot API
app.post("/api/bot/ask", async (req, res) => {
  res.json({ answer: "I'm connecting to the AI engine. Try again in a moment, or use the quick buttons below for instant answers!" });
});

// Sharp snapshot
app.get("/api/sharp/snapshot", async (req, res) => {
  const ev = await redisCache.getEV();
  const movement = await redisCache.getMovement("nba");
  res.json({
    evBets: ev || [],
    movements: movement ? movement.movements || [] : [],
    timestamp: new Date().toISOString(),
  });
});

// Catch-all for any missing /api/ routes — return empty instead of 404
app.all("/api/*", (req, res) => {
  res.json({ available: false, message: "This endpoint is served by the worker" });
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
    html = html.replace("</body>", helpButtonHTML + "\n" + botHTML + "\n" + fabHTML + "\n" + designHTML + "\n<style>.tab-bar,.fab-nav,.oracle-fab-group{display:none!important}</style>\n<script>!function(){var currentSport=null;function init(){var sb=document.querySelector('.sports-bar');if(!sb){setTimeout(init,500);return}var btns=sb.querySelectorAll('button');btns.forEach(function(b){if(b.className.indexOf('active')>=0||b.getAttribute('aria-selected')==='true'){currentSport=b.textContent.trim()}});sb.addEventListener('click',function(e){var btn=e.target.closest('button');if(!btn)return;var clicked=btn.textContent.trim();if(currentSport&&clicked!==currentSport){currentSport=clicked;setTimeout(function(){window.location.reload()},150)}else if(!currentSport){currentSport=clicked}},true)}setTimeout(init,1500)}()</script>\n</body>");
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
