/**
 * oracle-features.js — Next-Level Features for ORACLE
 * 
 * 1. Auto-Grading → Redis (graded picks survive restarts)
 * 2. Historical Performance Dashboard (daily/weekly/monthly stats)
 * 3. Same-Game Parlay (SGP) Correlation Engine
 * 4. Bankroll Simulator / Backtester
 * 5. Alerts System (Demon drops, +EV edges, POTD)
 * 
 * All data stored in Redis — accessible from web server.
 * Worker calls these functions, web server reads results.
 */

let redisCache = null;
try { redisCache = require('./redis-cache'); } catch(e) {}

// ============================================================
// 1. AUTO-GRADING — Grade picks against ESPN box scores
// ============================================================

/**
 * Grade a single pick: compare predicted line to actual stat
 * Returns { hit, miss, push, actual }
 */
function gradePick(pick, actual) {
  if (actual === null || actual === undefined) return { result: 'pending', actual: null };
  
  var line = parseFloat(pick.line || pick.consensusLine || 0);
  var direction = (pick.pick || pick.suggestion || '').toUpperCase();
  
  if (direction === 'OVER') {
    if (actual > line) return { result: 'hit', actual: actual };
    if (actual === line) return { result: 'push', actual: actual };
    return { result: 'miss', actual: actual };
  } else if (direction === 'UNDER') {
    if (actual < line) return { result: 'hit', actual: actual };
    if (actual === line) return { result: 'push', actual: actual };
    return { result: 'miss', actual: actual };
  }
  return { result: 'pending', actual: actual };
}

/**
 * Map prop market names to ESPN box score stat keys
 */
function mapMarketToStat(market) {
  var m = (market || '').toLowerCase();
  if (m.includes('point') || m === 'pts') return 'points';
  if (m.includes('rebound') || m === 'reb') return 'rebounds';
  if (m.includes('assist') || m === 'ast') return 'assists';
  if (m.includes('three') || m.includes('3pt') || m.includes('3-pointer')) return 'threePointFieldGoalsMade';
  if (m.includes('steal')) return 'steals';
  if (m.includes('block')) return 'blocks';
  if (m.includes('turnover')) return 'turnovers';
  if (m.includes('pra') || m.includes('pts+reb+ast')) return 'pra';
  if (m.includes('pr') || m.includes('pts+reb')) return 'pr';
  if (m.includes('pa') || m.includes('pts+ast')) return 'pa';
  if (m.includes('ra') || m.includes('reb+ast')) return 'ra';
  // NHL
  if (m.includes('goal') || m.includes('scorer')) return 'goals';
  if (m.includes('shot')) return 'shots';
  if (m.includes('save')) return 'saves';
  return null;
}

/**
 * Fetch ESPN box score for a game and extract player stats
 */
async function fetchBoxScore(sport, eventId) {
  var axios = require('axios');
  var sportPath = { nba: 'basketball/nba', nhl: 'hockey/nhl', mlb: 'baseball/mlb', nfl: 'football/nfl' }[sport] || 'basketball/nba';
  
  try {
    var url = 'https://site.api.espn.com/apis/site/v2/sports/' + sportPath + '/summary?event=' + eventId;
    var resp = await axios.get(url, { timeout: 10000 });
    var boxscore = resp.data.boxscore;
    if (!boxscore || !boxscore.players) return {};
    
    var playerStats = {};
    boxscore.players.forEach(function(team) {
      (team.statistics || []).forEach(function(statGroup) {
        var labels = statGroup.labels || [];
        (statGroup.athletes || []).forEach(function(athlete) {
          var name = athlete.athlete ? athlete.athlete.displayName : '';
          var stats = athlete.stats || [];
          var obj = {};
          labels.forEach(function(label, i) {
            obj[label.toLowerCase()] = stats[i];
          });
          // Parse numeric values
          var parsed = {
            points: parseInt(obj.pts || obj.points || 0) || 0,
            rebounds: parseInt(obj.reb || obj.rebounds || 0) || 0,
            assists: parseInt(obj.ast || obj.assists || 0) || 0,
            threePointFieldGoalsMade: parseInt((obj['3pt'] || obj['3pm'] || '0').split('-')[0]) || 0,
            steals: parseInt(obj.stl || obj.steals || 0) || 0,
            blocks: parseInt(obj.blk || obj.blocks || 0) || 0,
            turnovers: parseInt(obj.to || obj.turnovers || 0) || 0,
          };
          parsed.pra = parsed.points + parsed.rebounds + parsed.assists;
          parsed.pr = parsed.points + parsed.rebounds;
          parsed.pa = parsed.points + parsed.assists;
          parsed.ra = parsed.rebounds + parsed.assists;
          playerStats[name.toLowerCase()] = parsed;
        });
      });
    });
    return playerStats;
  } catch(e) {
    return {};
  }
}

