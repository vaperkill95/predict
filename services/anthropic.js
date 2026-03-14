const axios = require("axios");

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

/**
 * Generate AI prediction for a game
 */
async function predictGame(gameData, oddsData = null) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return generateFallbackPrediction(gameData);
  }

  const systemPrompt = `You are an elite sports analyst AI. You provide sharp, data-driven predictions for sports games. 
You ALWAYS respond in valid JSON format with no markdown or extra text.

Your analysis should include:
- Win probability for each team (must sum to 100)
- Predicted score
- Spread prediction
- Over/under prediction
- Key factors driving the prediction
- Confidence level (0-100)
- Top player to watch on each team
- A brief bold prediction / hot take

Be specific, use team context, recent form, historical matchups, and any data provided.
Always respond ONLY with the JSON object, no backticks or markdown.`;

  const prompt = `Analyze this game and predict the outcome:

GAME DATA:
${JSON.stringify(gameData, null, 2)}

${oddsData ? `CURRENT ODDS/LINES:\n${JSON.stringify(oddsData, null, 2)}` : ""}

Respond ONLY with this JSON structure:
{
  "homeTeam": "team name",
  "awayTeam": "team name",
  "homeWinProb": 55.5,
  "awayWinProb": 44.5,
  "predictedScore": { "home": 110, "away": 105 },
  "spread": { "favorite": "team name", "line": -4.5 },
  "overUnder": { "prediction": "OVER", "total": 215.5 },
  "confidence": 72,
  "keyFactors": ["factor 1", "factor 2", "factor 3"],
  "playersToWatch": {
    "home": { "name": "Player Name", "reason": "why" },
    "away": { "name": "Player Name", "reason": "why" }
  },
  "hotTake": "One bold sentence prediction",
  "recommendation": "Brief betting angle if any"
}`;

  try {
    const { data } = await axios.post(
      ANTHROPIC_URL,
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
        system: systemPrompt,
      },
      {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        timeout: 30000,
      }
    );

    const text = data.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");

    // Parse JSON, stripping any markdown fences
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error("Anthropic prediction error:", err.message);
    return generateFallbackPrediction(gameData);
  }
}

/**
 * Generate AI player stat projection
 */
async function predictPlayer(playerName, sport, context = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      player: playerName,
      sport,
      available: false,
      message: "AI predictions require an Anthropic API key",
    };
  }

  const systemPrompt = `You are an elite sports analytics AI specializing in player performance projections.
You provide detailed stat line predictions based on player history, matchup context, and trends.
Always respond ONLY in valid JSON with no markdown or extra text.`;

  const prompt = `Project the stat line for ${playerName} in their next ${sport.toUpperCase()} game.

${context.opponent ? `Opponent: ${context.opponent}` : ""}
${context.recentStats ? `Recent stats: ${JSON.stringify(context.recentStats)}` : ""}

Respond ONLY with this JSON structure (adjust stat categories for the sport):
{
  "player": "${playerName}",
  "sport": "${sport}",
  "projection": {
    "stat1_name": { "value": 25.5, "range": [20, 31], "confidence": 70 },
    "stat2_name": { "value": 7.2, "range": [5, 10], "confidence": 65 }
  },
  "overallConfidence": 68,
  "narrative": "Brief analysis of why these projections",
  "bestProp": { "stat": "stat name", "line": 24.5, "pick": "OVER", "confidence": 72 },
  "comparison": "How this compares to season average"
}`;

  try {
    const { data } = await axios.post(
      ANTHROPIC_URL,
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
        system: systemPrompt,
      },
      {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        timeout: 30000,
      }
    );

    const text = data.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");

    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error("Anthropic player prediction error:", err.message);
    return {
      player: playerName,
      sport,
      available: false,
      message: "Failed to generate prediction",
    };
  }
}

/**
 * Fallback prediction when no API key
 */
function generateFallbackPrediction(gameData) {
  const home = gameData.home?.name || "Home Team";
  const away = gameData.away?.name || "Away Team";
  return {
    homeTeam: home,
    awayTeam: away,
    homeWinProb: 52,
    awayWinProb: 48,
    confidence: 0,
    keyFactors: [
      "AI predictions require an Anthropic API key",
      "Add ANTHROPIC_API_KEY to your .env to enable full predictions",
      "Live scores and odds are still available",
    ],
    hotTake: "Configure your Anthropic API key to unlock AI-powered predictions!",
    fallback: true,
  };
}

module.exports = { predictGame, predictPlayer };
