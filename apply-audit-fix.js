/**
 * ORACLE Final Audit Patch
 * 
 * Eliminates ALL remaining HTTP self-calls that could trigger fresh Odds API fetches.
 * Caps unbounded arrays that grow forever.
 * 
 * Fixes:
 * 1. advanced-tools.js — reads Redis instead of HTTP /api/props
 * 2. sharp-tools.js — reads Redis instead of HTTP /api/props  
 * 3. prop-enrichment.js — reads Redis instead of HTTP /api/props
 * 4. auto-grader.js — caps gradedPicks at 500 in memory
 * 5. sharp-tools.js — caps lineSnapshots at 2000 keys
 * 6. server.js — fetchPicksInternal reads Redis directly
 * 7. server.js — getMovementInternal reads Redis directly
 * 
 * Usage: node apply-audit-fix.js
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

console.log('\n=== ORACLE Final Audit Patch ===\n');
if (!fs.existsSync('server.js')) { console.log('ERROR: Run from project root.'); process.exit(1); }

let applied = 0;

// FIX 1: advanced-tools.js — Redis instead of HTTP
console.log('[1/7] advanced-tools.js → Redis...');
if (replaceInFile('services/advanced-tools.js',
  `async function scanAll(sport = 'nba') {
  try {
    const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? \`https://\${process.env.RAILWAY_PUBLIC_DOMAIN}\`
      : \`http://localhost:\${PORT}\`;

    const resp = await axios.get(\`\${baseUrl}/api/props/\${sport}\`, { timeout: 20000 });
    const props = resp.data?.props || [];

    cache.middles = detectMiddles(props);
    cache.arbs = findArbitrages(props);
    cache.altLines = findAltLineValue(props);
    cache.lastScan = new Date().toISOString();

    console.log(\`[Advanced] Scan complete: \${cache.middles.length} middles, \${cache.arbs.length} arbs, \${cache.altLines.length} alt lines\`);
  } catch (e) {
    console.warn('[Advanced] Scan failed:', e.message);
  }
}`,
  `async function scanAll(sport = 'nba') {
  try {
    // Read from Redis directly — never trigger a fresh Odds API call
    let redisCache = null;
    try { redisCache = require('./redis-cache'); } catch(e) {}
    
    let props = [];
    if (redisCache && redisCache.isConnected()) {
      const data = await redisCache.getProps(sport);
      props = data ? (data.props || data.picks || []) : [];
    }
    
    if (props.length === 0) {
      console.log(\`[Advanced] No props in Redis for \${sport}, skipping scan\`);
      return;
    }

    cache.middles = detectMiddles(props);
    cache.arbs = findArbitrages(props);
    cache.altLines = findAltLineValue(props);
    cache.lastScan = new Date().toISOString();

    console.log(\`[Advanced] Scan complete: \${cache.middles.length} middles, \${cache.arbs.length} arbs, \${cache.altLines.length} alt lines\`);
  } catch (e) {
    console.warn('[Advanced] Scan failed:', e.message);
  }
}`,
  'advanced-tools → Redis'
)) applied++;

// FIX 2: sharp-tools.js — Redis instead of HTTP
console.log('[2/7] sharp-tools.js → Redis...');
if (replaceInFile('services/sharp-tools.js',
  `async function snapshotLines(sport = 'nba') {
  try {
    const resp = await axios.get(\`http://localhost:\${PORT}/api/props/\${sport}\`, { timeout: 15000 });
    const props = resp.data?.props || [];
    const now = Date.now();`,
  `async function snapshotLines(sport = 'nba') {
  try {
    // Read from Redis directly — never trigger a fresh Odds API call
    let redisCache = null;
    try { redisCache = require('./redis-cache'); } catch(e) {}
    
    let props = [];
    if (redisCache && redisCache.isConnected()) {
      const data = await redisCache.getProps(sport);
      props = data ? (data.props || data.picks || []) : [];
    }
    
    if (props.length === 0) {
      console.log(\`[Sharp] No props in Redis for \${sport}, skipping snapshot\`);
      return;
    }
    const now = Date.now();`,
  'sharp-tools → Redis'
)) applied++;

// FIX 3: prop-enrichment.js — Redis instead of HTTP (main call)
console.log('[3/7] prop-enrichment.js → Redis (main)...');
if (replaceInFile('services/prop-enrichment.js',
  `router.get('/props/:sport', async (req, res) => {
  const { sport } = req.params;
  try {
    const propsResp = await axios.get(\`http://localhost:\${PORT}/api/props/\${sport}\`, { timeout: 15000 });
    const propsData = propsResp.data;
    const props = propsData.props || [];`,
  `router.get('/props/:sport', async (req, res) => {
  const { sport } = req.params;
  try {
    // Read from Redis directly — never trigger a fresh Odds API call
    let redisCache = null;
    try { redisCache = require('./redis-cache'); } catch(e) {}
    
    let propsData = { props: [], count: 0 };
    if (redisCache && redisCache.isConnected()) {
      const data = await redisCache.getProps(sport);
      if (data) {
        const p = data.props || data.picks || [];
        propsData = { props: p, count: p.length, available: true };
      }
    }
    const props = propsData.props || [];`,
  'prop-enrichment → Redis (main)'
)) applied++;

// FIX 3b: prop-enrichment.js — Redis instead of HTTP (fallback)
console.log('        prop-enrichment.js → Redis (fallback)...');
if (replaceInFile('services/prop-enrichment.js',
  `    try {
      const fallback = await axios.get(\`http://localhost:\${PORT}/api/props/\${sport}\`);
      res.json({ ...fallback.data, enriched: false, error: err.message });`,
  `    try {
      // Fallback: return unenriched props from Redis
      let fallbackProps = { props: [], count: 0, enriched: false, error: err.message };
      if (redisCache && redisCache.isConnected()) {
        const data = await redisCache.getProps(sport);
        if (data) { const p = data.props || data.picks || []; fallbackProps = { props: p, count: p.length, enriched: false, error: err.message }; }
      }
      res.json(fallbackProps);`,
  'prop-enrichment → Redis (fallback)'
)) applied++;

// FIX 4: auto-grader.js — cap gradedPicks at 500
console.log('[4/7] auto-grader.js — cap gradedPicks...');
if (replaceInFile('services/auto-grader.js',
  `        });
        newGrades++;

        if (hit && !push) gradingStats.hits++;`,
  `        });
        // Cap in-memory array to prevent unbounded growth
        if (gradedPicks.length > 500) gradedPicks = gradedPicks.slice(-500);
        newGrades++;

        if (hit && !push) gradingStats.hits++;`,
  'Cap gradedPicks at 500'
)) applied++;

// FIX 5: sharp-tools.js — cap lineSnapshots keys
console.log('[5/7] sharp-tools.js — cap lineSnapshots...');
if (replaceInFile('services/sharp-tools.js',
  `    saveCLVData();
    return props.length;`,
  `    saveCLVData();
    
    // Cap total snapshot keys to prevent unbounded memory growth
    var snapKeys = Object.keys(lineSnapshots);
    if (snapKeys.length > 2000) {
      // Remove oldest keys (those with oldest last snapshot)
      var sorted = snapKeys.sort(function(a, b) {
        var aLast = lineSnapshots[a] && lineSnapshots[a].length > 0 ? lineSnapshots[a][lineSnapshots[a].length - 1].time : 0;
        var bLast = lineSnapshots[b] && lineSnapshots[b].length > 0 ? lineSnapshots[b][lineSnapshots[b].length - 1].time : 0;
        return aLast - bLast;
      });
      var toRemove = sorted.slice(0, sorted.length - 1500);
      toRemove.forEach(function(k) { delete lineSnapshots[k]; });
      console.log('[Sharp] Trimmed lineSnapshots from ' + snapKeys.length + ' to 1500 keys');
    }
    
    return props.length;`,
  'Cap lineSnapshots at 2000 keys'
)) applied++;

// FIX 6: server.js — fetchPicksInternal reads Redis directly
console.log('[6/7] server.js — fetchPicksInternal → Redis...');
if (replaceInFile('server.js',
  `async function fetchPicksInternal(sport) {
  try {
    const resp = await fetch(\`http://localhost:\${PORT}/api/props/\${sport}/picks\`);
    return await resp.json();
  } catch (err) {
    console.error(\`fetchPicksInternal failed for \${sport}:\`, err.message);
    return { picks: [] };
  }
}`,
  `async function fetchPicksInternal(sport) {
  try {
    // Read from Redis directly to avoid triggering AI picks generation
    if (redisCache && redisCache.isConnected()) {
      var data = await redisCache.getPicks(sport);
      if (data && data.picks && data.picks.length > 0) return data;
    }
    // Fallback: use smartPicks cache
    if (smartPicks && smartPicks.picksCache && smartPicks.picksCache[sport]) {
      var cached = smartPicks.picksCache[sport];
      if (cached && cached.picks && cached.picks.length > 0) return { picks: cached.picks };
    }
    return { picks: [] };
  } catch (err) {
    console.error(\`fetchPicksInternal failed for \${sport}:\`, err.message);
    return { picks: [] };
  }
}`,
  'fetchPicksInternal → Redis'
)) applied++;

// FIX 7: server.js — getMovementInternal reads Redis directly
console.log('[7/7] server.js — getMovementInternal → Redis...');
if (replaceInFile('server.js',
  `async function getMovementInternal(sport) {
  try {
    const resp = await fetch(\`http://localhost:\${PORT}/api/movement/\${sport}\`);
    return await resp.json();
  } catch (err) {
    console.error(\`getMovementInternal failed for \${sport}:\`, err.message);
    return { props: [] };
  }
}`,
  `async function getMovementInternal(sport) {
  try {
    // Read from Redis directly
    if (redisCache && redisCache.isConnected()) {
      var data = await redisCache.getMovement(sport);
      if (data) return data;
    }
    return { props: [], movements: [] };
  } catch (err) {
    console.error(\`getMovementInternal failed for \${sport}:\`, err.message);
    return { props: [] };
  }
}`,
  'getMovementInternal → Redis'
)) applied++;

console.log('\n=== COMPLETE: ' + applied + ' fixes applied ===\n');
if (applied > 0) {
  console.log('Run:');
  console.log('  git add -A');
  console.log('  git commit -m "Audit: eliminate all HTTP self-calls, cap unbounded arrays"');
  console.log('  git push');
  console.log('\nThis closes every remaining hole I found in the codebase.');
}
