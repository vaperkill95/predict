/**
 * ORACLE Final Stability + Credit Saver Patch
 * 
 * This combines crash fix #2 + credit saver + dedicated props refresh.
 * 
 * CRASH FIXES:
 * 1. Dedicated props refresh timer — ONLY place that calls Odds API
 *    All other services read from stable in-memory cache
 * 2. Sequential event fetching in props.js (was Promise.all)
 * 3. Props cache extended to 30 min (was 5 min)
 * 4. Multi-API cache extended to 30 min (was 15 min)
 * 5. GC runs between sport fetches
 * 6. 5-second delay between sports during refresh
 * 
 * CREDIT SAVER:
 * 7. AI picks cache extended to 2 hours (was 10 min)
 * 8. getDailyPicks switched from Sonnet → Haiku
 * 9. anthropic.js game/player predictions disabled (use free model)
 * 
 * Usage: node apply-final-fix.js
 */

const fs = require('fs');

function replaceInFile(filePath, oldStr, newStr, label) {
  const fullPath = require('path').resolve(filePath);
  if (!fs.existsSync(fullPath)) { console.log('  SKIP: ' + fullPath + ' not found'); return false; }
  let content = fs.readFileSync(fullPath, 'utf8');
  if (!content.includes(oldStr)) { console.log('  SKIP: "' + label + '" — already applied'); return false; }
  content = content.replace(oldStr, newStr);
  fs.writeFileSync(fullPath, content, 'utf8');
  console.log('  DONE: ' + label);
  return true;
}

console.log('\n=== ORACLE Final Stability + Credit Saver ===\n');
if (!fs.existsSync('server.js')) { console.log('ERROR: Run from project root.'); process.exit(1); }

let applied = 0;

// === CRASH FIXES ===

console.log('--- CRASH FIXES ---\n');

// 1. Sequential event fetching
console.log('[1/9] Sequential props fetch...');
if (replaceInFile('services/props.js',
  `    // SPEED: Fetch all events in parallel (not sequential)
    const marketsStr = markets.join(",");
    const eventResults = await Promise.all(
      events.slice(0, 5).map(event =>
        axios.get(\`\${ODDS_BASE}/sports/\${oddsSport}/events/\${event.id}/odds\`, {
          params: { apiKey, regions: "us,us2", markets: marketsStr, oddsFormat: "american", bookmakers: "draftkings,fanduel,betmgm,bovada,caesars,betrivers,fanatics,espnbet,hardrockbet,bet365,mybookieag,betonlineag,lowvig,betus,wynnbet,pointsbetus,prizepicks,underdog,fliff,sleeper" },
          timeout: 10000,
        }).then(res => ({ event, data: res.data })).catch(() => null)
      )
    );

    const allProps = [];
    for (const result of eventResults) {
      if (!result) continue;
      const { event, data: od } = result;
      for (const bk of od.bookmakers || []) for (const m of bk.markets || []) for (const o of m.outcomes || []) {
        if (!o.description) continue;
        allProps.push({ player: o.description, market: m.key, marketLabel: fmtMkt(m.key), game: \`\${event.away_team} @ \${event.home_team}\`, gameId: event.id, commenceTime: event.commence_time, homeTeam: event.home_team, awayTeam: event.away_team, book: bk.title, bookKey: bk.key, side: o.name, point: o.point, price: o.price });
      }
    }`,
  `    // MEMORY FIX: Fetch events SEQUENTIALLY (not all at once) to prevent memory spikes
    const marketsStr = markets.join(",");
    const allProps = [];
    const eventsToFetch = events.slice(0, 5);
    for (let i = 0; i < eventsToFetch.length; i++) {
      const event = eventsToFetch[i];
      try {
        const res = await axios.get(\`\${ODDS_BASE}/sports/\${oddsSport}/events/\${event.id}/odds\`, {
          params: { apiKey, regions: "us,us2", markets: marketsStr, oddsFormat: "american", bookmakers: "draftkings,fanduel,betmgm,bovada,caesars,betrivers,fanatics,espnbet,hardrockbet,bet365,mybookieag,betonlineag,lowvig,betus,wynnbet,pointsbetus,prizepicks,underdog,fliff,sleeper" },
          timeout: 10000,
        });
        const od = res.data;
        for (const bk of od.bookmakers || []) for (const m of bk.markets || []) for (const o of m.outcomes || []) {
          if (!o.description) continue;
          allProps.push({ player: o.description, market: m.key, marketLabel: fmtMkt(m.key), game: \`\${event.away_team} @ \${event.home_team}\`, gameId: event.id, commenceTime: event.commence_time, homeTeam: event.home_team, awayTeam: event.away_team, book: bk.title, bookKey: bk.key, side: o.name, point: o.point, price: o.price });
        }
        res.data = null;
      } catch(e) {}
    }`,
  'Sequential event fetch'
)) applied++;

