## ThreatsMap – NYPD Complaint Data (last 4 years) on Mapbox

This app renders NYPD Complaint Data Historic as vector tiles on Mapbox GL with filters for offense type and law category. Data is fetched from NYC Open Data (Socrata) and converted to Mapbox Vector Tiles on-the-fly per tile.

Data source: `https://data.cityofnewyork.us/resource/qgea-i56i.json`

### Environment variables

- `MAPBOX_API_KEY` (or `NEXT_PUBLIC_MAPBOX_TOKEN`): Mapbox access token
- `NYC_OPENDATA_APP_TOKEN` (optional but recommended): Socrata app token for higher rate limits

`next.config.ts` exposes `NEXT_PUBLIC_MAPBOX_TOKEN` to the client.

### Scripts

```bash
npm install
npm run dev
```

### API

- `GET /api/crime-types` – returns offense descriptions with counts (last 4 years) for building the filter UI.
- `GET /api/tiles/{z}/{x}/{y}.mvt?start=ISO&end=ISO&ofns=..&law=..` – returns a Mapbox Vector Tile containing points within the tile bbox. The implementation limits each upstream Socrata pull to 1000 rows for performance; at high zoom levels this typically fits within the tile. Responses are cached (`s-maxage=300`).

### Notes & roadmap

- Current implementation pulls directly from Socrata per tile and is cache-friendly. For web-scale traffic and instant loads, add a background ETL and serve prebuilt tiles from storage/CDN.

