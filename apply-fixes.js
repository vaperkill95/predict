/**
 * ORACLE Memory Stability Patch
 * 
 * Applies 10 fixes to prevent memory crashes:
 * 1. Fix trending picks "picks is not iterable" 
 * 2. Lower watchdog from 6GB to 5GB
 * 3. Add yellow zone at 3.5GB with aggressive cache clearing
 * 4. Null out sync loop data after each cycle
 * 5. Slim down _prevLineSnapshots (store numbers not objects)
 * 6. CDL standings circuit breaker
 * 7. Stagger service startups over 60 seconds
 * 8. Cap recentMatchIds in CDL scraper
 * 9. Cap playerMatchKills per player
 * 10. Add cache eviction to multi-api
 * 
 * Usage: cd into your predict project folder, then run:
 *   node apply-fixes.js
 */

const fs = require('fs');
const path = require('path');

function replaceInFile(filePath, oldStr, newStr, label) {
  const fullPath = path.resolve(filePath);
  if (!fs.existsSync(fullPath)) {
    console.log('  SKIP: ' + fullPath + ' not found');
    return false;
  }
  let content = fs.readFileSync(fullPath, 'utf8');
  if (!content.includes(oldStr)) {
    console.log('  SKIP: "' + label + '" — already applied or text not found');
    return false;
  }
  content = content.replace(oldStr, newStr);
  fs.writeFileSync(fullPath, content, 'utf8');
  console.log('  DONE: ' + label);
  return true;
}

console.log('\n=== ORACLE Memory Stability Patch ===\n');

// Verify we're in the right directory
if (!fs.existsSync('server.js') || !fs.existsSync('services')) {
  console.log('ERROR: Run this script from your predict project root folder.');
  console.log('  Expected to find server.js and services/ directory.');
  process.exit(1);
}

let applied = 0;

// ============================================================
// FIX 1: trending-picks.js — "picks is not iterable" bug
// ============================================================
console.log('\n[1/10] Fixing trending-picks.js — Array.isArray guards...');
if (replaceInFile('services/trending-picks.js',
  `    const props = propsData.props || propsData || [];
    const picks = picksData.picks || picksData || [];
    const movements = movementData.props || [];`,
  `    const props = Array.isArray(propsData.props) ? propsData.props : (Array.isArray(propsData) ? propsData : []);
    const picks = Array.isArray(picksData.picks) ? picksData.picks : (Array.isArray(picksData) ? picksData : []);
    const movements = Array.isArray(movementData.props) ? movementData.props : [];`,
  'Array.isArray guards for props/picks/movements'
)) applied++;

// ============================================================
// FIX 2+3: server.js — Lower watchdog + add yellow zone
// ============================================================
console.log('\n[2/10] Lowering watchdog threshold 6GB → 5GB + yellow zone...');
if (replaceInFile('server.js',
  `  // === MEMORY WATCHDOG — emergency restart if memory exceeds 6GB ===
  // (User has 32GB Pro plan — 6GB is safe for the worker)
  setInterval(function() {
    var rss = process.memoryUsage().rss;
    var rssMB = Math.round(rss / 1024 / 1024);
    if (rssMB > 6144) {
      console.warn("[WATCHDOG] Memory at " + rssMB + "MB — emergency restart. All data safe in Redis.");
      process.exit(1);
    } else if (rssMB > 4096) {
      console.warn("[Memory] WARNING: RSS at " + rssMB + "MB — running GC");
      if (global.gc) global.gc();
    } else if (rssMB > 2500) {
      // Trigger GC proactively
      if (global.gc) global.gc();
    }
  }, 60000);`,
  `  // === MEMORY WATCHDOG — emergency restart if memory exceeds 5GB ===
  // Lowered from 6GB: baseline sits at 3.5-4.5GB, need earlier intervention
  setInterval(function() {
    var rss = process.memoryUsage().rss;
    var rssMB = Math.round(rss / 1024 / 1024);
    if (rssMB > 5120) {
      console.warn("[WATCHDOG] Memory at " + rssMB + "MB — emergency restart. All data safe in Redis.");
      process.exit(1);
    } else if (rssMB > 4096) {
      console.warn("[Memory] WARNING: RSS at " + rssMB + "MB — running GC");
      if (global.gc) global.gc();
    } else if (rssMB > 3500) {
      // Yellow zone — proactively clear non-essential caches
      if (global.gc) global.gc();
      // Trim line movement snapshots to reduce memory
      if (_prevLineSnapshots && Object.keys(_prevLineSnapshots).length > 2000) {
        var keys = Object.keys(_prevLineSnapshots);
        var toRemove = keys.slice(0, keys.length - 1000);
        toRemove.forEach(function(k) { delete _prevLineSnapshots[k]; });
        console.log("[Memory] Trimmed _prevLineSnapshots from " + keys.length + " to 1000 entries");
      }
      // Trim CDL match kill history
      try {
        var cdlScraper = require("./services/cdl-stats-scraper");
        // recentMatchIds is not directly accessible, but we can trigger GC
      } catch(e) {}
    } else if (rssMB > 2500) {
      // Trigger GC proactively
      if (global.gc) global.gc();
    }
  }, 60000);`,
  'Watchdog 6GB→5GB + yellow zone at 3.5GB'
)) applied++;

