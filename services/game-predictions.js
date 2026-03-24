/**
 * game-predictions.js — Enhanced AI Game Predictions v2
 * 
 * LIVE DATA from ESPN (free, no key):
 *   - Team records (wins/losses) → dynamic power ratings
 *   - Injuries → impact adjustment
 *   - Scoreboard → back-to-back detection, recent form
 *   - Team stats → pace, offensive/defensive ratings
 * 
 * + Odds API data for lines/odds across 20+ books
 * + Best bet per game highlighting
 * + Games cache for Discord poster
 */

const axios = require('axios');
const router = require('express').Router();
const PORT = process.env.PORT || 3001;

// ============================================================
// ESPN Data Cache (refreshes every 30 min)
// ============================================================
const espnCache = {
  nba: { teams: null, injuries: null, fetchedAt: 0 },
  nhl: { teams: null, injuries: null, fetchedAt: 0 },
  mlb: { teams: null, injuries: null, fetchedAt: 0 },
  nfl: { teams: null, injuries: null, fetchedAt: 0 },
};
const ESPN_TTL = 30 * 60 * 1000; // 30 min

const ESPN_SPORTS = {
  nba: 'basketball/nba',
  nhl: 'hockey/nhl',
  mlb: 'baseball/mlb',
  nfl: 'football/nfl',
};

// Fallback static power ratings (used if ESPN fails)
const STATIC_POWER = {
  nba: { CLE:8.5,BOS:8.2,OKC:8.0,NYK:7.5,DET:7.3,MIA:6.8,ORL:6.5,MIL:5.8,TOR:6.2,PHI:5.5,ATL:5.8,CHA:5.0,CHI:4.8,BKN:4.5,IND:6.0,WAS:3.5,HOU:7.0,MEM:6.5,DAL:6.2,DEN:6.8,MIN:6.5,LAL:6.0,SAC:5.5,LAC:5.2,GSW:5.0,PHX:5.8,SAS:4.5,POR:4.0,NOP:4.2,UTA:3.8 },
  nhl: { WPG:8.5,DAL:8.0,FLA:7.8,COL:7.5,CAR:7.3,TOR:7.2,EDM:7.0,VGK:7.0,NYR:6.8,MIN:6.8,LAK:6.5,NJD:6.2,OTT:6.0,VAN:6.0,TBL:5.8,BOS:5.5,STL:5.5,CGY:5.3,CBJ:5.0,BUF:5.0,DET:4.8,SEA:4.5,PHI:4.5,WSH:6.5,MTL:4.2,NSH:5.5,NYI:5.2,PIT:5.8,ANA:4.0,SJS:3.5,UTA:5.5,CHI:3.8 },
  mlb: { LAD:8.5,NYY:7.8,ATL:7.5,PHI:7.2,BAL:7.0,HOU:7.0,CLE:6.8,MIL:6.8,ARI:6.5,SEA:6.2,MIN:6.2,TEX:6.0,SDP:6.0,TBR:5.8,BOS:5.5,STL:5.5,SFG:5.2,DET:5.0,KCR:5.0,TOR:5.0,CIN:5.5,PIT:4.8,NYM:7.0,CHC:5.5,LAA:4.5,CWS:3.5,OAK:3.8,MIA:4.0,WSH:4.5,COL:3.5 },
  nfl: { KCC:8.5,DET:8.0,BUF:8.0,BAL:7.8,PHI:7.5,SFO:7.2,DAL:6.8,MIA:6.5,CIN:6.8,HOU:6.5,JAX:6.0,CLE:5.5,PIT:6.0,GBP:6.5,MIN:6.5,SEA:6.0,LAR:6.0,DEN:5.5,TBB:5.5,NYJ:5.0,IND:5.0,LVR:5.0,NYG:4.5,TEN:5.0,ATL:6.0,NOS:5.5,LAC:5.5,CHI:4.5,CAR:4.0,WAS:5.5,ARI:4.0,NEP:4.5 },
};

const HOME_ADV = { nba: 3.0, nhl: 0.25, mlb: 0.3, nfl: 2.5 };
const DEFAULT_TOTALS = { nba: 220, nhl: 6.0, mlb: 8.5, nfl: 45 };

