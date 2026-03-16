import { useState, useEffect, useRef } from "react";

// ============================================================
// Sparkline SVG — renders inline in each prop row
// ============================================================
function Sparkline({ data, width = 80, height = 24, color }) {
  if (!data || data.length < 2) return null;

  const values = data.map((d) => d.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - ((v - min) / range) * (height - 4) - 2;
      return `${x},${y}`;
    })
    .join(" ");

  // Determine color from movement direction
  const moved = values[values.length - 1] - values[0];
  const lineColor = color || (moved > 0 ? "#f59e0b" : moved < 0 ? "#38bdf8" : "#64748b");

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ display: "block" }}
    >
      <polyline
        points={points}
        fill="none"
        stroke={lineColor}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* End dot */}
      <circle
        cx={(values.length - 1) / (values.length - 1) * width}
        cy={height - ((values[values.length - 1] - min) / range) * (height - 4) - 2}
        r="2.5"
        fill={lineColor}
      />
    </svg>
  );
}

// ============================================================
// Movement Badge — shows direction + amount inline
// ============================================================
function MovementBadge({ movement, direction }) {
  if (!movement || movement === 0) return null;

  const isUp = direction === "UP";
  const color = isUp ? "#f59e0b" : "#38bdf8";
  const arrow = isUp ? "▲" : "▼";
  const absMove = Math.abs(movement);

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        fontFamily: "var(--font-mono, 'JetBrains Mono', monospace)",
        fontSize: 10,
        fontWeight: 700,
        color,
        background: `${color}15`,
        border: `1px solid ${color}30`,
        padding: "1px 6px",
        borderRadius: 4,
        whiteSpace: "nowrap",
      }}
    >
      {arrow} {absMove > 0 ? (absMove >= 1 ? absMove.toFixed(1) : absMove.toFixed(1)) : ""}
    </span>
  );
}

// ============================================================
// LineMovementChip — compact inline component for each prop row
// Shows sparkline + movement badge. Click to expand.
// ============================================================
export function LineMovementChip({ player, market, sport, gameId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function fetch_data() {
      try {
        const resp = await fetch(
          `/api/movement/${sport}/${encodeURIComponent(player)}/${encodeURIComponent(market)}`
        );
        if (!resp.ok) return;
        const d = await resp.json();
        if (!cancelled && d.found) setData(d);
      } catch (e) {
        // Silently fail — movement data is optional
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetch_data();
    return () => { cancelled = true; };
  }, [player, market, sport]);

  if (loading || !data || data.consensusTimeline?.length < 2) return null;
  if (data.movement === 0) return null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        marginTop: 4,
      }}
    >
      <Sparkline data={data.consensusTimeline} width={60} height={18} />
      <MovementBadge movement={data.movement} direction={data.movement > 0 ? "UP" : "DOWN"} />
      <span
        style={{
          fontFamily: "var(--font-mono, monospace)",
          fontSize: 9,
          color: "var(--text-muted, #64748b)",
        }}
      >
        {data.openLine} → {data.currentLine}
      </span>
    </div>
  );
}

