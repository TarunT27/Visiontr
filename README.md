<div align="center">

# 🌐 VisonTR

### A spy-satellite simulator in your browser — then you realize the sources are public and the data is real.

Photorealistic 3D globe. Live aircraft, ships, satellites, earthquakes, traffic, and public cameras, with clearly labeled modeled views where a live feed is unavailable. Hands-free voice control powered by a realtime AI agent.

*No place left behind.*

</div>

---

<div align="center">

**[Quick Start](#-quick-start) · [What's Live](#-whats-on-the-globe) · [Under the Hood](#-under-the-hood) · [Keys](#-api-keys) · [Costs](#-what-it-actually-costs)**

</div>

---

## 🎛️ What This Thing Does

- **🛩️ Cockpit view:** Ride inside a tracked flight — the camera holds the terrain under you all the way down.
- **📡 Contacts:** A 250 km roster of everything near your target — step through live aircraft and drop into any cockpit.
- **🎯 Click-to-track anything:** Camera locks on, draws a fading trail, surfaces full metadata — and a tracked fire or vessel hands you off to the nearest live camera in one click.
- **🖊️ Voice whiteboard:** Speak annotations onto the world — real boundary polygons, marks, and routes.
- **🛫 3D hangar:** Real per-class aircraft models — 787, ATR-72, Citation, Bell 206, MQ-9 — and a tracked contact swaps from glyph to 3D model as you close in.
- **🎨 Reskin reality:** GLSL sensor looks over the normal globe — CRT, NVG, FLIR/thermal, Noir, Snow.
- **🟩 Detection overlay:** Screen-space bounding boxes and IDs on everything in view.
- **🎖️ Military HUD:** Tactical heads-up display with intelligence-style telemetry.
- **🌐 Global Context:** Stage the full situational picture with one switch — and get your exact view back when you leave.
- **🎥 Scene director:** Capture cinematic camera tours for clips and demos.
- **🔗 Share Links:** Camera, style, layers, and even one tracked target serialize into a URL — a live target is a handoff, not a bookmark.
- **🏠 Reset Globe:** One control — or one sentence — back to the full Earth.

---

## ⚡ Quick Start

Requires Node.js 24.14.x or 26.x (enforced by `package.json`).

1. Copy `.env.example` → `.env` and set `GOOGLE_MAPS_API_KEY`.
2. Install and run:

```bash
npm install
npm run dev -- --host localhost --port 4173
```

3. Open **`http://localhost:4173`**. Cold start settles in under two seconds on a recent laptop (median 1.86 s in a point-in-time M5/Chrome capture — [docs/PERFORMANCE.md](docs/PERFORMANCE.md); a comparison baseline, not a hardware requirement). A first-run card offers to stage a mission for you — **Live Contacts**, **Space Missions**, **Environmental** — or leaves you to explore manually.

> [!TIP]
> **Not a coder? Have an AI do this whole page for you.** A one-click installer is in the works — until then, install a coding agent ([Claude Code](https://claude.com/claude-code), [Codex](https://openai.com/codex/), [Cursor](https://cursor.com), or [Antigravity](https://antigravity.google)) and paste this:
>
> ```text
> Clone https://github.com/TarunT27/Visiontr and set it up on my machine.
> Install everything it needs, walk me through getting the required Google Maps API
> key step by step (plus any optional free keys I want), put the keys in .env, and
> help me set a billing alert and a usage quota on the Google key so I can't
> overspend. Then start the dev server and open it in my browser. I'm not a
> developer — explain what you're doing as you go, and ask me before any step
> that could cost money.
> ```

**That one key is the whole entry fee.** Everything in this README is color-coded — 🟢 needs nothing · 🟡 free key · 🔴 metered — and Google Maps is the only 🔴 you need: it buys the photorealistic planet, and most of the globe lights up 🟢 from there. For typical solo exploring, expect **$0 on most layers** and pocket change on the metered two: Google currently gives **1,000 free 3D-tile sessions a month** — each good for up to three hours of rendering, which is very hard for one person to exhaust — and voice carries a built-in $5 session cap. Full map in [Keys & Costs](#-api-keys), full honest breakdown in [What it actually costs](#-what-it-actually-costs).

The dev server binds to **localhost** — your keys stay on your machine. Sharing on a LAN safely is covered in [Sharing an instance](#-sharing-an-instance) and [SECURITY.md](SECURITY.md).

**macOS shortcut:** `./scripts/dev-fresh.sh` clears the Vite cache and pulls your keys straight from the Keychain.

---

## 🛰️ What's on the Globe

Thirteen live layers. **Ten of them need nothing at all** — no key, no account, no signup.

| Layer | What you get | Source | Auth |
|-------|--------------|--------|------|
| 🗺️ **Map Stack** | Google Photorealistic 3D, Bing aerial, OSM | Google / Ion / OSM | 🔴 Google (required) · 🟡 ion for Bing · 🟢 OSM |
| ✈️ **Live Flights** | Thousands of live aircraft + route history | OpenSky + adsb.lol | 🟢 (🟡 optional for more polling credits) |
| 🎖️ **Military Flights** | ADS-B military traffic in amber | adsb.lol | 🟢 |
| 🚢 **Live Vessels** | Thousands of ships worldwide | AISStream | 🟡 |
| 🛰️ **Satellites** | A roughly 840-object core catalog, color-coded by class with a live legend — the **DENSE** chip drops in the whole Starlink shell | CelesTrak | 🟢 |
| 🌍 **Earthquakes** | Global seismic activity, last 24h | USGS | 🟢 |
| 🚗 **Traffic** | Live congestion driving per-vehicle flow at street level — dive below ~8 km and the dots color to real jams. Keyless it's an approximate simulation | TomTom + OSM | 🟢 (🟡 TomTom makes it real — get one) |
| 📹 **CCTV Mesh** | ~800 public cameras projected *into* the 3D space — Austin · California (Caltrans) · London (TfL). Positions are published; poses are estimated priors **you calibrate by dragging a gizmo on the camera itself** | City APIs | 🟢 |
| 📻 **Radio** | Geolocated world radio with an **analog tuner** — drag the needle across up to 750 stations and the globe flies to each broadcaster | Radio Browser / broadcasters | 🟢 |
| 🚲 **Bikeshare** | Live station availability | GBFS | 🟢 |
| 🔥 **Active Fires** | Live NASA FIRMS detections, trailing 24h | NASA FIRMS | 🟡 |
| 🚀 **Space Missions** | Rolling 30-day launches with payload, stage, and recovery detail | Launch Library 2 | 🟢 (🟡 optional token raises the allowance) |
| 🎖️ **Mapped Installations** | Viewport-bounded military-site context from community mapping — incomplete by nature, and labeled that way | OpenStreetMap | 🟢 |

**Also on the globe:** neighborhood overlays · an optional cockpit WX cloud effect. **Bundled static infrastructure:** Datacenters (4,351), Dams (704), and Submarine Cables (712).

**Missing a layer you want?** Open an issue — or add it and send the PR.

---

## 🎖️ Field Missions

Once the basics click, run these:

| Mission | How |
|---|---|
| **🚁 Ask the planet** | *"Why are all these military helicopters flying in circles?"* Select a military track — it silently backfills ~24 h of real trace history — and see what it's been doing, resolved as stacked 3D loops. |
| **✈️ Final approach** | Click-track an airliner lining up for a runway, hop into the **cockpit**, and ride it down. |
| **🌃 Night watch** | Fly to your own city, switch to **NVG**, and let the detection mesh and HUD read the scene. |
| **🚢 Port call** | Vessels on over the Port of Long Beach. Click a tanker for its tactical card and wake trail — then hit **NEAREST** in the CCTV panel and look at the same water through a public camera. |
| **📻 Tokyo FM** | Orbit Shibuya with the **Radio** layer on — then drag the analog tuner needle: every position snaps to a real station and the globe flies to whoever's broadcasting. |
| **🔥 Fire line** | FIRMS over California. Click a detection — the camera dives to it — read the intensity, then hit **NEAREST** in the CCTV panel for a ground view. |
| **🚶 Ask for a walking route** *🎙️* | Tell the world where you want to go and watch a real street-following route trace itself through the 3D city — then *"fly it"*: banked turns, eased ends, a camera that leads the path like a drone shot. |
| **📏 Measure LAX to DFW** *🎙️* | *"How far is LAX from DFW?"* — an arrow spans the country, the distance lands in the caption, and the endpoints stay pinned to the real world as you orbit. |
| **🚀 Launch replay** | Open **Space Missions**, pick a launch from the last 30 days, and ride the T-minus countdown through ascent to orbit — scrub it at 0.25×–4×. Labeled `RECONSTRUCTED ESTIMATE`, because it is one. |
| **🪦 Walk the boneyard** | Fly from regional context down into dense, fully resolved rows of retired aircraft. |
| **🏗️ Orbit Three Gorges** | Sweep the dam and its terrain at a glance — then flip on the **Dams** layer and find 703 more. |
| **🌊 Trace the backbone** | Dive to the Bahamas with **Submarine Cables** on — labeled routes reveal beneath the water, 712 of them worldwide. |

*🎙️ = voice missions — they need an OpenAI key.*

---

## 🔧 Under the Hood

Some of the engineering that makes it feel real rather than like a tech demo:

- **World-stable icons.** Aircraft and ships point along their *true real-world heading* at every camera angle — tracked or not, looking straight down or across the horizon — via per-frame screen-space course projection. No spinning, no viewport-locking.
- **Smooth motion from choppy data.** Live feeds arrive every 15–30s; the globe renders one interval behind real time and interpolates between known fixes. Dead reckoning fills the gaps.
- **Honest satellites.** SGP4 propagation with orbit rings that stay locked to their satellites via GMST realignment — no drift, no per-second flicker.
- **Sits on the real ground.** Entity heights run through a real vertical datum — geoid-aware, sampled against the *rendered* terrain mesh — so aircraft park on aprons and cameras stand on street corners instead of floating.
- **Spends your quota like it's its own.** The paid feeds run behind cached, budget-governed proxies — an OpenSky credit governor, a TomTom daily tile budget, disk-cached TLEs — so an afternoon of exploring doesn't torch an API allowance.
- **Local-first key handling.** Secret-bearing providers such as OpenAI, AISStream, OpenSky OAuth, TomTom, and FIRMS are brokered server-side. Proxy destinations are fixed or allowlisted, and the higher-risk paths add bounded requests, timeouts, response caps, and sanitized errors as appropriate. The only provider credentials intentionally exposed to the browser are Google Maps and Cesium ion; restrict both at the provider.
- **No framework.** Vanilla JavaScript, **CesiumJS**, and **Vite** — plus **Google Photorealistic 3D Tiles** for the planet and the **OpenAI Realtime API** for voice. Fast to read, fast to hack on.

```
src/
├── main.js                 # Bootstrap: Google 3D tiles, layer registration
├── ui.js                   # Runtime UI — panels, HUD, styles, control facade
├── hud.js                  # Intelligence HUD + AI scene summary
├── mapStackController.js   # Google 3D / Bing / OSM switching
├── iconOrientation.js      # Screen-projected world-space headings + horizon cull
├── voice/                  # OpenAI Realtime session + 28 voice tools
├── data/                   # One module per layer + management + context store
│   └── local_data/         # Bundled datasets (per-folder provenance)
└── scenes/                 # Cinematic scene director
```

See [`docs/CURRENT-STATE.md`](docs/CURRENT-STATE.md) for the authoritative runtime reference.

---

## 🔑 API Keys

**The legend, one more time:** 🟢 **no signup** — works out of the box · 🟡 **free key** — register, paste, done · 🔴 **metered** — a billing-enabled account; costs are small but real.

Most of the globe is 🟢: flights (anonymous), military traffic, satellites, earthquakes, CCTV, radio, bikeshare, space missions, mapped installations, and every bundled dataset run with **zero keys**.

### What you need for the good experience

Five keys cover the fully keyed experience. Three currently offer no-cost developer access; Google Maps and OpenAI are usage-metered. Provider prices and allowances change, so use the linked pricing pages before relying on a budget estimate:

| | Key | Why | Get it |
|---|-----|-----|--------|
| 🔴 | **Google Maps** *(required)* | The photorealistic 3D planet ([Map Tiles API](https://developers.google.com/maps/documentation/tile)) | [Google Cloud Console](https://console.cloud.google.com/) — metered; [check current pricing](https://developers.google.com/maps/billing-and-pricing/pricing) and URL-restrict it |
| 🔴 | **OpenAI** | 🎙️ The voice experience + AI HUD summary. Want another provider behind the mic? PRs welcome | [platform.openai.com](https://platform.openai.com) — metered; [check current API pricing](https://openai.com/api/pricing/) |
| 🟡 | **AISStream** | 🚢 Live global ships | [aisstream.io](https://aisstream.io) — free, seriously, it's a two-minute signup |
| 🟡 | **NASA FIRMS** | 🔥 Live active fires | [firms.modaps.eosdis.nasa.gov](https://firms.modaps.eosdis.nasa.gov/api/map_key/) — free |
| 🟡 | **TomTom** | 🚦 Real traffic instead of an approximate simulation | [developer.tomtom.com](https://developer.tomtom.com) — check the current developer allowance for your account |

*A TomTom key provides live rush-hour density instead of an approximate simulation.*

### Cherry on top

| | Key | Why | Get it |
|---|-----|-----|--------|
| 🟡 | **Cesium ion** | 🗺️ Bing imagery map stacks (public `assets:read` token) | [cesium.com/ion](https://cesium.com/ion) — [check the plan that fits your use](https://cesium.com/platform/cesium-ion/pricing/) |
| 🟡 | **OpenSky** | ✈️ More flight-polling credits (🟢 anonymous works without) | [opensky-network.org](https://opensky-network.org) |
| 🟡 | **Launch Library 2** | 🚀 Higher space-missions request allowance (🟢 works without) | [thespacedevs.com](https://thespacedevs.com) |

All of them are worth getting. None of them are required to start.

```bash
# Put keys in .env (see .env.example), or pass them as env vars:
OPENAI_API_KEY="…" AISSTREAM_API_KEY="…" npm run dev -- --host localhost --port 4173
```

On macOS you can also keep any key in the Keychain and `./scripts/dev-fresh.sh` pulls them in — the `security add-generic-password` service names are documented in `.env.example`.

OpenSky can run fully anonymous (`OPENSKY_AUTH_MODE=anon`), or import OAuth credentials with `./scripts/opensky-import-client.sh /path/to/credentials.json`.

### 💸 What it actually costs

Honest numbers, roughly, as of mid-2026 — always check the provider pricing pages:

| | Cost reality |
|---|---|
| **🟢 Most layers** | **$0, no signup.** OpenSky anon, USGS, CelesTrak, adsb.lol, city CCTV, Radio Browser, GBFS, Launch Library 2, bundled datasets. |
| **🟡 Optional developer access** | AISStream, FIRMS, TomTom, Cesium ion, and authenticated OpenSky may offer no-cost access, but limits and permitted uses differ. Cesium ion and OpenSky in particular have plan or use restrictions; verify the current provider terms for your deployment. |
| **🔴 Google 3D tiles** | More generous than you'd guess: billing counts **root tileset requests** — one buys up to **three hours** of unlimited tile rendering — and the first **1,000 per month are free**, then about **$6 per 1,000** (US pricing; [check the current page](https://developers.google.com/maps/billing-and-pricing/pricing), rates vary by billing region). A solo user rarely leaves the free tier. Still: restrict the key, set quotas, and configure a budget alert before sustained use. |
| **🔴 OpenAI voice** | Realtime audio is usage-metered and the total depends on the selected model, conversation length, and audio volume. The app shows a live session estimate, warns at $2, and applies a **$5 in-app session cap**; provider-side usage limits remain the billing backstop. |

### 🔒 Sharing an instance

By default nobody else can reach your server — it binds to localhost. To share on your LAN, opt in explicitly (`npm run dev -- --host 0.0.0.0 --port 4173`, or `HOST=0.0.0.0 ./scripts/dev-fresh.sh` on macOS/Linux) — but know that ⚠️ **a LAN-visible server brokers your configured API keys to anyone who can reach it.** Set the per-IP throttles (`VTR_RATELIMIT_OPENAI_PER_MIN`, `VTR_RATELIMIT_GOOGLE_PER_MIN` — see `.env.example`) and, before anything else, **set provider-side budget caps** (Google Cloud budgets, OpenAI usage limits): the throttles are app-level guards, not billing caps. Full threat model in [SECURITY.md](SECURITY.md).

---

## 📋 Responsible & Open

VisonTR runs on **public data, clear sources, and local-first execution.** No secrets, no private datasets, no mystery scraping — anything involving a private key is brokered server-side. It has the visual grammar of a classified ops room, built entirely from open signals and inspectable code.

**The line.** This project models **events, assets, infrastructure, and systems** — aircraft, vessels, satellites, fires, cameras, cities. It does not build features for named-person search, face recognition, or tracking individuals, and pull requests that cross that line won't be merged. People are not a query type here.

**Come build it.** This is the canonical live 3D client from the project that kicked off the recent wave of spatial-intelligence tools — and it's a canvas: the layers here are the signals one person could find and fuse. Add a city pack, a data source, a style, a voice tool. It's the window through which you see the world; bring that window to others.

**Status:** An evolving open-source client for exploration and learning — a fast, hackable foundation, not a hardened production service. Released under the **[MIT License](LICENSE)**. Bundled and live datasets carry their own terms — see **[DATA_SOURCES.md](DATA_SOURCES.md)**. Security model: **[SECURITY.md](SECURITY.md)**. Want to contribute? **[CONTRIBUTING.md](CONTRIBUTING.md)**.

> [!IMPORTANT]
> VisonTR is an exploratory visualization of public and third-party data.
> Data may be delayed, incomplete, modeled, inferred, or wrong. Do not use it
> for flight or maritime navigation, emergency response, medical or health
> decisions, investment decisions, or other safety-critical or operational
> purposes. Verify important information with authoritative sources.

---

**🌐 VisonTR. No place left behind.**
