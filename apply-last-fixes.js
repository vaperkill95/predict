/**
 * ORACLE Last Remaining Fixes
 * 
 * Fixes the final 3 HTTP self-calls that could trigger Odds API:
 * 1. smart-picks.js — props fetch → Redis
 * 2. smart-picks.js — odds fetch → Redis (games data)
 * 3. oracle-bot-api.js — props fetch → Redis
 * 4. game-predictions.js — remove self-referencing loop
 * 
 * After this, ZERO services can trigger the Odds API except
 * the dedicated PropsRefresh timer.
 * 
 * Usage: node apply-last-fixes.js
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

console.log('\n=== ORACLE Last Remaining Fixes ===\n');
if (!fs.existsSync('server.js')) { console.log('ERROR: Run from project root.'); process.exit(1); }

let applied = 0;

// FIX 1: smart-picks.js — props fetch → Redis
console.log('[1/4] smart-picks.js props → Redis...');
if (replaceInFile('services/smart-picks.js',
  `  let props = [];
  try {
    const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? \`https://\${process.env.RAILWAY_PUBLIC_DOMAIN}\`
      : \`http://localhost:\${PORT}\`;
    const resp = await axios.get(\`\${baseUrl}/api/props/\${sport}\`, { timeout: 20000 });
    props = resp.data?.props || [];
  } catch (e) {
    console.warn(\`[SmartPicks-v3] Props fetch failed: \${e.message}\`);
    return [];
  }`,
  `  let props = [];
  try {
    // Read from Redis directly — never trigger a fresh Odds API call
    let redisCache = null;
    try { redisCache = require('./redis-cache'); } catch(e) {}
    
    if (redisCache && redisCache.isConnected()) {
      const data = await redisCache.getProps(sport);
      props = data ? (data.props || data.picks || []) : [];
    }
    
    if (props.length === 0) {
      console.log(\`[SmartPicks-v3] No props in Redis for \${sport}\`);
      return [];
    }
  } catch (e) {
    console.warn(\`[SmartPicks-v3] Props fetch failed: \${e.message}\`);
    return [];
  }`,
  'smart-picks props → Redis'
)) applied++;

// FIX 2: smart-picks.js — odds/game context → Redis
console.log('[2/4] smart-picks.js odds → Redis...');
if (replaceInFile('services/smart-picks.js',
  `  try {
    const odds = await axios.get(\`http://localhost:\${PORT}/api/odds/\${sport}\`, { timeout: 10000 });
    for (const game of (odds.data?.games || [])) {
      const bk = game.bookmakers?.[0];
      if (!bk) continue;
      const spreads = bk.markets?.find(m => m.key === 'spreads');
      const totals = bk.markets?.find(m => m.key === 'totals');
      const homeSpread = spreads?.outcomes?.find(o => o.name === game.homeTeam)?.point || 0;
      const total = totals?.outcomes?.[0]?.point || 220;
      ctx.games[game.homeTeam] = { homeTeam: game.homeTeam, awayTeam: game.awayTeam, spread: homeSpread, total };
      ctx.games[game.awayTeam] = ctx.games[game.homeTeam];
    }
  } catch (e) {}`,
  `  try {
    // Read game data from Redis instead of calling Odds API
    let redisCache = null;
    try { redisCache = require('./redis-cache'); } catch(e) {}
    
    if (redisCache && redisCache.isConnected()) {
      const gamesData = await redisCache.getGames(sport);
      if (gamesData && gamesData.games) {
        for (const game of gamesData.games) {
          if (!game.homeTeam) continue;
          const spread = game.consensus?.spread || 0;
          const total = game.consensus?.total || 220;
          ctx.games[game.homeTeam] = { homeTeam: game.homeTeam, awayTeam: game.awayTeam, spread, total };
          if (game.awayTeam) ctx.games[game.awayTeam] = ctx.games[game.homeTeam];
        }
      }
    }
  } catch (e) {}`,
  'smart-picks odds → Redis'
)) applied++;

// FIX 3: oracle-bot-api.js — props fetch → Redis
console.log('[3/4] oracle-bot-api.js props → Redis...');
if (replaceInFile('services/oracle-bot-api.js',
  `      // Fallback: fetch props directly if cache only has picks not full props
      try {
        var propResp = await axios.get('http://localhost:' + PORT + '/api/props/nba', { timeout: 5000 });
        allProps = propResp.data && propResp.data.props ? propResp.data.props : allProps;
      } catch(e) {}`,
  `      // Fallback: fetch props from Redis if cache only has picks not full props
      try {
        var redisCache = require('./redis-cache');
        if (redisCache && redisCache.isConnected()) {
          var rData = await redisCache.getProps('nba');
          if (rData && rData.props && rData.props.length > 0) allProps = rData.props;
        }
      } catch(e) {}`,
  'oracle-bot-api props → Redis'
)) applied++;

// FIX 4: game-predictions.js — remove self-referencing loop
console.log('[4/4] game-predictions.js — remove self-referencing loop...');
if (replaceInFile('services/game-predictions.js',
  `    var cached = getCachedGames(sport);
    if(cached){var game=cached.find(function(g){return g.id===gameId});if(game)return res.json(game)}
    var mainResp=await axios.get('http://localhost:'+PORT+'/api/games/'+sport,{timeout:20000});
    var game2=(mainResp.data.games||[]).find(function(g){return g.id===gameId});
    if(!game2)return res.json({error:'Game not found'});
    res.json(game2);`,
  `    var cached = getCachedGames(sport);
    if(cached){var game=cached.find(function(g){return g.id===gameId});if(game)return res.json(game)}
    // Don't self-reference /api/games/:sport — if cache is empty, return not found
    // The cache will be populated by the next regular refresh cycle
    res.json({error:'Game not found — predictions refresh every 30 minutes'});`,
  'Remove self-referencing loop'
)) applied++;

console.log('\n=== COMPLETE: ' + applied + ' fixes applied ===\n');
if (applied > 0) {
  console.log('Run:');
  console.log('  git add -A');
  console.log('  git commit -m "Final: zero services can trigger Odds API except PropsRefresh"');
  console.log('  git push');
  console.log('\nAfter this, the ONLY thing calling the Odds API is the dedicated');
  console.log('PropsRefresh timer every 30 minutes. Nothing else. Period.');
}
