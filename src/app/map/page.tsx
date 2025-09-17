"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Map as MapLibreMap, MapLayerMouseEvent, MapMouseEvent, MapGeoJSONFeature, GeoJSONSource } from "maplibre-gl";
import type { FeatureCollection as GJFeatureCollection, Geometry, GeoJsonProperties } from "geojson";
import { isViolentOfnsDesc } from "@/lib/categories";

type CrimeType = { label: string; count: number };

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

function fourYearsAgoISO(): string {
  const now = new Date();
  const d = new Date(now.getFullYear() - 4, now.getMonth(), now.getDate());
  return d.toISOString();
}

const asErrorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const isGeoJSONSource = (src: unknown): src is GeoJSONSource => {
  return !!src && (src as { type?: unknown; setData?: unknown }).type === 'geojson' && typeof (src as { setData?: unknown }).setData === 'function';
};

// Add neighborhood boundaries and interactivity
type NeighborhoodFilters = { startISO?: string; endISO?: string; vclass?: string[]; ofns?: string[]; includeUnknown?: boolean };
async function addNeighborhoodBoundaries(
  map: MapLibreMap,
  city: "nyc" | "sf",
  onSelect?: (name: string | null, feature: MapGeoJSONFeature | null) => void,
  filters?: NeighborhoodFilters,
  onShimmerChange?: (loading: boolean) => void
) {
  if (!map || typeof map.getStyle !== 'function') {
    console.warn('[map] addNeighborhoodBoundaries called before map is ready');
    return;
  }
  // Ensure style is fully loaded before touching sources/layers to avoid MapLibre style errors
  try {
    const styleLoaded = typeof map.isStyleLoaded === 'function' ? map.isStyleLoaded() : false;
    if (!styleLoaded) {
      console.warn('[map] style not loaded; deferring addNeighborhoodBoundaries until style.load');
      if (typeof map.once === 'function') {
        map.once('style.load', () => {
          try { addNeighborhoodBoundaries(map, city, onSelect, filters, onShimmerChange); } catch {}
        });
      }
      return;
    }
  } catch {}
  console.log(`[map] 🚀 Starting addNeighborhoodBoundaries for ${city}`);
  try { console.log(`[map] 🔍 Map loaded?`, map.isStyleLoaded ? map.isStyleLoaded() : 'unknown'); } catch {}
  
  const neighborhoodSourceId = "neighborhoods";
  const neighborhoodLayerId = "neighborhood-boundaries";
  const neighborhoodLabelsId = "neighborhood-labels";
  const neighborhoodLabelsSelectedId = `${neighborhoodLabelsId}-selected`;
  const neighborhoodOutlineId = `${neighborhoodLayerId}-outline`;
  const neighborhoodOutlineSourceId = `${neighborhoodLayerId}-outline-src`;
  const neighborhoodSelectedId = `${neighborhoodLayerId}-selected`;
  const neighborhoodLabelsSourceId = `${neighborhoodLabelsId}-src`;

  type MapAugments = {
    __neighborhoodShimmerTimer?: number;
    __neighborhoodLayerClickHandler?: (e: MapLayerMouseEvent) => void;
    __neighborhoodClearHandler?: (e: MapMouseEvent) => void;
  };
  const aug = map as MapLibreMap & MapAugments;

  // Remove existing neighborhood layers if they exist (including shimmer layers) in safe order
  try {
    console.log(`[map] 🧹 Cleaning up existing layers...`);
    if (map.getLayer(neighborhoodLabelsId)) {
      map.removeLayer(neighborhoodLabelsId);
      console.log(`[map] ✅ Removed existing labels layer`);
    }
    try { if (map.getLayer(neighborhoodLabelsSelectedId)) { map.removeLayer(neighborhoodLabelsSelectedId); console.log(`[map] ✅ Removed existing selected labels layer`); } } catch {}
    // Remove shimmer layers first to free the source
    try { if (aug.__neighborhoodShimmerTimer) { clearInterval(aug.__neighborhoodShimmerTimer); aug.__neighborhoodShimmerTimer = undefined; } } catch {}
    for (let k = 0; k < 6; k++) { // attempt a few indices defensively
      const sid = `${neighborhoodLayerId}-shimmer-${k}`;
      try { if (map.getLayer(sid)) { map.removeLayer(sid); console.log(`[map] ✅ Removed shimmer layer ${sid}`); } } catch {}
    }
    if (map.getLayer(neighborhoodLayerId)) {
      map.removeLayer(neighborhoodLayerId);
      console.log(`[map] ✅ Removed existing boundaries layer`);
    }
    if (map.getLayer(neighborhoodOutlineId)) {
      map.removeLayer(neighborhoodOutlineId);
      console.log(`[map] ✅ Removed existing boundaries outline layer`);
    }
    if (map.getSource(neighborhoodSourceId)) {
      map.removeSource(neighborhoodSourceId);
      console.log(`[map] ✅ Removed existing source`);
    }
  } catch (error) {
    console.log(`[map] ⚠️ Error during cleanup (this is normal):`, error);
  }

  // NYC: Load Neighborhood Tabulation Areas (NTA) from local static file in /public (no API)
  if (city === "nyc") {
    try {
      console.log(`[map] 📦 Loading NYC NTA GeoJSON from /public…`);
      const resLocal = await fetch(`/nyc_nta_2020.geojson`, { cache: "force-cache" });
      if (!resLocal.ok) throw new Error(`geojson_load_${resLocal.status}`);
      const data = await resLocal.json() as GJFeatureCollection<Geometry, GeoJsonProperties>;

      const guessLabelField = (props: Record<string, unknown> | null | undefined): string => {
        if (!props || typeof props !== "object") return "name";
        const keys = Object.keys(props).map((k) => k.toLowerCase());
        const candidates = ["ntaname", "nta_name", "name", "neighborhood", "label", "ntaname2020", "ntaname_2020"];
        for (const c of candidates) {
          const hit = Object.keys(props).find((k) => k.toLowerCase() === c);
          if (hit) return hit;
        }
        return "name";
      };

      const firstProps = (data.features && data.features[0] && data.features[0].properties) || {};
      const labelField = guessLabelField(firstProps);
      console.log(`[map] ✅ NYC NTA loaded from local file (label field: ${labelField})`);
      let currentSelectedName: string | null = null;

      // Inject wave band index for shimmer ('__band' = i%3)
      const withBandsNYC = {
        ...(data as any),
        features: ((data as any)?.features || []).map((f: any, i: number) => ({
          ...(f || {}),
          properties: { ...(f?.properties || {}), __band: i % 3 },
        })),
      } as GJFeatureCollection<Geometry, GeoJsonProperties>;
      const existingSrcNYC = map.getSource(neighborhoodSourceId);
      if (isGeoJSONSource(existingSrcNYC)) {
        try { existingSrcNYC.setData(withBandsNYC); } catch {}
      } else {
        try { if (existingSrcNYC) map.removeSource(neighborhoodSourceId); } catch {}
        map.addSource(neighborhoodSourceId, { type: "geojson", data: withBandsNYC });
      }
      try { console.log(`[map] neighborhoods source ready`, { features: Array.isArray((data as any)?.features) ? (data as any).features.length : -1 }); } catch {}

      // Fill layer with translucent interior and contrasting outline; color by crime density
      try { if (map.getLayer(neighborhoodLayerId)) map.removeLayer(neighborhoodLayerId); } catch {}
      try {
        map.addLayer({
          id: neighborhoodLayerId,
          type: "fill",
          source: neighborhoodSourceId,
          layout: { visibility: "visible" },
          paint: {
            // While loading density, neighborhoods are grey; we'll switch to ramp after fetch
            "fill-color": "#6b7280",
            "fill-opacity": 0.16,
            "fill-outline-color": "#A3A3A3",
          }
        });
      } catch {}

      // Build a line feature collection from polygon rings for robust outlines (copy label property for selection filtering)
      try {
        const toLines = (fc: any) => {
          const out: any = { type: "FeatureCollection", features: [] as any[] };
          const pushRing = (ring: any, props: any) => {
            if (Array.isArray(ring) && ring.length >= 2 && typeof ring[0][0] === 'number') {
              const p: any = {}; p[labelField] = String(props?.[labelField] || "");
              out.features.push({ type: "Feature", properties: p, geometry: { type: "LineString", coordinates: ring } });
            }
          };
          (fc?.features || []).forEach((f: any) => {
            const g = f?.geometry;
            if (!g) return;
            if (g.type === 'Polygon') {
              (g.coordinates || []).forEach((ring: any) => pushRing(ring, f?.properties || {}));
            } else if (g.type === 'MultiPolygon') {
              (g.coordinates || []).forEach((poly: any) => (poly || []).forEach((ring: any) => pushRing(ring, f?.properties || {})));
            } else if (g.type === 'LineString' || g.type === 'MultiLineString') {
              const p: any = {}; p[labelField] = String(f?.properties?.[labelField] || "");
              out.features.push({ type: "Feature", properties: p, geometry: g });
            }
          });
          return out;
        };
        const lineFc = toLines(data);
        try { if (map.getLayer(neighborhoodOutlineId)) map.removeLayer(neighborhoodOutlineId); } catch {}
        const existingOutlineSrc = map.getSource(neighborhoodOutlineSourceId);
        if (isGeoJSONSource(existingOutlineSrc)) {
          try { existingOutlineSrc.setData(lineFc); } catch {}
        } else {
          try { if (existingOutlineSrc) map.removeSource(neighborhoodOutlineSourceId); } catch {}
          map.addSource(neighborhoodOutlineSourceId, { type: 'geojson', data: lineFc });
        }
        map.addLayer({ id: neighborhoodOutlineId, type: 'line', source: neighborhoodOutlineSourceId, paint: { 'line-color': '#FFFF00', 'line-width': 2.5, 'line-opacity': 0.05 } });
        try { console.log('[map] outlines line features:', lineFc.features.length); } catch {}
      } catch {}

      // Ensure boundaries render above any subsequent layers (labels moved after creation below)
      try { map.moveLayer(neighborhoodOutlineId); } catch {}
      try { map.moveLayer(neighborhoodLayerId); console.log('[map] moved neighborhood layers to top'); } catch (e) { try { console.log('[map] moveLayer failed (neighborhoods):', asErrorMessage(e)); } catch {} }

      // If nothing renders, inspect and optionally fit to bounds once
      try {
        const logRendered = () => {
          try {
            const targetLayer = map.getLayer(neighborhoodOutlineId) ? neighborhoodOutlineId : (map.getLayer(neighborhoodLayerId) ? neighborhoodLayerId : undefined);
            if (!targetLayer) { console.log('[map] neighborhoods rendered check: no layer present'); return; }
            const rendered = map.queryRenderedFeatures(undefined, { layers: [targetLayer] }) || [];
            console.log('[map] neighborhoods rendered features (viewport):', rendered.length);
            if (rendered.length === 0 && data && Array.isArray((data as any).features) && (data as any).features.length > 0) {
              let minLon =  180, minLat =  90, maxLon = -180, maxLat = -90;
              for (const f of (data as any).features) {
                try {
                  const geom = f?.geometry;
                  if (!geom) continue;
                  const push = (lng: number, lat: number) => { if (Number.isFinite(lng) && Number.isFinite(lat)) { if (lng < minLon) minLon = lng; if (lat < minLat) minLat = lat; if (lng > maxLon) maxLon = lng; if (lat > maxLat) maxLat = lat; } };
                  const walk = (coords: any) => { if (!coords) return; if (typeof coords[0] === 'number') { push(coords[0], coords[1]); } else { for (const c of coords) walk(c); } };
                  walk(geom.coordinates);
                } catch {}
              }
              if (minLon < maxLon && minLat < maxLat) {
                console.log('[map] fitting to neighborhood bounds', { minLon, minLat, maxLon, maxLat });
                try { map.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 24, duration: 600 }); } catch {}
              }
            }
          } catch {}
        };
        if (typeof map.once === 'function') map.once('idle', logRendered); else setTimeout(logRendered, 0);
      } catch {}

      // Remove any temporary debug crosshair layer/source if present
      try { if (map.getLayer('dbg-cross-line')) map.removeLayer('dbg-cross-line'); } catch {}
      try { if (map.getSource('dbg-cross')) map.removeSource('dbg-cross'); } catch {}

      // Labels: place point labels at polygon centroids for better placement and legibility
      const makeCentroids = (fc: any) => {
        const out: any = { type: "FeatureCollection", features: [] as any[] };
        const centroidOfRing = (ring: any[]): [number, number] => {
          if (!Array.isArray(ring) || ring.length < 3) return [0, 0];
          let a = 0, cx = 0, cy = 0;
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [x1, y1] = ring[j];
            const [x2, y2] = ring[i];
            const f = (x1 * y2 - x2 * y1);
            a += f;
            cx += (x1 + x2) * f;
            cy += (y1 + y2) * f;
          }
          if (a === 0) {
            // fallback to simple average
            let sx = 0, sy = 0; for (const [x, y] of ring) { sx += x; sy += y; }
            return [sx / ring.length, sy / ring.length];
          }
          a *= 0.5; cx /= (6 * a); cy /= (6 * a);
          return [cx, cy];
        };
        const choosePoly = (coords: any[]) => {
          // pick largest area polygon ring set
          let best = { area: -Infinity, ring: null as any };
          for (const poly of coords) {
            const ring = poly && poly[0]; if (!ring) continue;
            // approximate area via shoelace absolute value
            let A = 0; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [x1, y1] = ring[j]; const [x2, y2] = ring[i]; A += (x1 * y2 - x2 * y1); }
            const area = Math.abs(A) * 0.5; if (area > best.area) best = { area, ring };
          }
          return best.ring;
        };
        for (const f of (fc?.features || [])) {
          const g = f?.geometry; if (!g) continue;
          let c: [number, number] | null = null;
          if (g.type === 'Polygon') { c = centroidOfRing(g.coordinates?.[0] || []); }
          else if (g.type === 'MultiPolygon') { const ring = choosePoly(g.coordinates || []); if (ring) c = centroidOfRing(ring); }
          if (c) out.features.push({ type: 'Feature', properties: { label: String((f.properties || {})[labelField] || '') }, geometry: { type: 'Point', coordinates: c } });
        }
        return out;
      };
      try {
        // Load density counts and attach to base polygons
        const params = new URLSearchParams();
        params.set('city', 'nyc');
        if (filters?.startISO) params.set('start', filters.startISO);
        if (filters?.endISO) params.set('end', filters.endISO);
        if (filters?.vclass && filters.vclass.length > 0) params.set('vclass', filters.vclass.join(','));
        if (filters?.ofns && filters.ofns.length > 0) params.set('ofns', filters.ofns.join(','));
        if (typeof filters?.includeUnknown === 'boolean') params.set('includeUnknown', filters.includeUnknown ? '1' : '0');
        let base = data;
        const shouldFetchDensity = (Array.isArray(filters?.vclass) && filters!.vclass!.length > 0) || (Array.isArray(filters?.ofns) && filters!.ofns!.length > 0);
        if (shouldFetchDensity) {
          // Progressive wave shimmer while fetching
          try { onShimmerChange && onShimmerChange(true); } catch {}
          try {
            try { map.setPaintProperty(neighborhoodLayerId, 'fill-color', '#6b7280'); } catch {}
            try { map.setPaintProperty(neighborhoodLayerId, 'fill-opacity', 0.16); } catch {}
            const mkShimmerId = (k: number) => `${neighborhoodLayerId}-shimmer-${k}`;
            for (let k = 0; k < 3; k++) { try { if (map.getLayer(mkShimmerId(k))) map.removeLayer(mkShimmerId(k)); } catch {} }
            for (let k = 0; k < 3; k++) {
              try { map.addLayer({ id: mkShimmerId(k), type: 'fill', source: neighborhoodSourceId, filter: ['==', ['get', '__band'], k], paint: { 'fill-color': '#9ca3af', 'fill-opacity': 0.0, 'fill-outline-color': '#A3A3A3' } }); } catch {}
            }
            let t = 0; const baseOp = 0.12, amp = 0.08;
            try { if ((map as any).__neighborhoodShimmerTimer) { clearInterval((map as any).__neighborhoodShimmerTimer); } } catch {}
            ;(map as any).__neighborhoodShimmerTimer = setInterval(() => {
              try {
                for (let k = 0; k < 3; k++) {
                  const id = mkShimmerId(k);
                  const phase = (t + k * 2.094);
                  const op = Math.max(0.06, Math.min(0.28, baseOp + Math.sin(phase) * amp));
                  try { map.setPaintProperty(id, 'fill-opacity', op); } catch {}
                }
                t += 0.22;
              } catch {}
            }, 120);
          } catch {}
          try {
            const resD = await fetch(`/api/neighborhoods/density?${params.toString()}`, { cache: 'no-store' });
            if (resD.ok) base = await resD.json();
          } catch {}
        } else {
          // No data mode: ensure plain grey neighborhoods and no shimmer
          try { onShimmerChange && onShimmerChange(false); } catch {}
          try { if (aug.__neighborhoodShimmerTimer) { clearInterval(aug.__neighborhoodShimmerTimer); aug.__neighborhoodShimmerTimer = undefined; } } catch {}
          try { for (let k = 0; k < 3; k++) { const id = `${neighborhoodLayerId}-shimmer-${k}`; if (map.getLayer(id)) map.removeLayer(id); } } catch {}
          try { map.setPaintProperty(neighborhoodLayerId, 'fill-color', '#6b7280'); } catch {}
          try { map.setPaintProperty(neighborhoodLayerId, 'fill-opacity', 0.16); } catch {}
          try { map.setPaintProperty(neighborhoodLayerId, 'fill-outline-color', '#A3A3A3'); } catch {}
        }

        const labelFc = makeCentroids(base);
        const existingLblSrc = map.getSource(neighborhoodLabelsSourceId);
        if (isGeoJSONSource(existingLblSrc)) {
          try { existingLblSrc.setData(labelFc); } catch {}
        } else {
          try { if (existingLblSrc) map.removeSource(neighborhoodLabelsSourceId); } catch {}
          map.addSource(neighborhoodLabelsSourceId, { type: 'geojson', data: labelFc });
        }
        // Update fill source data to the enriched version so counts are in properties
        try {
          const src = map.getSource(neighborhoodSourceId);
          if (isGeoJSONSource(src)) src.setData(base);
        } catch {}
        // Stop shimmer and switch to percentile ramp only if we fetched density
        if (shouldFetchDensity) {
          try { if (aug.__neighborhoodShimmerTimer) { clearInterval(aug.__neighborhoodShimmerTimer); aug.__neighborhoodShimmerTimer = undefined; } } catch {}
          try { for (let k = 0; k < 3; k++) { const id = `${neighborhoodLayerId}-shimmer-${k}`; if (map.getLayer(id)) map.removeLayer(id); } } catch {}
          try { onShimmerChange && onShimmerChange(false); } catch {}
          try {
            // Percentile-based continuous gradient: evenly distributed across neighborhoods
            map.setPaintProperty(neighborhoodLayerId, 'fill-color', [
              'interpolate', ['linear'], ['coalesce', ['get', 'p'], 0],
              0.00, '#003A99',   // darkest blue
              0.10, '#2AA7FF',
              0.30, '#00FFCC',
              0.50, '#7CFF66',
              0.70, '#D9FF3D',
              0.85, '#FF9900',
              0.95, '#FF3D00',
              1.00, '#B30000'    // darkest red
            ]);
            map.setPaintProperty(neighborhoodLayerId, 'fill-opacity', 0.18);
            map.setPaintProperty(neighborhoodLayerId, 'fill-outline-color', '#FFFF00');
          } catch {}
        }
      } catch {}

      if (!map.getLayer(neighborhoodLabelsId)) {
        try {
          map.addLayer({
            id: neighborhoodLabelsId,
            type: "symbol",
            source: neighborhoodLabelsSourceId,
            minzoom: 10,
            layout: {
              "text-field": ["get", "label"],
              "text-size": [
                "interpolate", ["linear"], ["zoom"],
                10, 10,
                12, 11,
                14, 12,
                16, 14
              ],
              "symbol-placement": "point",
              "text-transform": "uppercase",
              "text-padding": 2,
              "text-max-width": 12,
              "text-justify": "center",
              "text-anchor": "center",
              "text-allow-overlap": true,
              "text-ignore-placement": true,
              "text-optional": true,
            },
            paint: {
              // Base labels: lower-opacity white, keep halo the same
              "text-color": "#FFFFFF",
              "text-halo-color": "#0b1220",
              "text-halo-width": 1.2,
              "text-opacity": 0.6,
            }
          });
          try { map.moveLayer(neighborhoodLabelsId); console.log('[map] moved neighborhood labels to top'); } catch (e) { try { console.log('[map] moveLayer failed (labels):', asErrorMessage(e)); } catch {} }
        } catch {}
      }

      // Selected neighborhood label overlay: bright white, same halo
      try { if (!map.getLayer(neighborhoodLabelsSelectedId)) {
        map.addLayer({
          id: neighborhoodLabelsSelectedId,
          type: "symbol",
          source: neighborhoodLabelsSourceId,
          minzoom: 10,
          layout: {
            "text-field": ["get", "label"],
            "text-size": [
              "interpolate", ["linear"], ["zoom"],
              10, 10,
              12, 11,
              14, 12,
              16, 14
            ],
            "symbol-placement": "point",
            "text-transform": "uppercase",
            "text-padding": 2,
            "text-max-width": 12,
            "text-justify": "center",
            "text-anchor": "center",
            "text-allow-overlap": true,
            "text-ignore-placement": true,
            "text-optional": true,
          },
          paint: {
            "text-color": "#FFFFFF",
            "text-halo-color": "#0b1220",
            "text-halo-width": 1.2,
            "text-opacity": 1.0,
          },
          // Use the 'label' property present in centroids source
          filter: ["==", ["get", "label"], "__none__"],
        });
        try { map.moveLayer(neighborhoodLabelsSelectedId); } catch {}
      } } catch {}

      // Selection highlight layer (updated via filter on click)
      try { if (!map.getLayer(neighborhoodSelectedId)) {
        map.addLayer({
          id: neighborhoodSelectedId,
          type: "line",
          source: neighborhoodOutlineSourceId,
          layout: { visibility: "visible" },
          paint: { "line-color": "#FFFFFF", "line-width": 4, "line-opacity": 0.9 },
          filter: ["==", ["get", labelField], "__none__"],
        });
      } } catch {}

      // Interactivity: click to select neighborhood (toggle if same), click outside to clear
      try {
        map.on("mouseenter", neighborhoodLayerId, () => { try { map.getCanvas().style.cursor = "pointer"; } catch {} });
        map.on("mouseleave", neighborhoodLayerId, () => { try { map.getCanvas().style.cursor = ""; } catch {} });

        // Remove any prior handlers to avoid duplicates across reloads
        const prevLayerHandler = (map as any).__neighborhoodLayerClickHandler;
        if (prevLayerHandler) { try { map.off("click", neighborhoodLayerId, prevLayerHandler); } catch {} }

        const layerClickHandler = (e: any) => {
          const f = e?.features?.[0];
          if (!f) return;
          const name = String((f.properties || {})[labelField] || "");

          // Toggle off if clicking the same neighborhood
          if (currentSelectedName === name) {
            currentSelectedName = null;
            try { map.setFilter(neighborhoodSelectedId, ["==", ["get", labelField], "__none__"]); } catch {}
            try { map.setFilter(neighborhoodLabelsSelectedId, ["==", ["get", "label"], "__none__"]); } catch {}
            try { onSelect && onSelect(null, null); } catch {}
            return;
          }

          currentSelectedName = name;
          try { map.setFilter(neighborhoodSelectedId, ["==", ["get", labelField], name]); } catch {}
          try {
            map.setFilter(neighborhoodLabelsSelectedId, ["==", ["get", "label"], name]);
            // Ensure selected label layer renders above the base labels
            try { map.moveLayer(neighborhoodLabelsSelectedId); } catch {}
          } catch {}
          // No tooltip popup on neighborhood selection
          try { onSelect && onSelect(name, f); } catch {}
        };
        (map as any).__neighborhoodLayerClickHandler = layerClickHandler;
        map.on("click", neighborhoodLayerId, layerClickHandler);

        // Global map click: clear selection when clicking outside any neighborhood polygon
        const prevClearHandler = (map as any).__neighborhoodClearHandler;
        if (prevClearHandler) { try { map.off("click", prevClearHandler); } catch {} }
        const clearHandler = (e: any) => {
          try {
            const hits = map.queryRenderedFeatures(e.point, { layers: [neighborhoodLayerId] }) || [];
            if (hits.length > 0) return; // clicked on a neighborhood; layer handler will manage
          } catch {}
          currentSelectedName = null;
          try { map.setFilter(neighborhoodSelectedId, ["==", ["get", labelField], "__none__"]); } catch {}
          try { map.setFilter(neighborhoodLabelsSelectedId, ["==", ["get", "label"], "__none__"]); } catch {}
          try { onSelect && onSelect(null, null); } catch {}
        };
        (map as any).__neighborhoodClearHandler = clearHandler;
        map.on("click", clearHandler);
      } catch {}

      // Done for NYC
      const style = map.getStyle();
      try { console.log(`[map] 📋 Current map layers:`, style.layers?.map((l: any) => l.id) || 'none'); } catch {}
      return;
    } catch (error) {
      console.warn(`[map] NYC NTA load failed, falling back to test rectangle:`, (error as any)?.message || error);
      // Fall through to test rectangle below
    }
  }

  // SF: Load neighborhood polygons from local static file in /public and attach density
  if (city === "sf") {
    try {
      console.log(`[map] 📦 Loading SF NTA GeoJSON from /public…`);
      const resLocal = await fetch(`/sf_nta_2025.geojson`, { cache: "force-cache" });
      if (!resLocal.ok) throw new Error(`geojson_load_${resLocal.status}`);
      const data: any = await resLocal.json();

      const guessLabelField = (props: any): string => {
        if (!props || typeof props !== "object") return "name";
        const candidates = [
          "label", "name", "neighborhood",
          // Common SF fields we might see
          "analysis_neighborhood", "district", "nta", "nta_name", "nta2025", "nta_name_2025"
        ];
        for (const c of candidates) {
          const hit = Object.keys(props).find((k) => k.toLowerCase() === c);
          if (hit) return hit;
        }
        return "name";
      };

      const firstProps = (data.features && data.features[0] && data.features[0].properties) || {};
      const labelField = guessLabelField(firstProps);
      console.log(`[map] ✅ SF neighborhoods loaded from local file (label field: ${labelField})`);
      let currentSelectedName: string | null = null;

      // Inject bands for shimmer
      const withBandsSF = {
        ...(data as any),
        features: ((data as any)?.features || []).map((f: any, i: number) => ({
          ...(f || {}),
          properties: { ...(f?.properties || {}), __band: i % 3 },
        })),
      } as any;
      const existingSrcSF = map.getSource(neighborhoodSourceId);
      if (isGeoJSONSource(existingSrcSF)) {
        try { existingSrcSF.setData(withBandsSF); } catch {}
      } else {
        try { if (existingSrcSF) map.removeSource(neighborhoodSourceId); } catch {}
        map.addSource(neighborhoodSourceId, { type: "geojson", data: withBandsSF });
      }
      try { console.log(`[map] neighborhoods source ready (SF)`, { features: Array.isArray((data as any)?.features) ? (data as any).features.length : -1 }); } catch {}

      // Fill layer with grey while loading; switch to ramp after density fetch
      try { if (map.getLayer(neighborhoodLayerId)) map.removeLayer(neighborhoodLayerId); } catch {}
      try {
        map.addLayer({
          id: neighborhoodLayerId,
          type: "fill",
          source: neighborhoodSourceId,
          layout: { visibility: "visible" },
          paint: {
            "fill-color": "#6b7280",
            "fill-opacity": 0.16,
            "fill-outline-color": "#A3A3A3",
          }
        });
      } catch {}

      // Build line feature collection for outline filtering
      try {
        const toLines = (fc: any) => {
          const out: any = { type: "FeatureCollection", features: [] as any[] };
          const pushRing = (ring: any, props: any) => {
            if (Array.isArray(ring) && ring.length >= 2 && typeof ring[0][0] === 'number') {
              const p: any = {}; p[labelField] = String(props?.[labelField] || "");
              out.features.push({ type: "Feature", properties: p, geometry: { type: "LineString", coordinates: ring } });
            }
          };
          (fc?.features || []).forEach((f: any) => {
            const g = f?.geometry; if (!g) return;
            if (g.type === 'Polygon') {
              (g.coordinates || []).forEach((ring: any) => pushRing(ring, f?.properties || {}));
            } else if (g.type === 'MultiPolygon') {
              (g.coordinates || []).forEach((poly: any) => (poly || []).forEach((ring: any) => pushRing(ring, f?.properties || {})));
            } else if (g.type === 'LineString' || g.type === 'MultiLineString') {
              const p: any = {}; p[labelField] = String(f?.properties?.[labelField] || "");
              out.features.push({ type: "Feature", properties: p, geometry: g });
            }
          });
          return out;
        };
        const lineFc = toLines(data);
        try { if (map.getLayer(neighborhoodOutlineId)) map.removeLayer(neighborhoodOutlineId); } catch {}
        const existingOutlineSrc = map.getSource(neighborhoodOutlineSourceId);
        if (isGeoJSONSource(existingOutlineSrc)) {
          try { existingOutlineSrc.setData(lineFc); } catch {}
        } else {
          try { if (existingOutlineSrc) map.removeSource(neighborhoodOutlineSourceId); } catch {}
          map.addSource(neighborhoodOutlineSourceId, { type: 'geojson', data: lineFc });
        }
        map.addLayer({ id: neighborhoodOutlineId, type: 'line', source: neighborhoodOutlineSourceId, paint: { 'line-color': '#FFFF00', 'line-width': 2.5, 'line-opacity': 0.15 } });
      } catch {}

      try { map.moveLayer(neighborhoodOutlineId); } catch {}
      try { map.moveLayer(neighborhoodLayerId); } catch {}

      // Labels via centroids
      const makeCentroids = (fc: any) => {
        const out: any = { type: "FeatureCollection", features: [] as any[] };
        const centroidOfRing = (ring: any[]): [number, number] => {
          if (!Array.isArray(ring) || ring.length < 3) return [0, 0];
          let a = 0, cx = 0, cy = 0;
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [x1, y1] = ring[j];
            const [x2, y2] = ring[i];
            const f = (x1 * y2 - x2 * y1);
            a += f;
            cx += (x1 + x2) * f;
            cy += (y1 + y2) * f;
          }
          if (a === 0) {
            let sx = 0, sy = 0; for (const [x, y] of ring) { sx += x; sy += y; }
            return [sx / ring.length, sy / ring.length];
          }
          a *= 0.5; cx /= (6 * a); cy /= (6 * a);
          return [cx, cy];
        };
        const choosePoly = (coords: any[]) => {
          let best = { area: -Infinity, ring: null as any };
          for (const poly of coords) {
            const ring = poly && poly[0]; if (!ring) continue;
            let A = 0; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [x1, y1] = ring[j]; const [x2, y2] = ring[i]; A += (x1 * y2 - x2 * y1); }
            const area = Math.abs(A) * 0.5; if (area > best.area) best = { area, ring };
          }
          return best.ring;
        };
        for (const f of (fc?.features || [])) {
          const g = f?.geometry; if (!g) continue;
          let c: [number, number] | null = null;
          if (g.type === 'Polygon') { c = centroidOfRing(g.coordinates?.[0] || []); }
          else if (g.type === 'MultiPolygon') { const ring = choosePoly(g.coordinates || []); if (ring) c = centroidOfRing(ring); }
          if (c) out.features.push({ type: 'Feature', properties: { label: String((f.properties || {})[labelField] || '') }, geometry: { type: 'Point', coordinates: c } });
        }
        return out;
      };

      try {
        // Load density counts and attach to base polygons (SF)
        const params = new URLSearchParams();
        params.set('city', 'sf');
        if (filters?.startISO) params.set('start', filters.startISO);
        if (filters?.endISO) params.set('end', filters.endISO);
        if (filters?.vclass && filters.vclass.length > 0) params.set('vclass', filters.vclass.join(','));
        if (filters?.ofns && filters.ofns.length > 0) params.set('ofns', filters.ofns.join(','));
        if (typeof filters?.includeUnknown === 'boolean') params.set('includeUnknown', filters.includeUnknown ? '1' : '0');
        let base = data;
        const shouldFetchDensity = (Array.isArray(filters?.vclass) && filters!.vclass!.length > 0) || (Array.isArray(filters?.ofns) && filters!.ofns!.length > 0);
        if (shouldFetchDensity) {
          // Start shimmer wave (same as NYC)
          try { onShimmerChange && onShimmerChange(true); } catch {}
          try {
            const mkShimmerId = (k: number) => `${neighborhoodLayerId}-shimmer-${k}`;
            for (let k = 0; k < 3; k++) { try { if (map.getLayer(mkShimmerId(k))) map.removeLayer(mkShimmerId(k)); } catch {} }
            for (let k = 0; k < 3; k++) {
              try { map.addLayer({ id: mkShimmerId(k), type: 'fill', source: neighborhoodSourceId, filter: ['==', ['get', '__band'], k], paint: { 'fill-color': '#9ca3af', 'fill-opacity': 0.0, 'fill-outline-color': '#A3A3A3' } }); } catch {}
            }
            let t = 0; const baseOp = 0.12, amp = 0.08;
            try { if ((map as any).__neighborhoodShimmerTimer) { clearInterval((map as any).__neighborhoodShimmerTimer); } } catch {}
            ;(map as any).__neighborhoodShimmerTimer = setInterval(() => {
              try {
                for (let k = 0; k < 3; k++) {
                  const id = mkShimmerId(k);
                  const phase = (t + k * 2.094);
                  const op = Math.max(0.06, Math.min(0.28, baseOp + Math.sin(phase) * amp));
                  try { map.setPaintProperty(id, 'fill-opacity', op); } catch {}
                }
                t += 0.22;
              } catch {}
            }, 120);
          } catch {}
          try {
            const resD = await fetch(`/api/neighborhoods/density?${params.toString()}`, { cache: 'no-store' });
            if (resD.ok) base = await resD.json();
          } catch {}
        } else {
          // No data mode: ensure plain grey neighborhoods and no shimmer
          try { if ((map as any).__neighborhoodShimmerTimer) { clearInterval((map as any).__neighborhoodShimmerTimer); (map as any).__neighborhoodShimmerTimer = null; } } catch {}
          try { for (let k = 0; k < 3; k++) { const id = `${neighborhoodLayerId}-shimmer-${k}`; if (map.getLayer(id)) map.removeLayer(id); } } catch {}
          try { map.setPaintProperty(neighborhoodLayerId, 'fill-color', '#6b7280'); } catch {}
          try { map.setPaintProperty(neighborhoodLayerId, 'fill-opacity', 0.16); } catch {}
          try { map.setPaintProperty(neighborhoodLayerId, 'fill-outline-color', '#A3A3A3'); } catch {}
        }

        const labelFc = makeCentroids(base);
        const existingLblSrc = map.getSource(neighborhoodLabelsSourceId);
        if (isGeoJSONSource(existingLblSrc)) {
          try { existingLblSrc.setData(labelFc); } catch {}
        } else {
          try { if (existingLblSrc) map.removeSource(neighborhoodLabelsSourceId); } catch {}
          map.addSource(neighborhoodLabelsSourceId, { type: 'geojson', data: labelFc });
        }
        try {
          const src = map.getSource(neighborhoodSourceId);
          if (isGeoJSONSource(src)) src.setData(base);
        } catch {}
        // Stop shimmer and switch to ramp only if we fetched density
        if (shouldFetchDensity) {
          try { if ((map as any).__neighborhoodShimmerTimer) { clearInterval((map as any).__neighborhoodShimmerTimer); (map as any).__neighborhoodShimmerTimer = null; } } catch {}
          try { for (let k = 0; k < 3; k++) { const id = `${neighborhoodLayerId}-shimmer-${k}`; if (map.getLayer(id)) map.removeLayer(id); } } catch {}
          try { onShimmerChange && onShimmerChange(false); } catch {}
          try {
            map.setPaintProperty(neighborhoodLayerId, 'fill-color', [
              'interpolate', ['linear'], ['coalesce', ['get', 'p'], 0],
              0.00, '#003A99',
              0.10, '#2AA7FF',
              0.30, '#00FFCC',
              0.50, '#7CFF66',
              0.70, '#D9FF3D',
              0.85, '#FF9900',
              0.95, '#FF3D00',
              1.00, '#B30000'
            ]);
            map.setPaintProperty(neighborhoodLayerId, 'fill-opacity', 0.18);
            map.setPaintProperty(neighborhoodLayerId, 'fill-outline-color', '#FFFF00');
          } catch {}
        }
      } catch {}

      if (!map.getLayer(neighborhoodLabelsId)) {
        try {
          map.addLayer({
            id: neighborhoodLabelsId,
            type: "symbol",
            source: neighborhoodLabelsSourceId,
            minzoom: 10,
            layout: {
              "text-field": ["get", "label"],
              "text-size": [
                "interpolate", ["linear"], ["zoom"],
                10, 10,
                12, 11,
                14, 12,
                16, 14
              ],
              "symbol-placement": "point",
              "text-transform": "uppercase",
              "text-padding": 2,
              "text-max-width": 12,
              "text-justify": "center",
              "text-anchor": "center",
              "text-allow-overlap": true,
              "text-ignore-placement": true,
              "text-optional": true,
            },
            paint: {
              "text-color": "#FFFFFF",
              "text-halo-color": "#0b1220",
              "text-halo-width": 1.2,
              "text-opacity": 0.6,
            }
          });
          try { map.moveLayer(neighborhoodLabelsId); } catch {}
        } catch {}
      }

      // Selected neighborhood label overlay for SF (bright white, same halo)
      try { if (!map.getLayer(neighborhoodLabelsSelectedId)) {
        map.addLayer({
          id: neighborhoodLabelsSelectedId,
          type: "symbol",
          source: neighborhoodLabelsSourceId,
          minzoom: 10,
          layout: {
            "text-field": ["get", "label"],
            "text-size": [
              "interpolate", ["linear"], ["zoom"],
              10, 10,
              12, 11,
              14, 12,
              16, 14
            ],
            "symbol-placement": "point",
            "text-transform": "uppercase",
            "text-padding": 2,
            "text-max-width": 12,
            "text-justify": "center",
            "text-anchor": "center",
            "text-allow-overlap": true,
            "text-ignore-placement": true,
            "text-optional": true,
          },
          paint: {
            "text-color": "#FFFFFF",
            "text-halo-color": "#0b1220",
            "text-halo-width": 1.2,
            "text-opacity": 1.0,
          },
          filter: ["==", ["get", "label"], "__none__"],
        });
        try { map.moveLayer(neighborhoodLabelsSelectedId); } catch {}
      } } catch {}

      // Selection highlight layer (updated via filter on click)
      try { if (!map.getLayer(neighborhoodSelectedId)) {
        map.addLayer({
          id: neighborhoodSelectedId,
          type: "line",
          source: neighborhoodOutlineSourceId,
          layout: { visibility: "visible" },
          paint: { "line-color": "#FFFFFF", "line-width": 4, "line-opacity": 0.9 },
          filter: ["==", ["get", labelField], "__none__"],
        });
      } } catch {}

      // Interactivity
      try {
        map.on("mouseenter", neighborhoodLayerId, () => { try { map.getCanvas().style.cursor = "pointer"; } catch {} });
        map.on("mouseleave", neighborhoodLayerId, () => { try { map.getCanvas().style.cursor = ""; } catch {} });

        const prevLayerHandler = (map as any).__neighborhoodLayerClickHandler;
        if (prevLayerHandler) { try { map.off("click", neighborhoodLayerId, prevLayerHandler); } catch {} }

        const layerClickHandler = (e: any) => {
          const f = e?.features?.[0];
          if (!f) return;
          const name = String((f.properties || {})[labelField] || "");

          if (currentSelectedName === name) {
            currentSelectedName = null;
            try { map.setFilter(neighborhoodSelectedId, ["==", ["get", labelField], "__none__"]); } catch {}
            try { if (map.getLayer(neighborhoodLabelsSelectedId)) map.setFilter(neighborhoodLabelsSelectedId, ["==", ["get", "label"], "__none__"]); } catch {}
            try { onSelect && onSelect(null, null); } catch {}
            return;
          }

          currentSelectedName = name;
          try { map.setFilter(neighborhoodSelectedId, ["==", ["get", labelField], name]); } catch {}
          try { if (map.getLayer(neighborhoodLabelsSelectedId)) map.setFilter(neighborhoodLabelsSelectedId, ["==", ["get", "label"], name]); } catch {}
          // No tooltip popup on neighborhood selection
          try { onSelect && onSelect(name, f); } catch {}
        };
        (map as any).__neighborhoodLayerClickHandler = layerClickHandler;
        map.on("click", neighborhoodLayerId, layerClickHandler);

        const prevClearHandler = (map as any).__neighborhoodClearHandler;
        if (prevClearHandler) { try { map.off("click", prevClearHandler); } catch {} }
        const clearHandler = (e: any) => {
          try {
            const hits = map.queryRenderedFeatures(e.point, { layers: [neighborhoodLayerId] }) || [];
            if (hits.length > 0) return;
          } catch {}
          currentSelectedName = null;
          try { map.setFilter(neighborhoodSelectedId, ["==", ["get", labelField], "__none__"]); } catch {}
          try { if (map.getLayer(neighborhoodLabelsSelectedId)) map.setFilter(neighborhoodLabelsSelectedId, ["==", ["get", "label"], "__none__"]); } catch {}
          try { onSelect && onSelect(null, null); } catch {}
        };
        (map as any).__neighborhoodClearHandler = clearHandler;
        map.on("click", clearHandler);
      } catch {}

      // Done for SF
      const style = map.getStyle();
      try { console.log(`[map] 📋 Current map layers (SF):`, style.layers?.map((l: any) => l.id) || 'none'); } catch {}
      return;
    } catch (error) {
      console.warn(`[map] SF NTA load failed, falling back to test rectangle:`, (error as any)?.message || error);
    }
  }

  // Fallback disabled in production flow: return early to avoid noisy errors during city/style races
  console.warn(`[map] 🧪 Fallback geometry disabled; returning without drawing test rectangle for ${city}.`);
  return;
}

