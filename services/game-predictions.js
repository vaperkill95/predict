/**
 * game-predictions.js — AI Game Predictions + Best Odds Finder
 * 
 * Features:
 *   1. Game-level predictions (spread pick, over/under pick, winner) for every game
 *   2. Best odds shopping — which book has the best line for each side
 *   3. Line comparison table — every book's spread/total side by side
 *   4. Confidence scoring based on line movement, consensus, and model factors
 * 
 * Setup:
 *   const gamePredictions = require('./services/game-predictions');
 *   app.use('/api/games', gamePredictions.router);
 */

const express = require('express');
const axios = require('axios');
const router = express.Router();

const PORT = process.env.PORT || 3001;

// Team strength ratings (approximate, based on win% and point differential)
const TEAM_POWER = {
  CLE: 8.5, BOS: 8.2, OKC: 8.0, NYK: 7.5, DET: 7.3, MIA: 6.8, ORL: 6.5, MIL: 5.8,
  TOR: 6.2, PHI: 5.5, ATL: 5.8, CHA: 5.0, CHI: 4.8, BKN: 4.5, IND: 6.0, WAS: 3.5,
  HOU: 7.0, MEM: 6.5, DAL: 6.2, DEN: 6.8, MIN: 6.5, LAL: 6.0, SAC: 5.5, LAC: 5.2,
  GSW: 5.0, PHX: 5.8, SAS: 4.5, POR: 4.0, NOP: 4.2, UTA: 3.8,
};

const TEAM_ABBR_MAP = {
  'Atlanta Hawks': 'ATL', 'Boston Celtics': 'BOS', 'Brooklyn Nets': 'BKN', 'Charlotte Hornets': 'CHA',
  'Chicago Bulls': 'CHI', 'Cleveland Cavaliers': 'CLE', 'Dallas Mavericks': 'DAL', 'Denver Nuggets': 'DEN',
  'Detroit Pistons': 'DET', 'Golden State Warriors': 'GSW', 'Houston Rockets': 'HOU', 'Indiana Pacers': 'IND',
  'Los Angeles Clippers': 'LAC', 'Los Angeles Lakers': 'LAL', 'LA Clippers': 'LAC', 'LA Lakers': 'LAL',
  'Memphis Grizzlies': 'MEM', 'Miami Heat': 'MIA', 'Milwaukee Bucks': 'MIL', 'Minnesota Timberwolves': 'MIN',
  'New Orleans Pelicans': 'NOP', 'New York Knicks': 'NYK', 'Oklahoma City Thunder': 'OKC', 'Orlando Magic': 'ORL',
  'Philadelphia 76ers': 'PHI', 'Phoenix Suns': 'PHX', 'Portland Trail Blazers': 'POR', 'Sacramento Kings': 'SAC',
  'San Antonio Spurs': 'SAS', 'Toronto Raptors': 'TOR', 'Utah Jazz': 'UTA', 'Washington Wizards': 'WAS',
};

function abbr(name) { return TEAM_ABBR_MAP[name] || name?.substring(0, 3)?.toUpperCase() || '???'; }

function fmtOdds(price) {
  if (!price) return '';
  return price > 0 ? `+${price}` : `${price}`;
}

/**
 * Analyze a single game and generate predictions
 */