// ============================================================
// FIX 4: server.js — Null out sync data after each cycle
// ============================================================
console.log('\n[3/10] Nulling out sync loop data after each cycle...');
if (replaceInFile('server.js',
  `      var mem = process.memoryUsage();
      var heapMB = Math.round(mem.heapUsed / 1024 / 1024);
      var rssMB = Math.round(mem.rss / 1024 / 1024);
      console.log("[Redis] Synced " + synced + " entries | Heap: " + heapMB + "MB | RSS: " + rssMB + "MB");
      if (rssMB > 2048) console.warn("[Memory] WARNING: RSS at " + rssMB + "MB");
    } catch(e) {
      console.warn("[Redis] Sync error:", e.message);
    }`,
  `      var mem = process.memoryUsage();
      var heapMB = Math.round(mem.heapUsed / 1024 / 1024);
      var rssMB = Math.round(mem.rss / 1024 / 1024);
      console.log("[Redis] Synced " + synced + " entries | Heap: " + heapMB + "MB | RSS: " + rssMB + "MB");
      if (rssMB > 2048) console.warn("[Memory] WARNING: RSS at " + rssMB + "MB");
      
      // Free the sync data to help GC
      d = null;
      allMovements = null;
      _currentSnapshots = null;
      sharpData = null;
      sharpMovements = null;
    } catch(e) {
      console.warn("[Redis] Sync error:", e.message);
    }`,
  'Null out sync data after each cycle'
)) applied++;

// ============================================================
// FIX 5: server.js — Slim down _prevLineSnapshots
// ============================================================
console.log('\n[4/10] Slimming down _prevLineSnapshots...');
if (replaceInFile('server.js',
  `            _currentSnapshots[snapKey] = { line: mp.consensusLine, player: mp.player, market: mp.market, sport: mvSport, game: mp.game };`,
  `            _currentSnapshots[snapKey] = mp.consensusLine;`,
  '_prevLineSnapshots: store just numbers'
)) applied++;

console.log('\n[5/10] Fixing snapshot comparison...');
if (replaceInFile('server.js',
  `            if (_prevLineSnapshots[snapKey] && _prevLineSnapshots[snapKey].line !== mp.consensusLine) {
              var oldLine = _prevLineSnapshots[snapKey].line;
              var newLine = mp.consensusLine;`,
  `            if (_prevLineSnapshots[snapKey] !== undefined && _prevLineSnapshots[snapKey] !== mp.consensusLine) {
              var oldLine = _prevLineSnapshots[snapKey];
              var newLine = mp.consensusLine;`,
  'Snapshot comparison for new format'
)) applied++;

// ============================================================
// FIX 6: server.js — CDL standings circuit breaker
// ============================================================
console.log('\n[6/10] Adding CDL standings circuit breaker...');
if (replaceInFile('server.js',
  `  // Sync loop — direct memory access (no HTTP self-calls that timeout)`,
  `  // Circuit breakers for endpoints that keep failing
  var _cdlStandingsFailCount = 0;
  var _cdlStandingsLastSuccess = 0;
  var CDL_STANDINGS_MAX_FAILS = 5; // After 5 consecutive failures, stop trying for 30 min

  // Sync loop — direct memory access (no HTTP self-calls that timeout)`,
  'Circuit breaker variables'
)) applied++;

