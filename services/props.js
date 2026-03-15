const axios = require("axios");
const NodeCache = require("node-cache");

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

/**
 * Get all player props for a sport
 */
async function getPlayerProps(sportKey, marketFilter = null) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return { available: false, message: "Odds API key not configured" };

  const oddsSport = PROP_SPORTS[sportKey];
  if (!oddsSport) return { available: false, message: `No props support for ${sportKey}` };

  const cacheKey = `props_${sportKey}_${marketFilter || "all"}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const markets = marketFilter ? [marketFilter] : (PROP_MARKETS[sportKey] || []).slice(0, 3); // Start with 3 markets to save API calls

  try {
    // Step 1: Get events (games) for this sport
    console.log(`[Props] Fetching events for ${oddsSport}...`);
    const { data: events } = await axios.get(`${ODDS_BASE}/sports/${oddsSport}/events`, {
      params: { apiKey },
      timeout: 15000,
    });

    console.log(`[Props] Found ${events.length} events for ${oddsSport}`);

    if (!events || events.length === 0) {
      const result = { available: true, sport: sportKey, props: [], count: 0, markets, message: "No games scheduled" };
      cache.set(cacheKey, result);
      return result;
    }

    // Step 2: For each event, fetch player props odds
    const allProps = [];
    const marketsStr = markets.join(",");

    // Limit to 5 events to conserve API calls
    const eventsToFetch = events.slice(0, 5);

    for (const event of eventsToFetch) {
      try {
        console.log(`[Props] Fetching props for event ${event.id}: ${event.away_team} @ ${event.home_team}, markets: ${marketsStr}`);

        const { data: oddsData } = await axios.get(
          `${ODDS_BASE}/sports/${oddsSport}/events/${event.id}/odds`,
          {
            params: {
              apiKey,
              regions: "us,us2",
              markets: marketsStr,
              oddsFormat: "american",
              bookmakers: "draftkings,fanduel,betmgm,bovada,pointsbet,williamhill_us,betrivers,unibet_us,prizepicks,underdog",
            },
            timeout: 15000,
          }
        );

        console.log(`[Props] Event ${event.id}: ${(oddsData.bookmakers || []).length} bookmakers responded`);

        // Parse each bookmaker's prop lines
        for (const bookmaker of oddsData.bookmakers || []) {
          for (const market of bookmaker.markets || []) {
            for (const outcome of market.outcomes || []) {
              if (!outcome.description) continue; // Skip non-player outcomes

              allProps.push({
                player: outcome.description,
                market: market.key,
                marketLabel: formatMarketName(market.key),
                game: `${event.away_team} @ ${event.home_team}`,
                gameId: event.id,
                commenceTime: event.commence_time,
                homeTeam: event.home_team,
                awayTeam: event.away_team,
                book: bookmaker.title,
                bookKey: bookmaker.key,
                side: outcome.name, // "Over" or "Under"
                point: outcome.point,
                price: outcome.price,
              });
            }
          }
        }
      } catch (err) {
        console.error(`[Props] Error fetching props for event ${event.id}:`, err.response?.status, err.response?.data?.message || err.message);
        // Continue to next event
      }
    }

    console.log(`[Props] Total raw prop lines collected: ${allProps.length}`);

    // Step 3: Consolidate into player prop objects
    const consolidated = consolidateProps(allProps);

    const result = {
      available: true,
      sport: sportKey,
      props: consolidated,
      count: consolidated.length,
      markets,
      eventsChecked: eventsToFetch.length,
    };

    cache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.error(`[Props] Top-level error for ${sportKey}:`, err.response?.status, err.response?.data?.message || err.message);
    return {
      available: false,
      message: `Failed to fetch props: ${err.response?.data?.message || err.message}`,
    };
  }
}

/**
 * Consolidate flat prop lines into grouped player prop objects
 */
function consolidateProps(rawProps) {
  const grouped = {};

  for (const prop of rawProps) {
    const key = `${prop.player}__${prop.market}__${prop.gameId}`;

    if (!grouped[key]) {
      grouped[key] = {
        player: prop.player,
        market: prop.market,
        marketLabel: prop.marketLabel,
        game: prop.game,
        gameId: prop.gameId,
        commenceTime: prop.commenceTime,
        homeTeam: prop.homeTeam,
        awayTeam: prop.awayTeam,
        books: {},
      };
    }

    if (!grouped[key].books[prop.book]) {
      grouped[key].books[prop.book] = {};
    }

    grouped[key].books[prop.book][prop.side.toLowerCase()] = {
      price: prop.price,
      point: prop.point,
    };
  }

  // Calculate consensus, best lines, edges
  return Object.values(grouped).map((prop) => {
    const bookEntries = Object.entries(prop.books);
    const overPoints = [];
    const allOvers = [];
    const allUnders = [];

    for (const [book, sides] of bookEntries) {
      if (sides.over) {
        overPoints.push(sides.over.point);
        allOvers.push({ book, ...sides.over });
      }
      if (sides.under) {
        allUnders.push({ book, ...sides.under });
      }
    }

    const consensusLine = overPoints.length > 0
      ? Math.round((overPoints.reduce((a, b) => a + b, 0) / overPoints.length) * 10) / 10
      : null;

    const bestOver = allOvers.length > 0
      ? allOvers.reduce((best, curr) => curr.price > best.price ? curr : best)
      : null;

    const bestUnder = allUnders.length > 0
      ? allUnders.reduce((best, curr) => curr.price > best.price ? curr : best)
      : null;

    const lineSpread = overPoints.length > 1
      ? Math.max(...overPoints) - Math.min(...overPoints)
      : 0;

    return {
      player: prop.player,
      market: prop.market,
      marketLabel: prop.marketLabel,
      game: prop.game,
      gameId: prop.gameId,
      commenceTime: prop.commenceTime,
      homeTeam: prop.homeTeam,
      awayTeam: prop.awayTeam,
      books: bookEntries.map(([name, sides]) => ({ name, ...sides })),
      consensusLine,
      bestOver,
      bestUnder,
      lineSpread,
      bookCount: bookEntries.length,
      hasEdge: lineSpread >= 1.5,
    };
  }).sort((a, b) => b.bookCount - a.bookCount);
}

/**
 * AI daily picks
 */
async function getDailyPicks(sportKey, props) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return { available: false, message: "Anthropic API key needed" };

  const topProps = props.slice(0, 25).map(p => ({
    player: p.player, market: p.marketLabel, line: p.consensusLine,
    game: p.game, bookCount: p.bookCount, hasEdge: p.hasEdge, lineSpread: p.lineSpread,
    bestOver: p.bestOver ? `${p.bestOver.book} ${p.bestOver.point} (${p.bestOver.price > 0 ? "+" : ""}${p.bestOver.price})` : null,
    bestUnder: p.bestUnder ? `${p.bestUnder.book} ${p.bestUnder.point} (${p.bestUnder.price > 0 ? "+" : ""}${p.bestUnder.price})` : null,
  }));

  try {
    const { data } = await axios.post("https://api.anthropic.com/v1/messages", {
      model: "claude-sonnet-4-20250514", max_tokens: 1500,
      system: `You are an elite sports betting analyst. Analyze player props and pick the best opportunities. Respond ONLY in valid JSON with no markdown.`,
      messages: [{ role: "user", content: `Analyze these ${sportKey.toUpperCase()} props and pick the 5-8 best plays:\n\n${JSON.stringify(topProps, null, 2)}\n\nRespond with: {"picks":[{"player":"name","market":"stat","pick":"OVER/UNDER","line":24.5,"bestBook":"book","bestOdds":"+110","confidence":75,"reasoning":"why","edge":"where value is"}],"summary":"overview"}` }],
    }, {
      headers: { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      timeout: 30000,
    });

    const text = data.content.filter(c => c.type === "text").map(c => c.text).join("");
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch (err) {
    console.error("AI picks error:", err.message);
    return { available: false, message: "Failed to generate AI picks" };
  }
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
