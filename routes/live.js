const express = require("express");
const router = express.Router();
const { getLiveBoxScore, getTodaysGames, getLivePlayerStat, gradeCompletedPicks } = require("../services/livestats");
const { getPickHistory, updatePickResults } = require("../services/history");

// GET /api/live/:sport/games — Today's games with status
router.get("/:sport/games", async (req, res, next) => {
  try {
    const games = await getTodaysGames(req.params.sport);
    res.json({ games, count: games.length });
  } catch (err) { next(err); }
});

// GET /api/live/:sport/box/:eventId — Live box score
router.get("/:sport/box/:eventId", async (req, res, next) => {
  try {
    const box = await getLiveBoxScore(req.params.sport, req.params.eventId);
    res.json(box || { error: "Box score not available" });
  } catch (err) { next(err); }
});

// GET /api/live/:sport/player?name=LeBron&market=player_points — Live player stat
router.get("/:sport/player", async (req, res, next) => {
  try {
    const { name, market } = req.query;
    if (!name) return res.status(400).json({ error: "name required" });
    const stat = await getLivePlayerStat(req.params.sport, name, market || "player_points");
    res.json(stat || { found: false, message: "Player not in a live game" });
  } catch (err) { next(err); }
});

// POST /api/live/:sport/grade — Grade today's picks against final box scores
router.post("/:sport/grade", async (req, res, next) => {
  try {
    const { picks } = req.body;
    if (!picks?.length) return res.status(400).json({ error: "picks array required" });

    const results = await gradeCompletedPicks(req.params.sport, picks);

    // Update history with results
    if (results.results.length) {
      updatePickResults(results.results);
    }

    res.json(results);
  } catch (err) { next(err); }
});

module.exports = router;
