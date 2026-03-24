/**
 * ORACLE Memory Crash Fix #2
 * 
 * Root cause: props.js fetches 5 events × 20+ bookmakers using Promise.all
 * All responses held in memory at once, tripling RSS when 3 sports refresh simultaneously.
 * 
 * Fixes:
 * 1. Sequential event fetching instead of Promise.all (prevents memory spike)
 * 2. Props cache extended from 5min → 30min (fewer refreshes)
 * 3. Multi-API cache extended from 15min → 30min (fewer refreshes)
 * 4. GC runs between sport fetches in sync loop
 * 5. Response data freed immediately after processing
 * 
 * Usage: node apply-crash-fix-2.js
 */

const fs = require('fs');

function replaceInFile(filePath, oldStr, newStr, label) {
  const fullPath = require('path').resolve(filePath);
  if (!fs.existsSync(fullPath)) { console.log('  SKIP: ' + fullPath + ' not found'); return false; }
  let content = fs.readFileSync(fullPath, 'utf8');
  if (!content.includes(oldStr)) { console.log('  SKIP: "' + label + '" — already applied or not found'); return false; }
  content = content.replace(oldStr, newStr);
  fs.writeFileSync(fullPath, content, 'utf8');
  console.log('  DONE: ' + label);
  return true;
}

console.log('\n=== ORACLE Crash Fix #2 — Sequential Props Fetch ===\n');
if (!fs.existsSync('server.js')) { console.log('ERROR: Run from project root.'); process.exit(1); }

let applied = 0;

// FIX 1: Sequential event fetching
console.log('[1/4] Switching props fetch from parallel → sequential...');
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
        // Free response data immediately
        res.data = null;
      } catch(e) { /* skip failed event */ }
    }`,
  'Sequential event fetch (was Promise.all)'
)) applied++;

// FIX 2: Extend props cache 5min → 30min
console.log('\n[2/4] Extending props cache to 30 minutes...');
if (replaceInFile('services/props.js',
  'const propsCache = new NodeCache({ stdTTL: 300 });',
  'const propsCache = new NodeCache({ stdTTL: 1800 });',
  'Props cache 300s → 1800s (30 min)'
)) applied++;

// FIX 3: Extend multi-api props cache 15min → 30min
console.log('\n[3/4] Extending multi-api props cache to 30 minutes...');
if (replaceInFile('services/multi-api.js',
  '  props: 15 * 60 * 1000,      // 15 min — player props (Odds API)',
  '  props: 30 * 60 * 1000,      // 30 min — player props (Odds API)',
  'Multi-API props cache 15min → 30min'
)) applied++;

// FIX 4: GC between sport fetches in sync loop
console.log('\n[4/4] Adding GC between sport fetches in sync loop...');
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

console.log('\n=== PATCH COMPLETE ===');
console.log(applied + ' fixes applied.\n');
if (applied > 0) {
  console.log('Now run:');
  console.log('  git add -A');
  console.log('  git commit -m "Fix crash: sequential props fetch, extend cache to 30min, GC between sports"');
  console.log('  git push');
}