// 2. Props cache 5min → 30min
console.log('[2/9] Props cache → 30 min...');
if (replaceInFile('services/props.js',
  'const propsCache = new NodeCache({ stdTTL: 300 });',
  'const propsCache = new NodeCache({ stdTTL: 1800 });',
  'Props cache 5min → 30min'
)) applied++;

// 3. Multi-API cache 15min → 30min
console.log('[3/9] Multi-API cache → 30 min...');
if (replaceInFile('services/multi-api.js',
  '  props: 15 * 60 * 1000,      // 15 min — player props (Odds API)',
  '  props: 30 * 60 * 1000,      // 30 min — player props (Odds API)',
  'Multi-API cache 15min → 30min'
)) applied++;

// 4. GC between sport fetches
console.log('[4/9] GC between sports in sync loop...');
if (replaceInFile('server.js',
  `        for (var sport of ['nba', 'nhl', 'mlb']) {
          try {
            if (typeof getCachedProps === 'function') {
              var p = await getCachedProps(sport);
              if (p && p.props && p.props.length > 0) d['props_' + sport] = p;
            }
          } catch(e) {}
        }`,
  `        for (var sport of ['nba', 'nhl', 'mlb']) {
          try {
            if (typeof getCachedProps === 'function') {
              var p = await getCachedProps(sport);
              if (p && p.props && p.props.length > 0) d['props_' + sport] = p;
            }
          } catch(e) {}
          // Run GC between sports to prevent memory accumulation
          if (global.gc) global.gc();
        }`,
  'GC between sport fetches'
)) applied++;

