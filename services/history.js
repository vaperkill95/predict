const fs = require("fs");
const path = require("path");

const HISTORY_FILE = path.join(__dirname, "../pick-history.json");
let history = [];

// Load existing history on startup
try {
  if (fs.existsSync(HISTORY_FILE)) {
    history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  }
} catch (err) {
  console.error("Failed to load pick history:", err.message);
  history = [];
}

function savePickHistory(sport, picks) {
  const entry = {
    id: Date.now().toString(36),
    sport,
    date: new Date().toISOString().split("T")[0],
    timestamp: new Date().toISOString(),
    picks: picks.map((p) => ({
      player: p.player,
      market: p.market,
      pick: p.pick,
      line: p.line,
      confidence: p.confidence,
      bestBook: p.bestBook,
      bestOdds: p.bestOdds,
      reasoning: p.reasoning,
      result: null, // Will be updated later: "hit", "miss", or "push"
    })),
  };

  history.unshift(entry);

  // Keep last 100 entries
  if (history.length > 100) history = history.slice(0, 100);

  // Persist to file
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (err) {
    console.error("Failed to save pick history:", err.message);
  }
}

function getPickHistory() {
  // Calculate aggregate stats
  const allPicks = history.flatMap((h) => h.picks);
  const graded = allPicks.filter((p) => p.result);
  const hits = graded.filter((p) => p.result === "hit");

  return {
    entries: history.slice(0, 30), // Last 30 sessions
    stats: {
      totalSessions: history.length,
      totalPicks: allPicks.length,
      gradedPicks: graded.length,
      hits: hits.length,
      misses: graded.length - hits.length,
      hitRate: graded.length > 0 ? Math.round((hits.length / graded.length) * 1000) / 10 : null,
    },
  };
}

module.exports = { savePickHistory, getPickHistory };
