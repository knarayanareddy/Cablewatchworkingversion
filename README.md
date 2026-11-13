# CableWatch: Operational Subsea Infrastructure Early Threat Detection

> **Early Detection of Threats to Subsea Infrastructure from Open AIS Data**  
> Operational anomaly detection, behavioral scoring, and ISR asset cueing system built for the Mantavia Baltic Infrastructure Challenge.

---

## ⚡ Quick Start (Single Command)

To run the complete system (both the Python AIS microservice and the Next.js UI) with automatic port binding and graceful cleanup:

```bash
cd Cablewatchworkingversion
npm install # first time only
./run.sh
```

Then open your browser to **[http://127.0.0.1:3100/real](http://127.0.0.1:3100/real)**.

---

## ⚡ Overview & Capabilities

CableWatch continuously ingests open historical and daily AIS data (Danish Maritime Authority `aisdk-*.zip`, Norwegian Coastal Administration, Digitraffic) and flags vessels whose behavior indicates malicious or accidental anchor dragging across subsea power, gas, and optical fiber corridors—distinguishing true threats from innocent slow vessels (e.g. fishing trawlers, ferries, and anchorages) without generating alert fatigue.

### Core Challenge Features (All 6 Fully Operational)
1. **Streaming Open AIS Ingestion Pipeline (`python/pipeline.py`):**
   - Direct streaming extraction from DMA `.zip` archives without inflating multi-gigabyte raw files.
   - Cleans position jumps, implausible coordinates, and corrupt entries into indexed SQLite databases with hot-swap support.
2. **Contextual Anomaly Scoring Engine:**
   - Evaluates commercial vessel speed deficits against strict class baselines (tankers ~12.5 kn, cargo ~12.0 kn, passenger ~18.0 kn).
   - **Trawler & Ferry False-Positive Suppression:** Automatically discounts fishing vessels operating at normal towing speeds (2.5–4.5 kn).
   - **Anchor-Drag Drift Signature:** Computes angular divergence between vessel Course Over Ground (COG) and Heading ($\Delta > 14^\circ$).
3. **Ranked Alerts with Human-Readable Diagnostic Explanations:**
   - Categorized into actionable priority tiers: **`CUE`** (immediate ISR investigation recommended, score $\ge 4.2$), **`REVIEW`** candidate, or **`NORMAL`**.
   - Generates exact operational justification strings (e.g., `HIGH-PRIORITY CUE: 1.2 km from cable corridor, slow transit 3.2 kn vs ~12.5 kn typical (Tanker), course drifts 24° from heading. Strong anchor-drag or disabled drift signature over infrastructure.`).
4. **Single-Asset ISR Cueing & Sortie Planner:**
   - Models a 1-hour endurance fixed-wing / rotary ISR platform operating at $25\text{ m/s}$ ($1.5\text{ km/min}$) based out of Bornholm (or user-anchored coastal base).
   - Computes multi-leg routing, 4-minute camera dwell per target, return-to-base fuel reserves, and automatically drops infeasible targets with explicit fuel margin explanations.
5. **Multi-Scale Tactical Radar Map with Sector Focus:**
   - High-contrast tactical radar HUD (`#06101e`) with interactive mouse drag-to-pan and wheel zoom (15% to 1200%).
   - **Sector Focus Quick-Switcher:**
     - `🇩🇰 Bornholm Demo (Judges Window 13.5°–16.0°E, 54.5°–56.0°N)`: Target area for the live spot-check and the *Samus Swan* cable incident.
     - `🇩🇰 Fehmarn Belt`: Cross-strait Germany-Denmark connector corridor.
     - `🇩🇰 Storebælt (Great Belt)`: Major shipping channel between Fyn and Zealand.
     - `🇩🇰 Øresund (The Sound)`: Copenhagen-Malmö subsea power links.
     - `🇩🇰 Kattegat & Anholt`: Northern Danish strait corridors.
     - `⛶ Fit Active Data`: Auto-detects and centers the exact bounding box of the active ingested AIS dataset.
     - `🌐 Full Baltic & Danish Domain`: Regional overview (`9.5°–16.5°E`).
6. **Built-in Baltic Subsea Infrastructure Network + Custom GeoJSON:**
   - Pre-loaded with 14 major subsea corridors: Baltic Power Interconnector (450kV), Baltic Pipe Gas Corridor, Nord Stream 1 & 2, C-Lion1 Optical Fiber, Bornholm-Sweden 60kV MVAC Cable, SwePol Link (450kV), Kriegers Flak Combined Grid Solution, Fehmarn Belt Cross-Strait Link, Baltic Cable (450kV), Storebælt Link, Lillebælt Link, Øresund Link, Konti-Skan HVDC Interconnector, and Balticconnector.
   - De-cluttered visualization with staggered labels, dark pill badges, and terminal landing beacons (*Rønne*, *Hasle*, *Simrishamn*, *Rødbyhavn*, *Puttgarden*, *Nyborg*, *Korsør*).
   - **`📁 Load Custom GeoJSON`**: Upload any arbitrary subsea line in WGS84 for instant proximity and threat scoring.

---

## 🚀 Quick Start (Running Locally)

### 1. Prerequisites
- Python 3.9+
- Node.js 20.9+ and npm

### 2. Install & Build
```sh
# Install Node dependencies
npm ci

# Build the Next.js production app
npm run build
```

### 3. Start Backend & UI Services

**Terminal 1 — Backend AIS API Server:**
```sh
# Serves the included sample Baltic database (or any newly ingested SQLite database)
python3 python/local_ais.py serve work/baltic_sample.sqlite
```
*API service runs locally on `http://127.0.0.1:8765`.*

**Terminal 2 — Tactical Next.js Frontend:**
```sh
npm run start -- --hostname 127.0.0.1 --port 3100
```
Open **`http://127.0.0.1:3100/real`** in your browser.

---

## ⚡ Ingesting New AIS Archives for the Live Demo

You can ingest any single day between 7 and 16 September 2026 (or any historical day like the 28 February 2022 *Samus Swan* Bornholm incident) using either the UI or the CLI:

### Option A: Via the Web UI
1. Click **`⚡ Ingest / Switch Dataset`** in the top navigation bar.
2. Select your downloaded `.zip` file from the auto-discovered list (or enter its path).
3. Select a preset (e.g. `Bornholm Basin (Judges Demo Area)` or `Storebælt`).
4. Click **`Run Ingestion Pipeline`**. The system streams, filters, indexes, and hot-swaps the database into the live replay automatically.

### Option B: Via Command Line Pipeline
```sh
# Ingest with the official Bornholm demo bounding box:
python3 python/pipeline.py ~/Downloads/aisdk-2026-09-12.zip --preset bornholm --name demo_sept12

# Or ingest for the 2022 Bornholm incident:
python3 python/pipeline.py ~/Downloads/aisdk-2022-02-28.zip --preset bornholm --name samus_swan_incident
```

The pipeline automatically notifies the running `local_ais.py` server to hot-switch to the new database immediately without restarting.

---

## 🧪 Testing

Run Python automated unit tests:
```sh
python3 -m unittest discover -s tests -v
```

---

## 🔒 Security & Local Execution Policy
- All network bindings are restricted to loopback (`127.0.0.1`).
- Operates entirely on open public AIS and infrastructure data; introduces no non-public or proprietary data.
