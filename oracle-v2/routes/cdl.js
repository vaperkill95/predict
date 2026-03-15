const express = require("express");
const router = express.Router();
const { getCDLMatches, getCDLStandings, getCDLPlayers } = require("../services/cdl");

// GET /api/cdl/matches
router.get("/matches", async (req, res, next) => {
  try {
    const data = await getCDLMatches();
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/cdl/standings
router.get("/standings", async (req, res, next) => {
  try {
    const data = await getCDLStandings();
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/cdl/players?q=Shotzzy
router.get("/players", async (req, res, next) => {
  try {
    const data = await getCDLPlayers(req.query.q || "");
    res.json(data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