// ============================================================
// Fetch LIVE team data from ESPN
// ============================================================
async function fetchESPNTeams(sport) {
  var cached = espnCache[sport];
  if (cached && cached.teams && Date.now() - cached.fetchedAt < ESPN_TTL) return cached.teams;

  var espnSport = ESPN_SPORTS[sport];
  if (!espnSport) return null;

  try {
    // Use standings endpoint — has wins, losses, home/away records, L10, streaks
    var resp = await axios.get('https://site.api.espn.com/apis/v2/sports/' + espnSport + '/standings', {
      timeout: 10000,
    });
    var teams = {};
    var conferences = resp.data.children || [];

    conferences.forEach(function(conf) {
      var entries = conf.standings ? (conf.standings.entries || []) : [];
      entries.forEach(function(entry) {
        var team = entry.team || {};
        var abbr = team.abbreviation;
        if (!abbr) return;
        var stats = entry.stats || [];

        // Helper to find a stat by name
        function getStat(name) {
          var s = stats.find(function(st) { return st.name === name || st.abbreviation === name; });
          return s ? s.value : null;
        }
        function getStatDisplay(name) {
          var s = stats.find(function(st) { return st.name === name || st.abbreviation === name; });
          return s ? (s.displayValue || s.summary || null) : null;
        }

        var wins = getStat('wins') || 0;
        var losses = getStat('losses') || 0;
        var winPct = getStat('winPercent') || (wins / Math.max(wins + losses, 1));
        var ppg = getStat('avgPointsFor') || 0;
        var oppg = getStat('avgPointsAgainst') || 0;
        var ptDiff = getStat('pointDifferential') || (ppg - oppg);
        var streak = getStatDisplay('streak') || '';

        // Parse home/away records: "30-5" format
        var homeStr = getStatDisplay('Home') || '';
        var awayStr = getStatDisplay('Road') || '';
        var l10Str = getStatDisplay('Last Ten Games') || '';

        function parseRecord(str) {
          if (!str) return { w: 0, l: 0, pct: 0.5 };
          var parts = str.split('-');
          var w = parseInt(parts[0]) || 0;
          var l = parseInt(parts[1]) || 0;
          return { w: w, l: l, pct: w / Math.max(w + l, 1) };
        }

        var homeRec = parseRecord(homeStr);
        var awayRec = parseRecord(awayStr);
        var l10Rec = parseRecord(l10Str);

        // Convert win% to power rating (1-10 scale)
        // Also factor in point differential for more accuracy
        // .750 win% = ~8.5, .500 = ~5.5, .250 = ~2.5
        var basePower = 2.5 + (winPct * 8);
        // Point diff adjustment: +10 ptDiff = +0.5 power, -10 = -0.5
        var ptDiffAdj = (ptDiff / 20) * 1.0;
        var power = basePower + ptDiffAdj;
        power = Math.max(2, Math.min(9.5, power));

        teams[abbr] = {
          name: team.displayName || team.name || abbr,
          abbr: abbr,
          wins: wins,
          losses: losses,
          winPct: +winPct.toFixed(3),
          ppg: +ppg.toFixed(1),
          oppg: +oppg.toFixed(1),
          ptDiff: +ptDiff.toFixed(1),
          homeRecord: homeStr,
          awayRecord: awayStr,
          l10Record: l10Str,
          streak: streak,
          homeWinPct: homeRec.pct,
          awayWinPct: awayRec.pct,
          l10WinPct: l10Rec.pct,
          power: +power.toFixed(1),
          formFactor: l10Rec.pct - winPct,
        };
      });
    });

    if (!espnCache[sport]) espnCache[sport] = {};
    espnCache[sport].teams = teams;
    espnCache[sport].fetchedAt = Date.now();
    console.log('[Games] ESPN Standings: Loaded ' + Object.keys(teams).length + ' ' + sport.toUpperCase() + ' teams with live records');
    return teams;
  } catch (e) {
    console.warn('[Games] ESPN standings fetch failed:', e.message);
    return null;
  }
}

