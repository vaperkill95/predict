const express = require("express");
const router = express.Router();
const { getPlayerProps, getDailyPicks, PROP_MARKETS } = require("../services/props");

// GET /api/props/:sport — Get all player props for a sport
router.get("/:sport", async (req, res, next) => {
  try {
    const { market } = req.query; // optional filter by market
    const markets = market ? [market] : null;
    const data = await getPlayerProps(req.params.sport, markets);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/props/:sport/picks — AI-generated best picks
router.get("/:sport/picks", async (req, res, next) => {
  try {
    const propsData = await getPlayerProps(req.params.sport);
    if (!propsData.available || !propsData.props?.length) {
      return res.json({ available: false, message: "No props available to analyze" });
    }
    const picks = await getDailyPicks(req.params.sport, propsData.props);
    res.json({ ...picks, sport: req.params.sport, timestamp: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

// GET /api/props/:sport/markets — List available markets
router.get("/:sport/markets", (req, res) => {
  const markets = PROP_MARKETS[req.params.sport] || [];
  res.json({ sport: req.params.sport, markets });
});

module.exports = router;
