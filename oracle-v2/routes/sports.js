const express = require("express");
const router = express.Router();
const espn = require("../services/espn");

// GET /api/sports/scores/:sport
router.get("/scores/:sport", async (req, res, next) => {
  try {
    const data = await espn.getScoreboard(req.params.sport);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/sports/standings/:sport
router.get("/standings/:sport", async (req, res, next) => {
  try {
    const data = await espn.getStandings(req.params.sport);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/sports/game/:sport/:gameId
router.get("/game/:sport/:gameId", async (req, res, next) => {
  try {
    const data = await espn.getGameDetail(req.params.sport, req.params.gameId);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/sports/team/:sport/:teamId
router.get("/team/:sport/:teamId", async (req, res, next) => {
  try {
    const data = await espn.getTeamInfo(req.params.sport, req.params.teamId);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/sports/search/player?q=
router.get("/search/player", async (req, res, next) => {
  try {
    const results = await espn.searchAthlete(req.query.q || "");
    res.json(results);
  } catch (err) {
    next(err);
  }
});

// GET /api/sports/leagues
router.get("/leagues", (req, res) => {
  res.json(
    Object.entries(espn.SPORT_MAP).map(([key, val]) => ({
      key,
      ...val,
    }))
  );
});

module.exports = router;
