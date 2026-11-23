// Petits utilitaires partagés.

export const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const uuid = () =>
  (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID()
  : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });

export const fmtNum = (n, d = 0) =>
  n == null || Number.isNaN(n) ? "—" : Number(n).toLocaleString("fr-BE", { maximumFractionDigits: d, minimumFractionDigits: 0 });

export const plural = (n, one, many) => `${fmtNum(n)} ${n > 1 ? many : one}`;

export const fmtDistance = (m) => {
  if (m == null || Number.isNaN(m)) return "—";
  if (m < 1000) return `${Math.round(m / 5) * 5} m`;
  return `${fmtNum(m / 1000, 1)} km`;
};

export const fmtDuration = (ms) => {
  const min = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(min / 60);
  return h ? `${h} h ${String(min % 60).padStart(2, "0")}` : `${min} min`;
};

const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
export const fmtDateTime = (ts) => {
  const d = new Date(ts);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} à ${String(d.getHours()).padStart(2, "0")}h${String(d.getMinutes()).padStart(2, "0")}`;
};

export const initials = (name) =>
  String(name || "?").replace(/^(les?|la|l'|l’)\s+/i, "").trim().charAt(0).toUpperCase() || "?";

let toastTimer;
export function toast(msg, kind = "info") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), kind === "error" ? 5000 : 2600);
}

export function confirmDialog(message, okLabel = "Confirmer", danger = true) {
  return new Promise((resolve) => {
    const dlg = document.getElementById("dialog");
    if (dlg.open) dlg.close();
    dlg.className = "";
    dlg.innerHTML = `<form method="dialog" class="dlg">
      <p>${esc(message)}</p>
      <div class="dlg-actions">
        <button value="cancel" class="btn ghost">Annuler</button>
        <button value="ok" class="btn ${danger ? "danger" : "primary"}">${esc(okLabel)}</button>
      </div></form>`;
    dlg.onclose = () => resolve(dlg.returnValue === "ok");
    dlg.showModal();
  });
}

// Réduit une photo avant de la stocker (le stockage du téléphone est limité).
export function shrinkImage(file, max = 1600, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error("Photo illisible"))), "image/jpeg", quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Photo illisible")); };
    img.src = url;
  });
}

// Prépare une photo (réduite) ou une vidéo (taille limitée) pour l'envoi.
export const MAX_VIDEO_MB = 48;
export async function prepareMedia(file) {
  if (file.type.startsWith("video/")) {
    if (file.size > MAX_VIDEO_MB * 1024 * 1024) {
      throw new Error(`Vidéo trop lourde (${Math.round(file.size / 1e6)} Mo) : refais-la plus courte, 15 secondes environ`);
    }
    const ext = /mp4/.test(file.type) ? "mp4" : /quicktime/.test(file.type) ? "mov" : (file.name.split(".").pop() || "mp4").toLowerCase();
    return { blob: file, kind: "video", ext, url: URL.createObjectURL(file) };
  }
  const blob = await shrinkImage(file);
  return { blob, kind: "photo", ext: "jpg", url: URL.createObjectURL(blob) };
}

// Ancien format (photo en texte « data: ») → Blob, sans passer par le réseau.
export function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(",");
  const type = head.match(/data:([^;]+)/)?.[1] || "application/octet-stream";
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type });
}

// URL affichable d'un média stocké (Blob ou ancien texte « data: »), mise en cache.
const urls = new Map();
export function mediaUrl(id, value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (!urls.has(id)) urls.set(id, URL.createObjectURL(value));
  return urls.get(id);
}
