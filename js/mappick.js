// Choix d'un lieu sur une carte OpenStreetMap (Leaflet), sans clé ni compte.
// Chargé seulement à l'ouverture. La carte vit hors de #main pour survivre aux redessins.
import { esc, toast } from "./util.js";
import { icon } from "./icons.js";
import { parseLocation, currentPosition } from "./geo.js";

const LEAFLET_JS = "./vendor/leaflet/leaflet-src.esm.js";
const LEAFLET_CSS = new URL("./vendor/leaflet/leaflet.css", import.meta.url).href;
const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const SEARCH = "https://nominatim.openstreetmap.org/search";

let leaflet = null;
async function loadLeaflet() {
  if (leaflet) return leaflet;
  if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
    const link = Object.assign(document.createElement("link"), { rel: "stylesheet", href: LEAFLET_CSS });
    const loaded = new Promise((res) => { link.onload = res; link.onerror = res; });
    document.head.append(link);
    await loaded;
  }
  leaflet = await import(LEAFLET_JS);
  return leaflet;
}

const pinIcon = (L, cls, html = "") => L.divIcon({ className: `mp-pin ${cls}`, html, iconSize: [30, 38], iconAnchor: [15, 36] });

// start : {lat, lng} déjà choisi (ou null) ; others : [{lat, lng, label}] autres étapes ; radius en mètres.
// Renvoie {lat, lng} ou null si l'utilisateur annule.
export async function pickLocation({ start = null, others = [], radius = 25, title = "Choisir le lieu" } = {}) {
  const L = await loadLeaflet();
  const back = document.activeElement;
  const root = document.createElement("div");
  root.className = "mappick";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", title);
  root.innerHTML = `
    <header class="mp-top">
      <button type="button" class="icon-btn" data-mp="cancel" aria-label="Fermer">${icon("back", 22)}</button>
      <form class="mp-search" role="search">
        <input type="search" name="q" placeholder="Adresse ou lien Maps" aria-label="Rechercher un lieu" autocomplete="off" enterkeyhint="search">
        <button type="submit" class="btn small primary">Chercher</button>
      </form>
    </header>
    <ul class="mp-results" hidden></ul>
    <div class="mp-map"></div>
    <button type="button" class="mp-locate" data-mp="locate" aria-label="Centrer sur ma position">${icon("target", 20)}</button>
    <footer class="mp-bar">
      <span class="mp-info small grow">Touche la carte pour choisir le lieu.</span>
      <button type="button" class="btn ghost" data-mp="cancel">Annuler</button>
      <button type="button" class="btn primary" data-mp="ok" disabled>Placer ici</button>
    </footer>`;
  document.body.append(root);
  document.body.classList.add("mp-open");

  const $ = (s) => root.querySelector(s);
  const info = $(".mp-info"), okBtn = $('[data-mp="ok"]'), results = $(".mp-results"), input = $('input[name="q"]');
  const map = L.map($(".mp-map"), { zoomControl: true, attributionControl: true });
  L.tileLayer(TILES, { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>' }).addTo(map);

  // Autres étapes du parcours, pour se repérer.
  for (const o of others) {
    L.marker([o.lat, o.lng], { icon: pinIcon(L, "other", `<span>${esc(o.label)}</span>`), interactive: false, keyboard: false }).addTo(map);
  }

  let chosen = null, marker = null, zone = null;
  const place = (lat, lng, zoom) => {
    chosen = { lat, lng };
    if (!marker) {
      marker = L.marker([lat, lng], { icon: pinIcon(L, "main"), draggable: true, autoPan: true }).addTo(map);
      zone = L.circle([lat, lng], { radius, className: "mp-zone", interactive: false }).addTo(map);
      marker.on("drag", (e) => zone.setLatLng(e.latlng));
      marker.on("dragend", (e) => { const p = e.target.getLatLng(); place(p.lat, p.lng); });
    } else { marker.setLatLng([lat, lng]); zone.setLatLng([lat, lng]); }
    if (zoom) map.setView([lat, lng], Math.max(zoom, map.getZoom() || 0));
    info.innerHTML = `<strong>${lat.toFixed(5)}, ${lng.toFixed(5)}</strong><br><span class="muted">Fais glisser l'épingle pour ajuster.</span>`;
    okBtn.disabled = false;
  };
  map.on("click", (e) => place(e.latlng.lat, e.latlng.lng));

  // Vue de départ : le lieu actuel, sinon les autres étapes, sinon la position du téléphone.
  if (start) place(start.lat, start.lng, 18);
  else if (others.length === 1) map.setView([others[0].lat, others[0].lng], 17);
  else if (others.length) map.fitBounds(others.map((o) => [o.lat, o.lng]), { padding: [40, 40], maxZoom: 17 });
  else {
    map.setView([46.6, 2.4], 5);
    currentPosition().then((p) => { if (!chosen) map.setView([p.lat, p.lng], 17); }).catch(() => {});
  }
  requestAnimationFrame(() => map.invalidateSize());

  const showResults = (html) => { results.innerHTML = html; results.hidden = !html; };
  async function search(q) {
    q = q.trim();
    if (!q) return;
    const coords = parseLocation(q);
    if (coords) { showResults(""); place(coords.lat, coords.lng, 18); return; }
    if (/goo\.gl\/|maps\.app\./i.test(q)) {
      showResults(`<li class="mp-msg">Les liens courts Google Maps ne contiennent pas le lieu. Dans Google Maps, appuie longuement sur l'endroit, puis copie les coordonnées affichées (ex. 50.8448, 4.364) et colle-les ici.</li>`);
      return;
    }
    showResults(`<li class="mp-msg">Recherche…</li>`);
    try {
      const b = map.getBounds();
      const params = new URLSearchParams({ format: "jsonv2", q, limit: "6", "accept-language": "fr",
        viewbox: [b.getWest(), b.getNorth(), b.getEast(), b.getSouth()].join(",") });
      const res = await fetch(`${SEARCH}?${params}`, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error();
      const list = await res.json();
      showResults(list.length
        ? list.map((r) => `<li><button type="button" data-lat="${esc(r.lat)}" data-lng="${esc(r.lon)}">${esc(r.display_name)}</button></li>`).join("")
        : `<li class="mp-msg">Aucun lieu trouvé. Essaie avec la ville, ou colle des coordonnées.</li>`);
    } catch {
      showResults(`<li class="mp-msg">Recherche impossible (pas de réseau ?). Tu peux coller des coordonnées.</li>`);
    }
  }

  return new Promise((resolve) => {
    const close = (value) => {
      document.removeEventListener("keydown", onKey);
      map.remove();
      root.remove();
      document.body.classList.remove("mp-open");
      back?.focus?.();
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (!results.hidden) showResults(""); else close(null);
    };
    document.addEventListener("keydown", onKey);
    $(".mp-search").addEventListener("submit", (e) => { e.preventDefault(); input.blur(); search(input.value); });
    results.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-lat]");
      if (!b) return;
      showResults("");
      place(Number(b.dataset.lat), Number(b.dataset.lng), 18);
    });
    root.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-mp]");
      if (!b) return;
      if (b.dataset.mp === "cancel") close(null);
      else if (b.dataset.mp === "ok" && chosen) close(chosen);
      else if (b.dataset.mp === "locate") {
        b.disabled = true;
        try { const p = await currentPosition(); map.setView([p.lat, p.lng], 18); }
        catch (err) { toast(err.message, "error"); }
        b.disabled = false;
      }
    });
    input.focus({ preventScroll: true });
  });
}
