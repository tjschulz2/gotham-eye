"use client";

import { useMemo, useState, useRef, useEffect } from "react";
import type { CityId } from "@/lib/city-config";
import type { PairsMode } from "@/types/crime";
import type { Stats, TrendStats } from "@/hooks/useDataState";

// Rotating loading text with fade/slide transitions
type RotatingLoadingTextProps = { messages: string[]; intervalMs?: number; className?: string; staticMessage?: string; resetKey?: unknown };
function RotatingLoadingText({ messages, intervalMs = 7000, className, staticMessage, resetKey }: RotatingLoadingTextProps) {
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<'in' | 'out'>('in');
  const outMs = 400;
  const intervalRef = useRef<number | null>(null);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (staticMessage) {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
      setPhase('in');
      return;
    }
    if (!messages || messages.length === 0) return;
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    intervalRef.current = window.setInterval(() => {
      setPhase('out');
      if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
      timeoutRef.current = window.setTimeout(() => {
        setIndex((prev) => (prev + 1) % messages.length);
        setPhase('in');
      }, outMs);
    }, intervalMs);
    return () => {
      if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    };
  }, [messages, intervalMs, staticMessage]);

  useEffect(() => {
    // Reset rotation when a new loading cycle begins
    setIndex(0);
    setPhase('in');
  }, [resetKey]);

  const current = staticMessage ?? (messages[Math.max(0, index) % messages.length] || '');
  const animClass = phase === 'in' ? 'fade-in-up' : 'fade-out-down';

  return (
    <span className={(animClass + (className ? (" " + className) : "")).trim()} style={{ display: 'inline-flex', alignItems: 'baseline' }}>
      <span className="text-shimmer">{current}</span>
      <span className="ellipsis-oscillate" />
    </span>
  );
}

