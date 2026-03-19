/**
 * game-predictions.js — Enhanced AI Game Predictions + Best Odds Finder
 * 
 * Features:
 *   1. Game-level predictions (moneyline, spread, total) for NBA, NHL, MLB, NFL
 *   2. Best odds shopping across 20+ books
 *   3. Line comparison table
 *   4. Confidence scoring based on power ratings, pace, defense
 *   5. Games cache for Discord auto-poster (no redundant API calls)
 *   6. NHL, MLB, NFL team power ratings
 *   7. Best bet per game highlighting
 */

const axios = require('axios');
const router = require('express').Router();

const PORT = process.env.PORT || 3001;

// ============================================================
// Team Power Ratings (scale 1-10)
// ============================================================
const TEAM_POWER = {
  CLE: 8.5, BOS: 8.2, OKC: 8.0, NYK: 7.5, DET: 7.3, MIA: 6.8, ORL: 6.5, MIL: 5.8,
  TOR: 6.2, PHI: 5.5, ATL: 5.8, CHA: 5.0, CHI: 4.8, BKN: 4.5, IND: 6.0, WAS: 3.5,
  HOU: 7.0, MEM: 6.5, DAL: 6.2, DEN: 6.8, MIN: 6.5, LAL: 6.0, SAC: 5.5, LAC: 5.2,
  GSW: 5.0, PHX: 5.8, SAS: 4.5, POR: 4.0, NOP: 4.2, UTA: 3.8,
};

const NHL_POWER = {
  WPG: 8.5, DAL: 8.0, FLA: 7.8, COL: 7.5, CAR: 7.3, TOR: 7.2, EDM: 7.0, VGK: 7.0,
  NYR: 6.8, MIN: 6.8, LAK: 6.5, NJD: 6.2, OTT: 6.0, VAN: 6.0, TBL: 5.8, BOS: 5.5,
  STL: 5.5, CGY: 5.3, CBJ: 5.0, BUF: 5.0, DET: 4.8, SEA: 4.5, PHI: 4.5, WSH: 6.5,
  MTL: 4.2, NSH: 5.5, NYI: 5.2, PIT: 5.8, ANA: 4.0, SJS: 3.5, UTA: 5.5, CHI: 3.8,
};

const MLB_POWER = {
  LAD: 8.5, NYY: 7.8, ATL: 7.5, PHI: 7.2, BAL: 7.0, HOU: 7.0, CLE: 6.8, MIL: 6.8,
  ARI: 6.5, SEA: 6.2, MIN: 6.2, TEX: 6.0, SDP: 6.0, TBR: 5.8, BOS: 5.5, STL: 5.5,
  SFG: 5.2, DET: 5.0, KCR: 5.0, TOR: 5.0, CIN: 5.5, PIT: 4.8, NYM: 7.0, CHC: 5.5,
  LAA: 4.5, CWS: 3.5, OAK: 3.8, MIA: 4.0, WSH: 4.5, COL: 3.5,
};

const NFL_POWER = {
  KCC: 8.5, DET: 8.0, BUF: 8.0, BAL: 7.8, PHI: 7.5, SFO: 7.2, DAL: 6.8, MIA: 6.5,
  CIN: 6.8, HOU: 6.5, JAX: 6.0, CLE: 5.5, PIT: 6.0, GBP: 6.5, MIN: 6.5, SEA: 6.0,
  LAR: 6.0, DEN: 5.5, TBB: 5.5, NYJ: 5.0, IND: 5.0, LVR: 5.0, NYG: 4.5, TEN: 5.0,
  ATL: 6.0, NOS: 5.5, LAC: 5.5, CHI: 4.5, CAR: 4.0, WAS: 5.5, ARI: 4.0, NEP: 4.5,
};

const HOME_ADV = { nba: 3.0, nhl: 0.25, mlb: 0.3, nfl: 2.5 };
const DEFAULT_TOTALS = { nba: 220, nhl: 6.0, mlb: 8.5, nfl: 45 };

function getPowerRatings(sport) {
  if (sport === 'nhl') return NHL_POWER;
  if (sport === 'mlb') return MLB_POWER;
  if (sport === 'nfl') return NFL_POWER;
  return TEAM_POWER;
}

