import { useState, useEffect } from "react";

// ============================================================
// CDL Props Tab Component for ORACLE
// ============================================================
// Drop this into your app alongside the existing tabs (History, Scores, Predictor, Standings)
// Requires: GET /api/cdl/props endpoint returning { matches: [...] }

const MARKETS = [
  { key: "all", label: "All" },
  { key: "map1_kills", label: "Map 1" },
  { key: "map2_kills", label: "Map 2" },
  { key: "map3_kills", label: "Map 3" },
  { key: "total_kills", label: "Total" },
  { key: "series_kd", label: "K/D" },
];

const EDGE_COLORS = {
  high: "#22c55e",   // green — strong edge
  medium: "#eab308", // yellow — moderate
  low: "#6b7280",    // gray — no edge
};

function getEdgeColor(confidence) {
  if (confidence >= 70) return EDGE_COLORS.high;
  if (confidence >= 55) return EDGE_COLORS.medium;
  return EDGE_COLORS.low;
}

function EdgeBadge({ edge }) {
  if (!edge) return null;
  const color = getEdgeColor(edge.confidence);
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
        color: "#000",
        background: color,
        padding: "2px 6px",
        borderRadius: 4,
        marginLeft: 6,
      }}
    >
      {edge.direction} {edge.confidence}%
    </span>
  );
}

function SuggestionBadge({ suggestion }) {
  if (!suggestion) return null;
  const isOver = suggestion === "OVER";
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 800,
        letterSpacing: 1,
        color: isOver ? "#22c55e" : "#ef4444",
        border: `1px solid ${isOver ? "#22c55e44" : "#ef444444"}`,
        padding: "1px 5px",
        borderRadius: 3,
        marginLeft: 4,
      }}
    >
      ★ {suggestion}
    </span>
  );
}

function PropRow({ prop }) {
  const isKD = prop.market === "series_kd";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 12px",
        borderRadius: 6,
        background: "var(--bg-card, #1a1f2e)",
        border: "1px solid var(--border, #2a2f3e)",
        fontSize: 13,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            fontFamily: "var(--font-mono, monospace)",
            color: "var(--text-secondary, #8b92a5)",
            fontSize: 11,
          }}
        >
          {prop.label}
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {/* Line */}
        <div style={{ textAlign: "center", minWidth: 44 }}>
          <div
            style={{
              fontSize: 9,
              color: "var(--text-secondary, #8b92a5)",
              letterSpacing: 1,
              fontWeight: 600,
            }}
          >
            LINE
          </div>
          <div
            style={{
              fontFamily: "var(--font-mono, monospace)",
              fontWeight: 700,
              fontSize: 15,
              color: "var(--text-primary, #e2e8f0)",
            }}
          >
            {isKD ? prop.line.toFixed(2) : prop.line}
          </div>
        </div>

        {/* Average */}
        <div style={{ textAlign: "center", minWidth: 44 }}>
          <div
            style={{
              fontSize: 9,
              color: "var(--text-secondary, #8b92a5)",
              letterSpacing: 1,
              fontWeight: 600,
            }}
          >
            AVG
          </div>
          <div
            style={{
              fontFamily: "var(--font-mono, monospace)",
              fontWeight: 700,
              fontSize: 15,
              color:
                prop.avg > prop.line
                  ? "#22c55e"
                  : prop.avg < prop.line
                  ? "#ef4444"
                  : "var(--text-primary, #e2e8f0)",
            }}
          >
            {isKD ? prop.avg.toFixed(2) : prop.avg}
          </div>
        </div>

        {/* Games */}
        <div
          style={{
            fontSize: 10,
            color: "var(--text-secondary, #8b92a5)",
            fontFamily: "var(--font-mono, monospace)",
            minWidth: 30,
            textAlign: "center",
          }}
        >
          {prop.games}g
        </div>

        {/* Edge */}
        {prop.edge && <EdgeBadge edge={prop.edge} />}
        {prop.suggestion && <SuggestionBadge suggestion={prop.suggestion} />}
      </div>
    </div>
  );
}

