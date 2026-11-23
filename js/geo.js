// Géolocalisation, boussole et simulation de position (pour tester sans bouger).

const R = 6371000; // rayon terrestre moyen, en mètres
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

// Distance en mètres entre deux points {lat, lng} (formule de haversine).
export function distance(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Cap (0 = nord, 90 = est) pour aller de a vers b.
export function bearing(a, b) {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

// Point situé à `dist` mètres de `p`, dans la direction `brg` (degrés).
export function offset(p, dist, brg) {
  const d = dist / R;
  const t = rad(brg);
  const lat1 = rad(p.lat);
  const lng1 = rad(p.lng);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(t));
  const lng2 = lng1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: deg(lat2), lng: ((deg(lng2) + 540) % 360) - 180 };
}

// « Chaud / froid » d'après l'évolution de la distance.
export function warmth(prev, now) {
  if (prev == null || now == null) return null;
  const delta = now - prev;
  if (Math.abs(delta) < 3) return null; // bruit GPS
  if (delta < 0) return now < 60 ? "brulant" : "chaud";
  return "froid";
}

export const WARMTH_LABEL = { brulant: "Tout près !", chaud: "Ça chauffe !", froid: "Ça refroidit…" };

// Direction cardinale lisible, pour le mode sans boussole.
export function cardinal(b) {
  const names = ["nord", "nord-est", "est", "sud-est", "sud", "sud-ouest", "ouest", "nord-ouest"];
  return names[Math.round(b / 45) % 8];
}

// ---------- Capteurs -------------------------------------------------------
// Suivi GPS réel. Renvoie une fonction d'arrêt.
export function watchPosition(onPos, onError) {
  if (!("geolocation" in navigator)) { onError?.(new Error("GPS indisponible sur cet appareil")); return () => {}; }
  const id = navigator.geolocation.watchPosition(
    (p) => onPos({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, at: Date.now() }),
    (e) => onError?.(new Error(e.code === 1 ? "Autorise la localisation pour jouer" : "Position introuvable pour l'instant")),
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

export function currentPosition() {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) return reject(new Error("GPS indisponible sur cet appareil"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject(new Error(e.code === 1 ? "Autorise la localisation dans Réglages > Safari" : "Position introuvable, réessaie à l'extérieur")),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    );
  });
}

// Boussole. Sur iPhone, l'autorisation doit être demandée après un geste de l'utilisateur.
export const compassNeedsPermission = () =>
  typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function";

export async function requestCompass() {
  if (!compassNeedsPermission()) return true;
  try { return (await DeviceOrientationEvent.requestPermission()) === "granted"; }
  catch { return false; }
}

// Écoute le cap du téléphone (0 = nord). Renvoie une fonction d'arrêt.
export function watchHeading(onHeading) {
  const handler = (e) => {
    let h = null;
    if (typeof e.webkitCompassHeading === "number") h = e.webkitCompassHeading; // iPhone
    else if ((e.absolute || e.type === "deviceorientationabsolute") && typeof e.alpha === "number") h = (360 - e.alpha) % 360; // Android
    if (h != null) onHeading(h);
  };
  window.addEventListener("deviceorientationabsolute", handler);
  window.addEventListener("deviceorientation", handler);
  return () => {
    window.removeEventListener("deviceorientationabsolute", handler);
    window.removeEventListener("deviceorientation", handler);
  };
}

// Garde l'écran allumé pendant la partie (le GPS d'une app web s'arrête écran éteint).
export async function keepAwake() {
  try {
    if ("wakeLock" in navigator) return await navigator.wakeLock.request("screen");
  } catch { /* refusé ou non pris en charge */ }
  return null;
}

// ---------- Lieu saisi à la main ----------------------------------------------
// Lit des coordonnées dans un texte : « 50.8448, 4.364 », « 50°50'41.3"N 4°21'50.4"E »
// ou un lien Google Maps complet (…/@50.84,4.36,17z, …!3d50.84!4d4.36, ?q=50.84,4.36).
// Renvoie {lat, lng} ou null. Les liens courts (maps.app.goo.gl) ne contiennent pas de coordonnées.
export function parseLocation(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  const ok = (lat, lng) => (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat || lng) ? { lat, lng } : null);
  const num = String.raw`(-?\d{1,3}(?:\.\d+)?)`;
  let m;
  // Lien Google Maps : l'épingle du lieu (!3d…!4d…) est plus précise que le centre de la vue (@…).
  const url = (() => { try { return decodeURIComponent(t); } catch { return t; } })();
  if ((m = url.match(new RegExp(String.raw`!3d${num}!4d${num}`)))) return ok(+m[1], +m[2]);
  if ((m = url.match(new RegExp(String.raw`[?&](?:q|query|ll|destination|center)=(?:loc:)?${num}\s*,\s*${num}`)))) return ok(+m[1], +m[2]);
  if ((m = url.match(new RegExp(String.raw`@${num},${num}`)))) return ok(+m[1], +m[2]);
  // Degrés, minutes, secondes.
  const dms = String.raw`(\d{1,3})°\s*(\d{1,2})['’′]\s*(\d{1,2}(?:[.,]\d+)?)["”″]?\s*([NSEWO])`;
  if ((m = t.match(new RegExp(`${dms}[\\s,;]+${dms}`, "i")))) {
    const v = (d, mi, s, h) => (+d + +mi / 60 + +s.replace(",", ".") / 3600) * (/[SWO]/i.test(h) ? -1 : 1);
    let a = v(m[1], m[2], m[3], m[4]), b = v(m[5], m[6], m[7], m[8]);
    if (/[EWO]/i.test(m[4])) [a, b] = [b, a];
    return ok(a, b);
  }
  // Deux nombres décimaux : latitude puis longitude.
  if ((m = t.match(new RegExp(String.raw`^${num}\s*[,; ]\s*${num}$`)))) return ok(+m[1], +m[2]);
  return null;
}