export default function Home() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [mapRef, setMapRef] = useState<any>(null);
  const [mapShimmering, setMapShimmering] = useState<boolean>(false);
  const [vclass, setVclass] = useState<string[]>(["violent", "nonviolent"]);
  const [city, setCity] = useState<"nyc" | "sf">("nyc");
  const [crimeTypes, setCrimeTypes] = useState<CrimeType[]>([]);
  const [selectedOfns, setSelectedOfns] = useState<string[]>([]);
  const [filtersOpen, setFiltersOpen] = useState<boolean>(true);
  const [startYear, setStartYear] = useState<number>(2022);
  const [endYear, setEndYear] = useState<number>(new Date().getFullYear());
  const [loadingTiles, setLoadingTiles] = useState(false);
  const [stats, setStats] = useState<{
    total: number;
    ofnsTop: { label: string; count: number }[];
    byLaw: { label: string; count: number }[];
    byBoro: { label: string; count: number }[];
    byRace?: { label: string; count: number }[];
    byAge?: { label: string; count: number }[];
    byPremises?: { label: string; count: number }[];
    timeseries?: { month: string; count: number }[];
    raceOnRace?: { suspects: string[]; victims: string[]; counts: number[][] };
    sexOnSex?: { suspects: string[]; victims: string[]; counts: number[][] };
    sexRaceOnSexRace?: { suspects: string[]; victims: string[]; counts: number[][] };
  } | null>(null);
  const [statsLoading, setStatsLoading] = useState<boolean>(false);
  // Loading message coordination
  const [rotatorResetKey, setRotatorResetKey] = useState<number>(0);
  const [bothLoadingConcurrent, setBothLoadingConcurrent] = useState<boolean>(false);
  const lastMapLoadStartRef = useRef<number>(0);
  const lastStatsLoadStartRef = useRef<number>(0);
  const prevMapShimmeringRef = useRef<boolean>(mapShimmering);
  const prevStatsLoadingRef = useRef<boolean>(statsLoading);
  const [aggData, setAggData] = useState<any | null>(null);
  const [legendRange, setLegendRange] = useState<{ min: number; median: number; max: number } | null>(null);
  const [includeUnknown, setIncludeUnknown] = useState<boolean>(city === "nyc");
  const [availableYears, setAvailableYears] = useState<number[]>([2021, 2022, 2023, 2024, 2025]);
  const yearsInitRef = useRef<boolean>(false);
  const [cityDropdownOpen, setCityDropdownOpen] = useState<boolean>(false);
  const cityDropdownRef = useRef<HTMLDivElement>(null);
  // Mobile responsiveness
  const [viewportWidth, setViewportWidth] = useState<number>(typeof window !== "undefined" ? window.innerWidth : 1024);
  const [isMobile, setIsMobile] = useState<boolean>(false);
  useEffect(() => {
    const handleResize = () => {
      const w = window.innerWidth;
      setViewportWidth(w);
      setIsMobile(w <= 768);
    };
    try { handleResize(); } catch {}
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);
  // Default filters closed on mobile only
  useEffect(() => {
    try {
      if (typeof window !== "undefined" && window.innerWidth <= 768) {
        setFiltersOpen(false);
      }
    } catch {}
  }, []);
  
  // Detect map loading start events
  useEffect(() => {
    if (mapShimmering && !prevMapShimmeringRef.current) {
      const now = Date.now();
      lastMapLoadStartRef.current = now;
      setRotatorResetKey((k) => k + 1);
      setBothLoadingConcurrent((now - lastStatsLoadStartRef.current) < 800);
    }
    prevMapShimmeringRef.current = mapShimmering;
  }, [mapShimmering]);

  // Detect sidebar loading start events
  useEffect(() => {
    if (statsLoading && !prevStatsLoadingRef.current) {
      const now = Date.now();
      lastStatsLoadStartRef.current = now;
      setRotatorResetKey((k) => k + 1);
      setBothLoadingConcurrent((now - lastMapLoadStartRef.current) < 800);
    }
    prevStatsLoadingRef.current = statsLoading;
  }, [statsLoading]);
  // Force refresh key that bumps on any filter change
  const [filtersVersion, setFiltersVersion] = useState<number>(0);
  const [mapDrivenStats] = useState<boolean>(false); // disable map-move driven stats fetches
  const [selectedNeighborhood, setSelectedNeighborhood] = useState<{ name: string; feature: any } | null>(null);
  
  // Debug: Log when filtersVersion changes
  useEffect(() => {
    console.log(`[Filters Version] Changed to: ${filtersVersion}`);
  }, [filtersVersion]);
  const prevFiltersSigRef = useRef<string>("");
  const statsSeqRef = useRef<number>(0);

  // Close city dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (cityDropdownRef.current && !cityDropdownRef.current.contains(event.target as Node)) {
        setCityDropdownOpen(false);
      }
    };

    if (cityDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [cityDropdownOpen]);
  const clientCacheRef = useRef<{ stats: Map<string, { exp: number; data: any }>; agg: Map<string, { exp: number; data: any }> } | null>(null);
  if (!clientCacheRef.current) {
    clientCacheRef.current = { stats: new Map(), agg: new Map() };
  }
  // Abort controller for sidebar stats fetches so old city requests are cancelled on switch
  const sidebarFetchAbortRef = useRef<AbortController | null>(null);
  // Quantized viewport signatures so tiny pans/zooms don't refetch
  const lastStatsQuantRef = useRef<string>("");
  const lastAggQuantRef = useRef<string>("");
  const quantize = (n: number, step = 0.0015) => Math.round(n / step) * step; // ~150m grid
  const quantizeBBox = (b: any, step = 0.0015) => {
    const west = quantize(b.getWest(), step);
    const south = quantize(b.getSouth(), step);
    const east = quantize(b.getEast(), step);
    const north = quantize(b.getNorth(), step);
    return { west, south, east, north, str: `${west},${south},${east},${north}` };
  };
  const lastStatsFetchRef = useRef<{ key: string; at: number }>({ key: "", at: 0 });
  const lastAggFetchRef = useRef<{ key: string; at: number }>({ key: "", at: 0 });
  // Track last processed filtersVersion to coordinate effects on filter changes
  const lastFiltersVersionRef = useRef<number>(filtersVersion);
  // On filter version changes, immediately show loading and clear stale sidebar data
  useEffect(() => {
    if (lastFiltersVersionRef.current !== filtersVersion) {
      try { console.log("[stats] filtersVersion changed → clearing sidebar + showing loading", { from: lastFiltersVersionRef.current, to: filtersVersion }); } catch {}
      setStatsLoading(true);
      setStats(null);
      lastFiltersVersionRef.current = filtersVersion;
    }
  }, [filtersVersion]);

  // Keep a canonical reference to the latest filters so map event handlers always read fresh values
  const latestFiltersRef = useRef({ startISO: "", endISO: "", includeUnknown: false, vclass: [] as string[], effectiveSelectedOfns: [] as string[], emptySelectionFallback: false });

  // Sidebar typography system
  const textStyles = useMemo(() => ({
    header: { fontSize: 16, fontWeight: 600, color: "#e5e7eb" },
    body: { fontSize: 13, color: "#e5e7eb" },
    small: { fontSize: 12, color: "rgba(229,231,235,0.85)" },
  }), []);

  const violentOn = vclass.includes("violent");
  const nonviolentOn = vclass.includes("nonviolent");
  const violentOfns = useMemo(
    () => crimeTypes.map((c) => c.label).filter((l) => isViolentOfnsDesc(l)).sort(),
    [crimeTypes]
  );
  const nonviolentOfns = useMemo(
    () => crimeTypes.map((c) => c.label).filter((l) => !isViolentOfnsDesc(l)).sort(),
    [crimeTypes]
  );
  const startISO = useMemo(() => {
    const iso = new Date(Date.UTC(startYear, 0, 1, 0, 0, 0, 0)).toISOString();
    console.log(`[ISO Change] startISO: ${iso} (from startYear: ${startYear})`);
    return iso;
  }, [startYear]);
  const endISO = useMemo(() => {
    const iso = new Date(Date.UTC(endYear, 11, 31, 23, 59, 59, 999)).toISOString();
    console.log(`[ISO Change] endISO: ${iso} (from endYear: ${endYear})`);
    return iso;
  }, [endYear]);
  const effectiveSelectedOfns = useMemo(() => {
    if (selectedOfns.length === 0) return [] as string[];
    // When any explicit selections exist, they take precedence regardless of master category toggles
    return selectedOfns;
  }, [selectedOfns]);
  const emptySelectionFallback = useMemo(() => !violentOn && !nonviolentOn && effectiveSelectedOfns.length === 0, [violentOn, nonviolentOn, effectiveSelectedOfns]);
  const noDataMode = emptySelectionFallback;

  useEffect(() => {
    latestFiltersRef.current = {
      startISO,
      endISO,
      includeUnknown,
      vclass,
      effectiveSelectedOfns,
      emptySelectionFallback,
    } as any;
  }, [startISO, endISO, includeUnknown, vclass, effectiveSelectedOfns, emptySelectionFallback]);

  // Build tile URL with filter params
  const tileURL = useMemo(() => {
    const params = new URLSearchParams();
    params.set("start", startISO);
    params.set("end", endISO);
    if (effectiveSelectedOfns.length > 0) {
      params.set("ofns", effectiveSelectedOfns.join(","));
    } else if (vclass.length > 0) {
      params.set("vclass", vclass.join(","));
    } else if (emptySelectionFallback) {
      // When both categories are off and there are no explicit offenses, force empty results
      params.set("ofns", "__none__");
    }
    params.set("includeUnknown", includeUnknown ? "1" : "0");
    // Force cache-bust on filter changes and city switch
    params.set("fv", `${city}-${filtersVersion}`);
    // Also include date range in the bust key to avoid stale tiles when dates change
    params.set("dr", `${startYear}-${endYear}`);
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    return `${origin}/api/tiles/{z}/{x}/{y}.mvt?${params.toString()}`;
  }, [vclass, startISO, endISO, effectiveSelectedOfns, includeUnknown, filtersVersion, city]);

  

  useEffect(() => {
    let map: any;
    let cancelled = false;

    const init = async () => {
      const maplibregl = (await import("maplibre-gl")).default as any;
      (window as any).maplibregl = maplibregl;

      if (!containerRef.current || cancelled) return;

      map = new maplibregl.Map({
        container: containerRef.current,
        style: {
          version: 8,
          sources: {
            'carto-dark': {
              type: 'raster',
              tiles: [
                'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
                'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
                'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
                'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png'
              ],
              tileSize: 256,
              attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>'
            }
          },
          layers: [
            {
              id: 'carto-dark-layer',
              type: 'raster',
              source: 'carto-dark'
            }
          ],
          glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf'
        },
        center: [-73.99, 40.7328],
        zoom: 12.5,
      });

      map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }));

      // Add neighborhood boundaries when map loads
      map.on('load', () => {
        const fobj = { startISO, endISO, vclass, ofns: effectiveSelectedOfns, includeUnknown } as NeighborhoodFilters;
        addNeighborhoodBoundaries(map, city, (name, feature) => {
          if (name && feature) {
            try { setSelectedNeighborhood({ name, feature }); } catch {}
            try { triggerSidebarStatsFetch({ poly: feature?.geometry }); } catch {}
          } else {
            try { setSelectedNeighborhood(null); } catch {}
            try { triggerSidebarStatsFetch(); } catch {}
          }
        }, fobj, (loading) => { try { setMapShimmering(loading); } catch {} }).catch(error => {
          console.warn('[map] Failed to add neighborhood boundaries:', error);
        });
        // Sidebar: fetch whole-city stats once on load
        try { triggerSidebarStatsFetch(); } catch {}
      });

      setMapRef(map);
    };

    init();

    return () => {
      cancelled = true;
      try { map && map.remove(); } catch {}
      setMapRef(null);
    };
  }, [city]);

  // Helper: fetch sidebar stats once for whole-city or for a selected polygon
  const triggerSidebarStatsFetch = useMemo(() => {
    return (opts?: { poly?: any }) => {
      try {
        const { emptySelectionFallback: esf } = (latestFiltersRef.current as any) || {};
        if (esf) {
          // No data mode: skip fetch and ensure no loading state
          setStats(null);
          setStatsLoading(false);
          return;
        }
      } catch {}
      const params = new URLSearchParams();
      try {
        const { startISO: s, endISO: e, vclass: vc, effectiveSelectedOfns: ofs, includeUnknown } = (latestFiltersRef.current as any) || {};
        if (s) params.set('start', s);
        if (e) params.set('end', e);
        if (vc && vc.length > 0) params.set('vclass', vc.join(','));
        if (ofs && ofs.length > 0) params.set('ofns', ofs.join(','));
        if (includeUnknown) params.set('includeUnknown', includeUnknown ? '1' : '0');
      } catch {}
      // Explicit city hint to prevent server misrouting
      params.set('city', city);
      // Sequence to drop stale responses when city/filters change
      const seq = ++statsSeqRef.current;
      params.set('seq', String(seq));
      if (opts?.poly) {
        try {
          params.set('poly', JSON.stringify(opts.poly));
          // Include polygon bbox to let the server narrow its fetch while still using the exact polygon server-side
          const computeBbox = (geom: any): [number, number, number, number] | null => {
            try {
              const coords = geom?.coordinates;
              if (!coords) return null;
              let minLon = 180, minLat = 90, maxLon = -180, maxLat = -90;
              const walk = (c: any) => {
                if (!c) return;
                if (typeof c[0] === 'number') {
                  const x = Number(c[0]), y = Number(c[1]);
                  if (Number.isFinite(x) && Number.isFinite(y)) {
                    if (x < minLon) minLon = x;
                    if (y < minLat) minLat = y;
                    if (x > maxLon) maxLon = x;
                    if (y > maxLat) maxLat = y;
                  }
                } else {
                  for (const child of c) walk(child);
                }
              };
              walk(coords);
              return [minLon, minLat, maxLon, maxLat];
            } catch { return null; }
          };
          const bb = computeBbox(opts.poly);
          if (bb) params.set('bbox', `${bb[0]},${bb[1]},${bb[2]},${bb[3]}`);
        } catch {}
      } else {
        // Whole-city fallback: use a fixed city bbox (not viewport) to ensure NYC/SF routing server-side
        if (city === "sf") {
          // San Francisco approx bbox
          params.set('bbox', '-122.5149,37.7081,-122.3570,37.8324');
        } else {
          // NYC bbox
          params.set('bbox', '-74.25559,40.49612,-73.70001,40.91553');
        }
      }
      const url = `/api/stats?${params.toString()}`;
      setStatsLoading(true);
      // Lightweight client cache to avoid redundant calls across quick interactions
      try {
        const cache = clientCacheRef.current!.stats;
        const now = Date.now();
        const cached = cache.get(params.toString());
        if (cached && cached.exp > now) {
          // Cached response is for the exact params; safe to apply immediately
          setStats(cached.data);
          setTimeout(() => setStatsLoading(false), 60);
          return;
        }
      } catch {}
      try { sidebarFetchAbortRef.current?.abort(); } catch {}
      const controller = new AbortController();
      sidebarFetchAbortRef.current = controller;
      fetch(url, { signal: controller.signal })
        .then((r) => r.json())
        .then((d) => {
          try { clientCacheRef.current!.stats.set(params.toString(), { exp: Date.now() + 10000, data: d }); } catch {}
          if (seq === statsSeqRef.current) {
            setStats(d);
            setStatsLoading(false);
          } else {
            // Stale response from prior city/filters; ignore
          }
        })
        .catch(() => { if (seq === statsSeqRef.current) setStatsLoading(false); });
    };
  }, [city]);

  // Jump to selected city when changed
  useEffect(() => {
    if (!mapRef) return;
    // Clear previous city's visuals immediately to avoid showing stale data
    try {
      const sourceId = "nypd-complaints";
      const circleLayerId = "nypd-circles";
      const textLayerId = "nypd-text";
      const aggSourceId = "nypd-agg";
      const aggLayerId = "nypd-agg-hex";
      const aggOutlineLayerId = `${aggLayerId}-outline`;
      const neighborhoodSourceId = "neighborhoods";
      const neighborhoodLayerId = "neighborhood-boundaries";
      const neighborhoodLabelsId = "neighborhood-labels";
      const neighborhoodOutlineId = `${neighborhoodLayerId}-outline`;
      
      try { if (mapRef.getLayer(textLayerId)) mapRef.removeLayer(textLayerId); } catch {}
      try { if (mapRef.getLayer(circleLayerId)) mapRef.removeLayer(circleLayerId); } catch {}
      try { if (mapRef.getLayer(aggLayerId)) mapRef.removeLayer(aggLayerId); } catch {}
      try { if (mapRef.getLayer(aggOutlineLayerId)) mapRef.removeLayer(aggOutlineLayerId); } catch {}
      try { if (mapRef.getLayer(neighborhoodLabelsId)) mapRef.removeLayer(neighborhoodLabelsId); } catch {}
      try { if (mapRef.getLayer(neighborhoodLayerId)) mapRef.removeLayer(neighborhoodLayerId); } catch {}
      try { if (mapRef.getLayer(neighborhoodOutlineId)) mapRef.removeLayer(neighborhoodOutlineId); } catch {}
      try { if (mapRef.getSource(aggSourceId)) mapRef.removeSource(aggSourceId); } catch {}
      try { if (mapRef.getSource(sourceId)) mapRef.removeSource(sourceId); } catch {}
      try { if (mapRef.getSource(neighborhoodSourceId)) mapRef.removeSource(neighborhoodSourceId); } catch {}
    } catch {}
    // Reset client-side state and caches so we don't short-circuit with old keys
    try { lastStatsQuantRef.current = ""; } catch {}
    try { lastAggQuantRef.current = ""; } catch {}
    setAggData(null);
    setLegendRange(null);
    setStats(null);
    setStatsLoading(true);
    setLoadingTiles(true);
    // Proactively bump version so tiles update immediately on city switch
    setFiltersVersion((v) => v + 1);
    const coords = city === "sf" ? [-122.4194, 37.7749] : [-73.99, 40.7328];
    try {
      mapRef.flyTo({ center: coords, zoom: 12.5, speed: 1.2, curve: 1.4, essential: true });
    } catch {}
    
    // Update neighborhood boundaries for the new city
    try {
      if (typeof mapRef.isStyleLoaded === 'function' && mapRef.isStyleLoaded()) {
        const fobj = { startISO, endISO, vclass, ofns: effectiveSelectedOfns, includeUnknown } as NeighborhoodFilters;
        addNeighborhoodBoundaries(mapRef, city, (name, feature) => {
          if (name && feature) {
            try { setSelectedNeighborhood({ name, feature }); } catch {}
            try { triggerSidebarStatsFetch({ poly: feature?.geometry }); } catch {}
          } else {
            try { setSelectedNeighborhood(null); } catch {}
            try { triggerSidebarStatsFetch(); } catch {}
          }
        }, fobj, (loading) => { try { setMapShimmering(loading); } catch {} }).catch(error => {
          console.warn('[map] Failed to update neighborhood boundaries:', error);
        });
      } else {
        mapRef.once('load', () => {
          const fobj = { startISO, endISO, vclass, ofns: effectiveSelectedOfns, includeUnknown } as NeighborhoodFilters;
          addNeighborhoodBoundaries(mapRef, city, (name, feature) => {
            if (name && feature) {
              try { setSelectedNeighborhood({ name, feature }); } catch {}
              try { triggerSidebarStatsFetch({ poly: feature?.geometry }); } catch {}
            } else {
              try { setSelectedNeighborhood(null); } catch {}
              try { triggerSidebarStatsFetch(); } catch {}
            }
          }, fobj, (loading) => { try { setMapShimmering(loading); } catch {} }).catch(error => {
            console.warn('[map] Failed to update neighborhood boundaries (post-load):', error);
          });
        });
      }
    } catch (e) {
      console.warn('[map] Failed to schedule neighborhood boundaries:', e);
    }
  }, [city, mapRef]);

  // Rebuild neighborhood density/labels when core filters change (dates, categories, offenses, includeUnknown)
  useEffect(() => {
    if (!mapRef) return;
    try {
      const fobj = { startISO, endISO, vclass, ofns: effectiveSelectedOfns, includeUnknown } as NeighborhoodFilters;
      if (typeof mapRef.isStyleLoaded === 'function' && mapRef.isStyleLoaded()) {
        addNeighborhoodBoundaries(mapRef, city, (name, feature) => {
          if (name && feature) {
            try { setSelectedNeighborhood({ name, feature }); } catch {}
            try { triggerSidebarStatsFetch({ poly: feature?.geometry }); } catch {}
          } else {
            try { setSelectedNeighborhood(null); } catch {}
            try { triggerSidebarStatsFetch(); } catch {}
          }
        }, fobj, (loading) => { try { setMapShimmering(loading); } catch {} });
      } else if (typeof mapRef.once === 'function') {
        mapRef.once('load', () => {
          addNeighborhoodBoundaries(mapRef, city, (name, feature) => {
            if (name && feature) {
              try { setSelectedNeighborhood({ name, feature }); } catch {}
              try { triggerSidebarStatsFetch({ poly: feature?.geometry }); } catch {}
            } else {
              try { setSelectedNeighborhood(null); } catch {}
              try { triggerSidebarStatsFetch(); } catch {}
            }
          }, fobj, (loading) => { try { setMapShimmering(loading); } catch {} });
        });
      }
    } catch {}
  }, [startISO, endISO, vclass, effectiveSelectedOfns, includeUnknown, city, mapRef, triggerSidebarStatsFetch]);

  // Reset filters and refresh available year range when switching cities
  useEffect(() => {
    // Reset offense filters to defaults
    setVclass(["violent", "nonviolent"]);
    setSelectedOfns([]);
    // Reset includeUnknown default per city: on for NYC, off for SF
    setIncludeUnknown(city === "nyc");
    // Clear client caches on city switch to avoid reusing previous city's responses
    try {
      clientCacheRef.current?.stats.clear();
      clientCacheRef.current?.agg.clear();
    } catch {}
    // Reload available years (dataset mix may differ by city) and re-apply default selection
    let cancelled = false;
    const run = async () => {
      try {
        const res = await fetch(`/api/year-range?c=${city}&v=${new Date().getUTCFullYear()}`, { cache: "no-store" });
        const j = await res.json();
        const minY = Number(j?.minYear);
        const maxY = Number(j?.maxYear);
        if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
          Promise.resolve().then(() => setFiltersVersion((v) => v + 1));
          return;
        }
        const years: number[] = [];
        for (let y = minY; y <= maxY; y++) years.push(y);
        if (!cancelled) setAvailableYears(years);
        // Default to 2022–2025 for both cities, clamped to available range
        const defStart = Math.max(2022, minY);
        const defEnd = Math.min(2025, maxY);
        if (!cancelled) { setStartYear(defStart); setEndYear(defEnd); }
      } catch {
      } finally {
        // Force immediate reload of tiles/stats/agg after city switch, after state commit
        if (!cancelled) setTimeout(() => setFiltersVersion((v) => v + 1), 0);
      }
    };
    run();
    return () => { cancelled = true; };
  }, [city]);

  // Load offense list for the current city (with client-side safety dedupe)
  useEffect(() => {
    const abort = new AbortController();
    const params = new URLSearchParams();
    params.set("city", city);
    fetch(`/api/crime-types?${params.toString()}`, { signal: abort.signal, cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        const arr = Array.isArray(data) ? (data as CrimeType[]) : [];
        // Case-insensitive dedupe by normalized key; prefer first occurrence
        const norm = (s: string) => s.trim().toUpperCase().replace(/[^A-Z0-9]+/g, " ").replace(/\s+/g, " ").trim();
        const seen = new Map<string, CrimeType>();
        for (const it of arr) {
          const key = norm(it.label || "");
          if (!key) continue;
          if (seen.has(key)) {
            const prev = seen.get(key)!;
            prev.count = Number(prev.count || 0) + Number(it.count || 0);
          } else {
            seen.set(key, { label: it.label, count: Number(it.count || 0) });
          }
        }
        setCrimeTypes(Array.from(seen.values()));
      })
      .catch(() => {});
    return () => abort.abort();
  }, [city]);

  // Load available year range and initialize dropdowns + default selection
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const res = await fetch(`/api/year-range?v=${new Date().getUTCFullYear()}`, { cache: "no-store" });
        const j = await res.json();
        const minY = Number(j?.minYear);
        const maxY = Number(j?.maxYear);
        if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return;
        const years: number[] = [];
        for (let y = minY; y <= maxY; y++) years.push(y);
        if (!cancelled) setAvailableYears(years);

        // Initialize default selection once, preferring 2022–2025 if available; otherwise last up to 4
        if (!cancelled && !yearsInitRef.current) {
          const preferred = [2022, 2023, 2024, 2025];
          const hasPreferred = preferred.every((y) => years.includes(y));
          if (hasPreferred) {
            setStartYear(2022);
            setEndYear(2025);
          } else {
            const end = years[years.length - 1];
            const start = Math.max(minY, end - 3);
            setStartYear(start);
            setEndYear(end);
          }
          yearsInitRef.current = true;
        }
      } catch {}
    };
    run();
    return () => { cancelled = true; };
  }, []);

  // Fetch stats when needed. Viewport-driven stats are disabled; rely on citywide fetch unless a neighborhood polygon is selected.
  useEffect(() => {
    if (!mapRef || !mapDrivenStats) return;
    const controller = new AbortController();
    let callId = 0;
    // Detect filter-driven reruns to avoid racing the immediate fetch effect
    const f = latestFiltersRef.current as any;
    const currSig = `${f.startISO}|${f.endISO}|${f.includeUnknown ? '1' : '0'}|vc:${(f.vclass||[]).join(',')}|of:${(f.effectiveSelectedOfns||[]).join(',')}`;
    const prevSig = prevFiltersSigRef.current || "";
    const isFilterChange = prevSig !== currSig;
    prevFiltersSigRef.current = currSig;

    let shouldRunNow = true;
    // Treat an explicit filtersVersion bump as a filter-change event and defer to the
    // immediate filter-change effect to avoid races with stale s/e values.
    const versionBump = filtersVersion !== lastFiltersVersionRef.current;
    if (versionBump) {
      shouldRunNow = false;
      lastFiltersVersionRef.current = filtersVersion;
      try { console.log("[stats] main-effect: version bump detected; deferring to immediate-fetch", { filtersVersion }); } catch {}
    } else if (isFilterChange) {
      // Let the immediate filter-change effect fetch first to prevent stale seq races
      shouldRunNow = false;
      try { console.log("[stats] main-effect: skip initial fetch due to filter change; immediate-fetch will run", { currSig }); } catch {}
    }
    const runFetch = () => {
      const id = ++callId;
      const b = mapRef.getBounds();
      if (!b) return;
      setStatsLoading(true);
      const qb = quantizeBBox(b);
      const bbox = qb.str;
      const { startISO: s, endISO: e, includeUnknown: iu, vclass: vc, effectiveSelectedOfns: ofs, emptySelectionFallback: esf } = latestFiltersRef.current as any;
      const params = new URLSearchParams({ bbox, start: s, end: e });
      if (ofs && ofs.length > 0) {
        params.set("ofns", ofs.join(","));
      } else if (vc && vc.length > 0) {
        params.set("vclass", vc.join(","));
      } else if (esf) {
        params.set("ofns", "__none__");
      }
      params.set("includeUnknown", iu ? "1" : "0");
      const seq = ++statsSeqRef.current;
      params.set("seq", String(seq));
      const t0 = performance.now();
      console.log("[stats] fetch start", { id, seq, bbox, s, e, iu, vc, ofs, esf, startYear, endYear, city, latestFilters: latestFiltersRef.current });
      // Throttle tiny camera changes (pan/zoom jitter) for ~1.2s
      try {
        const c = mapRef.getCenter();
        const z = mapRef.getZoom();
        const camKey = `${Number(z).toFixed(2)}|${Number(c.lng).toFixed(3)}|${Number(c.lat).toFixed(3)}|${s}|${e}|${iu?'1':'0'}|of:${(ofs||[]).length}|vc:${(vc||[]).length}|esf:${esf?'1':'0'}`;
        const nowMs = Date.now();
        if (lastStatsFetchRef.current.key === camKey && (nowMs - lastStatsFetchRef.current.at) < 100) {
          console.log("[stats] skip fetch (throttle)", { camKey, lastKey: lastStatsFetchRef.current.key, timeDiff: nowMs - lastStatsFetchRef.current.at });
          setTimeout(() => setStatsLoading(false), 60);
          return;
        }
        lastStatsFetchRef.current = { key: camKey, at: nowMs };
      } catch {}
      // If we already applied data for this quantized bbox AND same date range recently, skip a refetch
      const bboxDateKey = `${bbox}|${s}|${e}|${vc?.join(',')}|${ofs?.join(',')}`;
      if (lastStatsQuantRef.current === bboxDateKey && stats) {
        console.log("[stats] skip fetch (quantized unchanged)", { bboxDateKey, lastKey: lastStatsQuantRef.current, hasStats: !!stats });
        setTimeout(() => setStatsLoading(false), 60);
        return;
      }
      // Client-side short-lived cache to avoid duplicate network fetches during HMR/re-renders
      const cacheKey = params.toString();
      const cache = clientCacheRef.current!.stats;
      const now = Date.now();
      const cached = cache.get(cacheKey);
      if (cached && cached.exp > now) {
        const d = cached.data;
        const t1 = performance.now();
        if (id === callId && seq === statsSeqRef.current) { setStats(d); lastStatsQuantRef.current = bboxDateKey; console.log("[stats] apply (client-cache)", { id, seq, total: d?.total, ms: Math.round(t1 - t0) }); } else { console.log("[stats] drop stale (client-cache)", { id, seq, head: statsSeqRef.current, ms: Math.round(t1 - t0) }); }
        setTimeout(() => setStatsLoading(false), 60);
        return;
      }
      console.log(`[stats] making API call: /api/stats?${params.toString()}`);
      fetch(`/api/stats?${params.toString()}`, { cache: "no-store", signal: controller.signal })
        .then(async (r) => {
          try {
            const st = r.headers.get("server-timing") || r.headers.get("Server-Timing");
            if (st) console.log("[stats] server-timing", st);
            const seqHdr = r.headers.get("x-stats-seq") || r.headers.get("X-Stats-Seq");
            if (seqHdr) console.log("[stats] server-seq", seqHdr);
          } catch {}
          return r.json();
        })
        .then((d) => { const t1 = performance.now(); try { cache.set(cacheKey, { exp: Date.now() + 5000, data: d }); } catch {} if (id === callId && seq === statsSeqRef.current) { setStats(d); lastStatsQuantRef.current = bboxDateKey; console.log("[stats] apply", { id, seq, total: d?.total, ms: Math.round(t1 - t0) }); } else { console.log("[stats] drop stale", { id, seq, head: statsSeqRef.current, ms: Math.round(t1 - t0) }); } })
        .catch((err) => { console.warn("[stats] error", err?.message || err); })
        .finally(() => { if (id === callId) setTimeout(() => setStatsLoading(false), 60); });
    };
    if (shouldRunNow && mapDrivenStats) {
      try { console.log("[stats] main-effect: running fetch now", { currSig }); } catch {}
      runFetch();
    }
    
    // Fallback timeout to ensure loading state gets cleared
    const fallbackTimeout = setTimeout(() => {
      console.log("[stats] fallback timeout - clearing loading state");
      setStatsLoading(false);
    }, 45000);
    
    const onMoveStart = () => setStatsLoading(true);
    const debounced = (() => {
      let t: any;
      return () => { clearTimeout(t); t = setTimeout(runFetch, 80); };
    })();
    if (mapDrivenStats) {
      mapRef.on && mapRef.on("movestart", onMoveStart);
      mapRef.on && mapRef.on("moveend", debounced);
    }
    // Also listen to style reloads to refetch stats after city/style changes
    const onStyleLoad = () => { try { runFetch(); } catch {} };
    mapRef.on && mapRef.on("style.load", onStyleLoad);
    return () => {
      try {
        if (mapDrivenStats) {
          mapRef.off && mapRef.off("movestart", onMoveStart);
          mapRef.off && mapRef.off("moveend", debounced);
        }
        mapRef.off && mapRef.off("style.load", onStyleLoad);
      } catch {}
      clearTimeout(fallbackTimeout);
      controller.abort();
    };
  }, [mapRef, filtersVersion, includeUnknown, mapDrivenStats]);

  // Immediate refetch on filter changes (no debounce): use citywide or selected neighborhood polygon, not viewport
  useEffect(() => {
    if (!mapRef) return;
    if (emptySelectionFallback) { setStats(null); setStatsLoading(false); return; }
    setStatsLoading(true);
    const poly = selectedNeighborhood?.feature?.geometry;
    try { triggerSidebarStatsFetch(poly ? { poly } : undefined); } catch {}
  }, [startISO, endISO, includeUnknown, vclass, effectiveSelectedOfns, filtersVersion, mapRef, selectedNeighborhood, triggerSidebarStatsFetch]);

  // Fetch aggregated grid for current viewport to drive relative hotspots
  useEffect(() => {
    if (!mapRef) return;
    const controller = new AbortController();
    let callId = 0;
    const runFetch = () => {
      const id = ++callId;
      const b = mapRef.getBounds();
      const z = Math.round(mapRef.getZoom());
      if (!b || !z) return;
      const qb = quantizeBBox(b);
      const bbox = qb.str;
      const { startISO: s, endISO: e, includeUnknown: iu, vclass: vc, effectiveSelectedOfns: ofs, emptySelectionFallback: esf } = latestFiltersRef.current as any;
      if (esf) {
        // No data mode: clear aggregation and legend without fetching
        setAggData(null);
        setLegendRange(null);
        return;
      }
      const params = new URLSearchParams({ bbox, z: String(z), start: s, end: e });
      if (ofs && ofs.length > 0) {
        params.set("ofns", ofs.join(","));
      } else if (vc && vc.length > 0) {
        params.set("vclass", vc.join(","));
      } else if (esf) {
        params.set("ofns", "__none__");
      }
      params.set("includeUnknown", iu ? "1" : "0");
      // Throttle tiny camera changes for agg as well (~1.2s)
      try {
        const c = mapRef.getCenter();
        const camKey = `${z}|${Number(c.lng).toFixed(3)}|${Number(c.lat).toFixed(3)}|${s}|${e}|${iu?'1':'0'}|of:${(ofs||[]).length}|vc:${(vc||[]).length}|esf:${esf?'1':'0'}`;
        const nowMs = Date.now();
        if (lastAggFetchRef.current.key === camKey && (nowMs - lastAggFetchRef.current.at) < 1200) {
          console.debug("[agg] skip fetch (throttle)", { camKey });
          return;
        }
        lastAggFetchRef.current = { key: camKey, at: nowMs };
      } catch {}
      const t0 = performance.now();
      const aggKey = `${bbox}|${s}|${e}|${vc?.join(',')}|${ofs?.join(',')}`;
      if (lastAggQuantRef.current === aggKey && aggData) {
        console.debug("[agg] skip fetch (quantized unchanged)");
        return;
      }
      const cacheKey = params.toString();
      const cache = clientCacheRef.current!.agg;
      const now = Date.now();
      const cached = cache.get(cacheKey);
      if (cached && cached.exp > now) {
        const fc = cached.data;
        if (id !== callId) return;
        setAggData(fc);
        const rawCounts: number[] = (fc?.features || []).map((f: any) => f.properties?.count || 0);
        const counts: number[] = [...rawCounts].sort((a: number, b: number) => a - b);
        if (counts.length > 0) {
          const min = counts[0];
          const max = counts[counts.length - 1];
          const median = counts[Math.floor(counts.length / 2)] || 0;
          const p995 = counts[Math.max(0, Math.floor(0.995 * (counts.length - 1)))] || max;
          const scaled = Math.max(max, Math.round(p995 * 1.6));
          const displayMax = Math.max(1, scaled);
          setLegendRange({ min, median, max: displayMax });
        } else {
          setLegendRange({ min: 0, median: 0, max: 0 });
        }
        const t1 = performance.now();
        lastAggQuantRef.current = aggKey;
        console.debug("[agg] apply (client-cache)", { id, cells: (fc?.features||[]).length, ms: Math.round(t1 - t0) });
        return;
      }
      fetch(`/api/aggregate?${params.toString()}`, { signal: controller.signal, cache: "no-store" })
        .then(async (r) => {
          try {
            const st = r.headers.get("server-timing") || r.headers.get("Server-Timing");
            if (st) console.debug("[agg] server-timing", st);
            const seqHdr = r.headers.get("x-agg-seq") || r.headers.get("X-Agg-Seq");
            if (seqHdr) console.debug("[agg] server-seq", seqHdr);
          } catch {}
          return r.json();
        })
        .then((fc) => {
          if (id !== callId) return;
          setAggData(fc);
          const rawCounts: number[] = (fc?.features || []).map((f: any) => f.properties?.count || 0);
          const counts: number[] = [...rawCounts].sort((a: number, b: number) => a - b);
          if (counts.length > 0) {
            const min = counts[0];
            const max = counts[counts.length - 1];
            const median = counts[Math.floor(counts.length / 2)] || 0;
            const p995 = counts[Math.max(0, Math.floor(0.995 * (counts.length - 1)))] || max;
            const scaled = Math.max(max, Math.round(p995 * 1.6));
            const displayMax = Math.max(1, scaled);
            setLegendRange({ min, median, max: displayMax });
          } else {
            setLegendRange({ min: 0, median: 0, max: 0 });
          }
          try { cache.set(cacheKey, { exp: Date.now() + 15000, data: fc }); lastAggQuantRef.current = aggKey; } catch {}
          const t1 = performance.now();
          console.debug("[agg] apply", { id, cells: (fc?.features||[]).length, ms: Math.round(t1 - t0) });
        })
        .catch(() => {});
    };
    if (mapDrivenStats) {
      runFetch();
      const debounced = (() => { let t: any; return () => { clearTimeout(t); t = setTimeout(runFetch, 80); }; })();
      mapRef.on && mapRef.on("moveend", debounced);
      return () => { try { mapRef.off && mapRef.off("moveend", debounced); } catch {}; controller.abort(); };
    }
    return () => { controller.abort(); };
  }, [mapRef, filtersVersion, includeUnknown]);

  // Helpers for filters
  const toggleCategory = (key: "violent" | "nonviolent") => {
    setVclass((prev) => {
      const on = prev.includes(key);
      const next = on ? prev.filter((v) => v !== key) : [...prev, key];
      setSelectedOfns((sel) => {
        const allInCat = (key === "violent" ? violentOfns : nonviolentOfns);
        if (!on) {
          return sel;
        }
        const stillOn = next.includes(key);
        if (stillOn) return sel;
        const otherCatOn = next.includes(key === "violent" ? "nonviolent" : "violent");
        if (otherCatOn) {
          return sel.filter((l) => !allInCat.includes(l));
        }
        return [];
      });
      return next;
    });
    // bump version so tiles/stats refetch immediately
    setFiltersVersion((v) => v + 1);
  };
  const baselineAllActive = useMemo(() => {
    const arr: string[] = [];
    if (violentOn) arr.push(...violentOfns);
    if (nonviolentOn) arr.push(...nonviolentOfns);
    return Array.from(new Set(arr));
  }, [violentOn, nonviolentOn, violentOfns, nonviolentOfns]);
  const toggleOffense = (label: string, _categoryOn: boolean) => {
    setSelectedOfns((sel) => {
      if (sel.length === 0) {
        // Start explicit selection from empty when nothing chosen yet
        return [label];
      }
      const set = new Set(sel);
      if (set.has(label)) set.delete(label); else set.add(label);
      return Array.from(set);
    });
    setFiltersVersion((v) => v + 1);
  };
  const activeFilterCount = useMemo(() => {
    const catOffs = (violentOn ? 0 : 1) + (nonviolentOn ? 0 : 1);
    const ofnsCount = effectiveSelectedOfns.length;
    return catOffs + ofnsCount;
  }, [violentOn, nonviolentOn, effectiveSelectedOfns]);

  const formatNumber = (value: any): string => {
    if (value === null || value === undefined) return "–";
    const num = typeof value === "number" ? value : Number(value);
    if (!isFinite(num)) return String(value);
    return num.toLocaleString();
  };

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
    const onMove = (e: any) => {
      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      setPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
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
    const onMove = (e: any) => {
      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      setPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
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
    const monthLabel = (ym: string) => {
      const [y, m] = ym.split("-").map((v) => Number(v));
      if (!y || !m) return ym;
      return `${monthNames[m - 1]} ${String(y).slice(2)}`;
    };

    const [hover, setHover] = useState<null | { month: string; count: number; label?: string }>(null);
    const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
    const tipRef = useRef<HTMLDivElement | null>(null);
    const onMove = (e: any) => {
      const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
      setPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
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
                  key={d.month + i}
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

  // Helpers for month labels
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const mkMonthLabel = (ym: string) => {
    const [y, m] = ym.split("-").map((v) => Number(v));
    if (!y || !m) return ym;
    return `${monthNames[(m - 1 + 12) % 12]} ${String(y).slice(2)}`;
  };

  // Series rendered in the chart (labels adapt to monthly vs yearly)
  const chartSeries: { month: string; count: number; label?: string }[] = useMemo(() => {
    const base = (stats?.timeseries || []) as { month: string; count: number }[];
    const step = Number((stats as any)?.seriesStepMonths || 1);
    const isYearly = step >= 12;
    return base.map((d) => ({
      ...d,
      label: isYearly ? d.month : mkMonthLabel(d.month),
    }));
  }, [stats?.timeseries, (stats as any)?.seriesStepMonths]);

  // Force chart remount when dataset actually changes to avoid any stale SVG artifacts
  const chartKey = useMemo(() => {
    const parts: string[] = [];
    for (let i = 0; i < chartSeries.length; i++) {
      const d = chartSeries[i];
      parts.push(d.month + ":" + (Number(d.count) || 0));
    }
    return parts.join("|");
  }, [chartSeries]);

  // Top suspect/victim race pairs derived from matrix
  const topRacePairs = useMemo(() => {
    const r = stats?.raceOnRace;
    if (!r) return [] as { label: string; count: number; tooltip?: string }[];
    const pairs: { label: string; count: number; tooltip?: string }[] = [];
    for (let ri = 0; ri < r.victims.length; ri++) {
      const v = r.victims[ri];
      for (let ci = 0; ci < r.suspects.length; ci++) {
        const s = r.suspects[ci];
        const c = Number(r.counts?.[ri]?.[ci] || 0);
        if (c > 0) pairs.push({ label: `${s} / ${v}`, count: c });
      }
    }
    return pairs.sort((a, b) => b.count - a.count);
  }, [stats?.raceOnRace]);

  // Top suspect/victim sex pairs derived from matrix
  const topSexPairs = useMemo(() => {
    const r = stats?.sexOnSex;
    if (!r) return [] as { label: string; count: number; tooltip?: string }[];
    const pairs: { label: string; count: number; tooltip?: string }[] = [];
    for (let ri = 0; ri < r.victims.length; ri++) {
      const v = r.victims[ri];
      for (let ci = 0; ci < r.suspects.length; ci++) {
        const s = r.suspects[ci];
        const c = Number(r.counts?.[ri]?.[ci] || 0);
        if (c > 0) pairs.push({ label: `${s} / ${v}`, count: c });
      }
    }
    return pairs.sort((a, b) => b.count - a.count);
  }, [stats?.sexOnSex]);

  // Helpers for abbreviations and pretty labels (for Sex+Race combined)
  const abbrSex = (s: string) => (s === "MALE" ? "M" : s === "FEMALE" ? "W" : s === "UNKNOWN" ? "Unk" : s);
  const prettySex = (s: string) => (s === "MALE" ? "Man" : s === "FEMALE" ? "Woman" : s === "UNKNOWN" ? "Unknown" : s);
  const abbrRace = (r: string) => {
    const R = r.toUpperCase();
    if (R === "BLACK") return "Bl";
    if (R === "WHITE") return "Wh";
    if (R === "WHITE HISPANIC") return "Whh";
    if (R === "BLACK HISPANIC") return "Blh";
    if (R === "ASIAN / PACIFIC ISLANDER") return "As";
    if (R === "AMERICAN INDIAN/ALASKAN NATIVE") return "AI";
    if (R === "OTHER HISPANIC") return "Othh";
    if (R === "OTHER") return "Oth";
    if (R === "UNKNOWN") return "Unk";
    return R.slice(0, 3);
  };
  const prettyRace = (r: string) => {
    const R = r.toUpperCase();
    if (R === "BLACK") return "Black";
    if (R === "WHITE") return "White";
    if (R === "WHITE HISPANIC") return "White Hispanic";
    if (R === "BLACK HISPANIC") return "Black Hispanic";
    if (R === "ASIAN / PACIFIC ISLANDER") return "Asian / Pacific Islander";
    if (R === "AMERICAN INDIAN/ALASKAN NATIVE") return "American Indian/Alaskan Native";
    if (R === "OTHER HISPANIC") return "Other Hispanic";
    if (R === "OTHER") return "Other";
    if (R === "UNKNOWN") return "Unknown";
    return R
      .toLowerCase()
      .split(" ")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  };

  // Top suspect/victim sex+race pairs from combined matrix
  const topBothPairs = useMemo(() => {
    const r = (stats as any)?.sexRaceOnSexRace as { suspects: string[]; victims: string[]; counts: number[][] } | undefined;
    if (!r) return [] as { label: string; count: number; tooltip?: string }[];
    const pairs: { label: string; count: number; tooltip?: string }[] = [];
    for (let ri = 0; ri < r.victims.length; ri++) {
      const v = r.victims[ri];
      const [vs, vr] = String(v || "").split("+", 2);
      for (let ci = 0; ci < r.suspects.length; ci++) {
        const s = r.suspects[ci];
        const [ss, sr] = String(s || "").split("+", 2);
        const c = Number(r.counts?.[ri]?.[ci] || 0);
        if (c > 0) {
          const sAbbr = `${abbrRace(sr)}+${abbrSex(ss)}`;
          const vAbbr = `${abbrRace(vr)}+${abbrSex(vs)}`;
          const sFull = `${prettyRace(sr)} ${prettySex(ss)}`;
          const vFull = `${prettyRace(vr)} ${prettySex(vs)}`;
          pairs.push({ label: `${sAbbr} / ${vAbbr}`, tooltip: `${sFull} / ${vFull}`, count: c });
        }
      }
    }
    return pairs.sort((a, b) => b.count - a.count);
  }, [stats]);

  type PairsMode = "race" | "sex" | "both";
  const [pairsMode, setPairsMode] = useState<PairsMode>("race");
  const [pairsLocalLoading, setPairsLocalLoading] = useState<boolean>(false);
  const onChangePairsMode = (mode: PairsMode) => {
    setPairsMode(mode);
    setPairsLocalLoading(true);
    setTimeout(() => setPairsLocalLoading(false), 250);
  };
  const pairsData = useMemo(() => {
    if (pairsMode === "race") return topRacePairs;
    if (pairsMode === "sex") return topSexPairs;
    return topBothPairs;
  }, [pairsMode, topRacePairs, topSexPairs, topBothPairs]);

  // Robust start→end trend using Theil–Sen on log-counts across the full selected period
  // Returns avg monthly change, total change, CAGR-style monthly change, and a trend line to overlay
  const trendStats = useMemo(() => {
    // Drop trailing months that are clearly partial/no-data (zeros) to avoid biasing end behavior
    const rawVals = chartSeries.map((d) => Math.max(0, Number(d.count) || 0));
    let lastIdx = rawVals.length - 1;
    while (lastIdx > 0 && rawVals[lastIdx] === 0) lastIdx--;
    const values = rawVals.slice(0, lastIdx + 1);
    const n = values.length;
    if (n < 3) return null;
    const stepMonths = Number((stats as any)?.seriesStepMonths || 1);
    const eps = 1; // stabilizer for zeros in log space
    const logs = values.map((v) => Math.log(v + eps));
    const slopes: number[] = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = j - i;
        if (dx <= 0) continue;
        const s = (logs[j] - logs[i]) / dx; // per bar
        if (Number.isFinite(s)) slopes.push(s);
      }
    }
    if (!slopes.length) return null;
    const median = (arr: number[]) => {
      const s = [...arr].sort((a, b) => a - b);
      const mid = (s.length - 1) / 2;
      const lo = Math.floor(mid), hi = Math.ceil(mid);
      return (s[lo] + s[hi]) / 2;
    };
    const slopePerBar = median(slopes);
    if (!Number.isFinite(slopePerBar)) return null;
    const intercept = median(logs.map((y, i) => y - slopePerBar * i));
    const slopePerMonth = slopePerBar / stepMonths;
    const avgMonthlyPct = Math.exp(slopePerMonth) - 1; // average multiplicative change per calendar month

    const first = values[0];
    const last = values[n - 1];
    const totalPct = first > 0 ? last / first - 1 : (last > 0 ? 1 : 0);
    const totalMonths = Math.max(1, (n - 1) * stepMonths);
    const cagrMonthlyPct = first > 0 ? Math.pow(Math.max(1e-9, last / first), 1 / totalMonths) - 1 : 0;

    const line = Array.from({ length: chartSeries.length }, (_, i) => {
      if (i >= n) return null; // don't extrapolate past last reliable month
      const v = Math.exp(intercept + slopePerBar * i) - eps;
      return Math.max(0, v);
    });
    return { avgMonthlyPct, totalPct, cagrMonthlyPct, line, windowMonths: totalMonths };
  }, [chartSeries, (stats as any)?.seriesStepMonths]);

  // Reload tiles when filters change (tile URL or style), not on aggregation updates
  useEffect(() => {
    if (!mapRef) return;
    const apply = () => addOrReloadTiles(mapRef, tileURL, setLoadingTiles, aggData, legendRange);
    try {
      if (mapRef.isStyleLoaded && mapRef.isStyleLoaded()) {
        const t0 = performance.now();
        apply();
        const t1 = performance.now();
        console.debug("[map] tiles reload", { ms: Math.round(t1 - t0) });
      } else if (mapRef.on) {
        const onLoad = () => {
          try { const t0 = performance.now(); apply(); const t1 = performance.now(); console.debug("[map] tiles reload (style.load)", { ms: Math.round(t1 - t0) }); } finally { try { mapRef.off && mapRef.off("style.load", onLoad); } catch {} }
        };
        mapRef.on("style.load", onLoad);
        return () => { try { mapRef.off && mapRef.off("style.load", onLoad); } catch {} };
      } else {
        const t = setTimeout(apply, 100);
        return () => clearTimeout(t);
      }
    } catch {}
  }, [tileURL, mapRef, filtersVersion]);

  // Update choropleth when aggregation or legend changes
  useEffect(() => {
    if (!mapRef) return;
    try {
      updateAggChoropleth(mapRef, aggData, legendRange);
    } catch {}
  }, [mapRef, aggData, legendRange]);

  return (
    <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", width: "100vw", height: isMobile ? "auto" : "100vh" }}>
      {/* Map container */}
      <div style={{ flex: isMobile ? "0 0 auto" : 1, position: "relative", width: isMobile ? "100vw" : "auto" }}>
        <div ref={containerRef} style={{ width: "100%", height: isMobile ? viewportWidth : "100%" }} />

        {mapShimmering && (
          <div
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              zIndex: 9,
              textAlign: "center",
              pointerEvents: "none",
            }}
          >
            <div className="font-cabinet font-bold" style={{ fontSize: 18, lineHeight: 1.1 }}>
              <RotatingLoadingText
                messages={["Getting crime data", "Can take ~1 minute", "Almost done"]}
                staticMessage={(!mapShimmering && statsLoading) ? "Loading now" : undefined}
                resetKey={rotatorResetKey}
              />
            </div>
          </div>
        )}

        {/* Desktop-only Filters pinned top-left */}
        {!isMobile && (
          <div
            style={{
              position: "absolute",
              top: 12,
              left: 12,
              zIndex: 11,
              fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
            }}
          >
            <div style={{ position: "relative", flex: "0 0 auto" }}>
              <button onClick={() => setFiltersOpen((v) => !v)} style={{ display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0, 0, 0, 0.3)", backdropFilter: "blur(10px)", border: "none", color: "#fff", padding: 8, borderRadius: 9999, cursor: "pointer", height: 40, width: 40 }}>
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" shapeRendering="crispEdges" style={{ width: 20, height: 20, opacity: 0.9 }}>
                  <path vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 1 1-3 0m3 0a1.5 1.5 0 1 0-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-9.75 0h9.75" />
                </svg>
              </button>
              <div style={{ position: "absolute", top: -6, right: -6, background: activeFilterCount > 0 ? "#2563eb" : "#374151", color: "#fff", borderRadius: 9999, padding: "2px 6px", fontSize: 11, fontWeight: 700, minWidth: 18, textAlign: "center", lineHeight: 1 }}>
                {activeFilterCount}
              </div>
              {filtersOpen && (
                <div
                  style={{
                    position: "absolute",
                    top: "calc(100% + 8px)",
                    left: 0,
                    zIndex: 20,
                    width: Math.min(360, Math.max(220, viewportWidth - 32)),
                    height: 400,
                    overflowY: "auto",
                    background: "rgba(0, 0, 0, 0.4)",
                    backdropFilter: "blur(10px)",
                    borderRadius: 12,
                    padding: 12,
                    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
                  }}
                >
                  <div style={{ marginBottom: 8, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <label style={{ fontSize: 13, fontWeight: 600 }}>Years</label>
                    <button
                      type="button"
                      onClick={(e) => { e.preventDefault(); setVclass([]); setSelectedOfns([]); setStats(null); setAggData(null); setLegendRange(null); setFiltersVersion((v)=>v+1); try { if (mapRef && typeof mapRef.setPaintProperty === 'function') { mapRef.setPaintProperty('neighborhood-boundaries', 'fill-color', '#6b7280'); mapRef.setPaintProperty('neighborhood-boundaries', 'fill-opacity', 0.16); mapRef.setPaintProperty('neighborhood-boundaries', 'fill-outline-color', '#A3A3A3'); } } catch {} }}
                      style={{ background: "transparent", border: "none", color: "#e5e7eb", cursor: "pointer", fontSize: 12, padding: 0 }}
                    >
                      Clear all
                    </button>
                  </div>
                  <div style={{ marginTop: 4, display: "flex", gap: 8, alignItems: "center", flexWrap: viewportWidth <= 360 ? "wrap" : undefined }}>
                    <select
                      value={startYear}
                      onChange={(e) => {
                        const y = Number(e.target.value);
                        console.log(`[Start Year Change] Selected: ${y}, current endYear: ${endYear}`);
                        if (!Number.isFinite(y)) return;
                        if (y > endYear) {
                          console.log(`[Start Year Change] Setting both years to ${y}`);
                          setStartYear(y);
                          setEndYear(y);
                          setFiltersVersion((v) => v + 1);
                        } else {
                          console.log(`[Start Year Change] Setting startYear to ${y}`);
                          setStartYear(y);
                          setFiltersVersion((v) => v + 1);
                        }
                      }}
                      style={{ fontSize: 12, padding: "4px 8px", borderRadius: 6, background: "#111", color: "#fff", border: "1px solid #444" }}
                    >
                      {availableYears.map((y) => (
                        <option key={y} value={y}>{y}</option>
                      ))}
                    </select>
                    <span style={{ opacity: 0.9, color: "rgba(255,255,255,0.9)", fontSize: 12 }}>to</span>
                    <select
                      value={endYear}
                      onChange={(e) => {
                        const y = Number(e.target.value);
                        console.log(`[End Year Change] Selected: ${y}, current startYear: ${startYear}`);
                        if (!Number.isFinite(y)) return;
                        if (y < startYear) {
                          console.log(`[End Year Change] Setting both years to ${y}`);
                          setStartYear(y);
                          setEndYear(y);
                          setFiltersVersion((v) => v + 1);
                        } else {
                          console.log(`[End Year Change] Setting endYear to ${y}`);
                          setEndYear(y);
                          setFiltersVersion((v) => v + 1);
                        }
                      }}
                      style={{ fontSize: 12, padding: "4px 8px", borderRadius: 6, background: "#111", color: "#fff", border: "1px solid #444" }}
                    >
                      {availableYears.map((y) => (
                        <option key={y} value={y}>{y}</option>
                      ))}
                    </select>
                  </div>

                  {/* Violent section */}
                  <div style={{ marginTop: 14, borderTop: "1px solid #333", paddingTop: 12 }}>
                    <div style={{ display: "flex", alignItems: "center" }}>
                      <div style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>Violent crimes</div>
                      <input type="checkbox" checked={violentOn} onChange={() => toggleCategory("violent")} />
                    </div>
                    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6, opacity: violentOn ? 1 : 0.9 }}>
                      {violentOfns.map((label) => {
                        const isChecked = selectedOfns.length > 0 ? effectiveSelectedOfns.includes(label) : violentOn;
                        return (
                          <div key={label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <div style={{ fontSize: 12, flex: 1, color: "rgba(255,255,255,0.9)" }}>{label}</div>
                            <input type="checkbox" checked={isChecked} onChange={() => toggleOffense(label, violentOn)} />
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Non-violent section */}
                  <div style={{ marginTop: 20, borderTop: "1px solid #333", paddingTop: 12 }}>
                    <div style={{ display: "flex", alignItems: "center" }}>
                      <div style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>Non-violent crimes</div>
                      <input type="checkbox" checked={nonviolentOn} onChange={() => toggleCategory("nonviolent")} />
                    </div>
                    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6, opacity: nonviolentOn ? 1 : 0.9 }}>
                      {nonviolentOfns.map((label) => {
                        const isChecked = selectedOfns.length > 0 ? effectiveSelectedOfns.includes(label) : nonviolentOn;
                        return (
                          <div key={label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <div style={{ fontSize: 12, flex: 1, color: "rgba(255,255,255,0.9)" }}>{label}</div>
                            <input type="checkbox" checked={isChecked} onChange={() => toggleOffense(label, nonviolentOn)} />
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {loadingTiles ? (
                    <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>Loading tiles…</div>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Top controls: Filters (left on mobile) + Search (flex), centered on desktop */}
        <div
          ref={cityDropdownRef}
          style={{
            position: "absolute",
            top: 12,
            left: isMobile ? 12 : "50%",
            transform: isMobile ? undefined : "translateX(-50%)",
            zIndex: 10,
            fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          }}
        >
          {/* Top row container (leave ~96px on the right for MapLibre controls) */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, width: (isMobile
            ? Math.min(640, Math.max(200, viewportWidth - 24 - 96))
            : Math.min(308, Math.max(240, viewportWidth - 24 - 96 - 400))) }}>
            {/* Filters trigger (icon-only) — mobile/tablet only */}
            {isMobile && (
            <div style={{ position: "relative", flex: "0 0 auto" }}>
              <button onClick={() => setFiltersOpen((v) => !v)} style={{ display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0, 0, 0, 0.3)", backdropFilter: "blur(10px)", border: "none", color: "#fff", padding: 8, borderRadius: 9999, cursor: "pointer", height: 40, width: 40 }}>
                {/* Heroicons adjustments-horizontal (outline) */}
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" shapeRendering="crispEdges" style={{ width: 20, height: 20, opacity: 0.9 }}>
                  <path vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 1 1-3 0m3 0a1.5 1.5 0 1 0-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-9.75 0h9.75" />
                </svg>
              </button>
              <div style={{ position: "absolute", top: -6, right: -6, background: activeFilterCount > 0 ? "#2563eb" : "#374151", color: "#fff", borderRadius: 9999, padding: "2px 6px", fontSize: 11, fontWeight: 700, minWidth: 18, textAlign: "center", lineHeight: 1 }}>
                {activeFilterCount}
              </div>
               {filtersOpen && (
                <div
                  style={{
                    position: "absolute",
                    top: "calc(100% + 8px)",
                    left: 0,
                    zIndex: 20,
                     width: isMobile ? Math.min(360, Math.max(220, viewportWidth - 32)) : Math.min(360, Math.max(240, viewportWidth - 32)),
                    height: 400,
                    overflowY: "auto",
                    background: "rgba(0, 0, 0, 0.4)",
                    backdropFilter: "blur(10px)",
                    borderRadius: 12,
                    padding: 12,
                    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
                  }}
                >
                  {/* Years header + Clear all */}
                  <div style={{ marginBottom: 8, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <label style={{ fontSize: 13, fontWeight: 600 }}>Years</label>
                    <button
                      type="button"
                      onClick={(e) => { e.preventDefault(); setVclass([]); setSelectedOfns([]); setStats(null); setAggData(null); setLegendRange(null); setFiltersVersion((v)=>v+1); try { if (mapRef && typeof mapRef.setPaintProperty === 'function') { mapRef.setPaintProperty('neighborhood-boundaries', 'fill-color', '#6b7280'); mapRef.setPaintProperty('neighborhood-boundaries', 'fill-opacity', 0.16); mapRef.setPaintProperty('neighborhood-boundaries', 'fill-outline-color', '#A3A3A3'); } } catch {} }}
                      style={{ background: "transparent", border: "none", color: "#e5e7eb", cursor: "pointer", fontSize: 12, padding: 0 }}
                    >
                      Clear all
                    </button>
                  </div>
                  <div style={{ marginTop: 4, display: "flex", gap: 8, alignItems: "center", flexWrap: viewportWidth <= 360 ? "wrap" : undefined }}>
                    <select
                      value={startYear}
                      onChange={(e) => {
                        const y = Number(e.target.value);
                        console.log(`[Start Year Change] Selected: ${y}, current endYear: ${endYear}`);
                        if (!Number.isFinite(y)) return;
                        if (y > endYear) {
                          console.log(`[Start Year Change] Setting both years to ${y}`);
                          setStartYear(y);
                          setEndYear(y);
                          setFiltersVersion((v) => v + 1);
                        } else {
                          console.log(`[Start Year Change] Setting startYear to ${y}`);
                          setStartYear(y);
                          setFiltersVersion((v) => v + 1);
                        }
                      }}
                      style={{ fontSize: 12, padding: "4px 8px", borderRadius: 6, background: "#111", color: "#fff", border: "1px solid #444" }}
                    >
                      {availableYears.map((y) => (
                        <option key={y} value={y}>{y}</option>
                      ))}
                    </select>
                    <span style={{ opacity: 0.9, color: "rgba(255,255,255,0.9)", fontSize: 12 }}>to</span>
                    <select
                      value={endYear}
                      onChange={(e) => {
                        const y = Number(e.target.value);
                        console.log(`[End Year Change] Selected: ${y}, current startYear: ${startYear}`);
                        if (!Number.isFinite(y)) return;
                        if (y < startYear) {
                          console.log(`[End Year Change] Setting both years to ${y}`);
                          setStartYear(y);
                          setEndYear(y);
                          setFiltersVersion((v) => v + 1);
                        } else {
                          console.log(`[End Year Change] Setting endYear to ${y}`);
                          setEndYear(y);
                          setFiltersVersion((v) => v + 1);
                        }
                      }}
                      style={{ fontSize: 12, padding: "4px 8px", borderRadius: 6, background: "#111", color: "#fff", border: "1px solid #444" }}
                    >
                      {availableYears.map((y) => (
                        <option key={y} value={y}>{y}</option>
                      ))}
                    </select>
                  </div>

                  {/* Violent section */}
                  <div style={{ marginTop: 14, borderTop: "1px solid #333", paddingTop: 12 }}>
                    <div style={{ display: "flex", alignItems: "center" }}>
                      <div style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>Violent crimes</div>
                      <input type="checkbox" checked={violentOn} onChange={() => toggleCategory("violent")} />
                    </div>
                    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6, opacity: violentOn ? 1 : 0.9 }}>
                      {violentOfns.map((label) => {
                        const isChecked = selectedOfns.length > 0 ? effectiveSelectedOfns.includes(label) : violentOn;
                        return (
                          <div key={label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <div style={{ fontSize: 12, flex: 1, color: "rgba(255,255,255,0.9)" }}>{label}</div>
                            <input type="checkbox" checked={isChecked} onChange={() => toggleOffense(label, violentOn)} />
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Non-violent section */}
                  <div style={{ marginTop: 20, borderTop: "1px solid #333", paddingTop: 12 }}>
                    <div style={{ display: "flex", alignItems: "center" }}>
                      <div style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>Non-violent crimes</div>
                      <input type="checkbox" checked={nonviolentOn} onChange={() => toggleCategory("nonviolent")} />
                    </div>
                    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6, opacity: nonviolentOn ? 1 : 0.9 }}>
                      {nonviolentOfns.map((label) => {
                        const isChecked = selectedOfns.length > 0 ? effectiveSelectedOfns.includes(label) : nonviolentOn;
                        return (
                          <div key={label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <div style={{ fontSize: 12, flex: 1, color: "rgba(255,255,255,0.9)" }}>{label}</div>
                            <input type="checkbox" checked={isChecked} onChange={() => toggleOffense(label, nonviolentOn)} />
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {loadingTiles ? (
                    <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>Loading tiles…</div>
                  ) : null}
                </div>
              )}
            </div>
            )}

            {/* Search (flexible width, on the right) */}
            <div
              onClick={() => setCityDropdownOpen(!cityDropdownOpen)}
              style={{
                background: "rgba(0, 0, 0, 0.3)",
                backdropFilter: "blur(10px)",
                color: "#fff",
                padding: "8px 16px",
                borderRadius: 100,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                cursor: "pointer",
                height: 40,
                flex: 1,
                minWidth: 0,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                {/* Search Icon */}
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" style={{ width: 16, height: 16, opacity: 0.6 }}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
                </svg>
                {/* Location Text */}
                <span style={{ fontSize: 15, fontWeight: 500, marginLeft: 4, transform: "translateY(-1px)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {city === "nyc" ? "New York City" : "San Francisco"}
                </span>
              </div>
              {/* Down Chevron */}
              <svg 
                xmlns="http://www.w3.org/2000/svg" 
                fill="none" 
                viewBox="0 0 24 24" 
                strokeWidth={1.5} 
                stroke="currentColor" 
                style={{ 
                  width: 14, 
                  height: 14, 
                  opacity: 0.8,
                  transform: cityDropdownOpen ? "rotate(180deg)" : "rotate(0deg)",
                  transition: "transform 0.2s ease"
                }}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
              </svg>
            </div>
          </div>

          {/* Dropdown */}
          {cityDropdownOpen && (
            <div
              style={{
                position: "absolute",
                top: "100%",
                left: 0,
                right: 0,
                marginTop: 8,
                background: "rgba(0, 0, 0, 0.4)",
                backdropFilter: "blur(10px)",
                borderRadius: 12,
                overflow: "hidden",
                boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
              }}
            >
              <div
                onClick={() => {
                  setCity("nyc");
                  setCityDropdownOpen(false);
                }}
                style={{
                  padding: "12px 24px",
                  color: "#fff",
                  cursor: "pointer",
                  fontSize: 14,
                  fontWeight: 500,
                  backgroundColor: city === "nyc" ? "rgba(255, 255, 255, 0.1)" : "transparent",
                  borderBottom: "1px solid rgba(255, 255, 255, 0.1)",
                }}
                onMouseEnter={(e) => {
                  if (city !== "nyc") {
                    e.currentTarget.style.backgroundColor = "rgba(255, 255, 255, 0.05)";
                  }
                }}
                onMouseLeave={(e) => {
                  if (city !== "nyc") {
                    e.currentTarget.style.backgroundColor = "transparent";
                  }
                }}
              >
                New York City
              </div>
              <div
                onClick={() => {
                  setCity("sf");
                  setCityDropdownOpen(false);
                }}
                style={{
                  padding: "12px 24px",
                  color: "#fff",
                  cursor: "pointer",
                  fontSize: 14,
                  fontWeight: 500,
                  backgroundColor: city === "sf" ? "rgba(255, 255, 255, 0.1)" : "transparent",
                }}
                onMouseEnter={(e) => {
                  if (city !== "sf") {
                    e.currentTarget.style.backgroundColor = "rgba(255, 255, 255, 0.05)";
                  }
                }}
                onMouseLeave={(e) => {
                  if (city !== "sf") {
                    e.currentTarget.style.backgroundColor = "transparent";
                  }
                }}
              >
                San Francisco
              </div>
            </div>
          )}
        </div>

        {/* (Old controls overlay removed, now integrated into top row) */}

        {/* Legend */}
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
            <div style={{ width: "100%", height: 10, background: "linear-gradient(90deg, #0066FF, #00BFFF, #00FFCC, #7CFF66, #D9FF3D, #FF9900, #FF3D00)", borderRadius: 2 }} />
          </div>
          {legendRange ? (
            <div style={{ marginTop: 6, display: "flex", justifyContent: "space-between", opacity: 0.85 }}>
              <span>{legendRange.min}</span>
              <span>median {legendRange.median}</span>
              <span>{legendRange.max}</span>
            </div>
          ) : null}
        </div>
      </div>

      {/* Sidebar with tiles */}
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
              {selectedNeighborhood?.name || (city === "nyc" ? "New York City" : "San Francisco")}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Total incidents tile */}
              <div style={{ background: "#4D4D4D", borderRadius: 8, padding: 20, textAlign: "center" }}>
                <div style={{ fontSize: 44, fontWeight: 800, lineHeight: 1 }}>{formatNumber(stats?.total)}</div>
                <div style={{ marginTop: 6, fontSize: 16, opacity: 0.9 }}>total incidents</div>
                {city === "nyc" ? (
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
              {((stats as any)?.hasDemographics !== false) && ((stats?.byRace?.length || 0) > 0 || (stats?.byAge?.length || 0) > 0) ? (
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
              {((stats as any)?.hasDemographics !== false) && (pairsData.length > 0 || pairsLocalLoading) ? (
                <div style={{ background: "#4D4D4D", borderRadius: 8, padding: 16 }}>
                  <div style={{ margin: "0 0 8px 0", display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
                    <div style={{ ...textStyles.header }}>Suspect / Victim pairs</div>
                    <div style={{ display: "flex", gap: 6 }}>
                      {([
                        { key: "race", label: "Race" },
                        { key: "sex", label: "Sex" },
                        { key: "both", label: "Both" },
                      ] as { key: any; label: string }[]).map((opt) => {
                        const active = pairsMode === opt.key;
                        return (
                          <button
                            key={opt.key}
                            onClick={() => onChangePairsMode(opt.key)}
                            style={{ fontSize: 12, padding: "4px 8px", borderRadius: 12, border: "1px solid #666", background: active ? "#334155" : "#111", color: "#fff", cursor: "pointer" }}
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
                      <HBarList data={pairsData} width={isMobile ? Math.min(360, viewportWidth - 40) : 360} />
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
                  <BarChart key={chartKey} data={chartSeries} width={isMobile ? Math.min(360, viewportWidth - 40) : 360} height={140} trendLine={trendStats?.line} />
                </div>
              </div>
            </div>
          </>
        )}
        {/* Sources footer */}
        <div style={{ marginTop: "auto", paddingTop: 12, borderTop: "1px solid #444", fontSize: 11, color: "#6b7280" }}>
          <span>Sources: </span>
          {(city === "nyc"
            ? [
                "https://data.cityofnewyork.us/Public-Safety/NYPD-Complaint-Data-Historic/qgea-i56i/about_data",
                "https://data.cityofnewyork.us/Public-Safety/NYPD-Complaint-Data-Current-Year-To-Date-/5uac-w243/about_data",
                "https://data.cityofnewyork.us/Public-Safety/NYPD-Shooting-Incident-Data-Historic-/833y-fsy8/about_data",
                "https://data.cityofnewyork.us/Public-Safety/NYPD-Shooting-Incident-Data-Year-To-Date-/5ucz-vwe8/about_data",
              ]
            : [
                "https://data.sfgov.org/Public-Safety/Police-Department-Incident-Reports-2018-to-Present/wg3w-h783/about_data",
                "https://data.sfgov.org/Public-Safety/Police-Department-Incident-Reports-Historical-2003/tmnf-yvry/about_data",
              ]
          ).map((href, idx, arr) => (
            <span key={href}>
              <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: "#9ca3af" }}>{idx + 1}</a>
              {idx < arr.length - 1 ? <span>, </span> : null}
            </span>
          ))}
        </div>
        </div>
      </div>
    </div>
  );
}

function addOrReloadTiles(map: any, tileURL: string, setLoading?: (v: boolean) => void, aggFcParam?: any, legendRangeParam?: { min: number; median: number; max: number } | null) {
  const aggSourceId = "nypd-agg";
  const aggLayerId = "nypd-agg-hex";
  const aggOutlineLayerId = `${aggLayerId}-outline`;

  // Helper: quantile from sorted array
  const quantile = (sorted: number[], p: number) => {
    if (!sorted.length) return 0;
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1))));
    return sorted[idx];
  };

  const removeIfExists = () => {
    try { if (map.getLayer(aggLayerId)) map.removeLayer(aggLayerId); } catch {}
    try { if (map.getLayer(aggOutlineLayerId)) map.removeLayer(aggOutlineLayerId); } catch {}
    try { if (map.getSource(aggSourceId)) map.removeSource(aggSourceId); } catch {}
    // Note: We don't remove neighborhood boundaries here as they should persist across data updates
  };

  try {
    setLoading && setLoading(true);
    removeIfExists();
    try { console.log("[map] rebuilding sources/layers", { url: tileURL, hasAgg: !!(aggFcParam && aggFcParam.features && aggFcParam.features.length) }); } catch {}
    // When no categories/offenses are selected, the URL encodes an empty selection.
    // In that case, deliberately leave the map without any layers.
    if (tileURL.includes("ofns=__none__")) {
      setLoading && setLoading(false);
      return;
    }

    // Require aggregated data to render the density layer; this guarantees 1:1 with the legend
    const hasAgg = !!(aggFcParam && Array.isArray(aggFcParam.features) && aggFcParam.features.length > 0);
    if (!hasAgg) {
      // No aggregation data available - just show the base map without any layers
      setLoading && setLoading(false);
      return;
    }

    const countsAll: number[] = (aggFcParam.features || []).map((f: any) => Number(f?.properties?.count) || 0);
    const countsSorted: number[] = [...countsAll].sort((a: number, b: number) => a - b);
    const maxC = countsSorted[countsSorted.length - 1] || 0;
    const p995C = countsSorted[Math.max(0, Math.floor(0.995 * (countsSorted.length - 1)))] || maxC;
    const totalViewport = countsAll.reduce((s, v) => s + (Number(v) || 0), 0);
    const computedDisplayMax = Math.max(1, Math.max(maxC, Math.round(p995C * 1.6)));
    const displayMax = Math.max(1, Number(legendRangeParam?.max || computedDisplayMax));


    map.addSource(aggSourceId, {
      type: "geojson",
      data: aggFcParam,
      tolerance: 0,
    });
    try { console.log("[map] agg source added", { features: (aggFcParam?.features || []).length }); } catch {}

    // Choropleth fill layer using the same color scale as the legend, normalized by displayMax
    try { map.addLayer({
      id: aggLayerId,
      type: "fill",
      source: aggSourceId,
      paint: {
        "fill-color": [
          "interpolate", ["linear"], ["/", ["get", "count"], displayMax],
          0.00,    "rgba(0,0,0,0)",
          0.0005,  "rgba(0,102,255,0.18)",
          0.005,   "#0066FF",
          0.05,    "#00FFCC",
          0.20,    "#7CFF66",
          0.60,    "#D9FF3D",
          0.90,    "#FF9900",
          1.00,    "#FF3D00"
        ],
        "fill-opacity": 0.55,
      }
    }, "waterway-label"); } catch { try {
      map.addLayer({
        id: aggLayerId,
        type: "fill",
        source: aggSourceId,
        paint: {
          "fill-color": [
            "interpolate", ["linear"], ["/", ["get", "count"], displayMax],
            0.00,   "rgba(0,0,0,0)",
            0.01,   "rgba(0,102,255,0.22)",
            0.06,   "#0066FF",
            0.20,   "#00FFCC",
            0.45,   "#7CFF66",
            0.70,   "#D9FF3D",
            0.90,   "#FF9900",
            1.00,   "#FF3D00"
          ],
          "fill-opacity": 0.55,
        }
      });
    } catch {}
    }


    // Thin outline for readability on dark basemap
    try { map.addLayer({
      id: aggOutlineLayerId,
      type: "line",
      source: aggSourceId,
      paint: {
        "line-color": "#0b1220",
        "line-opacity": 0.35,
        "line-width": 0.5,
      }
    }, "waterway-label"); } catch { try {
      map.addLayer({ id: aggOutlineLayerId, type: "line", source: aggSourceId, paint: { "line-color": "#0b1220", "line-opacity": 0.35, "line-width": 0.5 } });
    } catch {}
    }

    // No point-level dot layers or popups; only aggregated choropleth is rendered

    // Raise neighborhood layers above any new layers for legibility
    try {
      const neighborhoodSourceId = "neighborhoods";
      const neighborhoodLayerId = "neighborhood-boundaries";
      const neighborhoodLabelsId = "neighborhood-labels";
      const neighborhoodOutlineId = `${neighborhoodLayerId}-outline`;
      if (map.getLayer(neighborhoodLayerId)) map.moveLayer(neighborhoodLayerId);
      if (map.getLayer(neighborhoodOutlineId)) map.moveLayer(neighborhoodOutlineId);
      if (map.getLayer(neighborhoodLabelsId)) map.moveLayer(neighborhoodLabelsId);
      try { console.log('[map] raised neighborhood layers above tiles'); } catch {}
    } catch (e) { try { console.log('[map] failed to raise neighborhood layers', (e as any)?.message || e); } catch {} }

    // Log current layer order for debugging
    try { const style = map.getStyle(); console.log('[map] layers after tiles:', (style.layers||[]).map((l:any)=>l.id)); } catch {}

  } finally {
    setTimeout(() => setLoading && setLoading(false), 50);
  }
}

// Update-only path: refresh or create the aggregated choropleth
function updateAggChoropleth(map: any, aggFcParam?: any, legendRangeParam?: { min: number; median: number; max: number } | null) {
  const aggSourceId = "nypd-agg";
  const aggLayerId = "nypd-agg-hex";
  const aggOutlineLayerId = `${aggLayerId}-outline`;
  try {
    if (!aggFcParam || !Array.isArray(aggFcParam.features) || !aggFcParam.features.length) {
      try { console.log("[map] agg empty; removing aggregation layers"); } catch {}
      try { if (map.getLayer(aggLayerId)) map.removeLayer(aggLayerId); } catch {}
      try { if (map.getLayer(aggOutlineLayerId)) map.removeLayer(aggOutlineLayerId); } catch {}
      try { if (map.getSource(aggSourceId)) map.removeSource(aggSourceId); } catch {}
      return;
    }
    const countsAll: number[] = (aggFcParam.features || []).map((f: any) => Number(f?.properties?.count) || 0);
    try { console.log("[map] agg stats", { cells: countsAll.length, sum: countsAll.reduce((a,b)=>a+(b||0),0) }); } catch {}
    const countsSorted: number[] = [...countsAll].sort((a: number, b: number) => a - b);
    const maxC = countsSorted[countsSorted.length - 1] || 0;
    const p995C = countsSorted[Math.max(0, Math.floor(0.995 * (countsSorted.length - 1)))] || maxC;
    const computedDisplayMax = Math.max(1, Math.max(maxC, Math.round(p995C * 1.6)));
    const displayMax = Math.max(1, Number(legendRangeParam?.max || computedDisplayMax));

    if (map.getSource(aggSourceId)) {
      try { map.getSource(aggSourceId).setData(aggFcParam); } catch {}
    } else {
      map.addSource(aggSourceId, { type: "geojson", data: aggFcParam, tolerance: 0 });
    }
    if (!map.getLayer(aggLayerId)) {
      map.addLayer({
        id: aggLayerId,
        type: "fill",
        source: aggSourceId,
        paint: {
          "fill-color": [
            "interpolate", ["linear"], ["/", ["get", "count"], displayMax],
            0.00,    "rgba(0,0,0,0)",
            0.0005,  "rgba(0,102,255,0.18)",
            0.005,   "#0066FF",
            0.05,    "#00FFCC",
            0.20,    "#7CFF66",
            0.60,    "#D9FF3D",
            0.90,    "#FF9900",
            1.00,    "#FF3D00"
          ],
          "fill-opacity": 0.55,
        }
      }, "waterway-label");
    } else {
      map.setPaintProperty(aggLayerId, "fill-color", [
        "interpolate", ["linear"], ["/", ["get", "count"], displayMax],
        0.00,    "rgba(0,0,0,0)",
        0.0005,  "rgba(0,102,255,0.18)",
        0.005,   "#0066FF",
        0.05,    "#00FFCC",
        0.20,    "#7CFF66",
        0.60,    "#D9FF3D",
        0.90,    "#FF9900",
        1.00,    "#FF3D00"
      ]);
    }
    if (!map.getLayer(aggOutlineLayerId)) {
      map.addLayer({
        id: aggOutlineLayerId,
        type: "line",
        source: aggSourceId,
        paint: { "line-color": "#0b1220", "line-opacity": 0.35, "line-width": 0.5 }
      }, "waterway-label");
    }
    // If agg exists but sums to zero, hide agg to prevent phantom ramp
    try {
      const sum = countsAll.reduce((s, v) => s + (Number(v) || 0), 0);
      if (sum === 0) {
        map.setLayoutProperty(aggLayerId, "visibility", "none");
      } else {
        map.setLayoutProperty(aggLayerId, "visibility", "visible");
      }
    } catch {}
  } catch {}
}

