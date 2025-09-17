import { NextRequest } from "next/server";

// Warmup endpoint: prefetches default 2022–present caches for NYC and SF
// so first page load is fast on Vercel. Safe to call via Vercel Cron
// or a Deploy Hook after each deployment.
export async function GET(req: NextRequest) {
  const t0 = Date.now();
  const origin = req.nextUrl.origin;

  // Default filters used on initial load
  const start = "2022-01-01T00:00:00.000Z";
  const end = "2025-12-31T23:59:59.999Z";
  const vclass = "violent,nonviolent";

  const urls: string[] = [];

  // Stats (sidebar)
  urls.push(`/api/stats?city=nyc&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&includeUnknown=1&vclass=${encodeURIComponent(vclass)}`);
  urls.push(`/api/stats?city=sf&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&includeUnknown=0&vclass=${encodeURIComponent(vclass)}`);

  // Crime types (sidebar dropdown)
  urls.push(`/api/crime-types?city=nyc`);
  urls.push(`/api/crime-types?city=sf`);

  // Neighborhood density (labels/shading when filters present)
  urls.push(`/api/neighborhoods/density?city=nyc&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&includeUnknown=1&vclass=${encodeURIComponent(vclass)}`);
  urls.push(`/api/neighborhoods/density?city=sf&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&includeUnknown=0&vclass=${encodeURIComponent(vclass)}`);

  // Citywide aggregate grid at a representative zoom for first render
  // NYC bbox
  urls.push(`/api/aggregate?bbox=${encodeURIComponent("-74.25559,40.49612,-73.70001,40.91553")}&z=10&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&includeUnknown=1&vclass=${encodeURIComponent(vclass)}`);
  // SF bbox
  urls.push(`/api/aggregate?bbox=${encodeURIComponent("-122.5149,37.7081,-122.3570,37.8324")}&z=10&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&includeUnknown=0&vclass=${encodeURIComponent(vclass)}`);

  // Year range
  urls.push(`/api/year-range`);

  const make = (path: string) => {
    const url = new URL(path, origin).toString();
    // Always no-store here; underlying routes may use persistent caches
    return fetch(url, { cache: "no-store", headers: { "x-warmup": "1" } })
      .then(async (r) => ({ ok: r.ok, status: r.status, url, bytes: Number(r.headers.get("content-length") || 0) }))
      .catch((e) => ({ ok: false, status: 0, url, error: String(e) }));
  };

  const settled = await Promise.allSettled(urls.map((u) => make(u)));
  const ok = settled.filter((s) => s.status === "fulfilled" && (s.value as any).ok).length;
  const total = urls.length;
  const ms = Date.now() - t0;

  try {
    console.log(`[warmup] completed`, { ok, total, ms });
  } catch {}

  return Response.json({ ok, total, ms }, { headers: { "Cache-Control": "no-store" } });
}