/**
 * Run grading cycle — fetch finished games, grade all ungraded picks
 * Stores results in Redis
 */
async function runGradingCycle() {
  if (!redisCache) return;
  
  var axios = require('axios');
  var PORT = process.env.PORT || 3001;
  
  try {
    // Get today's and yesterday's picks from Redis
    var allGrades = (await redisCache.get('oracle:graded_picks')) || [];
    var sports = ['nba', 'nhl'];
    
    for (var si = 0; si < sports.length; si++) {
      var sport = sports[si];
      var sportPath = { nba: 'basketball/nba', nhl: 'hockey/nhl' }[sport];
      
      // Get finished games from ESPN
      try {
        var scoreResp = await axios.get('https://site.api.espn.com/apis/site/v2/sports/' + sportPath + '/scoreboard', { timeout: 10000 });
        var events = scoreResp.data.events || [];
        var finishedGames = events.filter(function(e) { return e.status && e.status.type && e.status.type.completed; });
        
        if (finishedGames.length === 0) continue;
        
        // Get the props that were available for grading
        var propsData = await redisCache.getProps(sport);
        var props = propsData ? (propsData.props || propsData.picks || []) : [];
        
        if (props.length === 0) continue;
        
        // For each finished game, get box score and grade props
        for (var gi = 0; gi < finishedGames.length; gi++) {
          var game = finishedGames[gi];
          var eventId = game.id;
          var playerStats = await fetchBoxScore(sport, eventId);
          
          if (Object.keys(playerStats).length === 0) continue;
          
          // Grade each prop for this game
          props.forEach(function(prop) {
            // Check if this prop is for this game
            var propGame = (prop.game || '').toLowerCase();
            var teams = (game.shortName || '').toLowerCase();
            if (!propGame || !teams) return;
            
            // Match game by team names
            var teamsInProp = propGame.replace('@', ' ').replace(' vs ', ' ').split(/\s+/);
            var teamsInGame = teams.replace('@', ' ').replace(' vs ', ' ').split(/\s+/);
            var gameMatch = teamsInProp.some(function(t) { return teamsInGame.some(function(g) { return g.includes(t) || t.includes(g); }); });
            if (!gameMatch) return;
            
            // Check if already graded
            var gradeKey = prop.player + '|' + prop.market + '|' + (prop.consensusLine || prop.line) + '|' + eventId;
            var alreadyGraded = allGrades.some(function(g) { return g.key === gradeKey; });
            if (alreadyGraded) return;
            
            // Find player stats
            var playerName = (prop.player || '').toLowerCase();
            var stats = playerStats[playerName];
            if (!stats) {
              // Try partial match
              var keys = Object.keys(playerStats);
              var match = keys.find(function(k) { return k.includes(playerName) || playerName.includes(k); });
              if (match) stats = playerStats[match];
            }
            if (!stats) return;
            
            // Get the actual stat value
            var statKey = mapMarketToStat(prop.market || prop.marketLabel);
            if (!statKey || stats[statKey] === undefined) return;
            var actual = stats[statKey];
            
            // Determine direction
            var direction = '';
            if (prop.analytics && prop.analytics.suggestion) direction = prop.analytics.suggestion;
            else if (prop.pick) direction = prop.pick;
            
            if (!direction) return;
            
            // Grade it
            var line = parseFloat(prop.consensusLine || prop.line || 0);
            var hit = direction.toUpperCase() === 'OVER' ? actual > line : actual < line;
            var push = actual === line;
            
            allGrades.push({
              key: gradeKey,
              date: new Date().toISOString().split('T')[0],
              timestamp: Date.now(),
              player: prop.player,
              market: prop.marketLabel || prop.market,
              line: line,
              pick: direction.toUpperCase(),
              actual: actual,
              result: push ? 'push' : (hit ? 'hit' : 'miss'),
              confidence: prop.confidence,
              grade: prop.grade,
              game: prop.game,
              sport: sport,
              lineType: prop.lineType,
              bookCount: prop.bookCount,
            });
          });
        }
      } catch(e) {
        console.warn('[Grading] Error for ' + sport + ':', e.message);
      }
    }
    
    // Save to Redis
    if (allGrades.length > 0) {
      // Keep last 1000 grades max
      if (allGrades.length > 1000) allGrades = allGrades.slice(-1000);
      await redisCache.set('oracle:graded_picks', allGrades, 30 * 24 * 3600); // 30 day TTL
      
      // Calculate and save stats
      var stats = calculateStats(allGrades);
      await redisCache.set('oracle:grading_stats', stats, 30 * 24 * 3600);
      
      console.log('[Grading] Graded ' + allGrades.length + ' total picks. Hit rate: ' + stats.overall.hitRate + '%');
    }
  } catch(e) {
    console.warn('[Grading] Cycle error:', e.message);
  }
}

