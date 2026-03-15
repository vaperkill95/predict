const express = require("express");
const router = express.Router();
const axios = require("axios");
const { predictGame, predictPlayer } = require("../services/anthropic");
const espn = require("../services/espn");
const { getOdds } = require("../services/odds");

// POST /api/predictions/game
router.post("/game", async (req, res, next) => {
  try {
    const { sport, gameId } = req.body;

    if (!sport || !gameId) {
      return res.status(400).json({ error: "sport and gameId are required" });
    }

    // ─── CDL BRANCH: Use PandaScore instead of ESPN ───
    if (sport === "cdl") {
      const pandaKey = process.env.PANDASCORE_API_KEY;
      if (!pandaKey) {
        return res.json({
          gameId, sport, prediction: { fallback: true, confidence: 0,
            keyFactors: ["PandaScore API key needed for CDL predictions"],
            hotTake: "Add PANDASCORE_API_KEY to enable CDL AI predictions",
          }, timestamp: new Date().toISOString(),
        });
      }

      try {
        const headers = { Authorization: `Bearer ${pandaKey}` };

        // Fetch match details — use GENERIC /matches/{id} (NOT /codmw/matches/{id})
        const { data: match } = await axios.get(
          `https://api.pandascore.co/matches/${gameId}`,
          { headers, timeout: 10000 }
        );

        const team1 = match.opponents?.[0]?.opponent;
        const team2 = match.opponents?.[1]?.opponent;

        if (!team1 || !team2) {
          return res.json({
            gameId, sport, prediction: { fallback: true, confidence: 0,
              keyFactors: ["Teams not yet assigned for this match (TBD)"],
              hotTake: "Check back when teams are confirmed",
            }, timestamp: new Date().toISOString(),
          });
        }

        // Fetch recent results for both teams in parallel
        let team1Recent = [];
        let team2Recent = [];
        try {
          const [r1, r2] = await Promise.all([
            axios.get(`https://api.pandascore.co/codmw/matches`, {
              headers, timeout: 8000,
              params: { "filter[opponent_id]": team1.id, sort: "-scheduled_at", "page[size]": 5, "filter[status]": "finished" },
            }).catch(() => ({ data: [] })),
            axios.get(`https://api.pandascore.co/codmw/matches`, {
              headers, timeout: 8000,
              params: { "filter[opponent_id]": team2.id, sort: "-scheduled_at", "page[size]": 5, "filter[status]": "finished" },
            }).catch(() => ({ data: [] })),
          ]);
          team1Recent = r1.data || [];
          team2Recent = r2.data || [];
        } catch {}

        // Format recent results
        const fmtRecent = (matches, teamId) =>
          matches.map(m => {
            const winner = m.winner?.id === teamId ? "W" : "L";
            const opp = m.opponents?.find(o => o.opponent.id !== teamId)?.opponent?.name || "Unknown";
            const score = `${m.results?.[0]?.score || "?"}–${m.results?.[1]?.score || "?"}`;
            return `${winner} vs ${opp} (${score})`;
          }).join(", ") || "No recent matches";

        // Build CDL-specific game data for prediction
        const cdlGameData = {
          home: { name: team1.name, logo: team1.image_url },
          away: { name: team2.name, logo: team2.image_url },
          league: match.league?.name || "Call of Duty League",
          tournament: match.tournament?.name || "",
          team1Recent: fmtRecent(team1Recent, team1.id),
          team2Recent: fmtRecent(team2Recent, team2.id),
          bestOf: match.number_of_games,
          isCDL: true,
        };

        // Use the existing predictGame function
        const prediction = await predictGame(cdlGameData, null);

        return res.json({
          gameId, sport, prediction, gameData: cdlGameData,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        console.error("CDL prediction error:", err.message);
        return res.status(500).json({ error: `CDL prediction failed: ${err.message}` });
      }
    }

    // ─── STANDARD SPORTS: Use ESPN ───
    let gameData;
    try {
      gameData = await espn.getGameDetail(sport, gameId);
    } catch {
      const scoreboard = await espn.getScoreboard(sport);
      gameData = scoreboard.games.find((g) => g.id === gameId);
    }

    let oddsData = null;
    try { oddsData = await getOdds(sport); } catch {}

    const prediction = await predictGame(gameData, oddsData);

    res.json({
      gameId, sport, prediction, gameData,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/predictions/player
router.post("/player", async (req, res, next) => {
  try {
    const { playerName, sport, opponent } = req.body;
    if (!playerName || !sport) return res.status(400).json({ error: "playerName and sport are required" });

    const prediction = await predictPlayer(playerName, sport, { opponent });
    res.json({ playerName, sport, prediction, timestamp: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
