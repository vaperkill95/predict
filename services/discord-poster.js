/**
 * discord-poster.js — Auto-Post ORACLE Picks to Discord
 * 
 * Sends rich embed messages to Discord channels via webhooks:
 *   - NBA/NHL/MLB/NFL picks every 30 min
 *   - +EV bets every 30 min
 *   - Game predictions every 2 hours
 *   - Pick of the Day once daily
 *   - Graded results after games finish
 */

const axios = require("axios");

const WEBHOOKS = {
  nba: process.env.DISCORD_WEBHOOK_NBA,
  nhl: process.env.DISCORD_WEBHOOK_NHL,
  mlb: process.env.DISCORD_WEBHOOK_MLB,
  nfl: process.env.DISCORD_WEBHOOK_NFL,
  potd: process.env.DISCORD_WEBHOOK_POTD,
  ev: process.env.DISCORD_WEBHOOK_EV,
  games: process.env.DISCORD_WEBHOOK_GAMES,
  results: process.env.DISCORD_WEBHOOK_RESULTS,
};

const COLORS = {
  green: 0x10b981,
  red: 0xef4444,
  blue: 0x38bdf8,
  purple: 0xa78bfa,
  amber: 0xf59e0b,
  gray: 0x94a3b8,
};

// Track what we've already posted to avoid duplicates
const posted = {
  picks: {},    // sport -> timestamp of last post
  ev: 0,
  games: 0,
  potd: '',
  results: 0,
};

/**
 * Send a Discord webhook message with embeds
 */
async function sendWebhook(webhookUrl, embeds, content) {
  if (!webhookUrl) return;
  try {
    await axios.post(webhookUrl, {
      content: content || null,
      embeds: embeds.slice(0, 10), // Discord max 10 embeds per message
    }, { timeout: 10000 });
  } catch (e) {
    console.warn(`[Discord] Webhook failed: ${e.message}`);
  }
}

/**
 * Post top picks for a sport
 */
async function postPicks(sport, picks) {
  const webhook = WEBHOOKS[sport];
  if (!webhook || !picks || picks.length === 0) return;

  // Don't re-post within 25 minutes
  if (posted.picks[sport] && Date.now() - posted.picks[sport] < 25 * 60 * 1000) return;

  const sportName = sport.toUpperCase();
  const timestamp = new Date().toISOString();

  const embeds = picks.slice(0, 5).map(function(p) {
    var dirColor = p.pick === 'OVER' ? COLORS.green : COLORS.red;
    var gradeColor = (p.grade && p.grade.indexOf('A') >= 0) ? COLORS.green : (p.grade && p.grade.indexOf('B') >= 0) ? COLORS.blue : COLORS.amber;

    return {
      title: (p.pick === 'OVER' ? '🟢' : '🔴') + ' ' + p.player + ' — ' + p.pick + ' ' + p.line + ' ' + p.market,
      description: p.reasoning || '',
      color: dirColor,
      fields: [
        { name: 'Grade', value: p.grade || '—', inline: true },
        { name: 'Confidence', value: (p.confidence || 0) + '%', inline: true },
        { name: 'Projection', value: p.projection ? p.projection.toFixed(1) : '—', inline: true },
        { name: 'Hit Rate', value: p.hitRate ? p.hitRate.toFixed(0) + '%' : '—', inline: true },
        { name: 'Best Book', value: p.bestBook || '—', inline: true },
        { name: 'Game', value: p.game || '—', inline: true },
      ],
      footer: { text: '⟁ ORACLE — oraclepredictapp.com' },
      timestamp: timestamp,
    };
  });

  await sendWebhook(webhook, embeds, '🔮 **ORACLE ' + sportName + ' Picks** — ' + picks.length + ' picks generated');
  posted.picks[sport] = Date.now();
  console.log('[Discord] Posted ' + picks.length + ' ' + sportName + ' picks');
}

/**
 * Post +EV bets
 */
