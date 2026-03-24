/**
 * ORACLE Bot API — AI-Powered Assistant
 * 
 * Uses Claude Haiku to answer user questions about sports betting,
 * explain features, and suggest picks based on ORACLE's live data.
 * 
 * Cost: ~$0.25 per 1,000 conversations using Haiku
 */

const express = require("express");
const axios = require("axios");
const router = express.Router();

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3001;

// Rate limit per IP — max 20 questions per 15 minutes
const rateLimits = {};
const RATE_LIMIT = 20;
const RATE_WINDOW = 15 * 60 * 1000;

function checkRateLimit(ip) {
  const now = Date.now();
  if (!rateLimits[ip] || now - rateLimits[ip].start > RATE_WINDOW) {
    rateLimits[ip] = { start: now, count: 1 };
    return true;
  }
  rateLimits[ip].count++;
  return rateLimits[ip].count <= RATE_LIMIT;
}

// Cache for ORACLE data context — refreshes every 5 minutes
let contextCache = { data: null, time: 0 };
const CONTEXT_TTL = 5 * 60 * 1000;

async function getOracleContext() {
  const now = Date.now();
  if (contextCache.data && now - contextCache.time < CONTEXT_TTL) return contextCache.data;

  const ctx = {};
  try {
    // Use direct cache access to avoid rate limiting
    let smartPicks, gamePredictions, evEngine, parlayBuilder;
    try { smartPicks = require('./smart-picks'); } catch(e) {}
    try { gamePredictions = require('./game-predictions'); } catch(e) {}
    try { evEngine = require('./ev-engine'); } catch(e) {}
    try { parlayBuilder = require('./parlay-builder'); } catch(e) {}

    // Get picks from smart-picks cache
    if (smartPicks && smartPicks.picksCache) {
      var cached = smartPicks.picksCache['nba'];
      ctx.topPicks = (cached && cached.picks ? cached.picks : []).slice(0, 5).map(function(p) {
        return { player: p.player, market: p.market, pick: p.pick, line: p.line,
          confidence: p.confidence, grade: p.grade, projection: p.projection,
          hitRate: p.hitRate, bestBook: p.bestBook, reasoning: p.reasoning,
          game: p.game, seasonAvg: p.seasonAvg, l5Avg: p.l5Avg };
      });
    }

    // Get game predictions from cache
    if (gamePredictions && gamePredictions.gamesCache) {
      var gCached = gamePredictions.gamesCache['nba'];
      ctx.gamePredictions = (gCached && gCached.games ? gCached.games : []).slice(0, 6).map(function(g) {
        return { home: g.homeTeam, away: g.awayTeam, homeAbbr: g.homeAbbr, awayAbbr: g.awayAbbr,
          winner: g.predictions ? g.predictions.winner.team : null,
          winnerConf: g.predictions ? g.predictions.winner.confidence : null,
          spread: g.predictions ? g.predictions.spread.spread : null,
          spreadConf: g.predictions ? g.predictions.spread.confidence : null,
          total: g.predictions ? g.predictions.total.total : null,
          totalSide: g.predictions ? g.predictions.total.side : null,
          environment: g.environment, bookCount: g.bookCount };
      });
    }

    // Get EV bets from cache
    if (evEngine && evEngine.evCache) {
      ctx.evBets = (evEngine.evCache || []).slice(0, 5).map(function(b) {
        return { player: b.player, market: b.market, pick: b.pick, line: b.line,
          book: b.book, odds: b.oddsDisplay, edge: b.edgePercent, ev: b.evPer100, grade: b.grade };
      });
    }

    // Get accuracy from parlay builder
    if (parlayBuilder && parlayBuilder.getHistoricalStats) {
      var stats = parlayBuilder.getHistoricalStats();
      ctx.accuracy = stats.overall || {};
    }

    // Get props from smart-picks cache
    if (smartPicks && smartPicks.picksCache) {
      var pCached = smartPicks.picksCache['nba'];
      var allProps = pCached && pCached.picks ? pCached.picks : [];
      // Fallback: fetch props from Redis if cache only has picks not full props
      try {
        var redisCache = require('./redis-cache');
        if (redisCache && redisCache.isConnected()) {
          var rData = await redisCache.getProps('nba');
          if (rData && rData.props && rData.props.length > 0) allProps = rData.props;
        }
      } catch(e) {}
      ctx.propsCount = allProps.length;
      ctx.demons = allProps.filter(function(p) { return p.lineType === 'demon'; }).length;
      ctx.demonProps = allProps.filter(function(p) { return p.lineType === 'demon'; }).slice(0, 10).map(function(p) {
        return { player: p.player, market: p.marketLabel || p.market, line: p.consensusLine,
          bookCount: p.bookCount, game: p.game, lineType: p.lineType,
          hitRate: p.analytics ? p.analytics.hitRate : null, seasonAvg: p.analytics ? p.analytics.seasonAvg : null,
          l5Avg: p.analytics ? p.analytics.l5Avg : null, suggestion: p.analytics ? p.analytics.suggestion : null };
      });
      ctx.highHitRate = allProps.filter(function(p) { return p.analytics && p.analytics.hitRate >= 60; }).slice(0, 8).map(function(p) {
        return { player: p.player, market: p.marketLabel || p.market, line: p.consensusLine,
          hitRate: p.analytics.hitRate, bookCount: p.bookCount, game: p.game,
          suggestion: p.analytics.suggestion, seasonAvg: p.analytics.seasonAvg };
      });
    }

    contextCache = { data: ctx, time: now };
    return ctx;
  } catch (e) {
    console.warn('[BotAPI] Context error:', e.message);
    return ctx;
  }
}

