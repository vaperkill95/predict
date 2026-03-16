import { useState, useEffect } from "react";

// ============================================================
// Signal Badge — shows what's driving the trending score
// ============================================================
function SignalBadge({ signal }) {
  const colors = {
    demon: { bg: "#f59e0b", color: "#000", icon: "🔥" },
    goblin: { bg: "#334155", color: "#94a3b8", icon: "👹" },
    books: { bg: "#1e293b", color: "#94a3b8", icon: "📚" },
    spread: { bg: "#1e293b", color: "#94a3b8", icon: "📏" },
    edge: { bg: "#10b981", color: "#000", icon: "⚡" },
    movement: { bg: signal.direction === "UP" ? "#f59e0b20" : "#38bdf820", color: signal.direction === "UP" ? "#f59e0b" : "#38bdf8", icon: "📈" },
    ai: { bg: "#a78bfa20", color: "#a78bfa", icon: "🤖" },
  };
  const c = colors[signal.type] || { bg: "#1e293b", color: "#94a3b8", icon: "•" };

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
        fontSize: 10,
        fontWeight: 600,
        color: c.color,
        background: c.bg,
        border: `1px solid ${c.color}30`,
        padding: "2px 7px",
        borderRadius: 4,
        whiteSpace: "nowrap",
      }}
    >
      {c.icon} {signal.label}
    </span>
  );
}

// ============================================================
// Trending Score Bar — visual indicator of how "hot" a pick is
// ============================================================
function TrendingScoreBar({ score }) {
  const getColor = (s) => {
    if (s >= 70) return "#ef4444";
    if (s >= 50) return "#f59e0b";
    if (s >= 30) return "#38bdf8";
    return "#64748b";
  };
  const color = getColor(score);
  const label = score >= 70 ? "🔥 HOT" : score >= 50 ? "📈 RISING" : score >= 30 ? "👀 WATCH" : "";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div
        style={{
          width: 60,
          height: 6,
          borderRadius: 3,
          background: "var(--bg-elevated, #1a2236)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${score}%`,
            height: "100%",
            borderRadius: 3,
            background: color,
            transition: "width 0.5s ease",
          }}
        />
      </div>
      <span
        style={{
          fontFamily: "var(--font-mono, monospace)",
          fontSize: 11,
          fontWeight: 700,
          color,
        }}
      >
        {score}
      </span>
      {label && (
        <span style={{ fontSize: 10, fontWeight: 700, color }}>{label}</span>
      )}
    </div>
  );
}

// ============================================================
// Sparkline (inline)
// ============================================================
function MiniSparkline({ data, width = 60, height = 18 }) {
  if (!data || data.length < 2) return null;
  const values = data.map((d) => d.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const moved = values[values.length - 1] - values[0];
  const color = moved > 0 ? "#f59e0b" : moved < 0 ? "#38bdf8" : "#64748b";

  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - ((v - min) / range) * (height - 4) - 2;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "block" }}>
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle
        cx={width}
        cy={height - ((values[values.length - 1] - min) / range) * (height - 4) - 2}
        r="2"
        fill={color}
      />
    </svg>
  );
}

