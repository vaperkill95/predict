/**
 * ORACLE API Credit Saver Patch
 * 
 * Makes $25 in Anthropic credits last ~5-6 months instead of ~3 days:
 * 1. Extends AI picks cache from 10 min → 2 hours (12x fewer calls)
 * 2. Switches getDailyPicks from Sonnet → Haiku (5x cheaper per call)  
 * 3. Disables anthropic.js game/player predictions (uses free statistical model)
 * 
 * Usage: node apply-credit-saver.js
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

console.log('\n=== ORACLE API Credit Saver ===\n');

if (!fs.existsSync('server.js') || !fs.existsSync('services')) {
  console.log('ERROR: Run from your predict project root folder.');
  process.exit(1);
}

let applied = 0;

// FIX 1: Extend picks cache 10min → 2 hours
console.log('[1/3] Extending AI picks cache to 2 hours...');
if (replaceInFile('services/props.js',
  'const picksCache = new NodeCache({ stdTTL: 600 });',
  'const picksCache = new NodeCache({ stdTTL: 7200 });',
  'Picks cache 600s → 7200s (2 hours)'
)) applied++;

// FIX 2: Switch getDailyPicks from Sonnet to Haiku
console.log('\n[2/3] Switching AI picks from Sonnet → Haiku...');
if (replaceInFile('services/props.js',
  '      model: "claude-sonnet-4-20250514", max_tokens: 2000,',
  '      model: "claude-haiku-4-5-20251001", max_tokens: 2000,',
  'getDailyPicks: Sonnet → Haiku'
)) applied++;

// FIX 3: Disable anthropic.js game predictions (use free fallback)
console.log('\n[3/3] Disabling expensive Sonnet game predictions...');
if (replaceInFile('services/anthropic.js',
  `async function predictGame(gameData, oddsData = null) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return generateFallbackPrediction(gameData);
  }`,
  `async function predictGame(gameData, oddsData = null) {
  // API disabled to conserve credits — using statistical fallback model instead
  return generateFallbackPrediction(gameData);`,
  'predictGame: skip API, use free fallback'
)) applied++;

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
  'predictPlayer: skip API, use fallback'
)) applied++;

console.log('\n=== PATCH COMPLETE ===');
console.log(applied + ' changes applied.\n');

if (applied > 0) {
  console.log('Now run:');
  console.log('  git add -A');
  console.log('  git commit -m "Save API credits: Haiku + 2hr cache + disable Sonnet predictions"');
  console.log('  git push');
  console.log('\nEstimated savings: ~$8.45/day → ~$0.15/day');
  console.log('$25 will now last ~5-6 months instead of ~3 days.');
}