function PlayerCard({ playerData, marketFilter }) {
  const filteredProps =
    marketFilter === "all"
      ? playerData.props
      : playerData.props.filter((p) => p.market === marketFilter);

  if (filteredProps.length === 0) return null;

  return (
    <div
      style={{
        background: "var(--bg-surface, #141824)",
        border: "1px solid var(--border, #2a2f3e)",
        borderRadius: 10,
        padding: 14,
        marginBottom: 10,
      }}
    >
      {/* Player Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 10,
        }}
      >
        {playerData.headshot && (
          <img
            src={playerData.headshot}
            alt={playerData.player}
            style={{
              width: 36,
              height: 36,
              borderRadius: "50%",
              objectFit: "cover",
              border: "2px solid var(--border, #2a2f3e)",
            }}
          />
        )}
        <div>
          <div
            style={{
              fontFamily: "var(--font-display, 'Outfit', sans-serif)",
              fontWeight: 700,
              fontSize: 15,
              color: "var(--text-primary, #e2e8f0)",
            }}
          >
            {playerData.player}
          </div>
          <div
            style={{
              fontSize: 11,
              color: "var(--text-secondary, #8b92a5)",
              fontFamily: "var(--font-mono, monospace)",
            }}
          >
            {playerData.teamName} · K/D {playerData.kd.toFixed(2)}
          </div>
        </div>
      </div>

      {/* Props */}
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {filteredProps.map((prop, i) => (
          <PropRow key={prop.market + i} prop={prop} />
        ))}
      </div>
    </div>
  );
}

function MatchSection({ match, marketFilter }) {
  const allPlayers = [
    ...(match.team1?.players || []),
    ...(match.team2?.players || []),
  ];

  // Sort by highest edge confidence
  const sorted = [...allPlayers].sort((a, b) => {
    const aMax = Math.max(0, ...a.props.map((p) => p.edge?.confidence || 0));
    const bMax = Math.max(0, ...b.props.map((p) => p.edge?.confidence || 0));
    return bMax - aMax;
  });

  return (
    <div style={{ marginBottom: 24 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 12,
          padding: "8px 12px",
          background: "var(--bg-card, #1a1f2e)",
          borderRadius: 8,
          border: "1px solid var(--border, #2a2f3e)",
        }}
      >
        <span style={{ fontSize: 14 }}>🎮</span>
        <span
          style={{
            fontFamily: "var(--font-display, 'Outfit', sans-serif)",
            fontWeight: 700,
            fontSize: 14,
            color: "var(--text-primary, #e2e8f0)",
          }}
        >
          {match.team1?.name}
        </span>
        <span
          style={{
            fontSize: 11,
            color: "var(--text-secondary, #8b92a5)",
            fontWeight: 600,
          }}
        >
          vs
        </span>
        <span
          style={{
            fontFamily: "var(--font-display, 'Outfit', sans-serif)",
            fontWeight: 700,
            fontSize: 14,
            color: "var(--text-primary, #e2e8f0)",
          }}
        >
          {match.team2?.name}
        </span>
        <span
          style={{
            marginLeft: "auto",
            fontSize: 11,
            color: "var(--text-secondary, #8b92a5)",
            fontFamily: "var(--font-mono, monospace)",
          }}
        >
          {match.scheduledAt
            ? new Date(match.scheduledAt).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })
            : ""}
        </span>
      </div>

      {sorted.map((playerData) => (
        <PlayerCard
          key={playerData.playerId}
          playerData={playerData}
          marketFilter={marketFilter}
        />
      ))}
    </div>
  );
}