// ============================================================
// Fetch injuries from ESPN
// ============================================================
async function fetchESPNInjuries(sport) {
  var cached = espnCache[sport];
  if (cached && cached.injuries && Date.now() - cached.fetchedAt < ESPN_TTL) return cached.injuries;

  var espnSport = ESPN_SPORTS[sport];
  if (!espnSport) return {};

  try {
    var resp = await axios.get('https://site.api.espn.com/apis/site/v2/sports/' + espnSport + '/injuries', { timeout: 10000 });
    var injuries = {};
    (resp.data.items || []).forEach(function(team) {
      var abbr = team.team ? team.team.abbreviation : null;
      if (!abbr) return;
      injuries[abbr] = (team.injuries || []).map(function(inj) {
        return {
          name: inj.athlete ? inj.athlete.displayName : 'Unknown',
          status: inj.status || 'Unknown',
          type: inj.type ? inj.type.description : '',
        };
      });
    });

    if (!espnCache[sport]) espnCache[sport] = {};
    espnCache[sport].injuries = injuries;
    return injuries;
  } catch (e) {
    return {};
  }
}

// ============================================================
// Calculate injury impact on team power
// ============================================================
function calcInjuryImpact(injuries, teamAbbr) {
  if (!injuries || (!injuries[teamAbbr] && !injuries[espnAbbr(teamAbbr)])) return 0;
  var teamInj = injuries[teamAbbr] || injuries[espnAbbr(teamAbbr)] || [];
  var impact = 0;
  var outCount = 0;
  teamInj.forEach(function(inj) {
    if (inj.status === 'Out' || inj.status === 'Doubtful') {
      impact -= 0.5;
      outCount++;
    } else if (inj.status === 'Questionable') {
      impact -= 0.2;
    }
  });
  // Cap injury impact at -2.5 (even a decimated team can still play)
  return Math.max(-2.5, impact);
}

// ============================================================
// Back-to-Back Detection (ESPN Scoreboard)
// ============================================================
var b2bCache = { data: null, fetchedAt: 0 };

async function fetchYesterdayGames(sport) {
  if (b2bCache.data && Date.now() - b2bCache.fetchedAt < ESPN_TTL) return b2bCache.data;

  var espnSport = ESPN_SPORTS[sport];
  if (!espnSport) return {};

  try {
    // Get yesterday's date in YYYYMMDD format
    var yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    var dateStr = yesterday.getFullYear() +
      ('0' + (yesterday.getMonth() + 1)).slice(-2) +
      ('0' + yesterday.getDate()).slice(-2);

    var resp = await axios.get('https://site.api.espn.com/apis/site/v2/sports/' + espnSport + '/scoreboard', {
      params: { dates: dateStr },
      timeout: 10000,
    });

    var teamsPlayedYesterday = {};
    (resp.data.events || []).forEach(function(event) {
      var competitions = event.competitions || [];
      competitions.forEach(function(comp) {
        (comp.competitors || []).forEach(function(team) {
          var abbr = team.team ? team.team.abbreviation : null;
          if (abbr) teamsPlayedYesterday[abbr] = true;
        });
      });
    });

    b2bCache.data = teamsPlayedYesterday;
    b2bCache.fetchedAt = Date.now();
    var count = Object.keys(teamsPlayedYesterday).length;
    if (count > 0) console.log('[Games] B2B: ' + count + ' teams played yesterday');
    return teamsPlayedYesterday;
  } catch (e) {
    return {};
  }
}

// Back-to-back adjustment by sport
var B2B_PENALTY = { nba: -2.0, nhl: -1.0, mlb: -0.3, nfl: 0 };

function calcB2BAdjustment(b2bTeams, teamAbbr, sport) {
  if (!b2bTeams) return 0;
  var played = b2bTeams[teamAbbr] || b2bTeams[espnAbbr(teamAbbr)];
  if (!played) return 0;
  return B2B_PENALTY[sport] || 0;
}