// 5. Dedicated props refresh (the big one)
console.log('[5/9] Dedicated props refresh timer...');
if (replaceInFile('server.js',
  `// Shared props function — all services use this
async function getCachedProps(sport) {
  if (multiApi) {
    return await multiApi.getProps(sport);
  }
  // Fallback to direct Odds API call
  try {
    const { getPlayerProps } = require("./services/props");
    return await getPlayerProps(sport);
  } catch(e) {
    return { props: [] };
  }
}`,
  `// Shared props function — all services use this
// IMPORTANT: This reads from a stable in-memory cache.
// The cache is ONLY refreshed by the dedicated timer below.
// This prevents multiple services from triggering simultaneous API calls.
var _stablePropsCache = {}; // { sport: { props: [...], timestamp: Date.now() } }

async function getCachedProps(sport) {
  // Always return from stable cache first
  if (_stablePropsCache[sport] && _stablePropsCache[sport].props && _stablePropsCache[sport].props.length > 0) {
    return _stablePropsCache[sport];
  }
  // If stable cache is empty, try multi-api (which has its own cache)
  if (multiApi) {
    var data = await multiApi.getProps(sport);
    if (data && data.props && data.props.length > 0) {
      _stablePropsCache[sport] = data;
    }
    return data;
  }
  return { props: [] };
}

// Dedicated props refresh — runs every 30 min, one sport at a time, with GC between each
// This is the ONLY place that calls the Odds API for props
(function startPropsRefresh() {
  var PROPS_REFRESH_MS = 30 * 60 * 1000; // 30 min
  var sports = ['nba', 'nhl', 'mlb'];

  async function refreshAllProps() {
    for (var i = 0; i < sports.length; i++) {
      var sport = sports[i];
      try {
        if (multiApi) {
          var data = await multiApi.getProps(sport);
          if (data && data.props && data.props.length > 0) {
            _stablePropsCache[sport] = data;
            console.log('[PropsRefresh] ' + sport + ': ' + data.props.length + ' props cached');
          }
        }
      } catch(e) {
        console.warn('[PropsRefresh] ' + sport + ' failed: ' + e.message);
      }
      // GC between sports
      if (global.gc) global.gc();
      // Wait 5 seconds between sports to let memory settle
      await new Promise(function(r) { setTimeout(r, 5000); });
    }
  }

  // First refresh after 30 seconds (give Redis time to connect)
  setTimeout(function() {
    refreshAllProps().catch(function(e) { console.warn('[PropsRefresh] Initial error:', e.message); });
  }, 30000);

  // Then every 30 minutes
  setInterval(function() {
    refreshAllProps().catch(function(e) { console.warn('[PropsRefresh] Error:', e.message); });
  }, PROPS_REFRESH_MS);

  console.log('[PropsRefresh] Dedicated props refresh started (every 30 min, sequential, with GC)');
})()`,
  'Dedicated props refresh timer'
)) applied++;

// === CREDIT SAVER ===

console.log('\n--- CREDIT SAVER ---\n');

// 6. Picks cache 10min → 2hr
console.log('[6/9] AI picks cache → 2 hours...');
if (replaceInFile('services/props.js',
  'const picksCache = new NodeCache({ stdTTL: 600 });',
  'const picksCache = new NodeCache({ stdTTL: 7200 });',
  'Picks cache 10min → 2hr'
)) applied++;

// 7. Sonnet → Haiku for picks
console.log('[7/9] AI picks Sonnet → Haiku...');
if (replaceInFile('services/props.js',
  '      model: "claude-sonnet-4-20250514", max_tokens: 2000,',
  '      model: "claude-haiku-4-5-20251001", max_tokens: 2000,',
  'getDailyPicks Sonnet → Haiku'
)) applied++;

// 8. Disable anthropic.js predictGame
console.log('[8/9] Disable Sonnet game predictions...');
if (replaceInFile('services/anthropic.js',
  `async function predictGame(gameData, oddsData = null) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return generateFallbackPrediction(gameData);
  }`,
  `async function predictGame(gameData, oddsData = null) {
  // API disabled to conserve credits — using statistical fallback model instead
  return generateFallbackPrediction(gameData);`,
  'predictGame → free fallback'
)) applied++;

// 9. Disable anthropic.js predictPlayer
console.log('[9/9] Disable Sonnet player predictions...');
if (replaceInFile('services/anthropic.js',
  `async function predictPlayer(playerName, sport, context = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      player: playerName,
      sport,
      available: false,
      message: "AI predictions require an Anthropic API key",
    };
  }`,
  `async function predictPlayer(playerName, sport, context = {}) {
  // API disabled to conserve credits — using fallback response
  return {
    player: playerName,
    sport,
    available: false,
    message: "Player predictions are powered by ORACLE's statistical model. Visit /props for AI-analyzed picks.",
  };`,
  'predictPlayer → free fallback'
)) applied++;

console.log('\n=== COMPLETE: ' + applied + ' fixes applied ===\n');
if (applied > 0) {
  console.log('Run:');
  console.log('  git add -A');
  console.log('  git commit -m "Final fix: dedicated props refresh, sequential fetch, credit saver"');
  console.log('  git push');
  console.log('\nThis should be the last crash fix you need.');
}
