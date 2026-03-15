const axios = require("axios");
const NodeCache = require("node-cache");

const cache = new NodeCache({ stdTTL: 180 }); // 3 min cache to save API calls
const ODDS_BASE = "https://api.the-odds-api.com/v4";

// Sport key mapping for The Odds API
const PROP_SPORTS = {
  nba: "basketball_nba",
  nfl: "americanfootball_nfl",
  mlb: "baseball_mlb",
  nhl: "icehockey_nhl",
  ncaamb: "basketball_ncaab",
  ncaafb: "americanfootball_ncaaf",
};

// Player prop markets by sport
const PROP_MARKETS = {
  nba: [
    "player_points", "player_rebounds", "player_assists",
    "player_threes", "player_blocks", "player_steals",
    "player_points_rebounds_assists", "player_points_rebounds",
    "player_points_assists", "player_rebounds_assists",
    "player_double_double", "player_triple_double",
  ],
  nfl: [
    "player_pass_yds", "player_pass_tds", "player_pass_completions",
    "player_rush_yds", "player_rush_attempts", "player_rush_tds",
    "player_reception_yds", "player_receptions", "player_reception_tds",
    "player_anytime_td",
  ],
  mlb: [
    "batter_hits", "batter_total_bases", "batter_rbis",
    "batter_runs_scored", "batter_home_runs", "batter_stolen_bases",
    "pitcher_strikeouts", "pitcher_outs",
  ],
  nhl: [
    "player_points", "player_goals", "player_assists",
    "player_shots_on_goal", "player_blocked_shots",
  ],
};

/**
 * Get all player props for a sport with lines from multiple books
 */
async function getPlayerProps(sportKey, markets = null) {
  const apiKey = process.env.ODDS_API_KEY;
  if (!apiKey) return { available: false, message: "Odds API key not configured" };

  const oddsSport = PROP_SPORTS[sportKey];
  if (!oddsSport) return { available: false, message: `No props for ${sportKey}` };

  const requestedMarkets = markets || PROP_MARKETS[sportKey] || [];
  if (requestedMarkets.length === 0) return { available: false, message: "No prop markets for this sport" };

  // Batch markets in groups of 3 to conserve API calls
  const marketBatches = [];
  for (let i = 0; i < requestedMarkets.length; i += 3) {
    marketBatches.push(requestedMarkets.slice(i, i + 3));
  }

  const allProps = [];

  for (const batch of marketBatches) {
    const marketStr = batch.join(",");
    const cacheKey = `props_${sportKey}_${marketStr}`;
    const cached = cache.get(cacheKey);

    if (cached) {
      allProps.push(...cached);
      continue;
    }

    try {
      const { data } = await axios.get(`${ODDS_BASE}/sports/${oddsSport}/events`, {
        params: { apiKey },
        timeout: 10000,
      });

      // For each event, fetch props
      const eventProps = [];
      for (const event of data.slice(0, 8)) { // Limit to 8 games to save calls
        try {
          const { data: oddsData } = await axios.get(
            `${ODDS_BASE}/sports/${oddsSport}/events/${event.id}/odds`,
            {
              params: {
                apiKey,
                regions: "us",
                markets: marketStr,
                oddsFormat: "american",
              },
              timeout: 10000,
            }
          );

          // Parse bookmaker props
          const propsMap = {};

          for (const bookmaker of oddsData.bookmakers || []) {
            for (const market of bookmaker.markets || []) {
              for (const outcome of market.outcomes || []) {
                const key = `${outcome.description}_${market.key}`;
                if (!propsMap[key]) {
                  propsMap[key] = {
                    player: outcome.description,
                    market: market.key,
                    marketLabel: formatMarketName(market.key),
                    game: `${event.away_team} @ ${event.home_team}`,
                    gameId: event.id,
                    commenceTime: event.commence_time,
                    homeTeam: event.home_team,
                    awayTeam: event.away_team,
                    lines: [],
                  };
                }

                propsMap[key].lines.push({
                  book: bookmaker.title,
                  bookKey: bookmaker.key,
                  name: outcome.name, // "Over" or "Under"
                  point: outcome.point,
                  price: outcome.price,
                });
              }
            }
          }

          eventProps.push(...Object.values(propsMap));
        } catch (err) {
          // Skip events that fail
          console.error(`Props fetch error for event ${event.id}:`, err.message);
        }
      }

      cache.set(cacheKey, eventProps);
      allProps.push(...eventProps);
    } catch (err) {
      console.error(`Events fetch error (${sportKey}):`, err.message);
    }
  }

  // Group by player, merge over/under lines per book
  const playerProps = consolidateProps(allProps);

  return {
    available: true,
    sport: sportKey,
    props: playerProps,
    count: playerProps.length,
    markets: requestedMarkets,
  };
}