async function postEV(bets) {
  var webhook = WEBHOOKS.ev;
  if (!webhook || !bets || bets.length === 0) return;
  if (Date.now() - posted.ev < 25 * 60 * 1000) return;

  var timestamp = new Date().toISOString();

  var embeds = bets.slice(0, 5).map(function(b) {
    return {
      title: '💰 ' + b.player + ' — ' + b.pick + ' ' + b.line + ' ' + b.market,
      color: COLORS.green,
      fields: [
        { name: 'Book', value: b.book || '—', inline: true },
        { name: 'Odds', value: b.oddsDisplay || '—', inline: true },
        { name: 'Edge', value: b.edgePercent ? b.edgePercent + '%' : '—', inline: true },
        { name: 'EV/$100', value: b.evPer100 ? '+$' + b.evPer100 : '—', inline: true },
        { name: 'Grade', value: b.grade || '—', inline: true },
        { name: 'Game', value: b.game || '—', inline: true },
      ],
      footer: { text: '⟁ ORACLE Sharp Tools — oraclepredictapp.com/sharp' },
      timestamp: timestamp,
    };
  });

  await sendWebhook(webhook, embeds, '💰 **' + bets.length + ' +EV Bets Found** — Mathematically profitable opportunities');
  posted.ev = Date.now();
  console.log('[Discord] Posted ' + bets.length + ' +EV bets');
}

/**
 * Post game predictions
 */
async function postGames(games) {
  var webhook = WEBHOOKS.games;
  if (!webhook || !games || games.length === 0) return;
  if (Date.now() - posted.games < 110 * 60 * 1000) return; // 1h50m

  var timestamp = new Date().toISOString();

  var embeds = games.slice(0, 6).map(function(g) {
    var w = g.predictions ? g.predictions.winner : null;
    var sp = g.predictions ? g.predictions.spread : null;
    var t = g.predictions ? g.predictions.total : null;

    return {
      title: '🏟️ ' + (g.awayTeam || '?') + ' @ ' + (g.homeTeam || '?'),
      color: COLORS.blue,
      fields: [
        { name: 'Winner', value: w ? w.team + ' (' + w.confidence + '%)' : '—', inline: true },
        { name: 'Spread', value: sp ? sp.abbr + ' ' + sp.spread : '—', inline: true },
        { name: 'Total', value: t ? t.side + ' ' + t.total : '—', inline: true },
        { name: 'Environment', value: g.environment || '—', inline: true },
        { name: 'Books', value: (g.bookCount || 0) + ' compared', inline: true },
      ],
      footer: { text: '⟁ ORACLE — oraclepredictapp.com/games' },
      timestamp: timestamp,
    };
  });

  await sendWebhook(webhook, embeds, '🏟️ **ORACLE Game Predictions** — ' + games.length + ' games today');
  posted.games = Date.now();
  console.log('[Discord] Posted ' + games.length + ' game predictions');
}

/**
 * Post Pick of the Day
 */
async function postPOTD(pick) {
  var webhook = WEBHOOKS.potd;
  if (!webhook || !pick) return;

  // Don't re-post same player
  var key = pick.player + '_' + pick.line + '_' + pick.market;
  if (posted.potd === key) return;

  var dirColor = pick.pick === 'OVER' ? COLORS.green : COLORS.red;
  var timestamp = new Date().toISOString();

  var embed = {
    title: '🏆 PICK OF THE DAY',
    description: '**' + pick.player + '**\n' + (pick.pick === 'OVER' ? '🟢' : '🔴') + ' **' + pick.pick + ' ' + pick.line + ' ' + pick.market + '**',
    color: dirColor,
    fields: [
      { name: 'Grade', value: pick.grade || '—', inline: true },
      { name: 'Confidence', value: (pick.confidence || 0) + '%', inline: true },
      { name: 'Projection', value: pick.projection ? pick.projection.toFixed(1) : '—', inline: true },
      { name: 'Hit Rate', value: pick.hitRate ? pick.hitRate.toFixed(0) + '%' : '—', inline: true },
      { name: 'Best Book', value: pick.bestBook || '—', inline: true },
      { name: 'Game', value: pick.game || '—', inline: true },
    ],
    footer: { text: '⟁ ORACLE — oraclepredictapp.com/pick' },
    timestamp: timestamp,
  };

  if (pick.reasoning) {
    embed.fields.push({ name: 'Analysis', value: pick.reasoning.substring(0, 200), inline: false });
  }

  await sendWebhook(webhook, [embed], '🏆 **ORACLE PICK OF THE DAY**');
  posted.potd = key;
  console.log('[Discord] Posted POTD: ' + pick.player);
}

/**
 * Post graded results
 */
