const axios = require("axios");
const NodeCache = require("node-cache");
const { buildPredictionContext } = require("./playerdata");

// SPEED: Cache props for 5min, picks for 10min
const propsCache = new NodeCache({ stdTTL: 300 });
const picksCache = new NodeCache({ stdTTL: 600 });
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

async function getPlayerProps(sportKey, marketFilter = null) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return { available: false, message: "Odds API key not configured" };
  const oddsSport = PROP_SPORTS[sportKey];
  if (!oddsSport) return { available: false, message: `No props for ${sportKey}` };

  const ck = `props_${sportKey}_${marketFilter || "all"}`;
  const cached = propsCache.get(ck);
  if (cached) return cached;

  const markets = marketFilter ? [marketFilter] : (PROP_MARKETS[sportKey] || []).slice(0, 3);
  try {
    const { data: events } = await axios.get(`${ODDS_BASE}/sports/${oddsSport}/events`, { params: { apiKey }, timeout: 10000 });
    if (!events?.length) { const r = { available: true, sport: sportKey, props: [], count: 0, markets }; propsCache.set(ck, r); return r; }

    // SPEED: Fetch all events in parallel (not sequential)
    const marketsStr = markets.join(",");
    const eventResults = await Promise.all(
      events.slice(0, 5).map(event =>
        axios.get(`${ODDS_BASE}/sports/${oddsSport}/events/${event.id}/odds`, {
          params: { apiKey, regions: "us,us2", markets: marketsStr, oddsFormat: "american", bookmakers: "draftkings,fanduel,betmgm,bovada,pointsbet,williamhill_us,betrivers,unibet_us,prizepicks,underdog" },
          timeout: 10000,
        }).then(res => ({ event, data: res.data })).catch(() => null)
      )
    );

    const allProps = [];
    for (const result of eventResults) {
      if (!result) continue;
      const { event, data: od } = result;
      for (const bk of od.bookmakers || []) for (const m of bk.markets || []) for (const o of m.outcomes || []) {
        if (!o.description) continue;
        allProps.push({ player: o.description, market: m.key, marketLabel: fmtMkt(m.key), game: `${event.away_team} @ ${event.home_team}`, gameId: event.id, commenceTime: event.commence_time, homeTeam: event.home_team, awayTeam: event.away_team, book: bk.title, bookKey: bk.key, side: o.name, point: o.point, price: o.price });
      }
    }

    const consolidated = consolidate(allProps);
    const result = { available: true, sport: sportKey, props: consolidated, count: consolidated.length, markets };
    propsCache.set(ck, result);
    return result;
  } catch (err) {
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

async function getDailyPicks(sportKey, props) {
  const ak = process.env.ANTHROPIC_API_KEY;
  if (!ak) return { available: false, message: "Anthropic API key needed" };

  // SPEED: Check picks cache first (10 min)
  const picksCk = `picks_${sportKey}`;
  const cachedPicks = picksCache.get(picksCk);
  if (cachedPicks) {
    console.log(`[Picks] Returning cached picks for ${sportKey}`);
    return cachedPicks;
  }

  const top = props.slice(0, 10);

  // SPEED: Fetch player data in parallel, 10s timeout per player
  console.log(`[Picks] Building context for ${Math.min(top.length, 8)} players in parallel...`);
  const startTime = Date.now();

  const enriched = await Promise.all(
    top.slice(0, 8).map(prop =>
      Promise.race([
        buildPredictionContext(prop.player, sportKey, prop.market, prop.consensusLine, { homeTeam: prop.homeTeam, awayTeam: prop.awayTeam })
          .then(ctx => ({ ...fmtProp(prop), context: ctx }))
          .catch(() => fmtProp(prop)),
        // 10 second timeout per player — skip truly stuck ones
        new Promise(resolve => setTimeout(() => resolve(fmtProp(prop)), 10000)),
      ])
    )
  );

  console.log(`[Picks] Context built in ${Date.now() - startTime}ms, sending to AI...`);

  try {
    const { data } = await axios.post("https://api.anthropic.com/v1/messages", {
      model: "claude-sonnet-4-20250514", max_tokens: 2000,
      system: `You are an elite sports betting analyst with REAL player data. Analyze props using:
1. Season averages + recent form (last 5 games)
2. Home/away splits — note significant differences
3. Hit rate — how often they've gone over/under this line
4. Vs opponent history
5. Opponent defense ranking
6. Injuries affecting usage
7. Line discrepancies between books

RULES: Reference SPECIFIC numbers. Mention hit rate. Note venue splits if 2+ point gap. Be concise — 2-3 sentences max per pick.
Respond ONLY in valid JSON, no markdown.`,
      messages: [{ role: "user", content: `Pick the 5-8 best ${sportKey.toUpperCase()} plays:\n\n${JSON.stringify(enriched, null, 2)}\n\nJSON format:\n{"picks":[{"player":"name","market":"stat","pick":"OVER/UNDER","line":24.5,"bestBook":"book","bestOdds":"+110","confidence":75,"reasoning":"2-3 sentences with real stats","edge":"specific edge","keyStats":{"seasonAvg":"22.3","recentAvg":"25.1 (L5)","hitRate":"8/10 over","venueSplit":"26.1 home vs 19.4 away","vsOpponent":"28.0 in 2 vs OPP"}}],"summary":"1-2 sentences"}` }],
    }, {
      headers: { "x-api-key": ak, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      timeout: 30000,
    });

    const text = data.content.filter(c => c.type === "text").map(c => c.text).join("");
    const result = JSON.parse(text.replace(/```json|```/g, "").trim());

    console.log(`[Picks] Total time: ${Date.now() - startTime}ms`);

    // SPEED: Cache picks for 10 minutes
    picksCache.set(picksCk, result);
    return result;
  } catch (err) {
    console.error("[Picks] AI error:", err.message);
    return { available: false, message: "Failed to generate picks" };
  }
}

function fmtProp(p) {
  return { player: p.player, market: p.marketLabel || p.market, line: p.consensusLine || p.line, game: p.game, bookCount: p.bookCount, hasEdge: p.hasEdge, lineSpread: p.lineSpread, bestOver: p.bestOver ? `${p.bestOver.book} ${p.bestOver.point} (${p.bestOver.price > 0 ? "+" : ""}${p.bestOver.price})` : null, bestUnder: p.bestUnder ? `${p.bestUnder.book} ${p.bestUnder.point} (${p.bestUnder.price > 0 ? "+" : ""}${p.bestUnder.price})` : null };
}

function fmtMkt(k) {
  const m = { player_points: "Points", player_rebounds: "Rebounds", player_assists: "Assists", player_threes: "3-Pointers", player_blocks: "Blocks", player_steals: "Steals", player_points_rebounds_assists: "Pts+Reb+Ast", player_points_rebounds: "Pts+Reb", player_points_assists: "Pts+Ast", player_rebounds_assists: "Reb+Ast", player_pass_yds: "Pass Yards", player_pass_tds: "Pass TDs", player_rush_yds: "Rush Yards", player_rush_attempts: "Rush Att", player_receptions: "Receptions", player_reception_yds: "Rec Yards", player_anytime_td: "Anytime TD", batter_hits: "Hits", batter_total_bases: "Total Bases", batter_rbis: "RBIs", batter_home_runs: "HRs", pitcher_strikeouts: "Strikeouts", player_goals: "Goals", player_shots_on_goal: "SOG" };
  return m[k] || k.replace(/player_|batter_|pitcher_/g, "").replace(/_/g, " ");
}

module.exports = { getPlayerProps, getDailyPicks, PROP_SPORTS, PROP_MARKETS };
