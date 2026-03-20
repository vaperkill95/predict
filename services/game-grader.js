/**
 * game-grader.js — Auto-Grade Game Predictions + Live Team Stats + H2H
 * 
 * ALL ESPN data — zero Odds API cost
 * 
 * Features:
 *   1. Auto-grade yesterday's ML/spread/total predictions
 *   2. Live team stats (pace, ORtg, DRtg) from ESPN
 *   3. Head-to-head season records
 *   4. API routes for game accuracy dashboard
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const router = require('express').Router();

const ESPN_SPORTS = {
  nba: 'basketball/nba',
  nhl: 'hockey/nhl',
};

const GRADES_FILE = path.join(__dirname, '..', 'data', 'game-grades.json');

// ============================================================
// Game Grades Storage
// ============================================================
var gameGrades = {
  graded: [],
  stats: { total: 0, mlHits: 0, mlTotal: 0, spreadHits: 0, spreadTotal: 0, totalHits: 0, totalTotal: 0 },
};

function loadGameGrades() {
  try {
    if (fs.existsSync(GRADES_FILE)) {
      gameGrades = JSON.parse(fs.readFileSync(GRADES_FILE, 'utf8'));
      console.log('[GameGrader] Loaded ' + (gameGrades.graded || []).length + ' graded game predictions');
    }
  } catch(e) {}
}

function saveGameGrades() {
  try {
    var dir = path.dirname(GRADES_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(GRADES_FILE, JSON.stringify(gameGrades, null, 2));
  } catch(e) {}
}

// ============================================================
// Fetch yesterday's final scores from ESPN
// ============================================================
async function gradeYesterdayGames(sport, cachedPredictions) {
  sport = sport || 'nba';
  var espnSport = ESPN_SPORTS[sport];
  if (!espnSport) return 0;

  try {
    var yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    var dateStr = yesterday.getFullYear() + ('0'+(yesterday.getMonth()+1)).slice(-2) + ('0'+yesterday.getDate()).slice(-2);

    var resp = await axios.get('https://site.api.espn.com/apis/site/v2/sports/' + espnSport + '/scoreboard', {
      params: { dates: dateStr },
      timeout: 12000,
    });

    var events = resp.data.events || [];
    var newGrades = 0;

    events.forEach(function(event) {
      var comp = (event.competitions || [])[0];
      if (!comp) return;
      var statusName = comp.status && comp.status.type ? comp.status.type.name : '';
      if (statusName !== 'STATUS_FINAL') return;

      var homeTeam = null, awayTeam = null;
      (comp.competitors || []).forEach(function(c) {
        var obj = { abbr: c.team.abbreviation, name: c.team.displayName, score: parseInt(c.score) || 0 };
        if (c.homeAway === 'home') homeTeam = obj; else awayTeam = obj;
      });
      if (!homeTeam || !awayTeam) return;

      var gameKey = dateStr + '_' + awayTeam.abbr + '_' + homeTeam.abbr;
      if (gameGrades.graded.some(function(g) { return g.key === gameKey; })) return;

      var totalScore = homeTeam.score + awayTeam.score;
      var actualMargin = homeTeam.score - awayTeam.score;
      var actualWinner = homeTeam.score > awayTeam.score ? homeTeam.abbr : awayTeam.abbr;

      // Try to find our prediction — check cached predictions
      var pred = null;
      if (cachedPredictions && cachedPredictions.length > 0) {
        pred = cachedPredictions.find(function(g) {
          return g.homeAbbr === homeTeam.abbr || g.awayAbbr === awayTeam.abbr ||
            g.homeAbbr === homeTeam.abbr.replace('WSH','WAS').replace('NY','NYK').replace('GS','GSW').replace('SA','SAS').replace('NO','NOP').replace('UTAH','UTA');
        });
      }

      var grade = {
        key: gameKey, date: dateStr, sport: sport,
        home: homeTeam.abbr, homeName: homeTeam.name, homeScore: homeTeam.score,
        away: awayTeam.abbr, awayName: awayTeam.name, awayScore: awayTeam.score,
        totalScore: totalScore, actualMargin: actualMargin, actualWinner: actualWinner,
        mlPick: pred ? pred.predictions.winner.abbr : null,
        mlConf: pred ? pred.predictions.winner.confidence : null,
        mlHit: pred ? (pred.predictions.winner.abbr === actualWinner || 
          pred.predictions.winner.abbr === actualWinner.replace('WSH','WAS').replace('NY','NYK').replace('GS','GSW').replace('SA','SAS').replace('NO','NOP').replace('UTAH','UTA')) : null,
        spreadPick: pred ? pred.predictions.spread.abbr + ' ' + pred.predictions.spread.spread : null,
        spreadConf: pred ? pred.predictions.spread.confidence : null,
        spreadHit: pred ? (function() {
          var sp = pred.predictions.spread;
          if (sp.direction === 'home') return actualMargin + sp.spread > 0;
          else return -actualMargin + sp.spread > 0;
        })() : null,
        totalPick: pred ? pred.predictions.total.side + ' ' + pred.predictions.total.total : null,
        totalConf: pred ? pred.predictions.total.confidence : null,
        totalHit: pred ? ((pred.predictions.total.side === 'OVER' && totalScore > pred.predictions.total.total) ||
          (pred.predictions.total.side === 'UNDER' && totalScore < pred.predictions.total.total)) : null,
        timestamp: new Date().toISOString(),
      };

      gameGrades.graded.push(grade);
      newGrades++;

      // Update stats
      if (grade.mlHit !== null) { gameGrades.stats.mlTotal++; if (grade.mlHit) gameGrades.stats.mlHits++; }
      if (grade.spreadHit !== null) { gameGrades.stats.spreadTotal++; if (grade.spreadHit) gameGrades.stats.spreadHits++; }
      if (grade.totalHit !== null) { gameGrades.stats.totalTotal++; if (grade.totalHit) gameGrades.stats.totalHits++; }
      gameGrades.stats.total++;
    });

    if (newGrades > 0) {
      saveGameGrades();
      console.log('[GameGrader] Graded ' + newGrades + ' game predictions for ' + dateStr);
    }
    return newGrades;
  } catch(e) {
    console.warn('[GameGrader] Error:', e.message);
    return 0;
  }
}

// ============================================================
// Get Game Accuracy Stats
// ============================================================
function getGameAccuracy() {
  var s = gameGrades.stats;
  return {
    total: s.total,
    moneyline: { total: s.mlTotal, hits: s.mlHits, pct: s.mlTotal > 0 ? +(s.mlHits/s.mlTotal*100).toFixed(1) : 0 },
    spread: { total: s.spreadTotal, hits: s.spreadHits, pct: s.spreadTotal > 0 ? +(s.spreadHits/s.spreadTotal*100).toFixed(1) : 0 },
    totals: { total: s.totalTotal, hits: s.totalHits, pct: s.totalTotal > 0 ? +(s.totalHits/s.totalTotal*100).toFixed(1) : 0 },
    recent: (gameGrades.graded || []).slice(-20).reverse(),
  };
}

// ============================================================
// API Routes
// ============================================================
router.get('/accuracy', function(req, res) {
  res.json(getGameAccuracy());
});

router.get('/grades', function(req, res) {
  res.json({ graded: gameGrades.graded || [], stats: gameGrades.stats });
});

// ============================================================
// Start periodic grading (every 60 min)
// ============================================================
function startGameGrading(getCachedPredictions) {
  loadGameGrades();
  console.log('[GameGrader] Started game prediction grading (every 60 min)');

  // First run after 2 minutes
  setTimeout(function() {
    var cached = getCachedPredictions ? getCachedPredictions() : [];
    gradeYesterdayGames('nba', cached).catch(function(e) { console.warn('[GameGrader] Error:', e.message); });
  }, 2 * 60 * 1000);

  // Then every 60 minutes
  setInterval(function() {
    var cached = getCachedPredictions ? getCachedPredictions() : [];
    gradeYesterdayGames('nba', cached).catch(function(e) { console.warn('[GameGrader] Error:', e.message); });
  }, 60 * 60 * 1000);
}

module.exports = { router, startGameGrading, gradeYesterdayGames, getGameAccuracy, gameGrades };