// ============================================================
// Team abbreviation maps
// ============================================================
var TEAM_ABBR_MAP = {
  'Atlanta Hawks':'ATL','Boston Celtics':'BOS','Brooklyn Nets':'BKN','Charlotte Hornets':'CHA',
  'Chicago Bulls':'CHI','Cleveland Cavaliers':'CLE','Dallas Mavericks':'DAL','Denver Nuggets':'DEN',
  'Detroit Pistons':'DET','Golden State Warriors':'GSW','Houston Rockets':'HOU','Indiana Pacers':'IND',
  'Los Angeles Clippers':'LAC','Los Angeles Lakers':'LAL','LA Clippers':'LAC','LA Lakers':'LAL',
  'Memphis Grizzlies':'MEM','Miami Heat':'MIA','Milwaukee Bucks':'MIL','Minnesota Timberwolves':'MIN',
  'New Orleans Pelicans':'NOP','New York Knicks':'NYK','Oklahoma City Thunder':'OKC','Orlando Magic':'ORL',
  'Philadelphia 76ers':'PHI','Phoenix Suns':'PHX','Portland Trail Blazers':'POR','Sacramento Kings':'SAC',
  'San Antonio Spurs':'SAS','Toronto Raptors':'TOR','Utah Jazz':'UTA','Washington Wizards':'WAS',
  'Winnipeg Jets':'WPG','Dallas Stars':'DAL','Florida Panthers':'FLA','Colorado Avalanche':'COL',
  'Carolina Hurricanes':'CAR','Toronto Maple Leafs':'TOR','Edmonton Oilers':'EDM','Vegas Golden Knights':'VGK',
  'New York Rangers':'NYR','Minnesota Wild':'MIN','Los Angeles Kings':'LAK','New Jersey Devils':'NJD',
  'Ottawa Senators':'OTT','Vancouver Canucks':'VAN','Tampa Bay Lightning':'TBL','Boston Bruins':'BOS',
  'St. Louis Blues':'STL','Calgary Flames':'CGY','Columbus Blue Jackets':'CBJ','Buffalo Sabres':'BUF',
  'Detroit Red Wings':'DET','Seattle Kraken':'SEA','Philadelphia Flyers':'PHI','Washington Capitals':'WSH',
  'Montreal Canadiens':'MTL','Nashville Predators':'NSH','New York Islanders':'NYI','Pittsburgh Penguins':'PIT',
  'Anaheim Ducks':'ANA','San Jose Sharks':'SJS','Utah Hockey Club':'UTA','Chicago Blackhawks':'CHI',
  'Los Angeles Dodgers':'LAD','New York Yankees':'NYY','Atlanta Braves':'ATL','Philadelphia Phillies':'PHI',
  'Baltimore Orioles':'BAL','Houston Astros':'HOU','Cleveland Guardians':'CLE','Milwaukee Brewers':'MIL',
  'Arizona Diamondbacks':'ARI','Seattle Mariners':'SEA','Minnesota Twins':'MIN','Texas Rangers':'TEX',
  'San Diego Padres':'SDP','Tampa Bay Rays':'TBR','Boston Red Sox':'BOS','St. Louis Cardinals':'STL',
  'San Francisco Giants':'SFG','Detroit Tigers':'DET','Kansas City Royals':'KCR','Toronto Blue Jays':'TOR',
  'Cincinnati Reds':'CIN','Pittsburgh Pirates':'PIT','New York Mets':'NYM','Chicago Cubs':'CHC',
  'Los Angeles Angels':'LAA','Chicago White Sox':'CWS','Oakland Athletics':'OAK','Miami Marlins':'MIA',
  'Washington Nationals':'WSH','Colorado Rockies':'COL',
};
function abbrFromName(n) { return TEAM_ABBR_MAP[n] || (n ? n.substring(0,3).toUpperCase() : '???'); }
function fmtOdds(p) { return !p ? '' : p > 0 ? '+'+p : ''+p; }

// ============================================================
// Games Cache for Discord poster
// ============================================================
var gamesCache = {};
function getCachedGames(sport) {
  var c = gamesCache[sport];
  return (c && c.games && Date.now() - c.timestamp < 30*60*1000) ? c.games : null;
}

// ESPN uses different abbreviations than Odds API for some teams
var ESPN_ABBR_MAP = {
  WAS: 'WSH', WSH: 'WSH',
  NOP: 'NO', NO: 'NO',
  NYK: 'NY', NY: 'NY',
  GSW: 'GS', GS: 'GS',
  SAS: 'SA', SA: 'SA',
  UTA: 'UTAH', UTAH: 'UTAH',
  // NHL
  VGK: 'VGK',
  TBL: 'TB', TB: 'TB',
  NJD: 'NJ', NJ: 'NJ',
  SJS: 'SJ', SJ: 'SJ',
  LAK: 'LA', LA: 'LA',
  CBJ: 'CBJ',
  // MLB
  SDP: 'SD', SD: 'SD',
  SFG: 'SF', SF: 'SF',
  TBR: 'TB',
  KCR: 'KC', KC: 'KC',
  CWS: 'CHW', CHW: 'CHW',
  LAA: 'LAA',
  WSH: 'WSH',
};

