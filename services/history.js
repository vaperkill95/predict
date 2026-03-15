const fs = require("fs");
const path = require("path");

const HISTORY_FILE = path.join(__dirname, "../pick-history.json");
let history = [];

try {
  if (fs.existsSync(HISTORY_FILE)) {
    history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  }
} catch (err) { history = []; }

function savePickHistory(sport, picks) {
  const entry = {
    id: Date.now().toString(36),
    sport,
    date: new Date().toISOString().split("T")[0],
    timestamp: new Date().toISOString(),
    picks: picks.map(p => ({
      player: p.player, market: p.market, pick: p.pick, line: p.line,
      confidence: p.confidence, bestBook: p.bestBook, bestOdds: p.bestOdds,
      reasoning: p.reasoning, keyStats: p.keyStats || null,
      result: null, actual: null,
    })),
  };
  history.unshift(entry);
  if (history.length > 100) history = history.slice(0, 100);
  persist();
}

function updatePickResults(results) {
  // Match graded results to history picks
  for (const result of results) {
    for (const entry of history) {
      for (const pick of entry.picks) {
        if (pick.player === result.player && pick.line === result.line && !pick.result) {
          pick.result = result.result;
          pick.actual = result.actual;
        }
      }
    }
  }
  persist();
}

function getPickHistory() {
  const allPicks = history.flatMap(h => h.picks);
  const graded = allPicks.filter(p => p.result);
  const hits = graded.filter(p => p.result === "hit");
  const byConfidence = {};

  // Hit rate by confidence tier
  for (const p of graded) {
    const tier = p.confidence >= 75 ? "high" : p.confidence >= 55 ? "mid" : "low";
    if (!byConfidence[tier]) byConfidence[tier] = { total: 0, hits: 0 };
    byConfidence[tier].total++;
    if (p.result === "hit") byConfidence[tier].hits++;
  }

  return {
    entries: history.slice(0, 30),
    stats: {
      totalSessions: history.length,
      totalPicks: allPicks.length,
      gradedPicks: graded.length,
      hits: hits.length,
      misses: graded.length - hits.length,
      hitRate: graded.length > 0 ? Math.round((hits.length / graded.length) * 1000) / 10 : null,
      byConfidence: Object.entries(byConfidence).reduce((o, [tier, d]) => {
        o[tier] = { ...d, rate: Math.round((d.hits / d.total) * 1000) / 10 };
        return o;
      }, {}),
    },
  };
}

function persist() {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2)); }
  catch (err) { console.error("History persist error:", err.message); }
}

module.exports = { savePickHistory, getPickHistory, updatePickResults };
