"use client";

interface LoadingOverlayProps {
  visible: boolean;
  message?: string;
}

export default function LoadingOverlay({ 
  visible, 
  message = "Getting crime data..." 
}: LoadingOverlayProps) {
  if (!visible) return null;

  return (
    <div
      style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        zIndex: 999,
        textAlign: "center",
        pointerEvents: "none",
        background: "rgba(0,0,0,0.8)",
        padding: "20px 32px",
        borderRadius: "16px",
        backdropFilter: "blur(12px)",
        border: "1px solid rgba(255,255,255,0.1)",
        boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
      }}
    >
      <div 
        className="font-cabinet font-bold" 
        style={{ 
          fontSize: 20, 
          lineHeight: 1.2, 
          color: "#fff" 
        }}
      >
        {message}
      </div>
    </div>
  );
}