// SVG pie chart with legend and custom hover tooltip
type PieItem = { label: string; count: number; color?: string };
const PieChart = ({ data, size = 140 }: { data: PieItem[]; size?: number }) => {
  const total = Math.max(1, data.reduce((sum, d) => sum + (Number(d.count) || 0), 0));
  const [hover, setHover] = useState<null | { label: string; count: number; percent: number; color: string }>({
    label: "",
    count: 0,
    percent: 0,
    color: "",
  });
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const onMove = (e: React.MouseEvent | React.TouchEvent) => {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    if ('clientX' in e) {
      // Mouse event
      setPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    } else {
      // Touch event
      const touch = e.touches[0];
      if (touch) {
        setPos({ x: touch.clientX - rect.left, y: touch.clientY - rect.top });
      }
    }
  };

  const radius = size / 2;
  const cx = radius;
  const cy = radius;
  // Refined dark-theme palette (Nord-inspired): moody, desaturated, readable on dark
  const palette = ["#5E81AC", "#81A1C1", "#88C0D0", "#8FBCBB", "#A3BE8C", "#D08770", "#EBCB8B", "#B48EAD"]; 
  let start = 0;
  const wedges = data.map((d, i) => {
    const value = Math.max(0, Number(d.count) || 0);
    const angle = (value / total) * Math.PI * 2;
    const end = start + angle;
    const largeArc = angle > Math.PI ? 1 : 0;
    const sx = cx + radius * Math.cos(start - Math.PI / 2);
    const sy = cy + radius * Math.sin(start - Math.PI / 2);
    const ex = cx + radius * Math.cos(end - Math.PI / 2);
    const ey = cy + radius * Math.sin(end - Math.PI / 2);
    const color = d.color || palette[i % palette.length];
    const percent = Math.round((value / total) * 100);
    const path = `M ${cx} ${cy} L ${sx} ${sy} A ${radius} ${radius} 0 ${largeArc} 1 ${ex} ${ey} Z`;
    start = end;
    return (
      <path
        key={d.label + i}
        d={path}
        fill={color}
        stroke="rgba(0,0,0,0.1)"
        strokeWidth={1}
        style={{ cursor: "pointer" }}
        onMouseEnter={() => setHover({ label: d.label, count: value, percent, color })}
        onMouseLeave={() => setHover({ label: "", count: 0, percent: 0, color: "" })}
      />
    );
  });

  return (
    <div style={{ position: "relative", width: size }} onMouseMove={onMove}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {wedges}
      </svg>
      {hover && hover.label ? (
        <div
          style={{
            position: "absolute",
            left: Math.min(size - 10, Math.max(10, pos.x + 10)),
            top: Math.min(size - 10, Math.max(10, pos.y + 10)),
            background: "rgba(17,17,17,0.95)",
            color: "#fff",
            padding: "6px 8px",
            borderRadius: 6,
            pointerEvents: "none",
            fontSize: 12,
            boxShadow: "0 2px 6px rgba(0,0,0,0.4)",
            whiteSpace: "nowrap",
            zIndex: 2147483647,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 10, height: 10, background: hover.color, borderRadius: 2, display: "inline-block" }} />
            <span style={{ fontWeight: 600 }}>{hover.label}</span>
          </div>
          <div style={{ marginTop: 2, opacity: 0.9 }}>{hover.percent}%</div>
        </div>
      ) : null}
      {/* Legend */}
      <ul style={{ listStyle: "none", padding: 0, margin: "6px 0 0 0", fontSize: 12 }}>
        {data.map((d, i) => {
          const value = Math.max(0, Number(d.count) || 0);
          const percent = Math.round((value / total) * 100);
          const color = d.color || palette[i % palette.length];
          return (
            <li key={d.label + i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 4 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <span style={{ width: 10, height: 10, background: color, borderRadius: 2, display: "inline-block" }} />
                <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.label}</span>
              </div>
              <span style={{ opacity: 0.95 }}>{percent}%</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

// Horizontal bar list for top suspect/victim race pairs
const HBarList = ({ data, width = 360 }: { data: { label: string; count: number; tooltip?: string }[]; width?: number }) => {
  const max = Math.max(1, ...data.map((d) => Number(d.count) || 0));
  // Reserve space for label and count; bar takes the remaining width via flex
  const labelW = Math.max(110, Math.min(160, Math.floor(width * 0.44)));
  const countW = 84;

  const [hover, setHover] = useState<null | { label: string; count: number; tooltip?: string }>(null);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const tipRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onMove = (e: React.MouseEvent | React.TouchEvent) => {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    if ('clientX' in e) {
      // Mouse event
      setPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    } else {
      // Touch event
      const touch = e.touches[0];
      if (touch) {
        setPos({ x: touch.clientX - rect.left, y: touch.clientY - rect.top });
      }
    }
  };

  const formatNumber = (value: number | string): string => {
    if (value === null || value === undefined) return "–";
    const num = typeof value === "number" ? value : Number(value);
    if (!isFinite(num)) return String(value);
    return num.toLocaleString();
  };

  return (
    <div ref={containerRef} style={{ width: "100%", overflow: "hidden", position: "relative" }} onMouseMove={onMove}>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {data.map((d, i) => {
          const value = Math.max(0, Number(d.count) || 0);
          const pct = Math.max(0.02, Math.min(1, value / max));
          return (
            <li
              key={d.label + i}
              style={{ display: "flex", alignItems: "center", gap: 8, margin: "6px 0", width: "100%" }}
              onMouseEnter={() => setHover({ label: d.label, count: value, tooltip: d.tooltip })}
              onMouseLeave={() => setHover(null)}
            >
              <div title={d.label} style={{ minWidth: labelW, maxWidth: labelW, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: "#e5e7eb", fontSize: 13 }}>{d.label}</div>
              <div style={{ flex: 1, minWidth: 10, height: 12, background: "transparent", borderRadius: 4, overflow: "hidden" }}>
                <div style={{ width: `${Math.round(pct * 100)}%`, height: "100%", background: "#81A1C1" }} />
              </div>
              <div style={{ marginLeft: 6, width: countW, textAlign: "right", fontSize: 13, color: "#e5e7eb", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "clip", fontVariantNumeric: "tabular-nums" }}>{formatNumber(value)}</div>
            </li>
          );
        })}
      </ul>
      {hover ? (
        <div
          ref={tipRef}
          style={{
            position: "absolute",
            left: (() => {
              const margin = 6;
              const offset = 8;
              const wTip = Math.min(300, Math.max(120, tipRef.current?.offsetWidth || 180));
              const wCont = Math.max(width, containerRef.current?.offsetWidth || width);
              const rightSpace = wCont - pos.x - offset;
              const flip = rightSpace < wTip;
              const proposed = flip ? pos.x - wTip - offset : pos.x + offset;
              return Math.min(wCont - wTip - margin, Math.max(margin, proposed));
            })(),
            top: (() => {
              const tipH = Math.min(160, Math.max(36, tipRef.current?.offsetHeight || 44));
              const hCont = containerRef.current?.offsetHeight || 200;
              const preferred = pos.y - 24;
              const y = preferred < 6 ? pos.y + 12 : preferred;
              return Math.min(hCont - tipH - 6, Math.max(6, y));
            })(),
            background: "rgba(17,17,17,0.95)",
            color: "#fff",
            padding: "6px 8px",
            borderRadius: 6,
            pointerEvents: "none",
            fontSize: 12,
            boxShadow: "0 2px 6px rgba(0,0,0,0.4)",
            whiteSpace: "nowrap",
            zIndex: 2147483647,
          }}
        >
          <div style={{ fontWeight: 600 }}>{hover.tooltip || hover.label}</div>
          <div style={{ opacity: 0.9 }}>{formatNumber(hover.count)}</div>
        </div>
      ) : null}
    </div>
  );
};

// Compact SVG bar chart for monthly counts (linear, ticks, hover tooltip)
type BarDatum = { month: string; count: number; label?: string };
const BarChart = ({ data, width = 360, height = 120, trendLine }: { data: BarDatum[]; width?: number; height?: number; trendLine?: (number | null)[] }) => {
  const padding = { left: 6, right: 6, top: 6, bottom: 22 };
  const w = Math.max(0, width - padding.left - padding.right);
  const h = Math.max(0, height - padding.top - padding.bottom);
  const max = Math.max(
    1,
    ...data.map((d) => Number(d.count) || 0),
    ...((trendLine || []).filter((v) => typeof v === "number" && isFinite(Number(v))) as number[])
  );
  const step = w / Math.max(1, data.length);
  const bw = Math.max(1, Math.floor(step) - 1);

  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const monthLabel = (ym: string | undefined) => {
    if (!ym) return "Unknown";
    const parts = ym.split("-");
    if (parts.length !== 2) return ym;
    
    const y = Number(parts[0]);
    const m = Number(parts[1]);
    
    if (!isFinite(y) || !isFinite(m) || m < 1 || m > 12) return ym;
    return `${monthNames[m - 1]} ${String(y).slice(2)}`;
  };

  const [hover, setHover] = useState<null | { month: string; count: number; label?: string }>(null);
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const tipRef = useRef<HTMLDivElement | null>(null);
  const onMove = (e: React.MouseEvent | React.TouchEvent) => {
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
    if ('clientX' in e) {
      // Mouse event
      setPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    } else {
      // Touch event
      const touch = e.touches[0];
      if (touch) {
        setPos({ x: touch.clientX - rect.left, y: touch.clientY - rect.top });
      }
    }
  };

  const tickEvery = Math.max(1, Math.round(data.length / 6));

  const trendPath = useMemo(() => {
    if (!trendLine || trendLine.length !== data.length) return "";
    let path = "";
    let started = false;
    for (let i = 0; i < data.length; i++) {
      const tv = trendLine[i];
      if (tv === null || tv === undefined || !isFinite(Number(tv))) {
        started = false;
        continue;
      }
      const val = Math.max(0, Number(tv) || 0);
      const x = i * step + bw / 2;
      const y = h - Math.round((val / max) * h);
      path += (started ? "L" : "M") + " " + x + " " + y + " ";
      started = true;
    }
    return path.trim();
  }, [trendLine, data.length, step, bw, h, max]);

  const formatNumber = (value: number | string): string => {
    if (value === null || value === undefined) return "–";
    const num = typeof value === "number" ? value : Number(value);
    if (!isFinite(num)) return String(value);
    return num.toLocaleString();
  };

  return (
    <div style={{ position: "relative", width }} onMouseMove={onMove}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <g transform={`translate(${padding.left},${padding.top})`}>
          {data.map((d, i) => {
            const val = Number(d.count) || 0;
            const x = i * step;
            const barH = Math.round((val / max) * h);
            const y = h - barH;
            return (
              <rect
                key={`bar-${d.month || ''}-${i}`}
                x={x}
                y={y}
                width={bw}
                height={barH}
                fill="#81A1C1"
                shapeRendering="crispEdges"
                onMouseEnter={() => setHover({ month: d.month, count: val, label: d.label })}
                onMouseLeave={() => setHover(null)}
              />
            );
          })}

          {/* baseline */}
          <line x1={0} y1={h + 0.5} x2={w} y2={h + 0.5} stroke="#1f2937" strokeWidth={1} />

          {trendPath ? (
            <path d={trendPath} stroke="#f59e0b" strokeWidth={1.5} fill="none" opacity={0.9} />
          ) : null}

          {/* x ticks */}
          {data.map((d, i) => {
            if (i % tickEvery !== 0 && i !== data.length - 1) return null;
            const x = i * step;
            return (
              <text key={`tick-${i}`} x={x} y={h + 14} fill="#e5e7eb" fontSize={10} textAnchor="start">
                {d.label ? d.label : monthLabel(d.month)}
              </text>
            );
          })}
        </g>
      </svg>
      {hover ? (
        <div
          ref={tipRef}
          style={{
            position: "absolute",
            left: (() => {
              const margin = 6;
              const offset = 8;
              const wTip = Math.min(240, Math.max(80, tipRef.current?.offsetWidth || 140));
              const rightSpace = width - pos.x - offset;
              const flip = rightSpace < wTip;
              const proposed = flip ? pos.x - wTip - offset : pos.x + offset;
              return Math.min(width - wTip - margin, Math.max(margin, proposed));
            })(),
            top: (() => {
              const tipH = Math.min(120, Math.max(32, tipRef.current?.offsetHeight || 42));
              const preferred = pos.y - 28;
              const y = preferred < 6 ? pos.y + 12 : preferred;
              return Math.min(height - tipH - 6, Math.max(6, y));
            })(),
            background: "rgba(17,17,17,0.95)",
            color: "#fff",
            padding: "6px 8px",
            borderRadius: 6,
            pointerEvents: "none",
            fontSize: 12,
            boxShadow: "0 2px 6px rgba(0,0,0,0.4)",
            whiteSpace: "nowrap",
            zIndex: 2147483647,
          }}
        >
          <div style={{ fontWeight: 600 }}>{hover.label ? hover.label : monthLabel(hover.month)}</div>
          <div style={{ opacity: 0.9 }}>{formatNumber(hover.count)}</div>
        </div>
      ) : null}
    </div>
  );
};

interface SidebarProps {
  // UI state
  isMobile: boolean;
  viewportWidth: number;
  
  // Data state
  noDataMode: boolean;
  statsLoading: boolean;
  stats: Stats | null;
  selectedNeighborhood: { name: string; feature: GeoJSON.Feature } | null;
  mapShimmering: boolean;
  rotatorResetKey: string | number;
  
  // City config
  city: CityId;
  cityConfig: {
    displayName: string;
    hasDemographics: boolean;
    dataSources: string[];
  };
  
  // Filter state
  includeUnknown: boolean;
  setIncludeUnknown: (value: boolean) => void;
  
  // Pairs data
  pairsData: Array<{ label: string; count: number }> | null;
  pairsLocalLoading: boolean;
  pairsMode: PairsMode;
  onChangePairsMode: (mode: PairsMode) => void;
  
  // Chart data
  chartSeries: BarDatum[];
  chartKey: string;
  trendStats: TrendStats | null;
}

export default function Sidebar({
  isMobile,
  viewportWidth,
  noDataMode,
  statsLoading,
  stats,
  selectedNeighborhood,
  mapShimmering,
  rotatorResetKey,
  city,
  cityConfig,
  includeUnknown,
  setIncludeUnknown,
  pairsData,
  pairsLocalLoading,
  pairsMode,
  onChangePairsMode,
  chartSeries,
  chartKey,
  trendStats,
}: SidebarProps) {
  // Debug what data the sidebar is receiving
  console.log('[Sidebar] Received stats:', { 
    total: stats?.total, 
    offensesCount: stats?.ofnsTop?.length || 0,
    selectedNeighborhood: selectedNeighborhood?.name,
    statsLoading 
  });

  // Sidebar typography system
  const textStyles = useMemo(() => ({
    header: { fontSize: 16, fontWeight: 600, color: "#e5e7eb" },
    body: { fontSize: 13, color: "#e5e7eb" },
  }), []);

  const formatNumber = (n: number | undefined): string => {
    if (n === undefined || n === null) return "—";
    return n.toLocaleString();
  };

  return (
    <div
      style={{
        width: isMobile ? "100vw" : 400,
        height: isMobile ? "auto" : "100vh",
        background: "#2C2C2C",
        color: "#fff",
        padding: 20,
        overflow: isMobile ? "visible" : "auto",
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}>
        {noDataMode ? (
          <>
            <div className="font-cabinet font-bold" style={{ fontSize: 28, lineHeight: 1.1, textAlign: "left", marginBottom: 12 }}>
              Showing no data
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ background: "#4D4D4D", borderRadius: 8, padding: 20, textAlign: "center" }}>
                <div style={{ fontSize: 44, fontWeight: 800, lineHeight: 1 }}>{formatNumber(undefined)}</div>
                <div style={{ marginTop: 6, fontSize: 16, opacity: 0.9 }}>total incidents</div>
              </div>
              <div style={{ background: "#4D4D4D", borderRadius: 8, padding: 16 }}>
                <div style={{ ...textStyles.header, marginBottom: 8 }}>Incidents</div>
                <div style={{ maxHeight: 220, overflowY: "auto", paddingRight: 6 }}>
                  <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
                    {Array.from({ length: 8 }).map((_, i) => (
                      <li key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0" }}>
                        <span style={{ ...textStyles.body, marginRight: 12, opacity: 0.5 }}>—</span>
                        <span style={{ ...textStyles.body, opacity: 0.5 }}>—</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </>
        ) : statsLoading || !stats ? (
          <>
            {/* Selection label (animated loading text) */}
            <div className="font-cabinet font-bold" style={{ fontSize: 28, lineHeight: 1.1, textAlign: "left", marginBottom: 12 }}>
              <RotatingLoadingText
                messages={["Getting crime data", "Can take ~1 minute", "Almost done"]}
                staticMessage={(mapShimmering && !statsLoading) ? "Loading now" : undefined}
                resetKey={rotatorResetKey}
              />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Total tile skeleton */}
              <div style={{ background: "#4D4D4D", borderRadius: 8, padding: 20, textAlign: "center" }}>
                <div className="skeleton shimmer" style={{ height: 48, width: "80%", margin: "0 auto", borderRadius: 6 }} />
                <div className="skeleton shimmer" style={{ height: 14, width: 140, margin: "8px auto 0", borderRadius: 6 }} />
              </div>

              {/* Incidents skeleton */}
              <div style={{ background: "#4D4D4D", borderRadius: 8, padding: 20 }}>
                <div className="skeleton shimmer" style={{ height: 20, width: 120, borderRadius: 6, marginBottom: 12 }} />
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", gap: 12 }}>
                    <div className="skeleton shimmer" style={{ height: 14, width: "60%", borderRadius: 6 }} />
                    <div className="skeleton shimmer" style={{ height: 14, width: 60, borderRadius: 6 }} />
                  </div>
                ))}
              </div>

              {/* Charts skeleton */}
              <div style={{ display: "flex", gap: 16, flexDirection: viewportWidth < 400 ? "column" : "row" }}>
                <div style={{ background: "#4D4D4D", borderRadius: 8, flex: 1, padding: 12, display: "flex", flexDirection: "column", alignItems: "center" }}>
                  <div className="skeleton shimmer" style={{ height: 18, width: 100, borderRadius: 6, marginBottom: 8 }} />
                  <div className="skeleton shimmer" style={{ height: 140, width: 140, borderRadius: 9999 }} />
                </div>
                <div style={{ background: "#4D4D4D", borderRadius: 8, flex: 1, padding: 12, display: "flex", flexDirection: "column", alignItems: "center" }}>
                  <div className="skeleton shimmer" style={{ height: 18, width: 100, borderRadius: 6, marginBottom: 8 }} />
                  <div className="skeleton shimmer" style={{ height: 140, width: 140, borderRadius: 9999 }} />
                </div>
              </div>

              {/* Monthly trend skeleton */}
              <div style={{ background: "#4D4D4D", borderRadius: 8, padding: 12 }}>
                <div className="skeleton shimmer" style={{ height: 18, width: 140, borderRadius: 6, margin: "0 0 8px 4px" }} />
                <div className="skeleton shimmer" style={{ height: 120, width: "100%", borderRadius: 6 }} />
              </div>
            </div>
          </>
        ) : (
          <>
            {/* Selection label */}
            <div className="font-cabinet font-bold" style={{ fontSize: 28, lineHeight: 1.1, textAlign: "left", marginBottom: 12 }}>
              {selectedNeighborhood?.name || cityConfig.displayName}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Total incidents tile */}
              <div style={{ background: "#4D4D4D", borderRadius: 8, padding: 20, textAlign: "center" }}>
                <div style={{ fontSize: 44, fontWeight: 800, lineHeight: 1 }}>{formatNumber(stats?.total)}</div>
                <div style={{ marginTop: 6, fontSize: 16, opacity: 0.9 }}>total incidents</div>
                {cityConfig.hasDemographics ? (
                  <label style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 10, opacity: 0.5, fontSize: 10, fontStyle: "italic" }}>
                    <input type="checkbox" checked={includeUnknown} onChange={(e) => setIncludeUnknown(e.target.checked)} />
                    Include unknown data
                  </label>
                ) : null}
              </div>

              {/* Incidents list tile */}
              <div style={{ background: "#4D4D4D", borderRadius: 8, padding: 16 }}>
                <div style={{ ...textStyles.header, marginBottom: 8 }}>Incidents</div>
                <div style={{ maxHeight: 220, overflowY: "auto", paddingRight: 6 }}>
                  <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
                    {(stats?.ofnsTop || []).map((o) => (
                      <li
                        key={o.label}
                        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0" }}
                      >
                        <span style={{ ...textStyles.body, marginRight: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{o.label}</span>
                        <span style={{ ...textStyles.body, opacity: 0.95 }}>{formatNumber(o.count)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* Where incidents occur (hide when SF neighborhood is selected) */}
              {(city !== 'sf' || !selectedNeighborhood) && stats?.byPremises && stats.byPremises.length > 0 ? (
                <div style={{ background: "#4D4D4D", borderRadius: 8, padding: 16 }}>
                  <div style={{ ...textStyles.header, margin: "0 0 8px 0" }}>Where incidents occur</div>
                  <div style={{ maxHeight: 220, overflowY: "auto", paddingRight: 6 }}>
                    <HBarList data={(stats.byPremises || []).map((d) => ({ label: d.label, count: d.count }))} width={isMobile ? Math.min(360, viewportWidth - 40) : 360} />
                  </div>
                </div>
              ) : null}

              {/* Two pie graphs (Suspects by race, Suspects by age) */}
              {cityConfig.hasDemographics && ((stats?.byRace?.length || 0) > 0 || (stats?.byAge?.length || 0) > 0) ? (
                <div style={{ display: "flex", gap: 16, flexDirection: isMobile ? "column" : "row" }}>
                  <div style={{ background: "#4D4D4D", borderRadius: 8, flex: 1, padding: 12, display: "flex", flexDirection: "column", alignItems: "center" }}>
                    <div style={{ ...textStyles.header, marginBottom: 8 }}>Suspects by race</div>
                    <PieChart
                      data={(stats?.byRace || []).map((d) => ({ label: d.label, count: d.count }))}
                      size={140}
                    />
                  </div>
                  <div style={{ background: "#4D4D4D", borderRadius: 8, flex: 1, padding: 12, display: "flex", flexDirection: "column", alignItems: "center" }}>
                    <div style={{ ...textStyles.header, marginBottom: 8 }}>Suspects by age</div>
                    <PieChart
                      data={(stats?.byAge || []).map((d) => ({ label: d.label, count: d.count }))}
                      size={140}
                    />
                  </div>
                </div>
              ) : null}

              {/* Suspect / Victim pairs */}
              {cityConfig.hasDemographics && ((pairsData?.length ?? 0) > 0 || pairsLocalLoading) ? (
                <div style={{ background: "#4D4D4D", borderRadius: 8, padding: 16 }}>
                  <div style={{ margin: "0 0 8px 0", display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
                    <div style={{ ...textStyles.header }}>Suspect / Victim pairs</div>
                    <div style={{ display: "flex", gap: 6 }}>
                      {([
                        { key: "race", label: "Race" },
                        { key: "sex", label: "Sex" },
                        { key: "both", label: "Both" },
                      ] as { key: string; label: string }[]).map((opt) => {
                        const active = pairsMode === opt.key;
                        return (
                          <button
                            key={opt.key}
                            onClick={() => onChangePairsMode(opt.key as PairsMode)}
                            style={{ fontSize: 12, padding: "4px 8px", borderRadius: 12, border: "1px solid #666", background: active ? "#3A3A3A" : "#4D4D4D", color: "#fff", cursor: "pointer" }}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  {pairsLocalLoading ? (
                    <div className="skeleton shimmer" style={{ height: 180, width: "100%", borderRadius: 6 }} />
                  ) : (
                    <div style={{ maxHeight: 220, overflowY: "auto", paddingRight: 6 }}>
                      <HBarList data={pairsData ?? []} width={isMobile ? Math.min(360, viewportWidth - 40) : 360} />
                    </div>
                  )}
                </div>
              ) : null}

              {/* Monthly trend */}
              <div style={{ background: "#4D4D4D", borderRadius: 8, padding: 12 }}>
                <div style={{ margin: "0 0 6px 4px" }}>
                  <div style={{ ...textStyles.header }}>Crime growth (for selected area/filters)</div>
                  {trendStats !== null ? (
                    <div style={{ fontSize: 12, marginTop: 2, color: "rgba(255,255,255,0.9)" }}>
                      {(() => {
                        const m = trendStats?.avgMonthlyPct || 0;
                        const dir = m > 0 ? "up" : m < 0 ? "down" : "flat";
                        const color = m > 0 ? "#ef4444" : m < 0 ? "#10b981" : "#e5e7eb";
                        return (
                          <>
                            Crime rates are trending <span style={{ color, fontWeight: 700 }}>{dir}</span>
                          </>
                        );
                      })()}
                    </div>
                  ) : null}
                </div>
                <div style={{ overflow: "hidden" }}>
                  <BarChart key={chartKey} data={chartSeries} width={isMobile ? Math.min(360, viewportWidth - 40) : 360} height={140} trendLine={trendStats?.line.map(item => item.count)} />
                </div>
              </div>
            </div>
          </>
        )}
        {/* Sources footer */}
        <div style={{ marginTop: "auto", paddingTop: 12, borderTop: "1px solid #444", fontSize: 11, color: "#6b7280" }}>
          <span>Sources: </span>
          {cityConfig.dataSources.map((href, idx, arr) => (
            <span key={href}>
              <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: "#9ca3af" }}>{idx + 1}</a>
              {idx < arr.length - 1 ? <span>, </span> : null}
            </span>
          ))}
        </div>
      </div>
    </div>

  );
}
