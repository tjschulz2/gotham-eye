"use client";

interface LegendProps {
  isMobile: boolean;
  viewportWidth: number;
}

export default function Legend({ isMobile, viewportWidth }: LegendProps) {
  return (
    <div
      style={{
        position: "absolute",
        bottom: 16,
        left: 12,
        background: "rgba(18,18,18,0.9)",
        color: "#fff",
        padding: 10,
        borderRadius: 8,
        fontSize: 12,
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        width: isMobile ? Math.min(240, viewportWidth - 24) : 200,
      }}
    >
      <div style={{ marginBottom: 6 }}>Crime density (incidents)</div>
      <div style={{ width: "100%" }}>
        <div 
          style={{ 
            width: "100%", 
            height: 10, 
            background: "linear-gradient(90deg, #0066FF, #00BFFF, #00FFCC, #7CFF66, #D9FF3D, #FF9900, #FF3D00)", 
            borderRadius: 2 
          }} 
        />
      </div>
    </div>
  );
}