const SYSTEM_PROMPT = `You are ORACLE Assistant — an AI sports betting guide embedded in the ORACLE prediction engine website (www.oraclepredictapp.com). You help users understand what they're looking at, explain sports betting concepts, suggest picks, and BUILD PARLAYS based on ORACLE's live data.

PERSONALITY:
- Confident but not reckless. You give clear recommendations with reasoning.
- Concise — keep answers under 200 words unless building a parlay or explaining complex concepts.
- Use sports betting terminology naturally but explain it when a user seems new.
- Always recommend responsible gambling. Mention "for entertainment purposes" when giving picks.
- Never guarantee wins. Use language like "the data favors", "ORACLE leans", "the model suggests".

WHEN BUILDING PARLAYS:
- When asked to build a parlay, combine the HIGHEST CONFIDENCE picks from the data provided.
- For "safest" or "near guarantee" requests, choose picks with: highest hit rate (60%+), Demon lines (6+ books agree), and strong recent form.
- For each leg, explain WHY it's included (hit rate, trend, matchup, book consensus).
- Show the parlay in a clean format: Leg 1, Leg 2, Leg 3 etc. with the pick details.
- For same-game parlays (SGP), combine a game prediction pick + player props from the same game.
- Warn users that NO parlay is guaranteed — even 90% confidence legs can lose.
- For longshot parlays, pick interesting +EV or high-odds props with decent reasoning.
- Always mention which sportsbook has the best odds for each leg.

WHEN SUGGESTING "SAFEST" BETS:
- Prioritize: highest hit rate > Demon lines > high book count > strong recent form > favorable matchup.
- A "safe" pick is one where: hit rate is 70%+, 6+ books agree on the line, and recent form supports it.
- Combine 2-3 safe picks for a parlay, not 5-6 (fewer legs = higher probability).
- Be honest: even the "safest" parlay has risk. Frame it as "highest probability based on the data."

WHEN SUGGESTING PICKS:
- Always reference specific data: projection, hit rate, grade, confidence, best book.
- Explain WHY — what factors make this pick strong.
- If asked OVER or UNDER, give a clear direction with reasoning.
- Mention the best sportsbook to place the bet at.

WHEN EXPLAINING FEATURES:
- Be helpful and patient. Many users are new to sports betting.
- Reference ORACLE's specific features: 18-factor model, 20+ sportsbooks, Demons/Goblins/Edges, +EV, CLV, RLM, Kelly sizing.

ORACLE'S PAGES:
- /app/ — Main app with Player Props, Top Picks, Trending, History, Scores, Predictor, Standings
- /games — Game Predictions with ESPN Live data (spread, total, winner for every game)
- /sharp — Sharp Dashboard (+EV bets, RLM alerts, steam moves, middles, arbs, Kelly calc)
- /parlay — Parlay Builder + Accuracy Record
- /pick — Pick of the Day (single highest-conviction bet)
- /player — Player Profiles (search any player for game log, props, hit rates)
- /props — Props Explorer (all props across 20+ books)
- /futures — Championship contender tiers and playoff projections
- /consensus — Picks where AI + books + edge detection all agree
- /bankroll — Personal bet tracker
- /record — ORACLE's public accuracy record
- /share — Generate branded share cards for picks

KEY TERMS:
- Demon = 6+ books agree on a line (high consensus = reliable)
- Goblin = 3+ point spread between books (possible trap or value)
- Edge = 1.5+ point outlier at one book
- +EV = positive expected value (mathematically profitable long-term)
- CLV = closing line value (did the line move in your favor)
- RLM = reverse line movement (sharp money opposite of public)
- SGP = same game parlay (multiple bets from one game)

FORMAT: Use plain text. No markdown. Keep it conversational. Use emojis sparingly for emphasis.`;