function analyzeGame(game) {
  const homeAbbr = abbr(game.homeTeam);
  const awayAbbr = abbr(game.awayTeam);
  const homePower = TEAM_POWER[homeAbbr] || 5.5;
  const awayPower = TEAM_POWER[awayAbbr] || 5.5;

  // Collect all book data
  const spreadData = [];
  const totalData = [];
  const mlData = [];

  for (const bk of (game.bookmakers || [])) {
    for (const market of (bk.markets || [])) {
      if (market.key === 'spreads') {
        const home = market.outcomes?.find(o => o.name === game.homeTeam);
        const away = market.outcomes?.find(o => o.name === game.awayTeam);
        if (home) spreadData.push({ book: bk.title, side: 'home', team: game.homeTeam, point: home.point, price: home.price });
        if (away) spreadData.push({ book: bk.title, side: 'away', team: game.awayTeam, point: away.point, price: away.price });
      }
      if (market.key === 'totals') {
        for (const o of (market.outcomes || [])) {
          totalData.push({ book: bk.title, side: o.name.toLowerCase(), point: o.point, price: o.price });
        }
      }
      if (market.key === 'h2h') {
        for (const o of (market.outcomes || [])) {
          mlData.push({ book: bk.title, team: o.name, price: o.price });
        }
      }
    }
  }

  // === SPREAD ANALYSIS ===
  const homeSpreadLines = spreadData.filter(s => s.side === 'home').map(s => s.point);
  const consensusSpread = homeSpreadLines.length > 0
    ? +(homeSpreadLines.reduce((a, b) => a + b, 0) / homeSpreadLines.length).toFixed(1)
    : 0;

  // Best spread odds
  const bestHomeSpread = spreadData.filter(s => s.side === 'home').sort((a, b) => b.price - a.price)[0];
  const bestAwaySpread = spreadData.filter(s => s.side === 'away').sort((a, b) => b.price - a.price)[0];

  // Spread pick: use power ratings + home court advantage (3 pts)
  const expectedMargin = (homePower - awayPower) + 3; // home court = +3
  const spreadEdge = expectedMargin - Math.abs(consensusSpread) * (consensusSpread < 0 ? 1 : -1);
  let spreadPick, spreadConf;
  if (expectedMargin > consensusSpread + 1.5) {
    spreadPick = { side: game.homeTeam, abbr: homeAbbr, spread: consensusSpread, direction: 'home' };
    spreadConf = Math.min(85, 55 + Math.abs(spreadEdge) * 3);
  } else if (expectedMargin < consensusSpread - 1.5) {
    spreadPick = { side: game.awayTeam, abbr: awayAbbr, spread: -consensusSpread, direction: 'away' };
    spreadConf = Math.min(85, 55 + Math.abs(spreadEdge) * 3);
  } else {
    // Close — lean toward better team
    const lean = expectedMargin > consensusSpread ? 'home' : 'away';
    spreadPick = {
      side: lean === 'home' ? game.homeTeam : game.awayTeam,
      abbr: lean === 'home' ? homeAbbr : awayAbbr,
      spread: lean === 'home' ? consensusSpread : -consensusSpread,
      direction: lean,
    };
    spreadConf = Math.min(70, 50 + Math.abs(spreadEdge) * 2);
  }
  spreadConf = Math.round(spreadConf);

  // === TOTAL ANALYSIS ===
  const overLines = totalData.filter(t => t.side === 'over').map(t => t.point);
  const consensusTotal = overLines.length > 0
    ? +(overLines.reduce((a, b) => a + b, 0) / overLines.length).toFixed(1)
    : 220;

  const bestOver = totalData.filter(t => t.side === 'over').sort((a, b) => b.price - a.price)[0];
  const bestUnder = totalData.filter(t => t.side === 'under').sort((a, b) => b.price - a.price)[0];

  // Total pick: use pace and defensive ratings
  let boostModule = null;
  try { boostModule = require('./accuracy-boost'); } catch (e) {}

  let expectedTotal = 220;
  if (boostModule && boostModule.TEAM_DATA) {
    const homePace = boostModule.TEAM_DATA.pace?.[homeAbbr] || 98.5;
    const awayPace = boostModule.TEAM_DATA.pace?.[awayAbbr] || 98.5;
    const homeDefRating = boostModule.TEAM_DATA.defRating?.[homeAbbr] || 111;
    const awayDefRating = boostModule.TEAM_DATA.defRating?.[awayAbbr] || 111;
    const gamePace = (homePace + awayPace) / 2;
    const avgDefRating = (homeDefRating + awayDefRating) / 2;
    expectedTotal = (gamePace / 100) * avgDefRating * 2;
  }

  const totalEdge = expectedTotal - consensusTotal;
  let totalPick, totalConf;
  if (totalEdge > 2) {
    totalPick = { side: 'OVER', total: consensusTotal };
    totalConf = Math.min(80, 55 + totalEdge * 2);
  } else if (totalEdge < -2) {
    totalPick = { side: 'UNDER', total: consensusTotal };
    totalConf = Math.min(80, 55 + Math.abs(totalEdge) * 2);
  } else {
    totalPick = { side: totalEdge > 0 ? 'OVER' : 'UNDER', total: consensusTotal };
    totalConf = Math.min(65, 50 + Math.abs(totalEdge) * 1.5);
  }
  totalConf = Math.round(totalConf);

  // === MONEYLINE / WINNER ===
  const homeMl = mlData.filter(m => m.team === game.homeTeam);
  const awayMl = mlData.filter(m => m.team === game.awayTeam);
  const bestHomeMl = homeMl.sort((a, b) => b.price - a.price)[0];
  const bestAwayMl = awayMl.sort((a, b) => b.price - a.price)[0];

  const winnerPick = expectedMargin > 0
    ? { team: game.homeTeam, abbr: homeAbbr, confidence: Math.min(90, 55 + Math.abs(expectedMargin) * 3) }
    : { team: game.awayTeam, abbr: awayAbbr, confidence: Math.min(90, 55 + Math.abs(expectedMargin) * 3) };
  winnerPick.confidence = Math.round(winnerPick.confidence);

  // === LINE SHOPPING TABLE ===
  const lineShop = {};
  for (const bk of (game.bookmakers || [])) {
    lineShop[bk.title] = {};
    for (const market of (bk.markets || [])) {
      if (market.key === 'spreads') {
        const home = market.outcomes?.find(o => o.name === game.homeTeam);
        lineShop[bk.title].homeSpread = home ? `${home.point} (${fmtOdds(home.price)})` : null;
        const away = market.outcomes?.find(o => o.name === game.awayTeam);
        lineShop[bk.title].awaySpread = away ? `${away.point} (${fmtOdds(away.price)})` : null;
      }
      if (market.key === 'totals') {
        const over = market.outcomes?.find(o => o.name === 'Over');
        const under = market.outcomes?.find(o => o.name === 'Under');
        lineShop[bk.title].over = over ? `${over.point} (${fmtOdds(over.price)})` : null;
        lineShop[bk.title].under = under ? `${under.point} (${fmtOdds(under.price)})` : null;
      }
      if (market.key === 'h2h') {
        const home = market.outcomes?.find(o => o.name === game.homeTeam);
        const away = market.outcomes?.find(o => o.name === game.awayTeam);
        lineShop[bk.title].homeML = home ? fmtOdds(home.price) : null;
        lineShop[bk.title].awayML = away ? fmtOdds(away.price) : null;
      }
    }
  }

  // === GAME ENVIRONMENT ===
  const absSpread = Math.abs(consensusSpread);
  let environment;
  if (consensusTotal >= 235 && absSpread <= 5) environment = 'Shootout';
  else if (consensusTotal >= 230) environment = 'High Scoring';
  else if (absSpread >= 12) environment = 'Blowout Expected';
  else if (absSpread <= 3) environment = 'Toss-Up';
  else if (consensusTotal <= 210) environment = 'Defensive Battle';
  else environment = 'Standard';

  return {
    id: game.id,
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    homeAbbr: homeAbbr,
    awayAbbr: awayAbbr,
    commenceTime: game.commenceTime,
    environment,
    consensus: { spread: consensusSpread, total: consensusTotal },
    predictions: {
      winner: winnerPick,
      spread: { ...spreadPick, confidence: spreadConf, bestOdds: spreadPick.direction === 'home' ? bestHomeSpread : bestAwaySpread },
      total: { ...totalPick, confidence: totalConf, bestOver, bestUnder },
    },
    bestOdds: {
      homeSpread: bestHomeSpread,
      awaySpread: bestAwaySpread,
      over: bestOver,
      under: bestUnder,
      homeML: bestHomeMl || null,
      awayML: bestAwayMl || null,
    },
    lineShop,
    bookCount: Object.keys(lineShop).length,
  };
}

