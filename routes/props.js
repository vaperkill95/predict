const express = require("express");
const router = express.Router();
const { getPlayerProps, getDailyPicks, PROP_MARKETS } = require("../services/props");
const { savePickHistory, getPickHistory } = require("../services/history");

// GET /api/props/:sport
router.get("/:sport", async (req, res, next) => {
  try {
    const { market } = req.query;
    const data = await getPlayerProps(req.params.sport, market || null);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/props/:sport/picks
router.get("/:sport/picks", async (req, res, next) => {
  try {
    const propsData = await getPlayerProps(req.params.sport);
    if (!propsData.available || !propsData.props?.length) {
      return res.json({ available: false, message: "No props available to analyze" });
    }
    const picks = await getDailyPicks(req.params.sport, propsData.props);

    // Save picks to history
    if (picks?.picks?.length) {
      savePickHistory(req.params.sport, picks.picks);
    }

    res.json({ ...picks, sport: req.params.sport, timestamp: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

// GET /api/props/:sport/markets
router.get("/:sport/markets", (req, res) => {
  res.json({ sport: req.params.sport, markets: PROP_MARKETS[req.params.sport] || [] });
});

// GET /api/props/history/all
router.get("/history/all", (req, res) => {
  res.json(getPickHistory());
});

module.exports = router;
