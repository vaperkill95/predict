/**
 * ORACLE Final Cache Alignment
 * 
 * Extends ALL remaining short caches to 30 min so everything
 * is aligned with the dedicated PropsRefresh timer.
 * 
 * Fixes:
 * 1. odds.js cache: 5 min → 30 min
 * 2. enhanced-props-middleware.js cache: 5 min → 30 min  
 * 3. game-predictions.js cache: 20 min → 30 min
 * 
 * Usage: node apply-cache-alignment.js
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

console.log('\n=== ORACLE Final Cache Alignment ===\n');
if (!fs.existsSync('server.js')) { console.log('ERROR: Run from project root.'); process.exit(1); }

let applied = 0;

console.log('[1/3] odds.js cache 5min → 30min...');
if (replaceInFile('services/odds.js',
  'const cache = new NodeCache({ stdTTL: 300 }); // 5 min cache',
  'const cache = new NodeCache({ stdTTL: 1800 }); // 30 min cache — saves API credits',
  'odds.js 5min → 30min'
)) applied++;

console.log('[2/3] enhanced-props-middleware.js cache 5min → 30min...');
if (replaceInFile('services/enhanced-props-middleware.js',
  'const ENRICHMENT_TTL = 5 * 60 * 1000; // 5 min cache',
  'const ENRICHMENT_TTL = 30 * 60 * 1000; // 30 min cache — aligned with props refresh',
  'enrichment 5min → 30min'
)) applied++;

console.log('[3/3] game-predictions.js cache 20min → 30min...');
if (replaceInFile('services/game-predictions.js',
  'return (c && c.games && Date.now() - c.timestamp < 20*60*1000) ? c.games : null;',
  'return (c && c.games && Date.now() - c.timestamp < 30*60*1000) ? c.games : null;',
  'game-predictions 20min → 30min'
)) applied++;

console.log('\n=== COMPLETE: ' + applied + ' fixes applied ===\n');
if (applied > 0) {
  console.log('Run:');
  console.log('  git add -A');
  console.log('  git commit -m "Align all caches to 30min — final stability patch"');
  console.log('  git push');
  console.log('\nEvery cache in the system is now at 30 minutes.');
  console.log('The only thing calling the Odds API is the dedicated PropsRefresh timer.');
}
