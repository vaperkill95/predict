const express = require("express");
const router = express.Router();
const { getOdds } = require("../services/odds");

// GET /api/odds/:sport
router.get("/:sport", async (req, res, next) => {
  try {
    const data = await getOdds(req.params.sport);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