// ============================================================
// 2. HISTORICAL PERFORMANCE — Calculate stats by period
// ============================================================

function calculateStats(grades) {
  var now = Date.now();
  var dayMs = 24 * 60 * 60 * 1000;
  
  function calc(picks) {
    var hits = picks.filter(function(p) { return p.result === 'hit'; }).length;
    var misses = picks.filter(function(p) { return p.result === 'miss'; }).length;
    var pushes = picks.filter(function(p) { return p.result === 'push'; }).length;
    var total = hits + misses;
    return {
      total: total,
      hits: hits,
      misses: misses,
      pushes: pushes,
      hitRate: total > 0 ? Math.round((hits / total) * 1000) / 10 : 0,
      profit: calculateProfit(picks),
    };
  }
  
  var all = grades.filter(function(g) { return g.result === 'hit' || g.result === 'miss' || g.result === 'push'; });
  var today = all.filter(function(g) { return g.date === new Date().toISOString().split('T')[0]; });
  var last7 = all.filter(function(g) { return now - g.timestamp < 7 * dayMs; });
  var last30 = all.filter(function(g) { return now - g.timestamp < 30 * dayMs; });
  
  // By sport
  var bySport = {};
  ['nba', 'nhl', 'mlb', 'nfl'].forEach(function(sport) {
    var sportPicks = all.filter(function(g) { return g.sport === sport; });
    if (sportPicks.length > 0) bySport[sport] = calc(sportPicks);
  });
  
  // By line type (Demon vs Goblin vs Edge vs regular)
  var byLineType = {};
  ['demon', 'goblin', 'edge'].forEach(function(type) {
    var typed = all.filter(function(g) { return g.lineType === type; });
    if (typed.length > 0) byLineType[type] = calc(typed);
  });
  
  // By market (Points, Rebounds, Assists, etc.)
  var byMarket = {};
  all.forEach(function(g) {
    var market = (g.market || 'unknown').toLowerCase();
    if (!byMarket[market]) byMarket[market] = [];
    byMarket[market].push(g);
  });
  Object.keys(byMarket).forEach(function(m) { byMarket[m] = calc(byMarket[m]); });
  
  // Daily history (for charts)
  var dailyMap = {};
  all.forEach(function(g) {
    if (!dailyMap[g.date]) dailyMap[g.date] = [];
    dailyMap[g.date].push(g);
  });
  var daily = Object.keys(dailyMap).sort().map(function(date) {
    var dayPicks = dailyMap[date];
    var dayStats = calc(dayPicks);
    return { date: date, hits: dayStats.hits, misses: dayStats.misses, total: dayStats.total, hitRate: dayStats.hitRate, profit: dayStats.profit };
  });
  
  return {
    overall: calc(all),
    today: calc(today),
    last7Days: calc(last7),
    last30Days: calc(last30),
    bySport: bySport,
    byLineType: byLineType,
    byMarket: byMarket,
    daily: daily,
    recentPicks: all.slice(-50).reverse(),
    lastUpdated: new Date().toISOString(),
  };
}