function espnAbbr(abbr) {
  return ESPN_ABBR_MAP[abbr] || abbr;
}

function lookupTeam(liveTeams, abbr) {
  if (!liveTeams) return null;
  // Try direct lookup first, then ESPN abbreviation
  return liveTeams[abbr] || liveTeams[espnAbbr(abbr)] || null;
}

// ============================================================
// Analyze a single game with LIVE data
// ============================================================
function analyzeGame(game, sport, liveTeams, injuries, b2bTeams) {
  sport = sport || 'nba';
  var homeAbbr = abbrFromName(game.homeTeam);
  var awayAbbr = abbrFromName(game.awayTeam);

  // Get power ratings — prefer LIVE ESPN data, fall back to static
  var homePower, awayPower, homeRecord, awayRecord;
  var homeFormAdj = 0, awayFormAdj = 0;
  var homeHomeAdj = 0, awayAwayAdj = 0;
  var dataSource = 'static';

  var ht = lookupTeam(liveTeams, homeAbbr);
  var at = lookupTeam(liveTeams, awayAbbr);

  if (ht && at) {
    homePower = ht.power;
    awayPower = at.power;
    homeRecord = ht.wins + '-' + ht.losses;
    awayRecord = at.wins + '-' + at.losses;
    homeFormAdj = Math.max(-1.0, Math.min(1.0, ht.formFactor * 5));
    awayFormAdj = Math.max(-1.0, Math.min(1.0, at.formFactor * 5));
    homeHomeAdj = Math.max(-0.5, Math.min(0.5, (ht.homeWinPct - ht.winPct) * 3));
    awayAwayAdj = Math.max(-0.5, Math.min(0.5, (at.awayWinPct - at.winPct) * 3));
    dataSource = 'espn-live';
  } else {
    var staticMap = STATIC_POWER[sport] || STATIC_POWER.nba;
    homePower = staticMap[homeAbbr] || 5.5;
    awayPower = staticMap[awayAbbr] || 5.5;
    homeRecord = null;
    awayRecord = null;
  }

  // Injury adjustments
  var homeInjImpact = calcInjuryImpact(injuries, homeAbbr);
  var awayInjImpact = calcInjuryImpact(injuries, awayAbbr);

  // Back-to-back adjustment
  var homeB2B = calcB2BAdjustment(b2bTeams, homeAbbr, sport);
  var awayB2B = calcB2BAdjustment(b2bTeams, awayAbbr, sport);

  // Final adjusted power
  var homeAdj = homePower + homeFormAdj + homeHomeAdj + homeInjImpact + homeB2B;
  var awayAdj = awayPower + awayFormAdj + awayAwayAdj + awayInjImpact + awayB2B;
  var homeAdv = HOME_ADV[sport] || 3.0;

  // Collect book data
  var spreadData = [], totalData = [], mlData = [];
  (game.bookmakers || []).forEach(function(bk) {
    (bk.markets || []).forEach(function(mkt) {
      if (mkt.key === 'spreads') {
        var h = (mkt.outcomes||[]).find(function(o){return o.name===game.homeTeam});
        var a = (mkt.outcomes||[]).find(function(o){return o.name===game.awayTeam});
        if(h) spreadData.push({book:bk.title,side:'home',team:game.homeTeam,point:h.point,price:h.price});
        if(a) spreadData.push({book:bk.title,side:'away',team:game.awayTeam,point:a.point,price:a.price});
      }
      if (mkt.key === 'totals') {
        (mkt.outcomes||[]).forEach(function(o){ totalData.push({book:bk.title,side:o.name.toLowerCase(),point:o.point,price:o.price}); });
      }
      if (mkt.key === 'h2h') {
        (mkt.outcomes||[]).forEach(function(o){ mlData.push({book:bk.title,team:o.name,price:o.price}); });
      }
    });
  });

  // === SPREAD ===
  var homeSpreadLines = spreadData.filter(function(s){return s.side==='home'}).map(function(s){return s.point});
  var consensusSpread = homeSpreadLines.length > 0 ? +(homeSpreadLines.reduce(function(a,b){return a+b},0)/homeSpreadLines.length).toFixed(1) : 0;
  var bestHomeSpread = spreadData.filter(function(s){return s.side==='home'}).sort(function(a,b){return b.price-a.price})[0];
  var bestAwaySpread = spreadData.filter(function(s){return s.side==='away'}).sort(function(a,b){return b.price-a.price})[0];

  var expectedMargin = (homeAdj - awayAdj) + homeAdv;
  var spreadEdge = expectedMargin - Math.abs(consensusSpread) * (consensusSpread < 0 ? 1 : -1);
  var spreadPick, spreadConf;
  if (expectedMargin > consensusSpread + 1.5) {
    spreadPick = {side:game.homeTeam,abbr:homeAbbr,spread:consensusSpread,direction:'home'};
    spreadConf = Math.min(88, 55 + Math.abs(spreadEdge) * 3);
  } else if (expectedMargin < consensusSpread - 1.5) {
    spreadPick = {side:game.awayTeam,abbr:awayAbbr,spread:-consensusSpread,direction:'away'};
    spreadConf = Math.min(88, 55 + Math.abs(spreadEdge) * 3);
  } else {
    var lean = expectedMargin > consensusSpread ? 'home' : 'away';
    spreadPick = {side:lean==='home'?game.homeTeam:game.awayTeam,abbr:lean==='home'?homeAbbr:awayAbbr,
      spread:lean==='home'?consensusSpread:-consensusSpread,direction:lean};
    spreadConf = Math.min(70, 50 + Math.abs(spreadEdge) * 2);
  }
  spreadConf = Math.round(spreadConf);

  // === TOTAL ===
  var overLines = totalData.filter(function(t){return t.side==='over'}).map(function(t){return t.point});
  var consensusTotal = overLines.length > 0 ? +(overLines.reduce(function(a,b){return a+b},0)/overLines.length).toFixed(1) : DEFAULT_TOTALS[sport]||220;
  var bestOver = totalData.filter(function(t){return t.side==='over'}).sort(function(a,b){return b.price-a.price})[0];
  var bestUnder = totalData.filter(function(t){return t.side==='under'}).sort(function(a,b){return b.price-a.price})[0];

  var expectedTotal = DEFAULT_TOTALS[sport] || 220;
  try {
    var boostMod = require('./accuracy-boost');
    if (boostMod && boostMod.TEAM_DATA && sport === 'nba') {
      var hp = (boostMod.TEAM_DATA.pace||{})[homeAbbr]||98.5;
      var ap = (boostMod.TEAM_DATA.pace||{})[awayAbbr]||98.5;
      var hd = (boostMod.TEAM_DATA.defRating||{})[homeAbbr]||111;
      var ad = (boostMod.TEAM_DATA.defRating||{})[awayAbbr]||111;
      expectedTotal = ((hp+ap)/2/100) * ((hd+ad)/2) * 2;
    }
  } catch(e){}

  var totalEdge = expectedTotal - consensusTotal;
  var totalPick, totalConf;
  if (totalEdge > 2) { totalPick={side:'OVER',total:consensusTotal}; totalConf=Math.min(80,55+totalEdge*2); }
  else if (totalEdge < -2) { totalPick={side:'UNDER',total:consensusTotal}; totalConf=Math.min(80,55+Math.abs(totalEdge)*2); }
  else { totalPick={side:totalEdge>0?'OVER':'UNDER',total:consensusTotal}; totalConf=Math.min(65,50+Math.abs(totalEdge)*1.5); }
  totalConf = Math.round(totalConf);

  // === MONEYLINE ===
  var bestHomeMl = mlData.filter(function(m){return m.team===game.homeTeam}).sort(function(a,b){return b.price-a.price})[0];
  var bestAwayMl = mlData.filter(function(m){return m.team===game.awayTeam}).sort(function(a,b){return b.price-a.price})[0];
  var winnerPick = expectedMargin > 0
    ? {team:game.homeTeam,abbr:homeAbbr,confidence:Math.min(92,55+Math.abs(expectedMargin)*3)}
    : {team:game.awayTeam,abbr:awayAbbr,confidence:Math.min(92,55+Math.abs(expectedMargin)*3)};
  winnerPick.confidence = Math.round(winnerPick.confidence);
  winnerPick.bestOdds = expectedMargin > 0 ? bestHomeMl : bestAwayMl;

  // === LINE SHOP ===
  var lineShop = {};
  (game.bookmakers||[]).forEach(function(bk){
    lineShop[bk.title] = {};
    (bk.markets||[]).forEach(function(mkt){
      if(mkt.key==='spreads'){var h=(mkt.outcomes||[]).find(function(o){return o.name===game.homeTeam});var a=(mkt.outcomes||[]).find(function(o){return o.name===game.awayTeam});lineShop[bk.title].homeSpread=h?h.point+' ('+fmtOdds(h.price)+')':null;lineShop[bk.title].awaySpread=a?a.point+' ('+fmtOdds(a.price)+')':null;}
      if(mkt.key==='totals'){var ov=(mkt.outcomes||[]).find(function(o){return o.name==='Over'});var un=(mkt.outcomes||[]).find(function(o){return o.name==='Under'});lineShop[bk.title].over=ov?ov.point+' ('+fmtOdds(ov.price)+')':null;lineShop[bk.title].under=un?un.point+' ('+fmtOdds(un.price)+')':null;}
      if(mkt.key==='h2h'){var hm=(mkt.outcomes||[]).find(function(o){return o.name===game.homeTeam});var am=(mkt.outcomes||[]).find(function(o){return o.name===game.awayTeam});lineShop[bk.title].homeML=hm?fmtOdds(hm.price):null;lineShop[bk.title].awayML=am?fmtOdds(am.price):null;}
    });
  });

  // === ENVIRONMENT ===
  var absSpread = Math.abs(consensusSpread);
  var environment;
  if (sport==='nba') {
    if(consensusTotal>=235&&absSpread<=5) environment='Shootout';
    else if(consensusTotal>=230) environment='High Scoring';
    else if(absSpread>=12) environment='Blowout Expected';
    else if(absSpread<=3) environment='Toss-Up';
    else if(consensusTotal<=210) environment='Defensive Battle';
    else environment='Standard';
  } else if (sport==='nhl') {
    if(consensusTotal>=6.5) environment='High Scoring';
    else if(consensusTotal<=5.5) environment='Defensive Battle';
    else if(absSpread<=0.5) environment='Toss-Up';
    else environment='Standard';
  } else if (sport==='mlb') {
    if(consensusTotal>=9.5) environment='High Scoring';
    else if(consensusTotal<=7) environment='Pitchers Duel';
    else environment='Standard';
  } else {
    if(consensusTotal>=50) environment='Shootout';
    else if(consensusTotal<=38) environment='Defensive Battle';
    else if(absSpread<=3) environment='Toss-Up';
    else if(absSpread>=14) environment='Blowout Expected';
    else environment='Standard';
  }

  // === BEST BET ===
  var maxConf = Math.max(winnerPick.confidence, spreadConf, totalConf);
  var bestBet = null;
  if (maxConf >= 65) {
    if(maxConf===spreadConf) bestBet={type:'Spread',pick:spreadPick.abbr+' '+(spreadPick.spread>0?'+':'')+spreadPick.spread,confidence:spreadConf};
    else if(maxConf===winnerPick.confidence) bestBet={type:'Moneyline',pick:winnerPick.abbr,confidence:winnerPick.confidence};
    else bestBet={type:'Total',pick:totalPick.side+' '+totalPick.total,confidence:totalConf};
  }

  return {
    id:game.id, homeTeam:game.homeTeam, awayTeam:game.awayTeam, homeAbbr:homeAbbr, awayAbbr:awayAbbr,
    commenceTime:game.commenceTime, sport:sport, environment:environment, bestBet:bestBet,
    dataSource: dataSource,
    records: { home: homeRecord, away: awayRecord,
      homeL10: ht ? ht.l10Record : null,
      awayL10: at ? at.l10Record : null,
      homeStreak: ht ? ht.streak : null,
      awayStreak: at ? at.streak : null,
      homePPG: ht ? ht.ppg : null,
      awayPPG: at ? at.ppg : null,
    },
    adjustments: {
      homePower: +homeAdj.toFixed(1), awayPower: +awayAdj.toFixed(1),
      homeForm: +homeFormAdj.toFixed(2), awayForm: +awayFormAdj.toFixed(2),
      homeInjury: homeInjImpact, awayInjury: awayInjImpact,
      homeB2B: homeB2B, awayB2B: awayB2B,
    },
    consensus: {spread:consensusSpread,total:consensusTotal},
    predictions: {
      winner: winnerPick,
      spread: Object.assign({},spreadPick,{confidence:spreadConf,bestOdds:spreadPick.direction==='home'?bestHomeSpread:bestAwaySpread}),
      total: Object.assign({},totalPick,{confidence:totalConf,bestOver:bestOver,bestUnder:bestUnder}),
    },
    bestOdds: {homeSpread:bestHomeSpread,awaySpread:bestAwaySpread,over:bestOver,under:bestUnder,homeML:bestHomeMl||null,awayML:bestAwayMl||null},
    lineShop:lineShop, bookCount:Object.keys(lineShop).length,
  };
}

