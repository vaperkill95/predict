const fs = require('fs');
console.log('\n=== Fix Restart Policy ===\n');
if (!fs.existsSync('railway.toml')) { console.log('ERROR: Run from project root.'); process.exit(1); }
let content = fs.readFileSync('railway.toml', 'utf8');
if (content.includes('restartPolicyType = "ON_FAILURE"')) {
  content = content.replace('restartPolicyType = "ON_FAILURE"', 'restartPolicyType = "ALWAYS"');
  fs.writeFileSync('railway.toml', content, 'utf8');
  console.log('DONE: Changed restart policy from ON_FAILURE → ALWAYS');
  console.log('\nRun:');
  console.log('  git add -A');
  console.log('  git commit -m "Fix: restart policy ALWAYS so scheduled restarts work"');
  console.log('  git push');
} else if (content.includes('restartPolicyType = "ALWAYS"')) {
  console.log('Already set to ALWAYS — no change needed.');
} else {
  console.log('Could not find restart policy in railway.toml');
}