function calculateProfit(picks) {
  // Flat $100 bet on each pick at -110 odds
  var profit = 0;
  picks.forEach(function(p) {
    if (p.result === 'hit') profit += 90.91; // Win $90.91 at -110
    else if (p.result === 'miss') profit -= 100;
    // Push = $0
  });
  return Math.round(profit * 100) / 100;
}

// ============================================================
// 3. SAME-GAME PARLAY (SGP) CORRELATION ENGINE
// ============================================================

/**
 * Calculate correlation between two props in the same game
 * Returns a correlation score from -1 (negative) to +1 (positive)
 */
function calculateCorrelation(prop1, prop2) {
  var m1 = (prop1.market || prop1.marketLabel || '').toLowerCase();
  var m2 = (prop2.market || prop2.marketLabel || '').toLowerCase();
  var d1 = (prop1.pick || prop1.suggestion || '').toUpperCase();
  var d2 = (prop2.pick || prop2.suggestion || '').toUpperCase();
  var samePlayer = prop1.player === prop2.player;
  
  // Same player correlations
  if (samePlayer) {
    // Points OVER + Assists OVER = moderate positive (player is having a good game)
    if (m1.includes('point') && m2.includes('assist') && d1 === d2) return 0.4;
    if (m1.includes('point') && m2.includes('rebound') && d1 === d2) return 0.3;
    if (m1.includes('assist') && m2.includes('rebound') && d1 === d2) return 0.2;
    // PRA OVER + any stat OVER = high positive
    if ((m1.includes('pra') || m2.includes('pra')) && d1 === d2) return 0.7;
    // Opposite directions on same player = negative
    if (d1 !== d2) return -0.3;
  }
  
  // Same team correlations
  var sameTeam = false;
  if (prop1.game === prop2.game) {
    // Check if same team by looking at player names in game context
    var game = prop1.game || '';
    sameTeam = true; // Simplified — would need roster data for accurate check
  }
  
  // Both OVER on high-scoring game environment = positive
  if (d1 === 'OVER' && d2 === 'OVER') return 0.15;
  if (d1 === 'UNDER' && d2 === 'UNDER') return 0.1;
  
  return 0;
}

/**
 * Build SGP suggestions from available props
 */