// ============================================================
// Team Abbreviation Maps
// ============================================================
const TEAM_ABBR_MAP = {
  'Atlanta Hawks': 'ATL', 'Boston Celtics': 'BOS', 'Brooklyn Nets': 'BKN', 'Charlotte Hornets': 'CHA',
  'Chicago Bulls': 'CHI', 'Cleveland Cavaliers': 'CLE', 'Dallas Mavericks': 'DAL', 'Denver Nuggets': 'DEN',
  'Detroit Pistons': 'DET', 'Golden State Warriors': 'GSW', 'Houston Rockets': 'HOU', 'Indiana Pacers': 'IND',
  'Los Angeles Clippers': 'LAC', 'Los Angeles Lakers': 'LAL', 'LA Clippers': 'LAC', 'LA Lakers': 'LAL',
  'Memphis Grizzlies': 'MEM', 'Miami Heat': 'MIA', 'Milwaukee Bucks': 'MIL', 'Minnesota Timberwolves': 'MIN',
  'New Orleans Pelicans': 'NOP', 'New York Knicks': 'NYK', 'Oklahoma City Thunder': 'OKC', 'Orlando Magic': 'ORL',
  'Philadelphia 76ers': 'PHI', 'Phoenix Suns': 'PHX', 'Portland Trail Blazers': 'POR', 'Sacramento Kings': 'SAC',
  'San Antonio Spurs': 'SAS', 'Toronto Raptors': 'TOR', 'Utah Jazz': 'UTA', 'Washington Wizards': 'WAS',
  'Winnipeg Jets': 'WPG', 'Dallas Stars': 'DAL', 'Florida Panthers': 'FLA', 'Colorado Avalanche': 'COL',
  'Carolina Hurricanes': 'CAR', 'Toronto Maple Leafs': 'TOR', 'Edmonton Oilers': 'EDM', 'Vegas Golden Knights': 'VGK',
  'New York Rangers': 'NYR', 'Minnesota Wild': 'MIN', 'Los Angeles Kings': 'LAK', 'New Jersey Devils': 'NJD',
  'Ottawa Senators': 'OTT', 'Vancouver Canucks': 'VAN', 'Tampa Bay Lightning': 'TBL', 'Boston Bruins': 'BOS',
  'St. Louis Blues': 'STL', 'Calgary Flames': 'CGY', 'Columbus Blue Jackets': 'CBJ', 'Buffalo Sabres': 'BUF',
  'Detroit Red Wings': 'DET', 'Seattle Kraken': 'SEA', 'Philadelphia Flyers': 'PHI', 'Washington Capitals': 'WSH',
  'Montreal Canadiens': 'MTL', 'Nashville Predators': 'NSH', 'New York Islanders': 'NYI', 'Pittsburgh Penguins': 'PIT',
  'Anaheim Ducks': 'ANA', 'San Jose Sharks': 'SJS', 'Utah Hockey Club': 'UTA', 'Chicago Blackhawks': 'CHI',
  'Los Angeles Dodgers': 'LAD', 'New York Yankees': 'NYY', 'Atlanta Braves': 'ATL', 'Philadelphia Phillies': 'PHI',
  'Baltimore Orioles': 'BAL', 'Houston Astros': 'HOU', 'Cleveland Guardians': 'CLE', 'Milwaukee Brewers': 'MIL',
  'Arizona Diamondbacks': 'ARI', 'Seattle Mariners': 'SEA', 'Minnesota Twins': 'MIN', 'Texas Rangers': 'TEX',
  'San Diego Padres': 'SDP', 'Tampa Bay Rays': 'TBR', 'Boston Red Sox': 'BOS', 'St. Louis Cardinals': 'STL',
  'San Francisco Giants': 'SFG', 'Detroit Tigers': 'DET', 'Kansas City Royals': 'KCR', 'Toronto Blue Jays': 'TOR',
  'Cincinnati Reds': 'CIN', 'Pittsburgh Pirates': 'PIT', 'New York Mets': 'NYM', 'Chicago Cubs': 'CHC',
  'Los Angeles Angels': 'LAA', 'Chicago White Sox': 'CWS', 'Oakland Athletics': 'OAK', 'Miami Marlins': 'MIA',
  'Washington Nationals': 'WSH', 'Colorado Rockies': 'COL',
};

function abbrFromName(name) { return TEAM_ABBR_MAP[name] || (name ? name.substring(0, 3).toUpperCase() : '???'); }
function fmtOdds(price) { return !price ? '' : price > 0 ? '+' + price : '' + price; }

// ============================================================
// GAMES CACHE — for Discord poster
// ============================================================
const gamesCache = {};

function getCachedGames(sport) {
  var cached = gamesCache[sport];
  if (cached && cached.games && Date.now() - cached.timestamp < 20 * 60 * 1000) {
    return cached.games;
  }
  return null;
}