export default function CDLPropsTab() {
  const [matches, setMatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [market, setMarket] = useState("all");
  const [lastUpdated, setLastUpdated] = useState(null);

  useEffect(() => {
    fetchProps();
  }, []);

  async function fetchProps() {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch("/api/cdl/props");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      setMatches(data.matches || []);
      setLastUpdated(data.lastUpdated);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // Count total props across all matches
  const totalProps = matches.reduce(
    (sum, m) =>
      sum +
      (m.team1?.players || []).reduce((s, p) => s + p.props.length, 0) +
      (m.team2?.players || []).reduce((s, p) => s + p.props.length, 0),
    0
  );

  // Count strong edges (confidence >= 65%)
  const strongEdges = matches.reduce(
    (sum, m) =>
      sum +
      [...(m.team1?.players || []), ...(m.team2?.players || [])].reduce(
        (s, p) =>
          s + p.props.filter((pr) => pr.edge?.confidence >= 65).length,
        0
      ),
    0
  );

  return (
    <div>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 18 }}>🎯</span>
          <h2
            style={{
              fontFamily: "var(--font-display, 'Outfit', sans-serif)",
              fontWeight: 900,
              fontSize: 18,
              color: "var(--text-primary, #e2e8f0)",
              margin: 0,
            }}
          >
            CDL Player Props
          </h2>
          {totalProps > 0 && (
            <span
              style={{
                fontSize: 11,
                fontFamily: "var(--font-mono, monospace)",
                color: "var(--text-secondary, #8b92a5)",
                background: "var(--bg-card, #1a1f2e)",
                padding: "2px 8px",
                borderRadius: 10,
              }}
            >
              {totalProps} props
              {strongEdges > 0 && (
                <span style={{ color: "#22c55e", marginLeft: 4 }}>
                  · {strongEdges} edges
                </span>
              )}
            </span>
          )}
        </div>
        {lastUpdated && (
          <span
            style={{
              fontSize: 10,
              color: "var(--text-secondary, #8b92a5)",
              fontFamily: "var(--font-mono, monospace)",
            }}
          >
            Updated {new Date(lastUpdated).toLocaleTimeString()}
          </span>
        )}
      </div>

      {/* Market Filter */}
      <div
        style={{
          display: "flex",
          gap: 4,
          marginBottom: 16,
          overflowX: "auto",
          paddingBottom: 4,
        }}
      >
        {MARKETS.map((m) => (
          <button
            key={m.key}
            onClick={() => setMarket(m.key)}
            style={{
              fontFamily: "var(--font-mono, monospace)",
              fontSize: 11,
              fontWeight: market === m.key ? 700 : 500,
              color:
                market === m.key
                  ? "#000"
                  : "var(--text-secondary, #8b92a5)",
              background:
                market === m.key
                  ? "#22c55e"
                  : "var(--bg-card, #1a1f2e)",
              border: "1px solid var(--border, #2a2f3e)",
              borderRadius: 6,
              padding: "5px 12px",
              cursor: "pointer",
              whiteSpace: "nowrap",
              transition: "all 0.15s ease",
            }}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Safest Bet Tip */}
      {market === "map2_kills" && (
        <div
          style={{
            background: "#22c55e12",
            border: "1px solid #22c55e33",
            borderRadius: 8,
            padding: "10px 14px",
            marginBottom: 16,
            fontSize: 12,
            color: "#22c55e",
            fontFamily: "var(--font-mono, monospace)",
          }}
        >
          💡 <strong>Safest prop type:</strong> SnD kills are structurally
          capped (~5-8 per player). UNDER tends to hit at higher rates when
          lines are set from blended averages.
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            padding: 20,
          }}
        >
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              style={{
                height: 80,
                borderRadius: 10,
                background: "var(--bg-card, #1a1f2e)",
                animation: "pulse 1.5s ease-in-out infinite",
              }}
            />
          ))}
        </div>
      ) : error ? (
        <div
          style={{
            padding: 24,
            textAlign: "center",
            color: "var(--text-secondary, #8b92a5)",
          }}
        >
          <div style={{ fontSize: 24, marginBottom: 8 }}>⚠️</div>
          <div style={{ fontSize: 13 }}>{error}</div>
          <button
            onClick={fetchProps}
            style={{
              marginTop: 12,
              padding: "6px 16px",
              borderRadius: 6,
              border: "1px solid var(--border, #2a2f3e)",
              background: "var(--bg-card, #1a1f2e)",
              color: "var(--text-primary, #e2e8f0)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Retry
          </button>
        </div>
      ) : matches.length === 0 ? (
        <div
          style={{
            padding: 40,
            textAlign: "center",
            color: "var(--text-secondary, #8b92a5)",
          }}
        >
          <div style={{ fontSize: 28, marginBottom: 8 }}>🎮</div>
          <div
            style={{
              fontFamily: "var(--font-display, sans-serif)",
              fontWeight: 700,
              fontSize: 15,
            }}
          >
            No CDL props available
          </div>
          <div style={{ fontSize: 12, marginTop: 4 }}>
            Props appear when CDL matches are scheduled
          </div>
        </div>
      ) : (
        matches.map((match, i) => (
          <MatchSection key={i} match={match} marketFilter={market} />
        ))
      )}

      {/* Disclaimer */}
      <div
        style={{
          marginTop: 24,
          padding: 10,
          borderRadius: 6,
          background: "var(--bg-card, #1a1f2e)",
          fontSize: 10,
          color: "var(--text-secondary, #8b92a5)",
          textAlign: "center",
          fontFamily: "var(--font-mono, monospace)",
        }}
      >
        ⚠️ For entertainment & research only. Not financial or gambling advice.
        Lines are statistical estimates, not book lines.
      </div>
    </div>
  );
}