async function postResults(history) {
  var webhook = WEBHOOKS.results;
  if (!webhook || !history) return;
  if (Date.now() - posted.results < 110 * 60 * 1000) return;

  var overall = history.overall || {};
  if (overall.total === 0) return;

  var timestamp = new Date().toISOString();

  var embed = {
    title: '📊 ORACLE Accuracy Record',
    color: overall.hitRate >= 55 ? COLORS.green : overall.hitRate >= 45 ? COLORS.amber : COLORS.red,
    fields: [
      { name: 'Total Picks', value: '' + (overall.total || 0), inline: true },
      { name: 'Hits', value: '✅ ' + (overall.hits || 0), inline: true },
      { name: 'Misses', value: '❌ ' + (overall.misses || 0), inline: true },
      { name: 'Hit Rate', value: (overall.hitRate || 0) + '%', inline: true },
      { name: 'Last 7 Days', value: (history.last7Days ? history.last7Days.hitRate : 0) + '%', inline: true },
      { name: 'Pending', value: '' + (overall.pending || 0), inline: true },
    ],
    footer: { text: '⟁ ORACLE — oraclepredictapp.com/parlay' },
    timestamp: timestamp,
  };

  // Add recent graded picks
  var recent = (history.recentPicks || []).filter(function(p) { return p.result !== 'pending'; }).slice(0, 5);
  if (recent.length > 0) {
    var recentText = recent.map(function(p) {
      var icon = p.result === 'hit' ? '✅' : '❌';
      return icon + ' ' + p.player + ' ' + p.pick + ' ' + p.line + ' ' + p.market + (p.actual !== undefined ? ' (Actual: ' + p.actual + ')' : '');
    }).join('\n');
    embed.fields.push({ name: 'Recent Results', value: recentText, inline: false });
  }

  await sendWebhook(webhook, [embed], '📊 **ORACLE Accuracy Update** — ' + overall.total + ' picks graded');
  posted.results = Date.now();
  console.log('[Discord] Posted accuracy record');
}

/**
 * Start the auto-poster — called from server.js with data fetcher functions
 */
function startPosting(getPicksFn, getEVFn, getGamesFn, getPOTDFn, getHistoryFn) {
  console.log('[Discord] Auto-poster started');

  var activeWebhooks = Object.keys(WEBHOOKS).filter(function(k) { return !!WEBHOOKS[k]; });
  console.log('[Discord] Active webhooks: ' + activeWebhooks.join(', '));

  if (activeWebhooks.length === 0) {
    console.log('[Discord] No webhook URLs configured — auto-poster disabled');
    return;
  }

  async function runPost() {
    try {
      // Post picks for each sport
      var sports = ['nba', 'nhl', 'mlb', 'nfl'];
      for (var i = 0; i < sports.length; i++) {
        var sport = sports[i];
        if (!WEBHOOKS[sport]) continue;
        try {
          var data = await getPicksFn(sport);
          var picks = data ? (data.picks || []) : [];
          console.log('[Discord] ' + sport.toUpperCase() + ' picks: ' + picks.length);
          if (picks.length > 0) await postPicks(sport, picks);
        } catch (e) { console.warn('[Discord] ' + sport + ' picks error:', e.message); }
      }

      // Post EV bets
      if (WEBHOOKS.ev) {
        try {
          var evData = await getEVFn();
          var bets = evData ? (evData.bets || []) : [];
          if (bets.length > 0) await postEV(bets);
        } catch (e) { console.warn('[Discord] EV post error:', e.message); }
      }

      // Post game predictions
      if (WEBHOOKS.games) {
        try {
          var gamesData = await getGamesFn();
          var games = gamesData ? (gamesData.games || []) : [];
          console.log('[Discord] Games data: ' + games.length + ' games');
          if (games.length > 0) await postGames(games);
        } catch (e) { console.warn('[Discord] Games post error:', e.message); }
      }

      // Post POTD
      if (WEBHOOKS.potd) {
        try {
          var potdData = await getPOTDFn();
          if (potdData && potdData.pick) await postPOTD(potdData.pick);
        } catch (e) { console.warn('[Discord] POTD post error:', e.message); }
      }

      // Post results
      if (WEBHOOKS.results) {
        try {
          var historyData = await getHistoryFn();
          if (historyData && historyData.overall && historyData.overall.total > 0) await postResults(historyData);
        } catch (e) { console.warn('[Discord] Results post error:', e.message); }
      }
    } catch (e) {
      console.warn('[Discord] Post cycle error:', e.message);
    }
  }

  // First post after 3 minutes (let all data services load first)
  setTimeout(runPost, 3 * 60 * 1000);

  // Then every 30 minutes
  setInterval(runPost, 30 * 60 * 1000);
}

module.exports = { startPosting, postPicks, postEV, postGames, postPOTD, postResults, sendWebhook };
