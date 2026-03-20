/**
 * redis-cache.js — ORACLE's Shared Data Layer
 * 
 * All data flows through Redis:
 *   Worker writes → Redis → Web server reads
 * 
 * If Redis is unavailable, falls back to in-memory cache.
 * If in-memory cache is empty, returns empty arrays (never crashes).
 * 
 * Keys:
 *   oracle:props:{sport}     — Player props (from Odds API)
 *   oracle:picks:{sport}     — Smart picks (AI-generated)
 *   oracle:games:{sport}     — Game predictions
 *   oracle:ev                — +EV bets
 *   oracle:potd              — Pick of the Day
 *   oracle:accuracy          — Accuracy record
 *   oracle:movement:{sport}  — Line movement data
 *   oracle:ticker            — Live score ticker data
 */

const Redis = require('ioredis');

// ============================================================
// Redis Connection
// ============================================================
let redis = null;
let redisConnected = false;
const memoryFallback = {}; // In-memory fallback if Redis is down

function initRedis() {
  const url = process.env.REDIS_URL || process.env.REDIS_PUBLIC_URL;
  if (!url) {
    console.log('[Redis] No REDIS_URL found — using memory-only mode');
    return;
  }

  try {
    redis = new Redis(url, {
      maxRetriesPerRequest: 3,
      retryStrategy: function(times) {
        if (times > 10) return null; // Stop retrying after 10 attempts
        return Math.min(times * 200, 5000); // Exponential backoff, max 5s
      },
      connectTimeout: 10000,
      lazyConnect: false,
    });

    redis.on('connect', function() {
      redisConnected = true;
      console.log('[Redis] ✅ Connected to Redis');
    });

    redis.on('error', function(err) {
      if (redisConnected) {
        console.warn('[Redis] Connection error:', err.message);
      }
      redisConnected = false;
    });

    redis.on('close', function() {
      redisConnected = false;
    });

    redis.on('reconnecting', function() {
      console.log('[Redis] Reconnecting...');
    });
  } catch(e) {
    console.warn('[Redis] Failed to initialize:', e.message);
  }
}

// ============================================================
// Core Operations — Set, Get, with fallback
// ============================================================

/**
 * Write data to Redis (+ memory fallback)
 * TTL in seconds (default 1 hour)
 */
async function set(key, data, ttlSeconds) {
  ttlSeconds = ttlSeconds || 3600;
  var json = JSON.stringify(data);

  // Always write to memory fallback
  memoryFallback[key] = { data: data, time: Date.now(), ttl: ttlSeconds * 1000 };

  // Write to Redis if connected
  if (redis && redisConnected) {
    try {
      await redis.setex(key, ttlSeconds, json);
      return true;
    } catch(e) {
      console.warn('[Redis] Write error for ' + key + ':', e.message);
      return false;
    }
  }
  return false;
}

/**
 * Read data from Redis (falls back to memory)
 * Returns null if not found anywhere
 */
async function get(key) {
  // Try Redis first
  if (redis && redisConnected) {
    try {
      var json = await redis.get(key);
      if (json) {
        var data = JSON.parse(json);
        // Update memory fallback
        memoryFallback[key] = { data: data, time: Date.now(), ttl: 3600000 };
        return data;
      }
    } catch(e) {
      console.warn('[Redis] Read error for ' + key + ':', e.message);
    }
  }

  // Fall back to memory
  var mem = memoryFallback[key];
  if (mem && Date.now() - mem.time < mem.ttl) {
    return mem.data;
  }

  return null;
}

/**
 * Check if Redis is connected
 */
function isConnected() {
  return redisConnected;
}

// ============================================================
// ORACLE-Specific Helper Functions
// ============================================================

// --- Props ---
async function setProps(sport, propsData) {
  return set('oracle:props:' + sport, propsData, 1800); // 30 min TTL
}

async function getProps(sport) {
  return get('oracle:props:' + sport);
}

// --- Smart Picks ---
async function setPicks(sport, picksData) {
  return set('oracle:picks:' + sport, picksData, 1800);
}

async function getPicks(sport) {
  return get('oracle:picks:' + sport);
}

// --- Game Predictions ---
async function setGames(sport, gamesData) {
  return set('oracle:games:' + sport, gamesData, 1800);
}

async function getGames(sport) {
  return get('oracle:games:' + sport);
}

// --- EV Bets ---
async function setEV(evData) {
  return set('oracle:ev', evData, 1800);
}

async function getEV() {
  return get('oracle:ev');
}

// --- POTD ---
async function setPOTD(potdData) {
  return set('oracle:potd', potdData, 1800);
}

async function getPOTD() {
  return get('oracle:potd');
}

// --- Accuracy ---
async function setAccuracy(accuracyData) {
  return set('oracle:accuracy', accuracyData, 3600);
}

async function getAccuracy() {
  return get('oracle:accuracy');
}

// --- Line Movement ---
async function setMovement(sport, movementData) {
  return set('oracle:movement:' + sport, movementData, 1800);
}

async function getMovement(sport) {
  return get('oracle:movement:' + sport);
}

// --- Ticker (live scores) ---
async function setTicker(tickerData) {
  return set('oracle:ticker', tickerData, 300); // 5 min TTL
}

async function getTicker() {
  return get('oracle:ticker');
}

// --- Game Grades ---
async function setGameGrades(gradesData) {
  return set('oracle:game_grades', gradesData, 7200); // 2 hour TTL
}

async function getGameGrades() {
  return get('oracle:game_grades');
}

// --- Pick History (for accuracy record) ---
async function setPickHistory(historyData) {
  return set('oracle:pick_history', historyData, 7200);
}

async function getPickHistory() {
  return get('oracle:pick_history');
}

// ============================================================
// Health check
// ============================================================
async function healthCheck() {
  if (!redis || !redisConnected) {
    return { status: 'disconnected', mode: 'memory-only' };
  }
  try {
    await redis.ping();
    var keys = await redis.dbsize();
    return { status: 'connected', keys: keys, mode: 'redis' };
  } catch(e) {
    return { status: 'error', error: e.message, mode: 'memory-fallback' };
  }
}

// Initialize on load
initRedis();

module.exports = {
  // Core
  set, get, isConnected, healthCheck, initRedis,
  // Props
  setProps, getProps,
  // Picks
  setPicks, getPicks,
  // Games
  setGames, getGames,
  // EV
  setEV, getEV,
  // POTD
  setPOTD, getPOTD,
  // Accuracy
  setAccuracy, getAccuracy,
  // Movement
  setMovement, getMovement,
  // Ticker
  setTicker, getTicker,
  // Game Grades
  setGameGrades, getGameGrades,
  // Pick History
  setPickHistory, getPickHistory,
};