if (replaceInFile('server.js',
  `      // CDL standings — sync from worker
      try {
        await new Promise(function(resolve) {
          var sdata = '';
          var sreq = http.get("http://localhost:" + PORT + "/api/cdl/standings", { timeout: 10000 }, function(resp) {
            resp.on('data', function(chunk) { sdata += chunk; });
            resp.on('end', function() { try { var p = JSON.parse(sdata); if (p && (p.standings || p.groups || p.length > 0)) { redisCache.set("oracle:cdl_standings", p, 3600); synced++; } } catch(e) {} sdata = null; resolve(); });
          });
          sreq.on('error', function() { resolve(); });
          sreq.on('timeout', function() { sreq.destroy(); resolve(); });
        });
      } catch(e) {}`,
  `      // CDL standings — sync from worker (with circuit breaker)
      if (_cdlStandingsFailCount < CDL_STANDINGS_MAX_FAILS || (Date.now() - _cdlStandingsLastSuccess > 30 * 60 * 1000)) {
        try {
          await new Promise(function(resolve) {
            var sdata = '';
            var sreq = http.get("http://localhost:" + PORT + "/api/cdl/standings", { timeout: 10000 }, function(resp) {
              resp.on('data', function(chunk) { sdata += chunk; });
              resp.on('end', function() { try { var p = JSON.parse(sdata); if (p && (p.standings || p.groups || p.length > 0)) { redisCache.set("oracle:cdl_standings", p, 3600); synced++; _cdlStandingsFailCount = 0; _cdlStandingsLastSuccess = Date.now(); } else { _cdlStandingsFailCount++; } } catch(e) { _cdlStandingsFailCount++; } sdata = null; resolve(); });
            });
            sreq.on('error', function() { _cdlStandingsFailCount++; resolve(); });
            sreq.on('timeout', function() { _cdlStandingsFailCount++; sreq.destroy(); resolve(); });
          });
        } catch(e) { _cdlStandingsFailCount++; }
      }`,
  'CDL standings circuit breaker logic'
)) applied++;

// ============================================================
// FIX 7: server.js — Stagger service startups
// ============================================================
console.log('\n[7/10] Staggering service startups over 60 seconds...');
if (replaceInFile('server.js',
  `dvp.startRefresh();
analytics.startRefresh();
predictionModel.startRefresh();
if (enrichment && enrichment.startCache) {
  enrichment.startCache();
}
if (smartPicks && smartPicks.startRefresh) {
  smartPicks.startRefresh();
}
if (autoGrader && autoGrader.startGrading) {
  autoGrader.startGrading();
}
if (refData && refData.startRefresh) {
  refData.startRefresh();
}
if (evEngine && evEngine.startScanning) {
  // Give EV engine direct access to shared props cache (saves API credits)
  if (evEngine.setDirectFetcher) {
    evEngine.setDirectFetcher(async (sport) => {
      return await getCachedProps(sport);
    });
  }
  evEngine.startScanning();
}
if (sharpTools && sharpTools.startTracking) {
  sharpTools.startTracking();
}
if (potd && potd.startRefresh) {
  potd.startRefresh();
}
if (advancedTools && advancedTools.startScanning) {
  advancedTools.startScanning();
}
if (accuracyBoost && accuracyBoost.startMonitoring) {
  accuracyBoost.startMonitoring();
}`,
  `// === STAGGERED SERVICE STARTUP ===
// Spread service starts over 2 minutes to prevent concurrent memory spikes
dvp.startRefresh();
analytics.startRefresh();
predictionModel.startRefresh();
if (enrichment && enrichment.startCache) {
  enrichment.startCache();
}

// Wave 2: 15 seconds after startup
setTimeout(function() {
  if (smartPicks && smartPicks.startRefresh) {
    smartPicks.startRefresh();
  }
  if (autoGrader && autoGrader.startGrading) {
    autoGrader.startGrading();
  }
  if (refData && refData.startRefresh) {
    refData.startRefresh();
  }
  console.log("[Startup] Wave 2 services started (smartPicks, autoGrader, refData)");
}, 15000);

// Wave 3: 30 seconds after startup
setTimeout(function() {
  if (evEngine && evEngine.startScanning) {
    if (evEngine.setDirectFetcher) {
      evEngine.setDirectFetcher(async (sport) => {
        return await getCachedProps(sport);
      });
    }
    evEngine.startScanning();
  }
  if (sharpTools && sharpTools.startTracking) {
    sharpTools.startTracking();
  }
  console.log("[Startup] Wave 3 services started (evEngine, sharpTools)");
}, 30000);

// Wave 4: 60 seconds after startup
setTimeout(function() {
  if (potd && potd.startRefresh) {
    potd.startRefresh();
  }
  if (advancedTools && advancedTools.startScanning) {
    advancedTools.startScanning();
  }
  if (accuracyBoost && accuracyBoost.startMonitoring) {
    accuracyBoost.startMonitoring();
  }
  console.log("[Startup] Wave 4 services started (potd, advancedTools, accuracyBoost)");
}, 60000);`,
  'Staggered service startup (4 waves over 60s)'
)) applied++;