// ============================================================
// Analyze a single game
// ============================================================
function analyzeGame(game, sport) {
  sport = sport || 'nba';
  var homeAbbr = abbrFromName(game.homeTeam);
  var awayAbbr = abbrFromName(game.awayTeam);
  var powerMap = getPowerRatings(sport);
  var homePower = powerMap[homeAbbr] || 5.5;
  var awayPower = powerMap[awayAbbr] || 5.5;
  var homeAdv = HOME_ADV[sport] || 3.0;

  var spreadData = [], totalData = [], mlData = [];

  (game.bookmakers || []).forEach(function(bk) {
    (bk.markets || []).forEach(function(market) {
      if (market.key === 'spreads') {
        var home = (market.outcomes || []).find(function(o) { return o.name === game.homeTeam; });
        var away = (market.outcomes || []).find(function(o) { return o.name === game.awayTeam; });
        if (home) spreadData.push({ book: bk.title, side: 'home', team: game.homeTeam, point: home.point, price: home.price });
        if (away) spreadData.push({ book: bk.title, side: 'away', team: game.awayTeam, point: away.point, price: away.price });
      }
      if (market.key === 'totals') {
        (market.outcomes || []).forEach(function(o) {
          totalData.push({ book: bk.title, side: o.name.toLowerCase(), point: o.point, price: o.price });
        });
      }
      if (market.key === 'h2h') {
        (market.outcomes || []).forEach(function(o) {
          mlData.push({ book: bk.title, team: o.name, price: o.price });
        });
      }
    });
  });

  // === SPREAD ===
  var homeSpreadLines = spreadData.filter(function(s) { return s.side === 'home'; }).map(function(s) { return s.point; });
  var consensusSpread = homeSpreadLines.length > 0
    ? +(homeSpreadLines.reduce(function(a, b) { return a + b; }, 0) / homeSpreadLines.length).toFixed(1) : 0;
  var bestHomeSpread = spreadData.filter(function(s) { return s.side === 'home'; }).sort(function(a, b) { return b.price - a.price; })[0];
  var bestAwaySpread = spreadData.filter(function(s) { return s.side === 'away'; }).sort(function(a, b) { return b.price - a.price; })[0];

  var expectedMargin = (homePower - awayPower) + homeAdv;
  var spreadEdge = expectedMargin - Math.abs(consensusSpread) * (consensusSpread < 0 ? 1 : -1);
  var spreadPick, spreadConf;
  if (expectedMargin > consensusSpread + 1.5) {
    spreadPick = { side: game.homeTeam, abbr: homeAbbr, spread: consensusSpread, direction: 'home' };
    spreadConf = Math.min(85, 55 + Math.abs(spreadEdge) * 3);
  } else if (expectedMargin < consensusSpread - 1.5) {
    spreadPick = { side: game.awayTeam, abbr: awayAbbr, spread: -consensusSpread, direction: 'away' };
    spreadConf = Math.min(85, 55 + Math.abs(spreadEdge) * 3);
  } else {
    var lean = expectedMargin > consensusSpread ? 'home' : 'away';
    spreadPick = { side: lean === 'home' ? game.homeTeam : game.awayTeam, abbr: lean === 'home' ? homeAbbr : awayAbbr,
      spread: lean === 'home' ? consensusSpread : -consensusSpread, direction: lean };
    spreadConf = Math.min(70, 50 + Math.abs(spreadEdge) * 2);
  }
  spreadConf = Math.round(spreadConf);

  // === TOTAL ===
  var overLines = totalData.filter(function(t) { return t.side === 'over'; }).map(function(t) { return t.point; });
  var consensusTotal = overLines.length > 0
    ? +(overLines.reduce(function(a, b) { return a + b; }, 0) / overLines.length).toFixed(1) : DEFAULT_TOTALS[sport] || 220;
  var bestOver = totalData.filter(function(t) { return t.side === 'over'; }).sort(function(a, b) { return b.price - a.price; })[0];
  var bestUnder = totalData.filter(function(t) { return t.side === 'under'; }).sort(function(a, b) { return b.price - a.price; })[0];

  var expectedTotal = DEFAULT_TOTALS[sport] || 220;
  try {
    var boostModule = require('./accuracy-boost');
    if (boostModule && boostModule.TEAM_DATA && sport === 'nba') {
      var homePace = (boostModule.TEAM_DATA.pace || {})[homeAbbr] || 98.5;
      var awayPace = (boostModule.TEAM_DATA.pace || {})[awayAbbr] || 98.5;
      var homeDefRating = (boostModule.TEAM_DATA.defRating || {})[homeAbbr] || 111;
      var awayDefRating = (boostModule.TEAM_DATA.defRating || {})[awayAbbr] || 111;
      expectedTotal = ((homePace + awayPace) / 2 / 100) * ((homeDefRating + awayDefRating) / 2) * 2;
    }
  } catch (e) {}

  var totalEdge = expectedTotal - consensusTotal;
  var totalPick, totalConf;
  if (totalEdge > 2) { totalPick = { side: 'OVER', total: consensusTotal }; totalConf = Math.min(80, 55 + totalEdge * 2); }
  else if (totalEdge < -2) { totalPick = { side: 'UNDER', total: consensusTotal }; totalConf = Math.min(80, 55 + Math.abs(totalEdge) * 2); }
  else { totalPick = { side: totalEdge > 0 ? 'OVER' : 'UNDER', total: consensusTotal }; totalConf = Math.min(65, 50 + Math.abs(totalEdge) * 1.5); }
  totalConf = Math.round(totalConf);

  // === MONEYLINE ===
  var bestHomeMl = mlData.filter(function(m) { return m.team === game.homeTeam; }).sort(function(a, b) { return b.price - a.price; })[0];
  var bestAwayMl = mlData.filter(function(m) { return m.team === game.awayTeam; }).sort(function(a, b) { return b.price - a.price; })[0];
  var winnerPick = expectedMargin > 0
    ? { team: game.homeTeam, abbr: homeAbbr, confidence: Math.min(90, 55 + Math.abs(expectedMargin) * 3) }
    : { team: game.awayTeam, abbr: awayAbbr, confidence: Math.min(90, 55 + Math.abs(expectedMargin) * 3) };
  winnerPick.confidence = Math.round(winnerPick.confidence);
  winnerPick.bestOdds = expectedMargin > 0 ? bestHomeMl : bestAwayMl;

  // === LINE SHOP ===
  var lineShop = {};
  (game.bookmakers || []).forEach(function(bk) {
    lineShop[bk.title] = {};
    (bk.markets || []).forEach(function(mkt) {
      if (mkt.key === 'spreads') {
        var h = (mkt.outcomes || []).find(function(o) { return o.name === game.homeTeam; });
        var a = (mkt.outcomes || []).find(function(o) { return o.name === game.awayTeam; });
        lineShop[bk.title].homeSpread = h ? h.point + ' (' + fmtOdds(h.price) + ')' : null;
        lineShop[bk.title].awaySpread = a ? a.point + ' (' + fmtOdds(a.price) + ')' : null;
      }
      if (mkt.key === 'totals') {
        var ov = (mkt.outcomes || []).find(function(o) { return o.name === 'Over'; });
        var un = (mkt.outcomes || []).find(function(o) { return o.name === 'Under'; });
        lineShop[bk.title].over = ov ? ov.point + ' (' + fmtOdds(ov.price) + ')' : null;
        lineShop[bk.title].under = un ? un.point + ' (' + fmtOdds(un.price) + ')' : null;
      }
      if (mkt.key === 'h2h') {
        var hm = (mkt.outcomes || []).find(function(o) { return o.name === game.homeTeam; });
        var am = (mkt.outcomes || []).find(function(o) { return o.name === game.awayTeam; });
        lineShop[bk.title].homeML = hm ? fmtOdds(hm.price) : null;
        lineShop[bk.title].awayML = am ? fmtOdds(am.price) : null;
      }
    });
  });

  // === ENVIRONMENT ===
  var absSpread = Math.abs(consensusSpread);
  var environment;
  if (sport === 'nba') {
    if (consensusTotal >= 235 && absSpread <= 5) environment = 'Shootout';
    else if (consensusTotal >= 230) environment = 'High Scoring';
    else if (absSpread >= 12) environment = 'Blowout Expected';
    else if (absSpread <= 3) environment = 'Toss-Up';
    else if (consensusTotal <= 210) environment = 'Defensive Battle';
    else environment = 'Standard';
  } else if (sport === 'nhl') {
    if (consensusTotal >= 6.5) environment = 'High Scoring';
    else if (consensusTotal <= 5.5) environment = 'Defensive Battle';
    else if (absSpread <= 0.5) environment = 'Toss-Up';
    else environment = 'Standard';
  } else if (sport === 'mlb') {
    if (consensusTotal >= 9.5) environment = 'High Scoring';
    else if (consensusTotal <= 7) environment = 'Pitchers Duel';
    else environment = 'Standard';
  } else {
    if (consensusTotal >= 50) environment = 'Shootout';
    else if (consensusTotal <= 38) environment = 'Defensive Battle';
    else if (absSpread <= 3) environment = 'Toss-Up';
    else if (absSpread >= 14) environment = 'Blowout Expected';
    else environment = 'Standard';
  }

  // === BEST BET ===
  var maxConf = Math.max(winnerPick.confidence, spreadConf, totalConf);
  var bestBet = null;
  if (maxConf >= 65) {
    if (maxConf === spreadConf) bestBet = { type: 'Spread', pick: spreadPick.abbr + ' ' + (spreadPick.spread > 0 ? '+' : '') + spreadPick.spread, confidence: spreadConf };
    else if (maxConf === winnerPick.confidence) bestBet = { type: 'Moneyline', pick: winnerPick.abbr, confidence: winnerPick.confidence };
    else bestBet = { type: 'Total', pick: totalPick.side + ' ' + totalPick.total, confidence: totalConf };
  }

  return {
    id: game.id, homeTeam: game.homeTeam, awayTeam: game.awayTeam, homeAbbr: homeAbbr, awayAbbr: awayAbbr,
    commenceTime: game.commenceTime, sport: sport, environment: environment, bestBet: bestBet,
    consensus: { spread: consensusSpread, total: consensusTotal },
    predictions: {
      winner: winnerPick,
      spread: Object.assign({}, spreadPick, { confidence: spreadConf, bestOdds: spreadPick.direction === 'home' ? bestHomeSpread : bestAwaySpread }),
      total: Object.assign({}, totalPick, { confidence: totalConf, bestOver: bestOver, bestUnder: bestUnder }),
    },
    bestOdds: { homeSpread: bestHomeSpread, awaySpread: bestAwaySpread, over: bestOver, under: bestUnder, homeML: bestHomeMl || null, awayML: bestAwayMl || null },
    lineShop: lineShop,
    bookCount: Object.keys(lineShop).length,
  };
}