// ============================================================
// API Routes
// ============================================================

router.get('/:sport', async (req, res) => {
  const { sport } = req.params;
  try {
    const oddsResp = await axios.get(`http://localhost:${PORT}/api/odds/${sport}`, { timeout: 15000 });
    const games = oddsResp.data?.games || [];

    if (games.length === 0) {
      return res.json({ sport, games: [], count: 0, message: 'No games with odds today' });
    }

    const predictions = games.map(g => analyzeGame(g));

    // Sort by confidence (highest spread confidence first)
    predictions.sort((a, b) => b.predictions.spread.confidence - a.predictions.spread.confidence);

    res.json({
      sport,
      games: predictions,
      count: predictions.length,
      bestSpreadPick: predictions[0] ? {
        game: `${predictions[0].awayAbbr} @ ${predictions[0].homeAbbr}`,
        pick: `${predictions[0].predictions.spread.abbr} ${predictions[0].predictions.spread.spread > 0 ? '+' : ''}${predictions[0].predictions.spread.spread}`,
        confidence: predictions[0].predictions.spread.confidence,
      } : null,
      bestTotalPick: predictions.sort((a, b) => b.predictions.total.confidence - a.predictions.total.confidence)[0] ? {
        game: `${predictions[0].awayAbbr} @ ${predictions[0].homeAbbr}`,
        pick: `${predictions[0].predictions.total.side} ${predictions[0].predictions.total.total}`,
        confidence: predictions[0].predictions.total.confidence,
      } : null,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.json({ sport, games: [], count: 0, error: err.message });
  }
});

// Single game detail
router.get('/:sport/:gameId', async (req, res) => {
  const { sport, gameId } = req.params;
  try {
    const oddsResp = await axios.get(`http://localhost:${PORT}/api/odds/${sport}`, { timeout: 15000 });
    const game = (oddsResp.data?.games || []).find(g => g.id === gameId);
    if (!game) return res.json({ error: 'Game not found' });
    res.json(analyzeGame(game));
  } catch (err) {
    res.json({ error: err.message });
  }
});

module.exports = { router, analyzeGame };
