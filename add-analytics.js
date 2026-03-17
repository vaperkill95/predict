// save-this-as: add-analytics.js
// Run: node add-analytics.js

const fs = require('fs');

let code = fs.readFileSync('server.js', 'utf8');

if (code.includes('enhanced-analytics')) {
  console.log('Already has enhanced-analytics. Skipping.');
  process.exit(0);
}

// Add require after the last require line in the services block
const insertAfter = "const discordAlerts = require(\"./services/discord-alerts\");";
const newRequire = `\nconst analytics = require("./services/enhanced-analytics");`;

if (code.includes(insertAfter)) {
  code = code.replace(insertAfter, insertAfter + newRequire);
  console.log('Added: const analytics = require("./services/enhanced-analytics");');
} else {
  console.log('Could not find discordAlerts require line. Trying alternative...');
  // Try to find any services require
  const altPattern = /const\s+\w+\s*=\s*require\("\.\/services\/[^"]+"\);/g;
  const matches = [...code.matchAll(altPattern)];
  if (matches.length > 0) {
    const lastMatch = matches[matches.length - 1];
    const pos = lastMatch.index + lastMatch[0].length;
    code = code.slice(0, pos) + newRequire + code.slice(pos);
    console.log('Added require after: ' + lastMatch[0].substring(0, 50));
  } else {
    console.log('ERROR: Could not find where to insert require.');
    process.exit(1);
  }
}

// Add route after dvp.startRefresh()
const routeInsertAfter = "dvp.startRefresh();";
const newRoute = `\napp.use("/api/analytics", analytics.router);\nanalytics.startRefresh();`;

if (code.includes(routeInsertAfter)) {
  code = code.replace(routeInsertAfter, routeInsertAfter + newRoute);
  console.log('Added: app.use("/api/analytics", analytics.router);');
  console.log('Added: analytics.startRefresh();');
} else {
  // Try after the last app.use line
  const usePattern = /app\.use\("[^"]+",\s*\w+(?:\.router)?\);/g;
  const useMatches = [...code.matchAll(usePattern)];
  if (useMatches.length > 0) {
    const lastUse = useMatches[useMatches.length - 1];
    const pos = lastUse.index + lastUse[0].length;
    code = code.slice(0, pos) + newRoute + code.slice(pos);
    console.log('Added route after: ' + lastUse[0].substring(0, 50));
  }
}

// Backup and save
fs.writeFileSync('server.js.backup', fs.readFileSync('server.js'));
fs.writeFileSync('server.js', code);
console.log('\nDone! server.js updated. Backup saved as server.js.backup');
console.log('\nNow run:');
console.log('  git add -A');
console.log('  git commit -m "Add enhanced analytics engine"');
console.log('  git push');