// ============================================================
// API Routes
// ============================================================
var PROP_SPORTS = { nba: 'basketball_nba', nfl: 'americanfootball_nfl', mlb: 'baseball_mlb', nhl: 'icehockey_nhl' };

router.get('/:sport', async function(req, res) {
  var sport = req.params.sport;
  try {
    var cached = getCachedGames(sport);
    if (cached) {
      return res.json({ sport: sport, games: cached, count: cached.length, source: 'cache', timestamp: new Date().toISOString() });
    }

    var ODDS_KEY = process.env.ODDS_API_KEY;
    var oddsSport = PROP_SPORTS[sport];
    var games = [];

    if (ODDS_KEY && oddsSport) {
      var oddsResp = await axios.get('https://api.the-odds-api.com/v4/sports/' + oddsSport + '/odds', {
        params: { apiKey: ODDS_KEY, regions: 'us,us2', markets: 'spreads,totals,h2h', oddsFormat: 'american' },
        timeout: 15000,
      });
      games = (oddsResp.data || []).map(function(g) {
        return { id: g.id, homeTeam: g.home_team, awayTeam: g.away_team, commenceTime: g.commence_time,
          bookmakers: (g.bookmakers || []).map(function(b) { return { title: b.title, key: b.key, markets: b.markets }; }) };
      });
    }

    if (games.length === 0) {
      return res.json({ sport: sport, games: [], count: 0, message: 'No games with odds today' });
    }

    var predictions = games.map(function(g) { return analyzeGame(g, sport); });
    predictions.sort(function(a, b) { return b.predictions.spread.confidence - a.predictions.spread.confidence; });

    // Cache results for 20 min
    gamesCache[sport] = { games: predictions, timestamp: Date.now() };
    console.log('[Games] Cached ' + predictions.length + ' ' + sport.toUpperCase() + ' game predictions');

    res.json({
      sport: sport, games: predictions, count: predictions.length,
      bestBets: predictions.filter(function(g) { return g.bestBet; }).map(function(g) {
        return { game: g.awayAbbr + ' @ ' + g.homeAbbr, type: g.bestBet.type, pick: g.bestBet.pick, confidence: g.bestBet.confidence };
      }),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Games] Error:', err.message);
    res.json({ sport: sport, games: [], count: 0, error: err.message });
  }
});

router.get('/:sport/:gameId', async function(req, res) {
  var sport = req.params.sport, gameId = req.params.gameId;
  try {
    var cached = getCachedGames(sport);
    if (cached) {
      var game = cached.find(function(g) { return g.id === gameId; });
      if (game) return res.json(game);
    }
    var mainResp = await axios.get('http://localhost:' + PORT + '/api/games/' + sport, { timeout: 20000 });
    var game2 = (mainResp.data.games || []).find(function(g) { return g.id === gameId; });
    if (!game2) return res.json({ error: 'Game not found' });
    res.json(game2);
  } catch (err) { res.json({ error: err.message }); }
});

module.exports = { router, analyzeGame, gamesCache, getCachedGames };