async function buildSGPSuggestions() {
  if (!redisCache) return [];
  
  var propsData = await redisCache.getProps('nba');
  var props = propsData ? (propsData.props || propsData.picks || []) : [];
  
  if (props.length < 2) return [];
  
  // Group props by game
  var gameGroups = {};
  props.forEach(function(p) {
    var game = p.game || 'unknown';
    if (!gameGroups[game]) gameGroups[game] = [];
    gameGroups[game].push(p);
  });
  
  var sgpSuggestions = [];
  
  Object.keys(gameGroups).forEach(function(game) {
    var gameProps = gameGroups[game];
    
    // Find high-confidence Demon lines from same game
    var demons = gameProps.filter(function(p) { return p.lineType === 'demon' && p.bookCount >= 8; });
    
    if (demons.length >= 2) {
      // Build 2-3 leg parlays from correlated Demons
      for (var i = 0; i < Math.min(demons.length, 3); i++) {
        for (var j = i + 1; j < Math.min(demons.length, 4); j++) {
          var corr = calculateCorrelation(demons[i], demons[j]);
          if (corr > 0) {
            sgpSuggestions.push({
              game: game,
              legs: [
                { player: demons[i].player, market: demons[i].marketLabel || demons[i].market, line: demons[i].consensusLine, direction: demons[i].analytics ? demons[i].analytics.suggestion : 'OVER', bookCount: demons[i].bookCount },
                { player: demons[j].player, market: demons[j].marketLabel || demons[j].market, line: demons[j].consensusLine, direction: demons[j].analytics ? demons[j].analytics.suggestion : 'OVER', bookCount: demons[j].bookCount },
              ],
              correlation: corr,
              confidence: Math.round((corr + 1) * 50), // 0-100 scale
              type: corr > 0.3 ? 'Strong Correlation' : 'Moderate Correlation',
            });
          }
        }
      }
    }
  });
  
  // Sort by correlation (best first)
  sgpSuggestions.sort(function(a, b) { return b.correlation - a.correlation; });
  
  return sgpSuggestions.slice(0, 20); // Top 20
}

// ============================================================
// 4. BANKROLL SIMULATOR
// ============================================================

async function simulateBankroll(options) {
  if (!redisCache) return null;
  
  options = options || {};
  var startingBankroll = options.bankroll || 1000;
  var betSize = options.betSize || 100;
  var strategy = options.strategy || 'flat'; // flat, kelly, percentage
  var lineTypeFilter = options.lineType || null; // 'demon', 'edge', null for all
  
  var grades = (await redisCache.get('oracle:graded_picks')) || [];
  if (grades.length === 0) return { message: 'No graded picks yet. Check back after tonight\'s games.' };
  
  var filtered = lineTypeFilter ? grades.filter(function(g) { return g.lineType === lineTypeFilter; }) : grades;
  filtered = filtered.filter(function(g) { return g.result === 'hit' || g.result === 'miss'; });
  
  if (filtered.length === 0) return { message: 'No graded picks match your filter.' };
  
  var bankroll = startingBankroll;
  var peak = startingBankroll;
  var trough = startingBankroll;
  var history = [{ date: filtered[0].date, bankroll: startingBankroll, bet: 0, result: 'start' }];
  
  filtered.forEach(function(pick) {
    var currentBet = betSize;
    
    if (strategy === 'percentage') {
      currentBet = Math.round(bankroll * 0.05); // 5% of bankroll
    } else if (strategy === 'kelly') {
      var hitRate = 0.55; // Estimated
      var odds = 1.909; // -110 implied
      var kelly = ((hitRate * odds) - 1) / (odds - 1);
      currentBet = Math.max(10, Math.round(bankroll * Math.min(kelly * 0.25, 0.05))); // Quarter Kelly
    }
    
    if (pick.result === 'hit') {
      bankroll += Math.round(currentBet * 0.909); // -110 payout
    } else {
      bankroll -= currentBet;
    }
    
    if (bankroll > peak) peak = bankroll;
    if (bankroll < trough) trough = bankroll;
    
    history.push({
      date: pick.date,
      bankroll: bankroll,
      bet: currentBet,
      result: pick.result,
      player: pick.player,
      market: pick.market,
    });
  });
  
  return {
    startingBankroll: startingBankroll,
    finalBankroll: bankroll,
    profit: bankroll - startingBankroll,
    roi: Math.round(((bankroll - startingBankroll) / startingBankroll) * 1000) / 10,
    totalBets: filtered.length,
    wins: filtered.filter(function(g) { return g.result === 'hit'; }).length,
    losses: filtered.filter(function(g) { return g.result === 'miss'; }).length,
    peak: peak,
    trough: trough,
    maxDrawdown: Math.round(((peak - trough) / peak) * 1000) / 10,
    strategy: strategy,
    lineType: lineTypeFilter || 'all',
    history: history,
  };
}