// ============================================================
// Trending Pick Card
// ============================================================
function TrendingCard({ pick, rank }) {
  const [expanded, setExpanded] = useState(false);

  const borderColor =
    pick.trendingScore >= 70
      ? "#ef4444"
      : pick.trendingScore >= 50
      ? "#f59e0b"
      : "var(--border, #1e293b)";

  return (
    <div
      style={{
        background: "var(--bg-card, #111827)",
        border: `1px solid ${borderColor}`,
        borderRadius: 12,
        padding: 16,
        transition: "all 0.2s",
        cursor: "pointer",
      }}
      onClick={() => setExpanded(!expanded)}
    >
      {/* Top Row: Rank + Player + Score */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 10,
        }}
      >
        {/* Rank */}
        <div
          style={{
            fontFamily: "var(--font-display, 'Outfit', sans-serif)",
            fontWeight: 900,
            fontSize: 20,
            color:
              rank <= 3
                ? rank === 1
                  ? "#ef4444"
                  : rank === 2
                  ? "#f59e0b"
                  : "#38bdf8"
                : "var(--text-muted, #64748b)",
            minWidth: 28,
            textAlign: "center",
          }}
        >
          {rank}
        </div>

        {/* Player Info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                fontFamily: "var(--font-display, 'Outfit', sans-serif)",
                fontWeight: 700,
                fontSize: 15,
              }}
            >
              {pick.player}
            </span>
            {pick.lineType === "demon" && <span style={{ fontSize: 14 }}>🔥</span>}
            {pick.lineType === "goblin" && <span style={{ fontSize: 14 }}>👹</span>}
          </div>
          <div
            style={{
              fontFamily: "var(--font-mono, monospace)",
              fontSize: 11,
              color: "var(--text-secondary, #94a3b8)",
            }}
          >
            {pick.game} · {pick.marketLabel}
          </div>
        </div>

        {/* Line */}
        <div style={{ textAlign: "center" }}>
          <div
            style={{
              fontFamily: "var(--font-mono, monospace)",
              fontSize: 9,
              color: "var(--text-muted)",
              letterSpacing: 1,
            }}
          >
            LINE
          </div>
          <div
            style={{
              fontFamily: "var(--font-mono, monospace)",
              fontWeight: 700,
              fontSize: 17,
            }}
          >
            {pick.consensusLine}
          </div>
        </div>

        {/* Movement sparkline */}
        {pick.movement?.sparkline && (
          <MiniSparkline data={pick.movement.sparkline} />
        )}

        {/* Trending Score */}
        <TrendingScoreBar score={pick.trendingScore} />
      </div>

      {/* Signal Badges */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 4,
        }}
      >
        {pick.signals.map((signal, i) => (
          <SignalBadge key={i} signal={signal} />
        ))}
      </div>

      {/* Expanded: AI reasoning + book lines */}
      {expanded && (
        <div
          style={{
            marginTop: 12,
            paddingTop: 12,
            borderTop: "1px solid var(--border, #1e293b)",
          }}
        >
          {/* AI Pick reasoning */}
          {pick.aiPick && (
            <div style={{ marginBottom: 12 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  marginBottom: 6,
                }}
              >
                <span style={{ fontSize: 12 }}>🤖</span>
                <span
                  style={{
                    fontFamily: "var(--font-mono, monospace)",
                    fontSize: 10,
                    fontWeight: 700,
                    color: pick.aiPick.pick === "OVER" ? "#10b981" : "#ef4444",
                  }}
                >
                  AI: {pick.aiPick.pick} ({pick.aiPick.confidence}%)
                </span>
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-secondary, #94a3b8)",
                  lineHeight: 1.5,
                  fontStyle: "italic",
                }}
              >
                {pick.aiPick.reasoning}
              </div>
            </div>
          )}

          {/* Movement detail */}
          {pick.movement && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
                color: "var(--text-secondary)",
                marginBottom: 8,
              }}
            >
              <span>📈 Line moved:</span>
              <span
                style={{
                  fontFamily: "var(--font-mono, monospace)",
                  fontWeight: 700,
                  color: pick.movement.direction === "UP" ? "#f59e0b" : "#38bdf8",
                }}
              >
                {pick.movement.openLine} → {pick.movement.currentLine}
                ({pick.movement.direction === "UP" ? "+" : ""}{pick.movement.amount?.toFixed(1)})
              </span>
            </div>
          )}

          {/* Book lines */}
          {pick.books && pick.books.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {pick.books.map((book, i) => (
                <div
                  key={i}
                  style={{
                    background: "var(--bg-elevated, #1a2236)",
                    borderRadius: 6,
                    padding: "4px 10px",
                    fontFamily: "var(--font-mono, monospace)",
                    fontSize: 10,
                  }}
                >
                  <span style={{ color: "var(--text-muted)", marginRight: 4 }}>
                    {book.name}
                  </span>
                  <span style={{ fontWeight: 700 }}>{book.over?.point}</span>
                  <span style={{ color: "#10b981", marginLeft: 4 }}>
                    O {book.over?.price > 0 ? "+" : ""}{book.over?.price}
                  </span>
                  <span style={{ color: "#ef4444", marginLeft: 4 }}>
                    U {book.under?.price > 0 ? "+" : ""}{book.under?.price}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// TrendingPicksTab — Full page component
// ============================================================
export default function TrendingPicksTab({ sport }) {
  const [picks, setPicks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("all"); // all, demons, ai, movement

  useEffect(() => {
    fetchTrending();
  }, [sport]);

  async function fetchTrending() {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`/api/trending/${sport}?limit=30`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      setPicks(data.picks || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // Filter picks by signal type
  const filteredPicks =
    filter === "all"
      ? picks
      : picks.filter((p) =>
          p.signals.some((s) =>
            filter === "demons" ? s.type === "demon"
            : filter === "ai" ? s.type === "ai"
            : filter === "movement" ? s.type === "movement"
            : filter === "edges" ? s.type === "edge"
            : true
          )
        );

  // Count by category
  const demonCount = picks.filter((p) => p.lineType === "demon").length;
  const aiCount = picks.filter((p) => p.aiPick).length;
  const moveCount = picks.filter((p) => p.movement).length;
  const edgeCount = picks.filter((p) => p.hasEdge).length;

  const filters = [
    { key: "all", label: "All", count: picks.length },
    { key: "demons", label: "🔥 Demons", count: demonCount },
    { key: "ai", label: "🤖 AI Picks", count: aiCount },
    { key: "movement", label: "📈 Moving", count: moveCount },
    { key: "edges", label: "⚡ Edges", count: edgeCount },
  ];

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
          <span style={{ fontSize: 18 }}>🔥</span>
          <h2
            style={{
              fontFamily: "var(--font-display, 'Outfit', sans-serif)",
              fontWeight: 900,
              fontSize: 18,
              color: "var(--text-primary, #e2e8f0)",
              margin: 0,
            }}
          >
            Trending Picks
          </h2>
          <span
            style={{
              fontFamily: "var(--font-mono, monospace)",
              fontSize: 11,
              color: "var(--text-secondary)",
              background: "var(--bg-card, #111827)",
              padding: "2px 8px",
              borderRadius: 10,
            }}
          >
            {picks.length} picks ranked
          </span>
        </div>
        <button
          onClick={fetchTrending}
          style={{
            fontFamily: "var(--font-mono, monospace)",
            fontSize: 10,
            color: "var(--text-muted)",
            background: "transparent",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "4px 10px",
            cursor: "pointer",
          }}
        >
          Refresh
        </button>
      </div>

      {/* Explainer */}
      <div
        style={{
          background: "var(--bg-card, #111827)",
          border: "1px solid var(--border, #1e293b)",
          borderRadius: 10,
          padding: "12px 16px",
          marginBottom: 16,
          fontSize: 12,
          color: "var(--text-secondary, #94a3b8)",
          lineHeight: 1.5,
        }}
      >
        📊 Props ranked by combined signal strength: Demon lines, book consensus,
        line movement, AI confidence, and edge detection. Higher score = more
        signals converging on the same prop.
      </div>

      {/* Filters */}
      <div
        style={{
          display: "flex",
          gap: 4,
          marginBottom: 16,
          overflowX: "auto",
          paddingBottom: 4,
        }}
      >
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            style={{
              fontFamily: "var(--font-mono, monospace)",
              fontSize: 11,
              fontWeight: filter === f.key ? 700 : 500,
              color: filter === f.key ? "#000" : "var(--text-secondary, #94a3b8)",
              background: filter === f.key ? "#f59e0b" : "var(--bg-card, #111827)",
              border: "1px solid var(--border, #1e293b)",
              borderRadius: 6,
              padding: "5px 12px",
              cursor: "pointer",
              whiteSpace: "nowrap",
              transition: "all 0.15s ease",
            }}
          >
            {f.label}
            {f.count > 0 && (
              <span
                style={{
                  marginLeft: 4,
                  opacity: 0.7,
                  fontSize: 10,
                }}
              >
                {f.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              style={{
                height: 72,
                borderRadius: 12,
                background: "var(--bg-card, #111827)",
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
            color: "var(--text-secondary)",
          }}
        >
          <div style={{ fontSize: 24, marginBottom: 8 }}>⚠️</div>
          <div style={{ fontSize: 13 }}>{error}</div>
          <button
            onClick={fetchTrending}
            style={{
              marginTop: 12,
              padding: "6px 16px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-card)",
              color: "var(--text-primary)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Retry
          </button>
        </div>
      ) : filteredPicks.length === 0 ? (
        <div
          style={{
            padding: 40,
            textAlign: "center",
            color: "var(--text-secondary)",
          }}
        >
          <div style={{ fontSize: 28, marginBottom: 8 }}>📊</div>
          <div
            style={{
              fontFamily: "var(--font-display, sans-serif)",
              fontWeight: 700,
              fontSize: 15,
            }}
          >
            No trending picks yet
          </div>
          <div style={{ fontSize: 12, marginTop: 4 }}>
            Trending picks refresh every 10 minutes as data accumulates.
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filteredPicks.map((pick, i) => (
            <TrendingCard key={`${pick.player}-${pick.market}-${i}`} pick={pick} rank={i + 1} />
          ))}
        </div>
      )}

      {/* Disclaimer */}
      <div
        style={{
          marginTop: 24,
          padding: 10,
          borderRadius: 6,
          background: "var(--bg-card, #111827)",
          fontSize: 10,
          color: "var(--text-muted, #64748b)",
          textAlign: "center",
          fontFamily: "var(--font-mono, monospace)",
        }}
      >
        ⚠️ Trending score is based on data signals only. Not financial or gambling advice.
      </div>
    </div>
  );
}