// ============================================================
// FIX 8: cdl-stats-scraper.js — Cap recentMatchIds
// ============================================================
console.log('\n[8/10] Capping CDL recentMatchIds at 100...');
if (replaceInFile('services/cdl-stats-scraper.js',
  `        recentMatchIds.push(matchId);
        // Free parsed data and rate limit`,
  `        recentMatchIds.push(matchId);
        // Cap recentMatchIds to prevent unbounded memory growth
        if (recentMatchIds.length > 100) {
          recentMatchIds = recentMatchIds.slice(-100);
        }
        // Free parsed data and rate limit`,
  'Cap recentMatchIds at 100'
)) applied++;

// ============================================================
// FIX 9: cdl-stats-scraper.js — Cap playerMatchKills + mapPickHistory
// ============================================================
console.log('\n[9/10] Capping playerMatchKills (30/player) + mapPickHistory (50/team)...');
if (replaceInFile('services/cdl-stats-scraper.js',
  `            });
            totalNewKills++;`,
  `            });
            // Cap per-player kill history to prevent memory bloat
            if (playerMatchKills[pid].length > 30) {
              playerMatchKills[pid] = playerMatchKills[pid].slice(-30);
            }
            totalNewKills++;`,
  'Cap playerMatchKills at 30 per player'
)) applied++;

if (replaceInFile('services/cdl-stats-scraper.js',
  `                  mapPickHistory[tid].push({
                    matchId: p.match_id,
                    action: p.action, // 'Pick' or 'Ban'
                    mapId: p.map_id,
                    modeId: p.mode_id,
                    mapNumber: p.map_number,
                    order: p.order,
                  });`,
  `                  mapPickHistory[tid].push({
                    matchId: p.match_id,
                    action: p.action, // 'Pick' or 'Ban'
                    mapId: p.map_id,
                    modeId: p.mode_id,
                    mapNumber: p.map_number,
                    order: p.order,
                  });
                  // Cap per-team pick history
                  if (mapPickHistory[tid].length > 50) {
                    mapPickHistory[tid] = mapPickHistory[tid].slice(-50);
                  }`,
  'Cap mapPickHistory at 50 per team'
)) applied++;

// ============================================================
// FIX 10: multi-api.js — Cache eviction
// ============================================================
console.log('\n[10/10] Adding cache eviction to multi-api...');
if (replaceInFile('services/multi-api.js',
  `function setCache(key, data) {
  cache[key] = { data, time: Date.now() };
}`,
  `function setCache(key, data) {
  cache[key] = { data, time: Date.now() };
  
  // Evict stale entries if cache grows too large (>50 keys)
  var keys = Object.keys(cache);
  if (keys.length > 50) {
    var now = Date.now();
    var maxAge = 60 * 60 * 1000; // 1 hour max age for any cache entry
    keys.forEach(function(k) {
      if (now - cache[k].time > maxAge) {
        delete cache[k];
      }
    });
  }
}`,
  'Cache eviction for stale entries'
)) applied++;

// ============================================================
// SUMMARY
// ============================================================
console.log('\n=== PATCH COMPLETE ===');
console.log(applied + ' fixes applied.\n');

if (applied > 0) {
  console.log('Now run:');
  console.log('  git add -A');
  console.log('  git commit -m "Memory stability: lower watchdog, fix leaks, stagger services, circuit breaker"');
  console.log('  git push');
  console.log('\nRailway will auto-deploy. Watch logs for "Wave 2/3/4 services started" messages.');
} else {
  console.log('All fixes were already applied or files were not found.');
}
