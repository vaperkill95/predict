const axios = require("axios");
const NodeCache = require("node-cache");
const { buildPredictionContext } = require("./playerdata");

const cache = new NodeCache({ stdTTL: 180 });
const ODDS_BASE = "https://api.the-odds-api.com/v4";

const PROP_SPORTS = {
  nba: "basketball_nba",
  nfl: "americanfootball_nfl",
  mlb: "baseball_mlb",
  nhl: "icehockey_nhl",
  ncaamb: "basketball_ncaab",
  ncaafb: "americanfootball_ncaaf",
};

const PROP_MARKETS = {
  nba: ["player_points", "player_rebounds", "player_assists", "player_threes", "player_points_rebounds_assists"],
  nfl: ["player_pass_yds", "player_pass_tds", "player_rush_yds", "player_receptions", "player_reception_yds", "player_anytime_td"],
  mlb: ["batter_hits", "batter_total_bases", "pitcher_strikeouts", "batter_home_runs", "batter_rbis"],
  nhl: ["player_points", "player_goals", "player_assists", "player_shots_on_goal"],
  ncaamb: ["player_points", "player_rebounds", "player_assists"],
  ncaafb: ["player_pass_yds", "player_rush_yds", "player_reception_yds"],
};

// ─── getPlayerProps (unchanged from working version) ───
async function getPlayerProps(sportKey, marketFilter = null) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return { available: false, message: "Odds API key not configured" };

  const oddsSport = PROP_SPORTS[sportKey];
  if (!oddsSport) return { available: false, message: `No props support for ${sportKey}` };

  const cacheKey = `props_${sportKey}_${marketFilter || "all"}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const markets = marketFilter ? [marketFilter] : (PROP_MARKETS[sportKey] || []).slice(0, 3);

  try {
    console.log(`[Props] Fetching events for ${oddsSport}...`);
    const { data: events } = await axios.get(`${ODDS_BASE}/sports/${oddsSport}/events`, {
      params: { apiKey }, timeout: 15000,
    });
    console.log(`[Props] Found ${events.length} events`);

    if (!events?.length) {
      const result = { available: true, sport: sportKey, props: [], count: 0, markets };
      cache.set(cacheKey, result);
      return result;
    }

    const allProps = [];
    const marketsStr = markets.join(",");

    for (const event of events.slice(0, 5)) {
      try {
        const { data: oddsData } = await axios.get(
          `${ODDS_BASE}/sports/${oddsSport}/events/${event.id}/odds`,
          {
            params: {
              apiKey, regions: "us,us2", markets: marketsStr, oddsFormat: "american",
              bookmakers: "draftkings,fanduel,betmgm,bovada,pointsbet,williamhill_us,betrivers,unibet_us,prizepicks,underdog",
            },
            timeout: 15000,
          }
        );

        for (const bk of oddsData.bookmakers || []) {
          for (const mkt of bk.markets || []) {
            for (const out of mkt.outcomes || []) {
              if (!out.description) continue;
              allProps.push({
                player: out.description, market: mkt.key, marketLabel: formatMarketName(mkt.key),
                game: `${event.away_team} @ ${event.home_team}`, gameId: event.id,
                commenceTime: event.commence_time, homeTeam: event.home_team, awayTeam: event.away_team,
                book: bk.title, bookKey: bk.key, side: out.name, point: out.point, price: out.price,
              });
            }
          }
        }
      } catch (err) {
        console.error(`[Props] Event error ${event.id}:`, err.response?.status || err.message);
      }
    }

    console.log(`[Props] Raw lines: ${allProps.length}`);
    const consolidated = consolidateProps(allProps);
    const result = { available: true, sport: sportKey, props: consolidated, count: consolidated.length, markets };
    cache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.error(`[Props] Error: ${err.response?.data?.message || err.message}`);
    return { available: false, message: `Failed: ${err.response?.data?.message || err.message}` };
  }
}

function consolidateProps(rawProps) {
  const grouped = {};
  for (const prop of rawProps) {
    const key = `${prop.player}__${prop.market}__${prop.gameId}`;
    if (!grouped[key]) {
      grouped[key] = { player: prop.player, market: prop.market, marketLabel: prop.marketLabel, game: prop.game, gameId: prop.gameId, commenceTime: prop.commenceTime, homeTeam: prop.homeTeam, awayTeam: prop.awayTeam, books: {} };
    }
    if (!grouped[key].books[prop.book]) grouped[key].books[prop.book] = {};
    grouped[key].books[prop.book][prop.side.toLowerCase()] = { price: prop.price, point: prop.point };
  }
  return Object.values(grouped).map(prop => {
    const entries = Object.entries(prop.books);
    const overPts = [], allOvers = [], allUnders = [];
    for (const [bk, sides] of entries) {
      if (sides.over) { overPts.push(sides.over.point); allOvers.push({ book: bk, ...sides.over }); }
      if (sides.under) allUnders.push({ book: bk, ...sides.under });
    }
    const consensus = overPts.length ? Math.round((overPts.reduce((a, b) => a + b, 0) / overPts.length) * 10) / 10 : null;
    const bestOver = allOvers.length ? allOvers.reduce((b, c) => c.price > b.price ? c : b) : null;
    const bestUnder = allUnders.length ? allUnders.reduce((b, c) => c.price > b.price ? c : b) : null;
    const spread = overPts.length > 1 ? Math.max(...overPts) - Math.min(...overPts) : 0;
    return {
      ...prop, books: entries.map(([n, s]) => ({ name: n, ...s })),
      consensusLine: consensus, bestOver, bestUnder, lineSpread: spread,
      bookCount: entries.length, hasEdge: spread >= 1.5,
    };
  }).sort((a, b) => b.bookCount - a.bookCount);
}

/**
 * ENHANCED AI daily picks - now with real player data
 */
async function getDailyPicks(sportKey, props) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return { available: false, message: "Anthropic API key needed" };

  // Take top 15 props (by book coverage) for deeper analysis
  const topProps = props.slice(0, 15);

  // Fetch real player data for each prop (in parallel, limit 8 to save time)
  console.log(`[Picks] Fetching player data for ${Math.min(topProps.length, 8)} props...`);
  const enrichedProps = await Promise.all(
    topProps.slice(0, 8).map(async (prop) => {
      try {
        const context = await buildPredictionContext(
          prop.player, sportKey, prop.market, prop.consensusLine,
          { homeTeam: prop.homeTeam, awayTeam: prop.awayTeam }
        );
        return { ...formatPropForAI(prop), playerContext: context };
      } catch (err) {
        console.error(`[Picks] Context error for ${prop.player}:`, err.message);
        return formatPropForAI(prop);
      }
    })
  );

  console.log(`[Picks] Sending ${enrichedProps.length} enriched props to AI...`);

  try {
    const { data } = await axios.post("https://api.anthropic.com/v1/messages", {
      model: "claude-sonnet-4-20250514", max_tokens: 2000,
      system: `You are an elite sports betting analyst with access to REAL player data. You make data-driven predictions based on:
- Player season averages and recent game logs
- Hit rate (how often the player has gone over/under this line recently)
- Matchup context and opponent defense
- Line discrepancies between sportsbooks (edges)
- Injury reports affecting usage

Be specific. Reference actual stats. If a player averages 22 PPG but the line is 24.5, note that.
If they've gone over in 7 of last 10, note that.
If key teammates are injured meaning more usage, note that.

Respond ONLY in valid JSON with no markdown.`,
      messages: [{ role: "user", content: `Analyze these ${sportKey.toUpperCase()} player props with REAL PLAYER DATA and pick the 5-8 best plays:

${JSON.stringify(enrichedProps, null, 2)}

For each pick, consider:
1. Does the player's season average support over or under?
2. What's their recent trend (last 5 games)?
3. Hit rate: how often have they gone over/under this line?
4. Are there line discrepancies between books (edges)?
5. Any injury/matchup factors?

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
    "reasoning": "2-3 sentences referencing SPECIFIC stats - season avg, recent games, hit rate, matchup",
    "edge": "Where the value is, reference real numbers",
    "seasonAvg": "22.3 PPG",
    "recentAvg": "25.1 over last 5",
    "hitRate": "7/10 over"
  }],
  "summary": "1-2 sentence overview referencing data trends"
}` }],
    }, {
      headers: { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      timeout: 45000,
    });

    const text = data.content.filter(c => c.type === "text").map(c => c.text).join("");
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch (err) {
    console.error("[Picks] AI error:", err.message);
    return { available: false, message: "Failed to generate picks" };
  }
}

function formatPropForAI(prop) {
  return {
    player: prop.player, market: prop.marketLabel, line: prop.consensusLine,
    game: prop.game, bookCount: prop.bookCount, hasEdge: prop.hasEdge, lineSpread: prop.lineSpread,
    bestOver: prop.bestOver ? `${prop.bestOver.book} ${prop.bestOver.point} (${prop.bestOver.price > 0 ? "+" : ""}${prop.bestOver.price})` : null,
    bestUnder: prop.bestUnder ? `${prop.bestUnder.book} ${prop.bestUnder.point} (${prop.bestUnder.price > 0 ? "+" : ""}${prop.bestUnder.price})` : null,
  };
}

function formatMarketName(key) {
  const map = {
    player_points: "Points", player_rebounds: "Rebounds", player_assists: "Assists",
    player_threes: "3-Pointers", player_blocks: "Blocks", player_steals: "Steals",
    player_points_rebounds_assists: "Pts+Reb+Ast", player_points_rebounds: "Pts+Reb",
    player_points_assists: "Pts+Ast", player_rebounds_assists: "Reb+Ast",
    player_double_double: "Double-Double", player_triple_double: "Triple-Double",
    player_pass_yds: "Pass Yards", player_pass_tds: "Pass TDs",
    player_pass_completions: "Completions", player_rush_yds: "Rush Yards",
    player_rush_attempts: "Rush Att", player_rush_tds: "Rush TDs",
    player_reception_yds: "Rec Yards", player_receptions: "Receptions",
    player_reception_tds: "Rec TDs", player_anytime_td: "Anytime TD",
    batter_hits: "Hits", batter_total_bases: "Total Bases",
    batter_rbis: "RBIs", batter_runs_scored: "Runs", batter_home_runs: "HRs",
    batter_stolen_bases: "SBs", pitcher_strikeouts: "Strikeouts", pitcher_outs: "Outs",
    player_goals: "Goals", player_shots_on_goal: "SOG", player_blocked_shots: "Blocks",
  };
  return map[key] || key.replace(/player_|batter_|pitcher_/g, "").replace(/_/g, " ");
}

module.exports = { getPlayerProps, getDailyPicks, PROP_SPORTS, PROP_MARKETS };
