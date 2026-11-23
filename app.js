/* Cadastre map of L'Ametlla del Vallès */
(function () {
  "use strict";

  // ------------------------------------------------------------ config
  const CATS = {
    residential: { label: "Residential", color: "#f28e2b" },
    retail:      { label: "Retail",      color: "#e15759" },
    office:      { label: "Offices",     color: "#4e79a7" },
    industrial:  { label: "Industrial",  color: "#9c6ade" },
    public:      { label: "Public services", color: "#17a2b8" },
    agriculture: { label: "Agricultural building", color: "#8cb369" },
    buildable:   { label: "Unbuilt urban plot", color: "#ffe2b8" },
    devland:     { label: "Development land (needs sector plan)", color: "#e9d8a6" },
    facility:    { label: "Reserved for public facilities", color: "#bfe3ea" },
    open:        { label: "Park / square / open space", color: "#a8d5a2", hollow: true },
    rustic:      { label: "Rustic land", color: "#cfe1b9" },
    vacant:      { label: "Urban, no building", color: "#d9d9d6" },
    other:       { label: "Other",       color: "#999999" },
  };
  const RAMP = ["#fff5eb", "#fdd0a2", "#fd8d3c", "#d94801", "#7f2704"];
  const SCALES = {
    area: { label: "Plot size", unit: "m²", breaks: [250, 500, 1000, 2500, 10000], key: (p) => p.area },
    year: { label: "Year built", unit: "", breaks: [1950, 1970, 1990, 2005, 2030], key: (p) => p.year },
    far:  { label: "Built / plot", unit: "", breaks: [0.1, 0.25, 0.5, 1, 99],
            key: (p) => (p.built && p.area ? p.built / p.area : null) },
    // from the town-plan rules (zoning_rules.json)
    remaining: { label: "Remaining buildable", unit: "m²", breaks: [25, 100, 250, 500, 1e9],
            key: (p) => { const q = potential(p, RULES[p.zone]); return q && q.remaining != null ? q.remaining : null; } },
    dwellings: { label: "Extra dwellings possible", unit: "", breaks: [1, 2, 3, 5, 1e9],
            key: (p) => { const q = potential(p, RULES[p.zone]);
              return q && q.dwellings != null ? Math.max(0, q.dwellings - (p.dwellings || 0)) : null; } },
    slope: { label: "Terrain slope", unit: "%", breaks: [10, 20, 30, 40, 1e9],
            key: (p) => p.slope },
  };
  // Zoning families of the Mapa Urbanístic de Catalunya (MUC key prefix)
  const ZONES = {
    R1: { label: "Old town (casc antic)", color: "#b45309" },
    R2: { label: "Urban renewal", color: "#d97706" },
    R4: { label: "Multi-family / specific volumes", color: "#ea580c" },
    R5: { label: "Terraced single-family", color: "#f59e0b" },
    R6: { label: "Detached houses (ciutat jardí)", color: "#fcd34d" },
    A:  { label: "Industrial & commercial", color: "#9c6ade" },
    M:  { label: "Mixed / protected / transformation", color: "#a16207" },
    D:  { label: "Development land (urbanitzable)", color: "#e9d8a6" },
    SE: { label: "Public facilities", color: "#17a2b8" },
    ST: { label: "Technical services", color: "#64748b" },
    SV: { label: "Parks & gardens", color: "#4caf50" },
    SH: { label: "Streams", color: "#4a90d9" },
    SX: { label: "Roads & parking", color: "#b0b0ab" },
    N:  { label: "Rural land (no urbanitzable)", color: "#cfe1b9" },
    none: { label: "No zoning data", color: "#eeeeec" },
  };
  function zoneFamily(p) {
    const m = p.muc;
    if (!m) return "none";
    if (/^R\d/.test(m)) return ZONES[m.slice(0, 2)] ? m.slice(0, 2) : "R6";
    const two = m.slice(0, 2);
    if (ZONES[two]) return two;
    return ZONES[m[0]] ? m[0] : "none";
  }
  // categorical colour modes: key function + classes
  const CATEGORICAL = {
    cat: { key: (p) => p.cat, classes: CATS },
    zoning: { key: zoneFamily, classes: ZONES },
  };
  let RULES = {}; // zoning_rules.json "zones"
  const SEL_STYLE = { color: "#ff2d55", weight: 3, fillOpacity: 0.35 };

  // ------------------------------------------------------------ map
  const map = L.map("map", { preferCanvas: true, zoomControl: true }).setView([41.67, 2.26], 14);

  const base = {
    "Map": L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 20, maxNativeZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }),
    "Satellite (PNOA)": L.tileLayer(
      "https://www.ign.es/wmts/pnoa-ma?service=WMTS&request=GetTile&version=1.0.0&layer=OI.OrthoimageCoverage" +
      "&style=default&tilematrixset=GoogleMapsCompatible&TileMatrix={z}&TileRow={y}&TileCol={x}&format=image/jpeg",
      { maxZoom: 20, maxNativeZoom: 19, attribution: "PNOA © IGN España" }),
  };
  base["Map"].addTo(map);
  const catastroWms = L.tileLayer.wms("https://ovc.catastro.meh.es/Cartografia/WMS/ServidorWMS.aspx", {
    layers: "Catastro", format: "image/png", transparent: true, maxZoom: 20, attribution: "Catastro",
  });
  L.control.layers(base, { "Official Catastro map (WMS)": catastroWms }, { position: "topright" }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);

  // ------------------------------------------------------------ state
  let colorBy = "cat";
  const hidden = new Set();
  let parcels, selected = null;
  const byRc = new Map();

  function fillFor(p) {
    const c = CATEGORICAL[colorBy];
    if (c) return (c.classes[c.key(p)] || CATS.other).color;
    const s = SCALES[colorBy], v = s.key(p);
    if (v == null) return "#eeeeec";
    const i = s.breaks.findIndex((b) => v < b);
    return RAMP[i < 0 ? RAMP.length - 1 : i];
  }
  function bucketOf(p) {
    if (CATEGORICAL[colorBy]) return CATEGORICAL[colorBy].key(p);
    const v = SCALES[colorBy].key(p);
    if (v == null) return "none";
    const i = SCALES[colorBy].breaks.findIndex((b) => v < b);
    return String(i < 0 ? RAMP.length - 1 : i);
  }
  function styleFor(f) {
    const p = f.properties;
    if (hidden.has(bucketOf(p))) return { opacity: 0, fillOpacity: 0, weight: 0 };
    const z = map.getZoom();
    // plot borders get stronger as you zoom in so neighbouring plots stay distinct
    const line = z >= 17 ? { color: "#4a2f12", weight: 1.2, opacity: 0.9 }
               : z >= 15 ? { color: "#6b4a26", weight: 0.8, opacity: 0.8 }
               : { color: "#8a8a85", weight: 0.4, opacity: 0.7 };
    if (colorBy === "cat" && (CATS[p.cat] || {}).hollow) {
      // parks, squares, open space: let the base map (green, water) show through
      return { color: "#3d8b37", weight: z >= 15 ? 1 : 0.5, opacity: 0.8, dashArray: "3 3",
               fillColor: "#3d8b37", fillOpacity: 0.04 };
    }
    return { ...line, dashArray: null, fillColor: fillFor(p), fillOpacity: z >= 16 ? 0.55 : 0.7 };
  }
  function restyle() {
    parcels.setStyle(styleFor);
    if (selected) selected.setStyle(SEL_STYLE).bringToFront();
  }

  // ------------------------------------------------------------ legend
  function renderLegend() {
    const el = document.getElementById("legend");
    const counts = {};
    parcels.eachLayer((l) => { const b = bucketOf(l.feature.properties); counts[b] = (counts[b] || 0) + 1; });
    let rows;
    if (CATEGORICAL[colorBy]) {
      const cl = CATEGORICAL[colorBy].classes;
      rows = Object.keys(cl).filter((k) => counts[k]).map((k) => [k, cl[k].color, cl[k].label]);
    } else {
      const s = SCALES[colorBy], fmt = (n) => n.toLocaleString("en");
      rows = s.breaks.map((b, i) => {
        const lo = i ? s.breaks[i - 1] : null;
        const last = i === s.breaks.length - 1;
        const lbl = lo == null ? `< ${fmt(b)}` : last ? `≥ ${fmt(lo)}` : `${fmt(lo)} – ${fmt(b)}`;
        return [String(i), RAMP[i], `${lbl} ${s.unit}`];
      });
      rows.push(["none", "#eeeeec", "No data"]);
    }
    el.innerHTML = rows.map(([k, c, lbl]) =>
      `<div class="lg${hidden.has(k) ? " off" : ""}" data-k="${k}"><i style="background:${c}"></i>` +
      `<span>${lbl}</span><b>${(counts[k] || 0).toLocaleString("en")}</b></div>`).join("");
  }
  document.getElementById("legend").addEventListener("click", (e) => {
    const row = e.target.closest(".lg");
    if (!row) return;
    const k = row.dataset.k;
    hidden.has(k) ? hidden.delete(k) : hidden.add(k);
    restyle(); renderLegend();
  });
  document.getElementById("colorBy").addEventListener("change", (e) => {
    colorBy = e.target.value; hidden.clear(); restyle(); renderLegend();
  });
  map.on("zoomend", () => parcels && restyle());

  // ------------------------------------------------------------ load data
  // Catastro building footprints: drawn above the plots, never catch clicks
  map.createPane("buildings").style.zIndex = 450;
  map.getPane("buildings").style.pointerEvents = "none";
  const bRenderer = L.canvas({ pane: "buildings" });
  let buildings = null;
  const showBuildings = () => {
    if (!buildings) return;
    const on = map.getZoom() >= 15;
    if (on && !map.hasLayer(buildings)) buildings.addTo(map);
    if (!on && map.hasLayer(buildings)) map.removeLayer(buildings);
  };
  map.on("zoomend", showBuildings);

  fetch("data/buildings.geojson").then((r) => (r.ok ? r.json() : null)).then((fc) => {
    if (!fc) return;
    buildings = L.geoJSON(fc, {
      pane: "buildings", renderer: bRenderer, interactive: false,
      style: { stroke: true, color: "#3a2410", weight: 0.6, opacity: 0.7, fillColor: "#5a3b1c", fillOpacity: 0.45 },
    });
    showBuildings();
  });

  Promise.all([
    fetch("data/parcels.geojson").then((r) => r.json()),
    fetch("data/boundary.geojson").then((r) => r.json()),
    fetch("data/overrides.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    fetch("data/zoning_rules.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
  ]).then(([fc, boundary, overrides, rules]) => {
    RULES = rules.zones || {};
    for (const f of fc.features) {
      const p = f.properties;
      p.cat0 = p.cat; // category computed by the build script
      if (overrides[p.rc]) p.cat = overrides[p.rc];
    }
    L.geoJSON(boundary, { interactive: false, style: { color: "#1d1d1b", weight: 2, dashArray: "6 4", fill: false } }).addTo(map);
    parcels = L.geoJSON(fc, {
      style: styleFor,
      onEachFeature: (f, layer) => {
        byRc.set(f.properties.rc, layer);
        layer.bindTooltip(() => {
          const p = f.properties;
          return `${p.rc} · ${fmtM2(p.area)}${p.built ? ` · built ${fmtM2(p.built)}` : ""}`;
        }, { sticky: true, className: "tip", direction: "top", offset: [0, -6] });
        layer.on("click", () => select(f.properties.rc));
      },
    }).addTo(map);
    map.invalidateSize();
    if (map.getSize().x > 0) map.fitBounds(parcels.getBounds(), { padding: [10, 10] });
    else map.whenReady(() => map.fitBounds(parcels.getBounds()));
    window.addEventListener("resize", () => map.invalidateSize());
    document.getElementById("count").textContent = `${fc.features.length.toLocaleString("en")} plots`;
    renderLegend();
    const m = location.hash.match(/rc=([0-9A-Z]{14})/i);
    if (m) select(m[1].toUpperCase(), true);
  });

  // ------------------------------------------------------------ search
  document.getElementById("search").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = document.getElementById("q").value.trim().toUpperCase().replace(/\s+/g, "");
    if (!q) return;
    const rc = q.slice(0, 14);
    if (byRc.has(rc)) select(rc, true);
    else details(`<p class="err">${esc(q)} isn't a plot in L'Ametlla del Vallès (need the 14- or 20-character reference).</p>`);
  });

  // ------------------------------------------------------------ selection
  function unselect() {
    if (!selected) return;
    selected.setStyle(styleFor(selected.feature));
    selected = null;
    history.replaceState(null, "", location.pathname);
    const el = document.getElementById("details");
    el.classList.add("empty");
    el.innerHTML = "<p>Click a plot on the map to see its Catastro data.</p>";
  }

  function select(rc, zoom) {
    const layer = byRc.get(rc);
    if (!layer) return;
    if (selected === layer && !zoom) return unselect(); // second click on the same plot
    if (selected) selected.setStyle(styleFor(selected.feature));
    selected = layer;
    layer.setStyle(SEL_STYLE).bringToFront();
    if (zoom) map.fitBounds(layer.getBounds(), { maxZoom: 18, padding: [40, 40] });
    history.replaceState(null, "", `#rc=${rc}`);
    showDetails(layer.feature.properties);
  }

  const details = (html) => {
    const el = document.getElementById("details");
    el.classList.toggle("empty", false);
    el.innerHTML = html;
  };

  // Where Catastro plot records come from. With server.py (local) everything goes through /api.
  // On a static host: bundled saved records first, then the Catastro directly (works only if it allows it).
  const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
  const CATASTRO = "https://ovc.catastro.meh.es/OVCServWeb/OVCWcfCallejero/COVCCallejero.svc/json/Consulta_DNPRC?RefCat=";
  let savedRecords = null;
  async function fetchRecord(rc) {
    if (LOCAL) {
      const r = await fetch(`/api/dnprc?rc=${encodeURIComponent(rc)}`);
      if (!r.ok) throw new Error(`Catastro request failed (${r.status})`);
      return r.json();
    }
    if (!savedRecords) {
      savedRecords = fetch("data/records.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    }
    const saved = (await savedRecords)[rc];
    if (saved) return saved;
    try {
      const r = await fetch(CATASTRO + encodeURIComponent(rc));
      if (r.ok) return r.json();
    } catch (e) { /* blocked by the browser or the Catastro: fall through */ }
    throw new Error("Live Catastro details aren't available on this site for this plot. Use the Sede Catastro link below.");
  }

  async function getDnprc(rc) {
    const j = (await fetchRecord(rc)).consulta_dnprcResult;
    if (j.control && j.control.cuerr) {
      const e = j.lerr && j.lerr.err; const m = Array.isArray(e) ? e[0] : e;
      throw new Error((m && m.des) || "Catastro returned an error");
    }
    return j;
  }

  async function showDetails(p) {
    const token = p.rc;
    details(headerHtml(p, null) + overrideHtml(p) + statsHtml(p, null) + zoningHtml(p, null) + `<p class="muted">Loading Catastro record…</p>`);
    bindOverride(p, null);
    let j;
    try { j = await getDnprc(p.rc); }
    catch (err) {
      if (selected && selected.feature.properties.rc !== token) return;
      details(headerHtml(p, null) + overrideHtml(p) + statsHtml(p, null) + zoningHtml(p, null) + `<p class="err">${esc(err.message)}</p>` + linksHtml(p));
      return bindOverride(p, null);
    }
    if (!selected || selected.feature.properties.rc !== token) return; // user clicked elsewhere meanwhile
    const info = normalise(j);
    details(headerHtml(p, info) + overrideHtml(p) + statsHtml(p, info) + zoningHtml(p, info) + bodyHtml(info) + photoHtml(p) + linksHtml(p));
    bindUnits(info);
    bindOverride(p, info);
  }

  // Pick the value of a [[slope threshold, value], …] table for a slope ("superior a X" → slope > X)
  function bySlopeTable(table, slope) {
    if (!table || slope == null) return null;
    let v = null;
    for (const [th, val] of table) if (th === 0 || slope > th) v = val;
    return v;
  }
  // Rules after applying the plot's slope
  function effective(r, slope) {
    return {
      height: bySlopeTable(r.height_by_slope, slope) ?? r.max_height_m ?? null,
      coverage: bySlopeTable(r.coverage_by_slope, slope) ?? r.max_coverage_pct ?? null,
      depth: bySlopeTable(r.depth_by_slope, slope),
    };
  }
  // What the town-plan rules allow on a plot. Uses only the part of the plot inside its
  // building zone (not land reserved for roads / parks) and the street frontage.
  function potential(p, r, plotArea) {
    if (!r) return null;
    const plot = plotArea || p.area;
    if (!plot) return null;
    const zArea = Math.round(plot * (p.zone_share != null ? p.zone_share : 1));
    const e = effective(r, p.slope);
    const out = { zArea, e };
    if (r.far != null) {
      out.maxBuild = zArea * r.far;
      out.remaining = Math.max(0, out.maxBuild - (p.built || 0));
    }
    if (e.coverage != null) {
      out.footprint = zArea * e.coverage / 100;
      if (r.max_footprint_m2) out.footprint = Math.min(out.footprint, r.max_footprint_m2);
    }
    const minF = r.min_frontage_m, fr = p.frontage;
    // dwellings: by area, capped by the zone's max and by frontage (two-family / grouped: frontage −25%, Art. 135.4)
    let dw = null, dwWhy = "plot area";
    if (r.m2_per_dwelling) dw = Math.floor(zArea / r.m2_per_dwelling);
    else if (r.dwellings_per_plot != null && r.min_plot_m2) dw = zArea >= r.min_plot_m2 ? r.dwellings_per_plot : 0;
    if (dw != null && r.max_dwellings != null && dw > r.max_dwellings) { dw = r.max_dwellings; dwWhy = "zone maximum"; }
    if (dw != null && minF && fr != null) {
      const byF = Math.max(1, Math.floor(fr / (0.75 * minF)));
      if (byF < dw) { dw = byF; dwWhy = "street frontage"; }
    }
    out.dwellings = dw; out.dwWhy = dwWhy;
    // splits: every new plot needs the minimum area AND the minimum street frontage
    if (r.min_plot_m2) {
      const byArea = Math.floor(zArea / r.min_plot_m2);
      const byFront = minF && fr != null ? Math.floor(fr / minF) : byArea;
      out.splits = r.no_new_splits ? null : Math.min(byArea, byFront);
      out.splitWhy = r.no_new_splits ? "layout fixed in the plans"
        : byFront < byArea ? `street frontage ${fr} m ÷ ${minF} m` : `zoned area ÷ ${fmtM2(r.min_plot_m2)}`;
    }
    return out;
  }

  // Zoning: town-plan zone, its rules (zoning_rules.json) and what they allow on this plot
  function zoningHtml(p, info) {
    if (!p.muc) return `<h3>Zoning</h3><p class="muted">No zoning data for this plot.</p>`;
    const fam = ZONES[zoneFamily(p)] || ZONES.none;
    const r = RULES[p.zone] || {};
    let h = `<h3>Zoning</h3><div class="zone"><i style="background:${fam.color}"></i><div>` +
      `<strong>${esc(p.zone)}</strong><br><span class="muted">MUC ${esc(p.muc)} · ${esc(fam.label)}` +
      `${p.zone_share < 0.9 ? ` · covers ${Math.round(p.zone_share * 100)}% of plot` : ""}</span></div></div>`;

    const e = effective(r, p.slope);
    const bySlope = (on) => (on && p.slope != null ? ` <span class="muted">(at ${p.slope}% slope)</span>` : "");
    const rows = [
      ["Minimum plot", r.min_plot_m2 != null ? fmtM2(r.min_plot_m2) : null],
      ["Buildability", r.far != null ? `${r.far} m² built / m² plot` : null],
      ["Max. coverage", e.coverage != null ? `${e.coverage}%${r.max_footprint_m2 ? ` (max ${fmtM2(r.max_footprint_m2)})` : ""}${bySlope(r.coverage_by_slope)}` : null],
      ["Max. height", e.height != null ? `${e.height} m${bySlope(r.height_by_slope)}` : null],
      ["Max. building depth", e.depth != null ? `${e.depth} m from street${bySlope(true)}` : null],
      ["Max. floors", r.max_floors != null ? r.max_floors : null],
      ["Dwellings / min. plot", r.dwellings_per_plot != null ? r.dwellings_per_plot : null],
      ["Plot m² per dwelling", r.m2_per_dwelling != null ? fmtM2(r.m2_per_dwelling) : null],
      ["Max. dwellings per plot", r.max_dwellings != null ? r.max_dwellings : null],
      ["Subdivision", r.no_new_splits ? "only as fixed in the plans" : null],
    ].filter(([, v]) => v != null);
    if (!rows.length) {
      return h + `<p class="muted small">Rules for this zone not entered yet (zoning_rules.json).</p>`;
    }
    h += `<table>${rows.map(([k, v]) => `<tr><th>${k}</th><td class="n">${v}</td></tr>`).join("")}</table>`;

    // what the rules allow on this plot
    const plot = (info && info.plot) || p.area;
    const built = info && info.built != null ? info.built : p.built || 0;
    const q = potential(p, r, plot);
    const pot = [];
    if (p.other_zones && p.other_zones.length) {
      const parts = p.other_zones.map(([m, z, pct]) =>
        `${pct}% ${esc((ZONES[zoneFamily({ muc: m })] || ZONES.none).label.toLowerCase())} (${esc(z)})`).join(", ");
      h += `<p class="note">Not all of this plot can be built on: ${parts}. ` +
        `Only the ${fmtM2(q.zArea)} inside the building zone count below.</p>`;
    }
    if (q.zArea !== plot) pot.push(["Area in building zone", fmtM2(q.zArea)]);
    if (p.frontage != null) pot.push(["Street frontage (est.)", `${p.frontage} m${r.min_frontage_m ? ` · min. ${r.min_frontage_m} m per plot` : ""}`]);
    if (q.maxBuild != null) {
      pot.push(["Max. buildable", fmtM2(q.maxBuild)]);
      pot.push(["Already built", fmtM2(built)]);
      pot.push(["Remaining", `<strong>${fmtM2(Math.max(0, q.maxBuild - built))}</strong>`]);
    }
    if (q.footprint != null) pot.push(["Max. footprint", fmtM2(q.footprint)]);
    if (q.dwellings != null) pot.push(["Max. dwellings", `${q.dwellings} <span class="muted">(limited by ${q.dwWhy})</span>`]);
    if (r.min_plot_m2) {
      const s = q.splits;
      pot.push(["Could be split into", s == null ? `no (${q.splitWhy})`
        : s >= 2 ? `<strong>up to ${s} plots</strong> <span class="muted">(${esc(q.splitWhy)})</span>`
        : q.zArea < r.min_plot_m2 ? "no (below min. plot)" : `no <span class="muted">(${esc(q.splitWhy)})</span>`]);
    }
    if (p.slope != null) {
      pot.push(["Terrain", `${p.slope}% mean slope · ${p.drop} m drop · ${p.elev} m altitude`]);
    }
    if (pot.length) {
      h += `<h3>Potential on this plot</h3><table>${pot.map(([k, v]) => `<tr><th>${k}</th><td class="n">${v}</td></tr>`).join("")}</table>`;
    }
    if (q.splits >= 2) {
      h += `<p class="muted small">Upper bound from area and frontage only. A real subdivision also has to fit the ` +
        `existing building with its setbacks, give every new plot street access, and work with the plot's shape.</p>`;
    }
    if (r.source) h += `<p class="muted small">Source: ${esc(r.source)}</p>`;
    return h;
  }

  // Unbuilt plots: let the user correct "buildable" vs "park / open space"
  const UNBUILT = new Set(["buildable", "open", "vacant", "devland", "facility"]);
  function overrideHtml(p) {
    if (!LOCAL) return ""; // corrections are saved by server.py; the public site only shows them
    // any plot without a Catastro building can be corrected (e.g. a railway strip recorded as "industrial")
    if (!UNBUILT.has(p.cat0) && !UNBUILT.has(p.cat) && p.use) return "";
    const toOpen = p.cat !== "open";
    const manual = p.cat !== p.cat0;
    return `<div class="override"><button id="ovr" data-to="${toOpen ? "open" : "buildable"}">` +
      `${toOpen ? "Mark as park / open space" : "Mark as unbuilt plot"}</button>` +
      `${manual ? ` <span class="muted">(your correction · <a href="#" id="ovr-reset">undo</a>)</span>` : ""}</div>`;
  }
  function bindOverride(p, info) {
    const btn = document.getElementById("ovr");
    if (!btn) return;
    const save = async (cat) => {
      btn.disabled = true;
      const r = await fetch("/api/override", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rc: p.rc, cat: cat === p.cat0 ? null : cat }),
      });
      if (!r.ok) { btn.disabled = false; btn.textContent = "Couldn't save, try again"; return; }
      p.cat = cat;
      restyle(); renderLegend();
      showDetails(p);
    };
    btn.addEventListener("click", () => save(btn.dataset.to));
    const reset = document.getElementById("ovr-reset");
    if (reset) reset.addEventListener("click", (e) => { e.preventDefault(); save(p.cat0); });
  }

  // Turn the Catastro JSON into something flat.
  function normalise(j) {
    const out = { units: [], cons: [], crops: [] };
    if (j.bico) {
      const bi = j.bico.bi, f = j.bico.finca || {};
      out.cls = bi.idbi.cn;
      out.address = cleanAddr(bi.ldt || f.ldt);
      out.use = bi.debi && bi.debi.luso;
      out.built = num(bi.debi && bi.debi.sfc);
      out.year = bi.debi && bi.debi.ant;
      out.plot = num(f.dff && f.dff.ss);
      out.kind = f.ltp;
      out.cons = arr(j.bico.lcons).map((c) => ({
        use: c.lcd, m2: num(c.dfcons && c.dfcons.stl), type: c.dvcons && c.dvcons.dtip,
        ...loint(c.dt && c.dt.lourb && c.dt.lourb.loint),
      }));
      out.crops = arr(j.bico.lspr).map((s) => ({
        crop: s.dspr && s.dspr.dcc, intensity: s.dspr && s.dspr.ip, m2: num(s.dspr && s.dspr.ssp),
      }));
    } else if (j.lrcdnp) {
      const list = arr(j.lrcdnp.rcdnp);
      out.cls = list[0] && list[0].rc && /^\d{5}[A-Z]/.test(list[0].rc.pc1) ? "RU" : "UR";
      out.units = list.map((u) => {
        const lourb = u.dt && u.dt.locs && u.dt.locs.lous && u.dt.locs.lous.lourb;
        return {
          rc: rcString(u.rc), use: u.debi && u.debi.luso, m2: num(u.debi && u.debi.sfc),
          year: u.debi && u.debi.ant, share: u.debi && u.debi.cpt,
          street: lourb && lourb.dir ? [lourb.dir.tv, lourb.dir.nv, lourb.dir.pnp].filter(Boolean).join(" ") : "",
          ...loint(lourb && lourb.loint),
        };
      });
      const streets = [...new Set(out.units.map((u) => u.street).filter(Boolean))];
      out.address = streets.join(" · ");
      out.built = out.units.reduce((s, u) => s + (u.m2 || 0), 0);
      const years = out.units.map((u) => +u.year).filter(Boolean);
      out.year = years.length ? Math.min(...years) : null;
      const uses = countBy(out.units.map((u) => u.use));
      out.use = Object.entries(uses).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} (${n})`).join(", ");
      out.kind = "Division horizontal (" + out.units.length + " units)";
    }
    const floorsOf = (xs) => {
      const fl = new Set(xs.map((x) => x.floor).filter((x) => x != null && /^\d+$/.test(x)).map(Number));
      return fl.size ? Math.max(...fl) + 1 : null;
    };
    out.floors = floorsOf(out.units.length ? out.units : out.cons);
    out.basement = (out.units.length ? out.units : out.cons).some((x) => /^-/.test(x.floor || ""));
    return out;
  }

  function headerHtml(p, info) {
    const cls = info && info.cls ? (info.cls === "RU" ? "Rústico" : "Urbano") : null;
    return `<div class="rc">${p.rc}</div>` +
      `<div class="addr">${info && info.address ? esc(info.address) : ""}</div>` +
      `<div>${cls ? `<span class="badge">${cls}</span>` : ""}` +
      `<span class="badge" style="background:${(CATS[p.cat] || CATS.other).color}33">${(CATS[p.cat] || CATS.other).label}</span>` +
      `${info && info.kind ? `<span class="badge">${esc(info.kind)}</span>` : ""}</div>`;
  }

  function statsHtml(p, info) {
    const plot = (info && info.plot) || p.area;
    const built = info && info.built != null ? info.built : p.built;
    const year = (info && info.year) || p.year;
    const floors = (info && info.floors) || p.floors;
    const s = [
      ["Plot surface", fmtM2(plot)],
      ["Built surface", built ? fmtM2(built) : "—"],
      ["Main use", esc((info && info.use) || (p.use ? p.use.replace(/^[\d_]+/, "") : "—"))],
      ["Year built", year || "—"],
      ["Floors above ground", floors ? floors + (info && info.basement ? " + basement" : "") : "—"],
      ["Dwellings", p.dwellings != null ? p.dwellings : "—"],
      ["Footprint (coverage)", p.footprint && plot ? `${fmtM2(p.footprint)} · ${Math.round(100 * p.footprint / plot)}%` : "—"],
      ["Density (built/plot)", built && plot ? (built / plot).toFixed(2) : "—"],
    ];
    return `<div class="stats">${s.map(([k, v]) => `<div class="stat"><small>${k}</small><strong>${v}</strong></div>`).join("")}</div>`;
  }

  function bodyHtml(info) {
    let h = "";
    if (info.cons.length) {
      h += `<h3>Constructions</h3><table><tr><th>Use</th><th>Floor</th><th class="n">m²</th></tr>` +
        info.cons.map((c) => `<tr><td>${esc(cap(c.use))}${c.type ? `<br><span class="muted">${esc(cap(c.type))}</span>` : ""}</td>` +
          `<td>${floorLabel(c.floor)}${c.door ? ` · ${esc(c.door)}` : ""}</td><td class="n">${fmtN(c.m2)}</td></tr>`).join("") + `</table>`;
    }
    if (info.crops.length) {
      h += `<h3>Land use (subparcels)</h3><table><tr><th>Crop / use</th><th class="n">m²</th></tr>` +
        info.crops.map((c) => `<tr><td>${esc(cap(c.crop))}${c.intensity ? ` <span class="muted">(int. ${esc(c.intensity)})</span>` : ""}</td>` +
          `<td class="n">${fmtN(c.m2)}</td></tr>`).join("") + `</table>`;
    }
    if (info.units.length) {
      h += `<h3>Units (${info.units.length}) — click one for details</h3>` +
        `<table id="units"><tr><th>Floor · door</th><th>Use</th><th class="n">m²</th><th class="n">Year</th></tr>` +
        info.units.map((u, i) => `<tr class="unit" data-i="${i}"><td>${u.stairs && u.stairs !== "T" ? `Esc ${esc(u.stairs)} · ` : ""}` +
          `${floorLabel(u.floor)}${u.door ? ` · ${esc(u.door)}` : ""}</td><td>${esc(u.use)}</td>` +
          `<td class="n">${fmtN(u.m2)}</td><td class="n">${esc(u.year || "")}</td></tr>`).join("") + `</table>`;
    }
    return h;
  }

  function bindUnits(info) {
    const t = document.getElementById("units");
    if (!t) return;
    t.addEventListener("click", async (e) => {
      const row = e.target.closest("tr.unit");
      if (!row) return;
      const next = row.nextElementSibling;
      if (next && next.classList.contains("sub")) return next.remove();
      const u = info.units[+row.dataset.i];
      const sub = document.createElement("tr");
      sub.className = "sub";
      sub.innerHTML = `<td colspan="4">Loading ${u.rc}…</td>`;
      row.after(sub);
      try {
        const d = normalise(await getDnprc(u.rc));
        sub.innerHTML = `<td colspan="4"><span class="rc" style="font-size:12px">${u.rc}</span>` +
          `${num(u.share) ? ` · ${+num(u.share).toFixed(2)}% of the building` : ""}<br>` +
          (d.cons.map((c) => `${esc(cap(c.use))} · ${floorLabel(c.floor)} · ${fmtN(c.m2)} m²`).join("<br>") || "No breakdown") +
          `</td>`;
      } catch (err) { sub.innerHTML = `<td colspan="4" class="err">${esc(err.message)}</td>`; }
    });
  }

  function photoHtml(p) {
    if (!p.built && !p.use) return "";
    const src = LOCAL ? `/api/photo?rc=${p.rc}`
      : `https://ovc.catastro.meh.es/OVCServWeb/OVCWcfLibres/OVCFotoFachada.svc/RecuperarFotoFachadaGet?ReferenciaCatastral=${p.rc}`;
    return `<h3>Façade photo</h3><img class="photo" alt="Façade photo from Catastro" src="${src}" loading="lazy" ` +
      `onerror="this.previousElementSibling.remove();this.remove()">`;
  }
  function linksHtml(p) {
    return `<a class="link" target="_blank" rel="noopener" href="https://www1.sedecatastro.gob.es/Cartografia/mapa.aspx?del=8&mun=5&refcat=${p.rc}">Open in Sede Catastro ↗</a>` +
      `<br><a class="link" style="margin-top:4px" target="_blank" rel="noopener" href="https://www1.sedecatastro.gob.es/CYCBienInmueble/OVCListaBienes.aspx?rc1=${p.rc.slice(0, 7)}&rc2=${p.rc.slice(7, 14)}">Catastro property list ↗</a>`;
  }

  // ------------------------------------------------------------ helpers
  function arr(x) { return x == null ? [] : Array.isArray(x) ? x : [x]; }
  function num(x) { const n = parseFloat(String(x || "").replace(",", ".")); return isNaN(n) ? null : n; }
  function rcString(rc) { return rc ? `${rc.pc1}${rc.pc2}${rc.car || ""}${rc.cc1 || ""}${rc.cc2 || ""}` : ""; }
  function loint(l) { return l ? { stairs: l.es, floor: l.pt, door: l.pu } : {}; }
  function countBy(xs) { return xs.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {}); }
  function floorLabel(f) {
    if (f == null || f === "") return "—";
    if (f === "00") return "Ground";
    if (/^-\d+$/.test(f)) return `Basement ${f.slice(1).replace(/^0/, "")}`;
    if (/^\d+$/.test(f)) return `Floor ${+f}`;
    return esc(f);
  }
  function cleanAddr(s) { return (s || "").replace(/\s+/g, " ").replace(/ L' AMETLLA DEL VALLES \(BARCELONA\)/, "").trim(); }
  function cap(s) { return s ? s.charAt(0) + s.slice(1).toLowerCase() : ""; }
  function fmtN(n) { return n == null ? "—" : Math.round(n).toLocaleString("en"); }
  function fmtM2(n) { return n == null ? "—" : `${fmtN(n)} m²`; }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
})();