router.post("/ask", async (req, res) => {
  const { question, page, conversationHistory } = req.body;
  if (!question) return res.json({ error: "Question required" });

  // Rate limit
  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
  if (!checkRateLimit(ip)) {
    return res.json({ answer: "You're asking a lot of questions! Give me a minute to catch my breath. Try again in a few minutes. 😅" });
  }

  // If no API key, fall back to simple responses
  if (!ANTHROPIC_KEY) {
    return res.json({ answer: "I'm in basic mode right now — the AI engine is being set up. In the meantime, check out the Pick of the Day at /pick or browse Top Picks in the main app!", fallback: true });
  }

  try {
    // Get live ORACLE data for context
    const ctx = await getOracleContext();

    // Build context message
    let dataContext = `CURRENT ORACLE DATA (live):\n`;
    if (ctx.topPicks?.length) {
      dataContext += `\nTOP PICKS RIGHT NOW:\n`;
      for (const p of ctx.topPicks) {
        dataContext += `- ${p.player}: ${p.pick} ${p.line} ${p.market} | Grade ${p.grade} (${p.confidence}%) | Proj: ${p.projection?.toFixed?.(1) || '?'} | Hit: ${p.hitRate?.toFixed?.(0) || '?'}% | Best: ${p.bestBook} | ${p.game}\n  Reasoning: ${p.reasoning || 'N/A'}\n`;
      }
    }
    if (ctx.gamePredictions?.length) {
      dataContext += `\nGAME PREDICTIONS:\n`;
      for (const g of ctx.gamePredictions) {
        dataContext += `- ${g.away} @ ${g.home}: Winner ${g.winner} (${g.winnerConf}%), Spread ${g.spread} (${g.spreadConf}%), Total ${g.totalSide} ${g.total}, ${g.environment}, ${g.bookCount} books\n`;
      }
    }
    if (ctx.evBets?.length) {
      dataContext += `\n+EV BETS:\n`;
      for (const b of ctx.evBets) {
        dataContext += `- ${b.player} ${b.pick} ${b.line} ${b.market} at ${b.book} (${b.odds}) — Edge: ${b.edge}%, EV: +$${b.ev}/bet, Grade ${b.grade}\n`;
      }
    }
    if (ctx.accuracy) {
      dataContext += `\nACCURACY RECORD: ${ctx.accuracy.total || 0} total picks, ${ctx.accuracy.hits || 0} hits, ${ctx.accuracy.hitRate || 0}% hit rate, ${ctx.accuracy.pending || 0} pending\n`;
    }
    dataContext += `\nProps available: ${ctx.propsCount || 0} | Demons detected: ${ctx.demons || 0}\n`;
    if (ctx.demonProps?.length) {
      dataContext += `\nDEMON LINES (6+ books agree — great for parlays):\n`;
      for (const p of ctx.demonProps) {
        dataContext += `- ${p.player}: ${p.suggestion || '?'} ${p.line} ${p.market} | ${p.bookCount} books | Hit: ${p.hitRate?.toFixed?.(0) || '?'}% | Avg: ${p.seasonAvg?.toFixed?.(1) || '?'} | L5: ${p.l5Avg?.toFixed?.(1) || '?'} | ${p.game}\n`;
      }
    }
    if (ctx.highHitRate?.length) {
      dataContext += `\nHIGH HIT RATE PROPS (60%+ — safest picks):\n`;
      for (const p of ctx.highHitRate) {
        dataContext += `- ${p.player}: ${p.suggestion || '?'} ${p.line} ${p.market} | Hit: ${p.hitRate?.toFixed?.(0) || '?'}% | ${p.bookCount} books | Avg: ${p.seasonAvg?.toFixed?.(1) || '?'} | ${p.game}\n`;
      }
    }
    dataContext += `\nUser is on page: ${page || 'unknown'}\n`;

    // Build messages
    const messages = [];
    
    // Include conversation history (last 6 messages max)
    if (conversationHistory?.length) {
      for (const msg of conversationHistory.slice(-6)) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    // Add the current question with context
    messages.push({
      role: "user",
      content: `${dataContext}\n\nUSER QUESTION: ${question}`,
    });

    // Call Claude Haiku
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages,
      },
      {
        headers: {
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        timeout: 15000,
      }
    );

    const answer = response.data?.content?.[0]?.text || "I couldn't generate a response. Try asking differently!";

    res.json({ answer, model: "haiku", tokens: response.data?.usage });
  } catch (e) {
    console.error("[Bot] Error:", e.response?.data?.error?.message || e.message);
    // Fallback to a helpful response
    res.json({
      answer: "I'm having trouble connecting to my AI brain right now. But I can still help! Check out the Top Picks tab in the app for ORACLE's best suggestions, or visit /games for game predictions.",
      fallback: true,
    });
  }
});

// Simple health check
router.get("/status", (req, res) => {
  res.json({
    active: !!ANTHROPIC_KEY,
    model: "claude-haiku-4-5-20251001",
    rateLimits: Object.keys(rateLimits).length,
  });
});

module.exports = { router };