// ============================================================
// LineMovementDetail — expanded view with full per-book history
// ============================================================
export function LineMovementDetail({ player, market, sport, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchDetail() {
      try {
        const resp = await fetch(
          `/api/movement/${sport}/${encodeURIComponent(player)}/${encodeURIComponent(market)}`
        );
        const d = await resp.json();
        if (d.found) setData(d);
      } catch (e) {
        console.error("Movement detail fetch failed:", e);
      } finally {
        setLoading(false);
      }
    }
    fetchDetail();
  }, [player, market, sport]);

  if (loading) {
    return (
      <div style={{ padding: 20, textAlign: "center", color: "var(--text-muted)" }}>
        Loading movement data...
      </div>
    );
  }

  if (!data) {
    return (
      <div style={{ padding: 20, textAlign: "center", color: "var(--text-muted)" }}>
        No movement data available yet. Lines are tracked every 15 minutes.
      </div>
    );
  }

  const timeline = data.consensusTimeline || [];
  const bookTimelines = data.bookTimelines || {};

  return (
    <div
      style={{
        background: "var(--bg-card, #111827)",
        border: "1px solid var(--border, #1e293b)",
        borderRadius: 12,
        padding: 20,
        marginTop: 8,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <div>
          <div
            style={{
              fontFamily: "var(--font-display, 'Outfit', sans-serif)",
              fontWeight: 700,
              fontSize: 15,
            }}
          >
            {player} — {data.marketLabel || market}
          </div>
          <div
            style={{
              fontFamily: "var(--font-mono, monospace)",
              fontSize: 11,
              color: "var(--text-secondary, #94a3b8)",
              marginTop: 2,
            }}
          >
            {data.game} · {data.snapshotCount} snapshots
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <MovementBadge movement={data.movement} direction={data.movement > 0 ? "UP" : "DOWN"} />
          {onClose && (
            <button
              onClick={onClose}
              style={{
                background: "transparent",
                border: "1px solid var(--border, #1e293b)",
                borderRadius: 6,
                color: "var(--text-muted)",
                cursor: "pointer",
                padding: "4px 8px",
                fontSize: 12,
              }}
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Consensus Line Chart */}
      <div style={{ marginBottom: 16 }}>
        <div
          style={{
            fontFamily: "var(--font-mono, monospace)",
            fontSize: 10,
            color: "var(--text-muted, #64748b)",
            letterSpacing: 1,
            marginBottom: 6,
          }}
        >
          CONSENSUS LINE
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
          }}
        >
          <div style={{ flex: 1 }}>
            <Sparkline data={timeline} width={300} height={40} />
          </div>
          <div style={{ textAlign: "right" }}>
            <div
              style={{
                fontFamily: "var(--font-mono, monospace)",
                fontSize: 9,
                color: "var(--text-muted)",
              }}
            >
              OPEN
            </div>
            <div
              style={{
                fontFamily: "var(--font-mono, monospace)",
                fontSize: 16,
                fontWeight: 700,
              }}
            >
              {data.openLine}
            </div>
            <div
              style={{
                fontFamily: "var(--font-mono, monospace)",
                fontSize: 9,
                color: "var(--text-muted)",
                marginTop: 4,
              }}
            >
              CURRENT
            </div>
            <div
              style={{
                fontFamily: "var(--font-mono, monospace)",
                fontSize: 16,
                fontWeight: 700,
                color:
                  data.movement > 0
                    ? "#f59e0b"
                    : data.movement < 0
                    ? "#38bdf8"
                    : "inherit",
              }}
            >
              {data.currentLine}
            </div>
          </div>
        </div>
      </div>

      {/* Per-Book Movement */}
      {Object.keys(bookTimelines).length > 0 && (
        <div>
          <div
            style={{
              fontFamily: "var(--font-mono, monospace)",
              fontSize: 10,
              color: "var(--text-muted, #64748b)",
              letterSpacing: 1,
              marginBottom: 8,
            }}
          >
            PER-BOOK LINES
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {Object.entries(bookTimelines).map(([bookName, entries]) => {
              const first = entries[0];
              const last = entries[entries.length - 1];
              const moved = last.point - first.point;
              return (
                <div
                  key={bookName}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "6px 10px",
                    borderRadius: 6,
                    background: "var(--bg-elevated, #1a2236)",
                    fontSize: 12,
                  }}
                >
                  <span
                    style={{
                      fontFamily: "var(--font-body, 'DM Sans', sans-serif)",
                      fontWeight: 600,
                      color: "var(--text-secondary, #94a3b8)",
                      minWidth: 100,
                    }}
                  >
                    {bookName}
                  </span>
                  <div
                    style={{
                      flex: 1,
                      display: "flex",
                      justifyContent: "center",
                    }}
                  >
                    <Sparkline
                      data={entries.map((e) => ({ t: e.t, v: e.point }))}
                      width={80}
                      height={16}
                    />
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "var(--font-mono, monospace)",
                        fontSize: 11,
                        color: "var(--text-muted)",
                      }}
                    >
                      {first.point}
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--font-mono, monospace)",
                        fontSize: 9,
                        color: "var(--text-muted)",
                      }}
                    >
                      →
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--font-mono, monospace)",
                        fontSize: 11,
                        fontWeight: 700,
                        color:
                          moved !== 0
                            ? moved > 0
                              ? "#f59e0b"
                              : "#38bdf8"
                            : "var(--text-primary)",
                      }}
                    >
                      {last.point}
                    </span>
                    {moved !== 0 && (
                      <span
                        style={{
                          fontFamily: "var(--font-mono, monospace)",
                          fontSize: 9,
                          color: moved > 0 ? "#f59e0b" : "#38bdf8",
                        }}
                      >
                        ({moved > 0 ? "+" : ""}{moved.toFixed(1)})
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Timestamps */}
      <div
        style={{
          marginTop: 12,
          fontFamily: "var(--font-mono, monospace)",
          fontSize: 9,
          color: "var(--text-muted, #64748b)",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>First tracked: {new Date(data.firstSeen).toLocaleString()}</span>
        <span>Last update: {new Date(data.lastUpdated).toLocaleString()}</span>
      </div>
    </div>
  );
}

// ============================================================
// BiggestMovesPanel — shows the most significant line moves
// Can be added as a section above the props list
// ============================================================
export function BiggestMovesPanel({ sport }) {
  const [moves, setMoves] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchMoves() {
      try {
        const resp = await fetch(`/api/movement/${sport}/biggest?limit=5`);
        if (!resp.ok) return;
        const data = await resp.json();
        setMoves(data.biggestMoves || []);
      } catch (e) {
        // Silent fail
      } finally {
        setLoading(false);
      }
    }
    fetchMoves();
    // Refresh every 5 minutes
    const interval = setInterval(fetchMoves, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [sport]);

  if (loading || moves.length === 0) return null;

  return (
    <div
      style={{
        background: "var(--bg-card, #111827)",
        border: "1px solid var(--border, #1e293b)",
        borderRadius: 12,
        padding: 16,
        marginBottom: 16,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 12,
        }}
      >
        <span style={{ fontSize: 16 }}>📈</span>
        <span
          style={{
            fontFamily: "var(--font-display, 'Outfit', sans-serif)",
            fontWeight: 700,
            fontSize: 14,
          }}
        >
          Biggest Line Moves
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono, monospace)",
            fontSize: 10,
            color: "var(--text-muted)",
            background: "var(--bg-elevated, #1a2236)",
            padding: "2px 8px",
            borderRadius: 4,
          }}
        >
          Last 48h
        </span>
      </div>

      <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 4 }}>
        {moves.map((move, i) => (
          <div
            key={i}
            style={{
              background: "var(--bg-elevated, #1a2236)",
              border: "1px solid var(--border, #1e293b)",
              borderRadius: 10,
              padding: "12px 14px",
              minWidth: 180,
              flexShrink: 0,
            }}
          >
            <div
              style={{
                fontFamily: "var(--font-display, sans-serif)",
                fontWeight: 700,
                fontSize: 13,
                marginBottom: 2,
              }}
            >
              {move.player}
            </div>
            <div
              style={{
                fontFamily: "var(--font-mono, monospace)",
                fontSize: 10,
                color: "var(--text-muted)",
                marginBottom: 8,
              }}
            >
              {move.market}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <Sparkline data={move.sparkline} width={70} height={20} />
              <div style={{ textAlign: "right" }}>
                <div
                  style={{
                    fontFamily: "var(--font-mono, monospace)",
                    fontSize: 13,
                    fontWeight: 700,
                    color: move.direction === "UP" ? "#f59e0b" : "#38bdf8",
                  }}
                >
                  {move.direction === "UP" ? "▲" : "▼"} {Math.abs(move.movement).toFixed(1)}
                </div>
                <div
                  style={{
                    fontFamily: "var(--font-mono, monospace)",
                    fontSize: 9,
                    color: "var(--text-muted)",
                  }}
                >
                  {move.openLine} → {move.currentLine}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default { LineMovementChip, LineMovementDetail, BiggestMovesPanel, Sparkline, MovementBadge };