// ============================================================
// 5. ALERTS SYSTEM
// ============================================================

async function checkAlerts() {
  if (!redisCache) return;
  
  var alerts = [];
  
  try {
    // Check for new Demon lines (6+ books)
    var propsData = await redisCache.getProps('nba');
    var props = propsData ? (propsData.props || propsData.picks || []) : [];
    var demons = props.filter(function(p) { return p.lineType === 'demon' && p.bookCount >= 10; });
    
    if (demons.length > 0) {
      alerts.push({
        type: 'demon',
        priority: 'high',
        title: '🔥 ' + demons.length + ' High-Consensus Demon Lines',
        message: demons[0].player + ' ' + (demons[0].marketLabel || demons[0].market) + ' @ ' + demons[0].consensusLine + ' (' + demons[0].bookCount + ' books agree)',
        count: demons.length,
        timestamp: Date.now(),
      });
    }
    
    // Check for high-edge EV bets (10%+ edge)
    var evBets = (await redisCache.getEV()) || [];
    var highEdge = evBets.filter(function(b) { return (b.edgePercent || 0) >= 10; });
    
    if (highEdge.length > 0) {
      alerts.push({
        type: 'ev',
        priority: 'high',
        title: '💰 ' + highEdge.length + ' High-Edge +EV Bets (10%+)',
        message: highEdge[0].player + ' ' + highEdge[0].market + ' — ' + (highEdge[0].edgePercent || 0).toFixed(1) + '% edge at ' + highEdge[0].book,
        count: highEdge.length,
        timestamp: Date.now(),
      });
    }
    
    // Check for POTD
    var potd = await redisCache.getPOTD();
    if (potd && potd.pickOfTheDay) {
      alerts.push({
        type: 'potd',
        priority: 'medium',
        title: '🏆 Pick of the Day Available',
        message: potd.pickOfTheDay.player + ' ' + potd.pickOfTheDay.market + ' — ' + potd.pickOfTheDay.pick,
        timestamp: Date.now(),
      });
    }
  } catch(e) {}
  
  // Save alerts to Redis
  if (alerts.length > 0) {
    await redisCache.set('oracle:alerts', alerts, 3600); // 1 hour TTL
  }
  
  return alerts;
}

// ============================================================
// WORKER INTEGRATION — Call from server.js sync loop
// ============================================================

async function runAllFeatures() {
  try {
    await runGradingCycle();
  } catch(e) { console.warn('[Features] Grading error:', e.message); }
  
  try {
    var sgp = await buildSGPSuggestions();
    if (sgp.length > 0 && redisCache) {
      await redisCache.set('oracle:sgp_suggestions', sgp, 1800);
    }
  } catch(e) { console.warn('[Features] SGP error:', e.message); }
  
  try {
    await checkAlerts();
  } catch(e) { console.warn('[Features] Alerts error:', e.message); }
  
  try {
    // Run bankroll sim with default settings
    var sim = await simulateBankroll({ bankroll: 1000, betSize: 100, strategy: 'flat' });
    if (sim && redisCache) {
      await redisCache.set('oracle:bankroll_sim', sim, 3600);
    }
    // Also sim for Demons only
    var demonSim = await simulateBankroll({ bankroll: 1000, betSize: 100, strategy: 'flat', lineType: 'demon' });
    if (demonSim && redisCache) {
      await redisCache.set('oracle:bankroll_sim_demon', demonSim, 3600);
    }
  } catch(e) { console.warn('[Features] Bankroll error:', e.message); }
}

module.exports = {
  runGradingCycle,
  calculateStats,
  buildSGPSuggestions,
  simulateBankroll,
  checkAlerts,
  runAllFeatures,
  gradePick,
  calculateCorrelation,
};
