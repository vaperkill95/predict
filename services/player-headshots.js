/**
 * Player Headshots — ORACLE
 * 
 * Looks up ESPN player IDs by name and returns headshot image URLs.
 * Caches all lookups to avoid repeated API calls.
 * 
 * ESPN headshot URL format:
 * https://a.espncdn.com/combiner/i?img=/i/headshots/nba/players/full/{id}.png&w=96&h=70
 */

const axios = require("axios");
const express = require("express");
const router = express.Router();

// Cache: player name (lowercase) → { id, headshot, team, position }
const playerCache = {};
const SEARCH_URL = "https://site.web.api.espn.com/apis/common/v3/search";

const SPORT_HEADSHOT_MAP = {
  nba: "nba",
  nfl: "nfl",
  mlb: "mlb",
  nhl: "nhl",
  wnba: "wnba",
};

function getHeadshotUrl(playerId, sport = "nba") {
  const espnSport = SPORT_HEADSHOT_MAP[sport] || "nba";
  return `https://a.espncdn.com/combiner/i?img=/i/headshots/${espnSport}/players/full/${playerId}.png&w=96&h=70`;
}

async function lookupPlayer(name, sport = "nba") {
  const key = `${name.toLowerCase()}_${sport}`;
  if (playerCache[key]) return playerCache[key];

  try {
    const resp = await axios.get(SEARCH_URL, {
      params: { query: name, limit: 3, type: "player" },
      timeout: 8000,
    });

    const results = resp.data?.results || resp.data?.items || [];
    // Find best match for the sport
    const match = results.find(r =>
      r.league?.toLowerCase() === sport ||
      r.sport?.toLowerCase() === (sport === "nba" ? "basketball" : sport === "nfl" ? "football" : sport === "mlb" ? "baseball" : sport === "nhl" ? "hockey" : sport)
    ) || results[0];

    if (match?.id) {
      const result = {
        id: match.id,
        name: match.displayName || name,
        headshot: getHeadshotUrl(match.id, sport),
        team: match.leagueRelationships?.[0]?.teams?.[0]?.displayName || null,
        position: match.position || null,
        sport,
      };
      playerCache[key] = result;
      return result;
    }
  } catch (e) {
    // Silent fail — return null
  }

  // Cache miss result too to avoid re-querying
  playerCache[key] = { id: null, name, headshot: null, sport };
  return playerCache[key];
}

// Bulk lookup — resolve multiple players at once
async function lookupPlayers(names, sport = "nba") {
  const results = {};
  const uncached = [];

  for (const name of names) {
    const key = `${name.toLowerCase()}_${sport}`;
    if (playerCache[key]) {
      results[name] = playerCache[key];
    } else {
      uncached.push(name);
    }
  }

  // Lookup uncached in parallel (max 5 at a time)
  const chunks = [];
  for (let i = 0; i < uncached.length; i += 5) {
    chunks.push(uncached.slice(i, i + 5));
  }

  for (const chunk of chunks) {
    const lookups = chunk.map(name => lookupPlayer(name, sport));
    const resolved = await Promise.all(lookups);
    for (let i = 0; i < chunk.length; i++) {
      results[chunk[i]] = resolved[i];
    }
  }

  return results;
}

// === ROUTES ===

// GET /api/headshots/:sport/:name — Single player headshot
router.get("/:sport/:name", async (req, res) => {
  const { sport, name } = req.params;
  const result = await lookupPlayer(decodeURIComponent(name), sport);
  if (result?.headshot) {
    res.json(result);
  } else {
    res.json({ name, headshot: null, error: "Player not found" });
  }
});

// POST /api/headshots/bulk — Bulk lookup
router.post("/bulk", async (req, res) => {
  const { names, sport } = req.body;
  if (!names || !Array.isArray(names)) return res.json({ error: "names array required" });
  const results = await lookupPlayers(names, sport || "nba");
  res.json({ count: Object.keys(results).length, players: results });
});

// GET /api/headshots/cache-stats — Debug info
router.get("/cache-stats", (req, res) => {
  res.json({
    cached: Object.keys(playerCache).length,
    withHeadshots: Object.values(playerCache).filter(p => p.headshot).length,
  });
});

module.exports = { router, lookupPlayer, lookupPlayers, getHeadshotUrl };
