/**
 * stability.js — Make ORACLE rock-solid
 * 
 * Problem: Every deploy restarts the server, caches start empty, site shows
 * "no data" for 1-2 minutes while APIs refresh. Feels fragile.
 * 
 * Solution:
 * 1. Save caches to disk every 5 minutes
 * 2. On startup, pre-warm caches from disk immediately
 * 3. Site shows yesterday's/recent data instantly while fresh data loads
 * 4. Users never see an empty site
 */

const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');

// Ensure cache directory exists
try {
  if (!fs.existsSync(path.join(__dirname, '..', 'data'))) fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true });
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
} catch(e) { console.warn('[Stability] Could not create cache dir:', e.message); }

// ============================================================
// Disk Cache — read/write JSON to data/cache/
// ============================================================
function saveToDisk(key, data) {
  try {
    var filePath = path.join(CACHE_DIR, key.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');
    fs.writeFileSync(filePath, JSON.stringify({ data: data, savedAt: Date.now() }));
  } catch(e) {}
}

function loadFromDisk(key, maxAgeMs) {
  try {
    var filePath = path.join(CACHE_DIR, key.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');
    if (!fs.existsSync(filePath)) return null;
    var raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (maxAgeMs && Date.now() - raw.savedAt > maxAgeMs) return null;
    return raw.data;
  } catch(e) { return null; }
}

// ============================================================
// Pre-warm all caches from disk on startup
// Call this BEFORE starting refresh cycles
// ============================================================
function preWarmCaches(smartPicks, gamePredictions, evEngine) {
  var warmed = 0;
  var MAX_AGE = 6 * 60 * 60 * 1000; // 6 hours max stale

  try {
    // Restore props/picks caches
    if (smartPicks && smartPicks.picksCache) {
      ['nba', 'nhl', 'mlb', 'nfl'].forEach(function(sport) {
        var diskData = loadFromDisk('props_' + sport, MAX_AGE);
        if (diskData && diskData.picks && diskData.picks.length > 0) {
          smartPicks.picksCache[sport] = diskData;
          warmed++;
          console.log('[Stability] Pre-warmed ' + sport + ' props: ' + diskData.picks.length + ' picks from disk');
        }
      });
    }

    // Restore games caches
    if (gamePredictions && gamePredictions.gamesCache) {
      ['nba', 'nhl'].forEach(function(sport) {
        var diskData = loadFromDisk('games_' + sport, MAX_AGE);
        if (diskData && diskData.games && diskData.games.length > 0) {
          gamePredictions.gamesCache[sport] = diskData;
          warmed++;
          console.log('[Stability] Pre-warmed ' + sport + ' games: ' + diskData.games.length + ' games from disk');
        }
      });
    }

    // Restore EV cache
    if (evEngine) {
      var evDisk = loadFromDisk('ev_bets', MAX_AGE);
      if (evDisk && Array.isArray(evDisk) && evDisk.length > 0) {
        evEngine.evCache = evDisk;
        warmed++;
        console.log('[Stability] Pre-warmed EV bets: ' + evDisk.length + ' from disk');
      }
    }
  } catch(e) {
    console.warn('[Stability] Pre-warm error:', e.message);
  }

  if (warmed > 0) {
    console.log('[Stability] ✅ Pre-warmed ' + warmed + ' caches from disk — site ready immediately');
  } else {
    console.log('[Stability] No disk caches found — first startup, caches will populate from APIs');
  }
}

// ============================================================
// Periodically save caches to disk (every 5 min)
// ============================================================
function startPersistence(smartPicks, gamePredictions, evEngine) {
  function saveAll() {
    try {
      if (smartPicks && smartPicks.picksCache) {
        Object.keys(smartPicks.picksCache).forEach(function(sport) {
          var cached = smartPicks.picksCache[sport];
          if (cached && cached.picks && cached.picks.length > 0) {
            saveToDisk('props_' + sport, cached);
          }
        });
      }
      if (gamePredictions && gamePredictions.gamesCache) {
        Object.keys(gamePredictions.gamesCache).forEach(function(sport) {
          var cached = gamePredictions.gamesCache[sport];
          if (cached && cached.games && cached.games.length > 0) {
            saveToDisk('games_' + sport, cached);
          }
        });
      }
      if (evEngine && evEngine.evCache && evEngine.evCache.length > 0) {
        saveToDisk('ev_bets', evEngine.evCache);
      }
    } catch(e) {}
  }

  // Save every 5 minutes
  setInterval(saveAll, 5 * 60 * 1000);

  // Also save 2 minutes after startup (give caches time to populate)
  setTimeout(saveAll, 2 * 60 * 1000);

  console.log('[Stability] Cache persistence started (saves every 5 min)');
}

module.exports = {
  saveToDisk,
  loadFromDisk,
  preWarmCaches,
  startPersistence,
};
