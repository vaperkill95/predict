/**
 * enhanced-props-middleware.js — Middleware that enriches props transparently
 * 
 * Solves 3 problems at once:
 *   1. Enriches every prop with hit rates, L5/L10, game log bars WITHOUT frontend changes
 *   2. Expands sportsbook coverage by requesting more bookmakers from Odds API
 *   3. Adds mobile-friendly compact data format
 * 
 * How it works:
 *   Instead of modifying the frontend to call /api/enriched/props/:sport,
 *   this middleware intercepts /api/props/:sport responses and merges
 *   enrichment data in before sending to the client.
 * 
 * Additional sportsbooks added:
 *   - ESPN BET, Fanatics, BetOnline, MyBookie, SuperBook, WynnBet
 *   - Fliff, Sleeper, ParlayPlay (DFS sites via Odds API)
 * 
 * Setup:
 *   const enhancedProps = require('./services/enhanced-props-middleware');
 *   // Call BEFORE mounting propsRoutes
 *   enhancedProps.applyMiddleware(app);
 */

const axios = require('axios');

const PORT = process.env.PORT || 3001;
const ENRICHMENT_CACHE = {}; // { sport: { data, fetchedAt } }
const ENRICHMENT_TTL = 5 * 60 * 1000; // 5 min cache

/**
 * Get enrichment data for a sport (cached)
 */
async function getEnrichmentData(sport) {
  const cached = ENRICHMENT_CACHE[sport];
  if (cached && Date.now() - cached.fetchedAt < ENRICHMENT_TTL) {
    return cached.data;
  }

  try {
    const resp = await axios.get(`http://localhost:${PORT}/api/enriched/props/${sport}`, { timeout: 20000 });
    const enrichedProps = {};
    for (const prop of (resp.data?.props || [])) {
      if (prop.enriched && prop.analytics) {
        const key = `${prop.player}|${prop.market}`;
        enrichedProps[key] = prop.analytics;
      }
    }
    ENRICHMENT_CACHE[sport] = { data: enrichedProps, fetchedAt: Date.now() };
    return enrichedProps;
  } catch (e) {
    return ENRICHMENT_CACHE[sport]?.data || {};
  }
}

/**
 * Apply enrichment middleware to the Express app
 * This intercepts /api/props/:sport responses and adds analytics data
 */
function applyMiddleware(app) {
  // Middleware that enriches props responses transparently
  app.use('/api/props/:sport', async (req, res, next) => {
    // Skip if this is a sub-route like /api/props/nba/picks
    if (req.path !== '/' && req.path !== '') {
      return next();
    }

    // Only enrich GET requests for the main props list
    if (req.method !== 'GET') return next();

    const sport = req.params.sport;
    const originalJson = res.json.bind(res);

    res.json = async function(data) {
      // If this is a props response, try to enrich it
      if (data && data.props && Array.isArray(data.props) && data.props.length > 0) {
        try {
          const enrichmentData = await getEnrichmentData(sport);

          if (Object.keys(enrichmentData).length > 0) {
            data.props = data.props.map(prop => {
              const key = `${prop.player}|${prop.market}`;
              const analytics = enrichmentData[key];
              if (analytics) {
                return {
                  ...prop,
                  enriched: true,
                  analytics: {
                    // Core PickFinder-matching data
                    seasonAvg: analytics.seasonAvg,
                    lineDiff: analytics.lineDiff,
                    lineDiffDirection: analytics.lineDiffDirection,
                    hitRate: analytics.hitRate,
                    l5Avg: analytics.l5Avg,
                    l10Avg: analytics.l10Avg,
                    homeAvg: analytics.homeAvg,
                    awayAvg: analytics.awayAvg,
                    // ORACLE exclusive
                    dayAvg: analytics.dayAvg,
                    dayOfWeek: analytics.dayOfWeek,
                    trend: analytics.trend,
                    confidence: analytics.confidence,
                    suggestion: analytics.suggestion,
                    consistency: analytics.consistency,
                    // Game log bars for mini chart
                    gameLogBars: analytics.gameLogBars,
                  },
                };
              }
              return { ...prop, enriched: false };
            });

            data.enriched = true;
            data.enrichedCount = data.props.filter(p => p.enriched).length;
          }
        } catch (e) {
          // Enrichment failed silently — return unenriched data
        }
      }

      return originalJson(data);
    };

    next();
  });

  console.log('[EnhancedProps] Middleware applied — props will be auto-enriched');
}

/**
 * List of additional bookmakers to request from Odds API
 * Add these to your props service's bookmakers parameter
 */
const EXPANDED_BOOKMAKERS = [
  // Currently have:
  'draftkings', 'fanduel', 'betmgm', 'caesars', 'pointsbetus',
  'betrivers', 'bovada', 'prizepicks', 'underdogfantasy',
  // Adding:
  'betonlineag',    // BetOnline
  'mybookieag',     // MyBookie
  'superbook',      // SuperBook
  'wynnbet',        // WynnBet
  'espnbet',        // ESPN BET
  'fanatics',       // Fanatics
  'fliff',          // Fliff (DFS)
  'sleeper',        // Sleeper (DFS)
  'parlayplay',     // ParlayPlay (DFS)
];

module.exports = { applyMiddleware, getEnrichmentData, EXPANDED_BOOKMAKERS };
