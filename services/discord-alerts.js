/**
 * discord-alerts.js — Discord Webhook Alerts for High-Confidence Props
 * 
 * Sends alerts to a Discord channel when:
 *   - New Demon lines are detected (6+ books agree)
 *   - AI picks have 75%+ confidence
 *   - Significant line movement (1+ point shift)
 *   - CDL high-edge props (65%+ confidence)
 * 
 * Setup:
 *   1. Create a Discord webhook in your channel (Channel Settings > Integrations > Webhooks)
 *   2. Set DISCORD_WEBHOOK_URL in your .env
 *   3. Add to server.js:
 *      const discordAlerts = require('./services/discord-alerts');
 *      discordAlerts.start(fetchPropsFunc, fetchPicksFunc);
 */

const axios = require('axios');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour per player+market (don't spam)

// Track what we've already alerted on
const alertedProps = new Map(); // key -> timestamp

/**
 * Check if we should send an alert (cooldown check)
 */
function shouldAlert(key) {
  const lastAlerted = alertedProps.get(key);
  if (!lastAlerted) return true;
  return Date.now() - lastAlerted > ALERT_COOLDOWN_MS;
}

function markAlerted(key) {
  alertedProps.set(key, Date.now());
  // Clean old entries
  const cutoff = Date.now() - ALERT_COOLDOWN_MS * 2;
  for (const [k, v] of alertedProps) {
    if (v < cutoff) alertedProps.delete(k);
  }
}

/**
 * Send a Discord embed message
 */
async function sendDiscordEmbed(embed) {
  if (!WEBHOOK_URL) return;

  try {
    await axios.post(WEBHOOK_URL, {
      username: "ORACLE",
      avatar_url: "https://predict-production-c236.up.railway.app/static/favicons/cdl.png",
      embeds: [embed],
    });
  } catch (err) {
    console.error('Discord webhook failed:', err.message);
  }
}

/**
 * Format American odds with + prefix
 */
function fmtOdds(price) {
  if (!price) return '';
  return price > 0 ? `+${price}` : `${price}`;
}

// ============================================================
// Alert Types
// ============================================================

/**
 * Alert: New Demon line detected
 */
async function alertDemon(prop, sport) {
  const key = `demon|${prop.player}|${prop.market}`;
  if (!shouldAlert(key)) return;

  const bookList = (prop.books || [])
    .map(b => `${b.name}: **${b.over?.point}** (O ${fmtOdds(b.over?.price)} / U ${fmtOdds(b.under?.price)})`)
    .join('\n');

  await sendDiscordEmbed({
    title: `🔥 DEMON — ${prop.player}`,
    description: `**${prop.marketLabel}** line detected with strong book consensus`,
    color: 0xF59E0B, // amber
    fields: [
      { name: "Game", value: prop.game, inline: true },
      { name: "Sport", value: sport.toUpperCase(), inline: true },
      { name: "Consensus Line", value: `**${prop.consensusLine}**`, inline: true },
      { name: "Books Agree", value: `${prop.bookCount} books`, inline: true },
      { name: "Line Spread", value: `${prop.lineSpread} pts`, inline: true },
      { name: "Edge", value: prop.hasEdge ? "✅ Yes" : "—", inline: true },
      { name: "Book Lines", value: bookList || "—", inline: false },
    ],
    footer: { text: "ORACLE — AI Sports Prediction Engine" },
    timestamp: new Date().toISOString(),
  });

  markAlerted(key);
}

/**
 * Alert: AI High-Confidence Pick
 */
async function alertAIPick(pick, sport) {
  const key = `ai|${pick.player}|${pick.market}`;
  if (!shouldAlert(key)) return;

  const pickColor = pick.pick === 'OVER' ? 0x10B981 : 0xEF4444; // green or red

  await sendDiscordEmbed({
    title: `🤖 AI PICK — ${pick.player} ${pick.pick}`,
    description: pick.reasoning || "High confidence AI pick",
    color: pickColor,
    fields: [
      { name: "Market", value: pick.market, inline: true },
      { name: "Confidence", value: `**${pick.confidence}%**`, inline: true },
      { name: "Line", value: `${pick.line}`, inline: true },
      { name: "Best Book", value: pick.bestBook || "—", inline: true },
      { name: "Best Odds", value: pick.bestOdds || "—", inline: true },
      { name: "Sport", value: sport.toUpperCase(), inline: true },
    ],
    footer: { text: "ORACLE — AI Sports Prediction Engine" },
    timestamp: new Date().toISOString(),
  });

  markAlerted(key);
}

/**
 * Alert: Significant line movement
 */
async function alertMovement(move, sport) {
  const key = `move|${move.player}|${move.market}`;
  if (!shouldAlert(key)) return;

  const arrow = move.direction === 'UP' ? '📈' : '📉';
  const color = move.direction === 'UP' ? 0xF59E0B : 0x38BDF8;

  await sendDiscordEmbed({
    title: `${arrow} LINE MOVE — ${move.player}`,
    description: `**${move.market}** line moved **${move.movement > 0 ? '+' : ''}${move.movement.toFixed(1)}** points`,
    color,
    fields: [
      { name: "Game", value: move.game, inline: true },
      { name: "Open Line", value: `${move.openLine}`, inline: true },
      { name: "Current Line", value: `**${move.currentLine}**`, inline: true },
      { name: "Sport", value: sport.toUpperCase(), inline: true },
    ],
    footer: { text: "ORACLE — AI Sports Prediction Engine" },
    timestamp: new Date().toISOString(),
  });

  markAlerted(key);
}

/**
 * Alert: CDL high-edge prop
 */
async function alertCDLEdge(prop) {
  const key = `cdl|${prop.player}|${prop.market}`;
  if (!shouldAlert(key)) return;

  const bestEdge = prop.edge || {};

  await sendDiscordEmbed({
    title: `🎮 CDL EDGE — ${prop.player}`,
    description: `**${prop.label}** — ${bestEdge.direction} at ${bestEdge.confidence}% confidence`,
    color: 0x22C55E,
    fields: [
      { name: "Team", value: prop.team || "—", inline: true },
      { name: "Line", value: `${prop.line}`, inline: true },
      { name: "Avg", value: `${prop.avg}`, inline: true },
      { name: "Games", value: `${prop.games}`, inline: true },
      { name: "Edge", value: `${bestEdge.direction} ${bestEdge.confidence}%`, inline: true },
    ],
    footer: { text: "ORACLE — AI Sports Prediction Engine" },
    timestamp: new Date().toISOString(),
  });

  markAlerted(key);
}

// ============================================================
// Main Check Loop
// ============================================================

async function checkAndAlert(fetchProps, fetchPicks) {
  if (!WEBHOOK_URL) return;

  const sports = ['nba', 'nfl', 'mlb', 'nhl'];

  for (const sport of sports) {
    try {
      // Check props for Demons
      const propsData = await fetchProps(sport).catch(() => ({ props: [] }));
      const props = propsData.props || [];
      
      for (const prop of props) {
        if (prop.lineType === 'demon') {
          await alertDemon(prop, sport);
        }
      }

      // Check AI picks for high confidence
      const picksData = await fetchPicks(sport).catch(() => ({ picks: [] }));
      const picks = picksData.picks || [];

      for (const pick of picks) {
        if (pick.confidence >= 75) {
          await alertAIPick(pick, sport);
        }
      }
    } catch (err) {
      console.error(`Discord alert check failed for ${sport}:`, err.message);
    }
  }

  // Check CDL props for edges
  try {
    const cdlResp = await fetchProps('cdl').catch(() => ({ matches: [] }));
    // CDL props have a different structure
    if (cdlResp.matches) {
      for (const match of cdlResp.matches) {
        const allPlayers = [...(match.team1?.players || []), ...(match.team2?.players || [])];
        for (const player of allPlayers) {
          for (const prop of (player.props || [])) {
            if (prop.edge?.confidence >= 65) {
              await alertCDLEdge({ ...prop, player: player.player, team: player.team });
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('CDL Discord alert check failed:', err.message);
  }

  // Check line movement for big moves
  try {
    for (const sport of sports) {
      const moveResp = await axios.get(
        `http://localhost:${process.env.PORT || 3000}/api/movement/${sport}/biggest?limit=5`
      ).catch(() => ({ data: { biggestMoves: [] } }));

      for (const move of (moveResp.data?.biggestMoves || [])) {
        if (Math.abs(move.movement) >= 1.0) {
          await alertMovement(move, sport);
        }
      }
    }
  } catch (err) {
    console.error('Movement Discord alert check failed:', err.message);
  }
}

/**
 * Start the alert checking cron
 */
function start(fetchProps, fetchPicks) {
  if (!WEBHOOK_URL) {
    console.log('Discord alerts: DISCORD_WEBHOOK_URL not set — alerts disabled');
    return;
  }

  console.log('Discord alerts started (checking every 10 min)');

  // Initial check after 30 seconds (let data load first)
  setTimeout(() => {
    checkAndAlert(fetchProps, fetchPicks).catch(err =>
      console.error('Initial Discord alert check failed:', err.message)
    );
  }, 30000);

  // Recurring checks
  setInterval(() => {
    checkAndAlert(fetchProps, fetchPicks).catch(err =>
      console.error('Discord alert check failed:', err.message)
    );
  }, CHECK_INTERVAL_MS);
}

module.exports = { start, alertDemon, alertAIPick, alertMovement, alertCDLEdge, checkAndAlert };
