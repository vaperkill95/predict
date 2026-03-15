const axios = require("axios");
const NodeCache = require("node-cache");
const { buildPredictionContext } = require("./playerdata");

const cache = new NodeCache({ stdTTL: 180 });
const ODDS_BASE = "https://api.the-odds-api.com/v4";

const PROP_SPORTS = {
  nba: "basketball_nba", nfl: "americanfootball_nfl", mlb: "baseball_mlb",
  nhl: "icehockey_nhl", ncaamb: "basketball_ncaab", ncaafb: "americanfootball_ncaaf",
};

const PROP_MARKETS = {
  nba: ["player_points", "player_rebounds", "player_assists", "player_threes", "player_points_rebounds_assists"],
  nfl: ["player_pass_yds", "player_pass_tds", "player_rush_yds", "player_receptions", "player_reception_yds", "player_anytime_td"],
  mlb: ["batter_hits", "batter_total_bases", "pitcher_strikeouts", "batter_home_runs", "batter_rbis"],
  nhl: ["player_points", "player_goals", "player_assists", "player_shots_on_goal"],
  ncaamb: ["player_points", "player_rebounds", "player_assists"],
  ncaafb: ["player_pass_yds", "player_rush_yds", "player_reception_yds"],
};

// ─── getPlayerProps (unchanged) ───
async function getPlayerProps(sportKey, marketFilter = null) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return { available: false, message: "Odds API key not configured" };
  const oddsSport = PROP_SPORTS[sportKey];
  if (!oddsSport) return { available: false, message: `No props for ${sportKey}` };

  const cacheKey = `props_${sportKey}_${marketFilter || "all"}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const markets = marketFilter ? [marketFilter] : (PROP_MARKETS[sportKey] || []).slice(0, 3);
  try {
    console.log(`[Props] Fetching events for ${oddsSport}...`);
    const { data: events } = await axios.get(`${ODDS_BASE}/sports/${oddsSport}/events`, { params: { apiKey }, timeout: 15000 });
    console.log(`[Props] Found ${events.length} events`);
    if (!events?.length) { const r = { available: true, sport: sportKey, props: [], count: 0, markets }; cache.set(cacheKey, r); return r; }

    const allProps = [];
    const marketsStr = markets.join(",");
    for (const event of events.slice(0, 5)) {
      try {
        const { data: od } = await axios.get(`${ODDS_BASE}/sports/${oddsSport}/events/${event.id}/odds`, {
          params: { apiKey, regions: "us,us2", markets: marketsStr, oddsFormat: "american", bookmakers: "draftkings,fanduel,betmgm,bovada,pointsbet,williamhill_us,betrivers,unibet_us,prizepicks,underdog" },
          timeout: 15000,
        });
        for (const bk of od.bookmakers || []) for (const m of bk.markets || []) for (const o of m.outcomes || []) {
          if (!o.description) continue;
          allProps.push({ player: o.description, market: m.key, marketLabel: fmtMkt(m.key), game: `${event.away_team} @ ${event.home_team}`, gameId: event.id, commenceTime: event.commence_time, homeTeam: event.home_team, awayTeam: event.away_team, book: bk.title, bookKey: bk.key, side: o.name, point: o.point, price: o.price });
        }
      } catch (err) { console.error(`[Props] Event ${event.id}: ${err.response?.status || err.message}`); }
    }
    console.log(`[Props] Raw lines: ${allProps.length}`);
    const consolidated = consolidate(allProps);
    const result = { available: true, sport: sportKey, props: consolidated, count: consolidated.length, markets };
    cache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.error(`[Props] Error: ${err.response?.data?.message || err.message}`);
    return { available: false, message: `Failed: ${err.response?.data?.message || err.message}` };
  }
}

function consolidate(raw) {
  const g = {};
  for (const p of raw) {
    const k = `${p.player}__${p.market}__${p.gameId}`;
    if (!g[k]) g[k] = { player: p.player, market: p.market, marketLabel: p.marketLabel, game: p.game, gameId: p.gameId, commenceTime: p.commenceTime, homeTeam: p.homeTeam, awayTeam: p.awayTeam, books: {} };
    if (!g[k].books[p.book]) g[k].books[p.book] = {};
    g[k].books[p.book][p.side.toLowerCase()] = { price: p.price, point: p.point };
  }
  return Object.values(g).map(p => {
    const e = Object.entries(p.books), op = [], ao = [], au = [];
    for (const [b, s] of e) { if (s.over) { op.push(s.over.point); ao.push({ book: b, ...s.over }); } if (s.under) au.push({ book: b, ...s.under }); }
    const con = op.length ? Math.round((op.reduce((a, b) => a + b, 0) / op.length) * 10) / 10 : null;
    const bo = ao.length ? ao.reduce((b, c) => c.price > b.price ? c : b) : null;
    const bu = au.length ? au.reduce((b, c) => c.price > b.price ? c : b) : null;
    const sp = op.length > 1 ? Math.max(...op) - Math.min(...op) : 0;
    return { ...p, books: e.map(([n, s]) => ({ name: n, ...s })), consensusLine: con, bestOver: bo, bestUnder: bu, lineSpread: sp, bookCount: e.length, hasEdge: sp >= 1.5 };
  }).sort((a, b) => b.bookCount - a.bookCount);
}

// ─── DEEP AI PICKS with full context ───
async function getDailyPicks(sportKey, props) {
  const ak = process.env.ANTHROPIC_API_KEY;
  if (!ak) return { available: false, message: "Anthropic API key needed" };

  const top = props.slice(0, 12);
  console.log(`[Picks] Building deep context for ${Math.min(top.length, 8)} players...`);

  const enriched = await Promise.all(
    top.slice(0, 8).map(async (prop) => {
      try {
        const ctx = await buildPredictionContext(prop.player, sportKey, prop.market, prop.consensusLine, { homeTeam: prop.homeTeam, awayTeam: prop.awayTeam });
        return { ...fmtProp(prop), context: ctx };
      } catch (err) {
        console.error(`[Picks] Context error ${prop.player}:`, err.message);
        return fmtProp(prop);
      }
    })
  );

  console.log(`[Picks] Sending ${enriched.length} deep-enriched props to AI...`);

  try {
    const { data } = await axios.post("https://api.anthropic.com/v1/messages", {
      model: "claude-sonnet-4-20250514", max_tokens: 2500,
      system: `You are an elite sports betting analyst with access to REAL, COMPREHENSIVE player data. You make predictions using ALL of the following:

DATA YOU HAVE ACCESS TO:
1. SEASON AVERAGES — full stat lines for the current season
2. RECENT GAME LOGS — last 5 games with per-game stats and opponents
3. HOME/AWAY SPLITS — how the player performs at home vs on the road
4. VS OPPONENT HISTORY — how they've performed against this specific team
5. HIT RATE — what % of recent games they've gone over/under this exact line, plus current streak
6. OPPONENT DEFENSE — defensive rankings and stats of the team they're facing
7. TEAM PACE — pace of play for both teams (fast pace = inflated stats)
8. INJURIES — key players out on both teams (missing teammates = more usage)
9. SCHEDULE — whether team is on a back-to-back (fatigue)
10. LINE DISCREPANCIES — where different sportsbooks disagree on the number

ANALYSIS RULES:
- ALWAYS reference specific numbers from the data (e.g. "averaging 24.3 PPG, but 28.1 at home")
- ALWAYS mention the hit rate if available (e.g. "gone over in 8 of last 10")
- Note home/away splits when there's a significant difference (2+ point gap)
- Note vs opponent history when available
- Flag back-to-backs as negative for overs
- Flag missing teammates as positive for usage/stats
- Note pace matchups: fast vs fast = over territory, slow vs slow = under territory
- Line discrepancies > 2 points between books = strong edge signal

Respond ONLY in valid JSON, no markdown.`,
      messages: [{ role: "user", content: `Analyze these ${sportKey.toUpperCase()} player props with FULL CONTEXT DATA and pick the 5-8 best plays:

${JSON.stringify(enriched, null, 2)}

Respond with:
{
  "picks": [{
    "player": "name",
    "market": "stat type",
    "pick": "OVER" or "UNDER",
    "line": 24.5,
    "bestBook": "book name",
    "bestOdds": "+110",
    "confidence": 75,
    "reasoning": "3-4 sentences with SPECIFIC stats: season avg, recent avg, home/away split, vs opponent, hit rate, injuries, pace. Reference real numbers.",
    "edge": "The specific edge: hit rate, line discrepancy, venue split, matchup advantage, etc.",
    "keyStats": {
      "seasonAvg": "22.3",
      "recentAvg": "25.1 (L5)",
      "hitRate": "8/10 over",
      "venueSplit": "26.1 at home vs 19.4 away",
      "vsOpponent": "28.0 in 2 games vs OPP"
    }
  }],
  "summary": "2-3 sentence data-driven overview of today's board, reference trends"
}` }],
    }, {
      headers: { "x-api-key": ak, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      timeout: 60000, // Longer timeout for deep analysis
    });

    const text = data.content.filter(c => c.type === "text").map(c => c.text).join("");
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch (err) {
    console.error("[Picks] AI error:", err.message);
    return { available: false, message: "Failed to generate picks" };
  }
}

function fmtProp(p) {
  return { player: p.player, market: p.marketLabel, line: p.consensusLine, game: p.game, bookCount: p.bookCount, hasEdge: p.hasEdge, lineSpread: p.lineSpread, bestOver: p.bestOver ? `${p.bestOver.book} ${p.bestOver.point} (${p.bestOver.price > 0 ? "+" : ""}${p.bestOver.price})` : null, bestUnder: p.bestUnder ? `${p.bestUnder.book} ${p.bestUnder.point} (${p.bestUnder.price > 0 ? "+" : ""}${p.bestUnder.price})` : null };
}

function fmtMkt(k) {
  const m = { player_points: "Points", player_rebounds: "Rebounds", player_assists: "Assists", player_threes: "3-Pointers", player_blocks: "Blocks", player_steals: "Steals", player_points_rebounds_assists: "Pts+Reb+Ast", player_points_rebounds: "Pts+Reb", player_points_assists: "Pts+Ast", player_rebounds_assists: "Reb+Ast", player_double_double: "Double-Double", player_triple_double: "Triple-Double", player_pass_yds: "Pass Yards", player_pass_tds: "Pass TDs", player_pass_completions: "Completions", player_rush_yds: "Rush Yards", player_rush_attempts: "Rush Att", player_rush_tds: "Rush TDs", player_reception_yds: "Rec Yards", player_receptions: "Receptions", player_reception_tds: "Rec TDs", player_anytime_td: "Anytime TD", batter_hits: "Hits", batter_total_bases: "Total Bases", batter_rbis: "RBIs", batter_runs_scored: "Runs", batter_home_runs: "HRs", batter_stolen_bases: "SBs", pitcher_strikeouts: "Strikeouts", pitcher_outs: "Outs", player_goals: "Goals", player_shots_on_goal: "SOG", player_blocked_shots: "Blocks" };
  return m[k] || k.replace(/player_|batter_|pitcher_/g, "").replace(/_/g, " ");
}

module.exports = { getPlayerProps, getDailyPicks, PROP_SPORTS, PROP_MARKETS };