// ============================================================
// API Routes
// ============================================================
var PROP_SPORTS = {nba:'basketball_nba',nfl:'americanfootball_nfl',mlb:'baseball_mlb',nhl:'icehockey_nhl'};

router.get('/:sport', async function(req, res) {
  var sport = req.params.sport;
  try {
    // Check cache
    var cached = getCachedGames(sport);
    if (cached) return res.json({sport:sport,games:cached,count:cached.length,source:'cache',timestamp:new Date().toISOString()});

    // Fetch LIVE ESPN data in parallel with Odds API
    var ODDS_KEY = process.env.ODDS_API_KEY;
    var oddsSport = PROP_SPORTS[sport];

    var [liveTeams, injuries, b2bTeams, oddsData] = await Promise.all([
      fetchESPNTeams(sport),
      fetchESPNInjuries(sport),
      fetchYesterdayGames(sport),
      (ODDS_KEY && oddsSport) ? axios.get('https://api.the-odds-api.com/v4/sports/'+oddsSport+'/odds', {
        params:{apiKey:ODDS_KEY,regions:'us,us2',markets:'spreads,totals,h2h',oddsFormat:'american'},
        timeout:15000,
      }).then(function(r){return r.data}).catch(function(){return []}) : Promise.resolve([]),
    ]);

    var games = (oddsData || []).map(function(g) {
      return {id:g.id,homeTeam:g.home_team,awayTeam:g.away_team,commenceTime:g.commence_time,
        bookmakers:(g.bookmakers||[]).map(function(b){return{title:b.title,key:b.key,markets:b.markets}})};
    });

    if (!games.length) return res.json({sport:sport,games:[],count:0,message:'No games with odds today'});

    var predictions = games.map(function(g) { return analyzeGame(g, sport, liveTeams, injuries, b2bTeams); });
    predictions.sort(function(a,b) { return b.predictions.spread.confidence - a.predictions.spread.confidence; });

    // Cache
    gamesCache[sport] = {games:predictions,timestamp:Date.now()};
    console.log('[Games] Analyzed '+predictions.length+' '+sport.toUpperCase()+' games (source: '+(liveTeams?'ESPN live':'static')+')');

    res.json({
      sport:sport, games:predictions, count:predictions.length,
      dataSource: liveTeams ? 'espn-live' : 'static',
      bestBets: predictions.filter(function(g){return g.bestBet}).map(function(g){
        return{game:g.awayAbbr+' @ '+g.homeAbbr,type:g.bestBet.type,pick:g.bestBet.pick,confidence:g.bestBet.confidence};
      }),
      timestamp: new Date().toISOString(),
    });
  } catch(err) {
    console.error('[Games] Error:', err.message);
    res.json({sport:sport,games:[],count:0,error:err.message});
  }
});

router.get('/:sport/:gameId', async function(req, res) {
  var sport=req.params.sport, gameId=req.params.gameId;
  try {
    var cached = getCachedGames(sport);
    if(cached){var game=cached.find(function(g){return g.id===gameId});if(game)return res.json(game)}
    // Don't self-reference /api/games/:sport — if cache is empty, return not found
    // The cache will be populated by the next regular refresh cycle
    res.json({error:'Game not found — predictions refresh every 30 minutes'});
  } catch(err){res.json({error:err.message})}
});

module.exports = { router, analyzeGame, gamesCache, getCachedGames, fetchESPNTeams, fetchESPNInjuries, fetchYesterdayGames };