/**
 * Consolidate raw props into structured player prop objects
 */
function consolidateProps(rawProps) {
  const grouped = {};

  for (const prop of rawProps) {
    const key = `${prop.player}_${prop.market}`;
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
        consensusLine: null,
      };
    }

    for (const line of prop.lines) {
      if (!grouped[key].books[line.book]) {
        grouped[key].books[line.book] = {};
      }
      grouped[key].books[line.book][line.name.toLowerCase()] = {
        price: line.price,
        point: line.point,
      };
    }
  }

  // Calculate consensus line and detect edges
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
      ? overPoints.reduce((a, b) => a + b, 0) / overPoints.length
      : null;

    // Find best over and best under
    const bestOver = allOvers.length > 0
      ? allOvers.reduce((best, curr) => curr.price > best.price ? curr : best)
      : null;
    const bestUnder = allUnders.length > 0
      ? allUnders.reduce((best, curr) => curr.price > best.price ? curr : best)
      : null;

    // Detect line discrepancies (edges)
    const lineSpread = overPoints.length > 1
      ? Math.max(...overPoints) - Math.min(...overPoints)
      : 0;

    return {
      ...prop,
      books: bookEntries.map(([name, sides]) => ({ name, ...sides })),
      consensusLine: consensusLine ? Math.round(consensusLine * 10) / 10 : null,
      bestOver,
      bestUnder,
      lineSpread,
      bookCount: bookEntries.length,
      hasEdge: lineSpread >= 1.5, // Flag props with line discrepancies
    };
  }).sort((a, b) => b.bookCount - a.bookCount); // Most covered props first
}

/**
 * Generate AI-powered daily top picks
 */
async function getDailyPicks(sportKey, props) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return { available: false, message: "Anthropic API key needed for AI picks" };

  // Take top 30 props by book coverage
  const topProps = props.slice(0, 30).map(p => ({
    player: p.player,
    market: p.marketLabel,
    line: p.consensusLine,
    game: p.game,
    bookCount: p.bookCount,
    bestOver: p.bestOver ? `${p.bestOver.book} ${p.bestOver.point} (${p.bestOver.price > 0 ? '+' : ''}${p.bestOver.price})` : null,
    bestUnder: p.bestUnder ? `${p.bestUnder.book} ${p.bestUnder.point} (${p.bestUnder.price > 0 ? '+' : ''}${p.bestUnder.price})` : null,
    hasEdge: p.hasEdge,
    lineSpread: p.lineSpread,
  }));

  try {
    const { data } = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 1500,
        system: `You are an elite sports betting analyst. Analyze player props and pick the best opportunities.
Respond ONLY in valid JSON with no markdown. Evaluate each prop considering:
- Line value (are any books offering +EV?)
- Line discrepancies between books (edges)
- Historical player performance context
- Matchup context
Pick the 5-8 BEST props from the list.`,
        messages: [{
          role: "user",
          content: `Analyze these ${sportKey.toUpperCase()} player props and pick the best plays today:

${JSON.stringify(topProps, null, 2)}

Respond ONLY with this JSON:
{
  "picks": [
    {
      "player": "name",
      "market": "stat type",
      "pick": "OVER" or "UNDER",
      "line": 24.5,
      "bestBook": "book name",
      "bestOdds": "+110",
      "confidence": 75,
      "reasoning": "Short 1-2 sentence reason",
      "edge": "Where the value is"
    }
  ],
  "summary": "Brief 1-2 sentence overview of today's board"
}`
        }],
      },
      {
        headers: {
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        timeout: 30000,
      }
    );

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
    player_rush_attempts: "Rush Attempts", player_rush_tds: "Rush TDs",
    player_reception_yds: "Rec Yards", player_receptions: "Receptions",
    player_reception_tds: "Rec TDs", player_anytime_td: "Anytime TD",
    batter_hits: "Hits", batter_total_bases: "Total Bases",
    batter_rbis: "RBIs", batter_runs_scored: "Runs", batter_home_runs: "Home Runs",
    batter_stolen_bases: "Stolen Bases", pitcher_strikeouts: "Strikeouts",
    pitcher_outs: "Outs Recorded",
    player_goals: "Goals", player_shots_on_goal: "Shots on Goal",
    player_blocked_shots: "Blocked Shots",
  };
  return map[key] || key.replace(/player_|batter_|pitcher_/g, "").replace(/_/g, " ");
}

module.exports = { getPlayerProps, getDailyPicks, PROP_SPORTS, PROP_MARKETS };
