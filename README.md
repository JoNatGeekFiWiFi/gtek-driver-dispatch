# Dispatch Route Builder

A dispatch platform for building driver routes and tracking drivers live.

- **Dispatcher dashboard** (browser): build routes with start/end/stops, set a
  **dwell time limit and optional hard deadline per stop**, see ETAs with
  rush-hour or live-traffic adjustment and a **planned per-stop schedule**,
  crash-hazard scores from public NHTSA data, assign routes to drivers, and
  watch drivers move on the map in real time with off-route and
  **running-behind alerts**.
- **Driver app** (phone/tablet browser, installable as a PWA): shows the
  assigned route as a **stop-by-stop tracker** with planned times, **auto-marks
  arrival** within ~120 m of each stop (with manual backup), a **"Running
  behind" button**, a map that **follows the driver**, and streams live GPS to
  dispatch. Auto-alerts dispatch when the driver falls behind the schedule.
- **Walking sub-paths**: a stop can carry an on-foot leg (park → walk to the
  site → walk back to the vehicle). The dispatcher defines it by tracing it on
  the map, dropping a single destination point, or foot-routing it (with a
  walking-router key). Walk time folds into the stop's schedule; the driver app
  guides the walk-out/walk-back with auto-detection and reports each phase to
  dispatch live.
- **Multi-tenant**: each company registers its own workspace; dispatchers only
  see their own drivers and routes.

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:5173 — create a workspace (you become the dispatcher),
add a driver under the Drivers tab, then open the site on the driver's phone
(or a second browser window), sign in as the driver, and tap Share location.

Production: `npm run build` then `npm start` (serves everything from one port).

## Data sources & providers (all pluggable)

| Concern | Free default | Paid upgrade (set key in `.env`) |
|---|---|---|
| Routing | OSRM public server (no key) | `MAPBOX_TOKEN` or `TOMTOM_KEY` |
| Rush hour | Built-in time-of-day model | Live traffic from Mapbox/TomTom |
| Geocoding | OpenStreetMap Nominatim | — |
| Map tiles | OpenStreetMap raster | — |
| Crash data | NHTSA FARS API (Data tab → Import) | State DOT feeds (add importers in `server/src/crashes.js`) |

Copy `.env.example` to `.env` to configure. Everything works with no keys at all.

Notes:
- The OSRM/Nominatim public servers are fine for development and demos but are
  rate-limited; self-host OSRM or add a paid key before real fleet volume.
- NHTSA FARS covers **fatal** crashes nationwide with exact coordinates
  (roughly 2 years behind present).

## Crash-data sources & adding a state

Crash importers are registered in `server/src/importers.js` (`CRASH_SOURCES`).
Each entry declares which state it serves (`'*'` = all), and the Data tab shows
the sources available for the selected state. Included out of the box:

- **NHTSA FARS** — fatal crashes, every state.
- **AZ: Tempe Open Data** — ~59k all-severity crashes (city ArcGIS feed).
- **AZ: Phoenix Vision Zero** — ~4.3k serious-injury/fatal crashes 2020–2024.
- **AZ: Tucson Police collisions** — ~55k all-severity crashes 2014–2023.
- **AZ / CA sample data** — offline demo clusters (Phoenix metro / LA).

Cities checked with no public raw crash points as of Jul 2026: Scottsdale
(publishes only aggregated High-Injury-Network scores), Mesa, Chandler,
Gilbert, Glendale, Peoria. Statewide all-severity data exists in ADOT's ALISS
database — available to organizations via records request, and it would slot
into the registry the same way. Beware name collisions when hunting feeds:
"Mesa" matches Mesa County, Colorado, and generic "Crash Data" layers can be
from anywhere — always verify a layer's extent before trusting it.

**To add a state:** most DOTs and cities publish crash data as public ArcGIS
FeatureServers (search [hub.arcgis.com](https://hub.arcgis.com) for
"&lt;place&gt; crash data"). Copy the `az-tempe` entry, change the `url` and the
field names to match the new layer's schema, and it appears in the UI — the
generic ArcGIS importer handles paging, filtering by year, and normalization.
Non-ArcGIS sources (CSV downloads, custom APIs) can implement `run(params)`
directly, like the FARS importer does. Re-imports replace that source's rows,
so they're safe to run repeatedly.

## Architecture

```
server/   Node + Express + SQLite (node:sqlite, zero native deps)
  src/auth.js      multi-tenant orgs, JWT auth, dispatcher/driver roles
  src/routing.js   provider chain: Mapbox → TomTom → OSRM → offline estimate
  src/crashes.js   NHTSA ingest, bbox queries, per-route hazard scoring
  src/ws.js        WebSocket hub: GPS in from drivers, live updates to dispatch,
                   off-route detection (>150 m from assigned route line)
web/      React + Vite + MapLibre GL (free OSM tiles)
  pages/Dispatch.jsx  dispatcher dashboard
  pages/Driver.jsx    mobile driver app (PWA)
```

## Roadmap to production

- **Native driver app**: DONE — Capacitor projects in `web/android/` and
  `web/ios/` with background GPS configured; see `docs/mobile.md` to build.
- **Postgres**: swap SQLite when you outgrow one box (data layer is thin SQL,
  easy to port). Add PostGIS for faster geo queries at scale.
- **Billing/plans** for selling to other fleets (orgs are already isolated).
- **State DOT crash feeds** for all-severity (not just fatal) crash data.
- Set a strong `JWT_SECRET` and serve over HTTPS (required for phone GPS).
