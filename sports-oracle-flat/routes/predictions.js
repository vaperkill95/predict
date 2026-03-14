const express = require("express");
const router = express.Router();
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

    // Fetch game data from ESPN
    let gameData;
    try {
      gameData = await espn.getGameDetail(sport, gameId);
    } catch {
      // If detail fails, try scoreboard
      const scoreboard = await espn.getScoreboard(sport);
      gameData = scoreboard.games.find((g) => g.id === gameId);
    }

    // Fetch odds if available
    let oddsData = null;
    try {
      oddsData = await getOdds(sport);
    } catch {
      // Odds are optional
    }

    // Generate AI prediction
    const prediction = await predictGame(gameData, oddsData);

    res.json({
      gameId,
      sport,
      prediction,
      gameData,
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

    if (!playerName || !sport) {
      return res
        .status(400)
        .json({ error: "playerName and sport are required" });
    }

    const prediction = await predictPlayer(playerName, sport, { opponent });

    res.json({
      playerName,
      sport,
      prediction,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
