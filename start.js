/**
 * start.js — Smart starter for ORACLE
 * 
 * Checks ORACLE_MODE environment variable:
 *   "web"    → starts oracle-web.js (lightweight, reads Redis)
 *   anything else → starts server.js (worker, heavy background jobs)
 */

const mode = process.env.ORACLE_MODE || "worker";

if (mode === "web") {
  console.log("[ORACLE] Starting in WEB mode — lightweight, Redis-only");
  require("./oracle-web.js");
} else {
  console.log("[ORACLE] Starting in WORKER mode — full background services");
  require("./server.js");
}
