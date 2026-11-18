"use client";

// Envoi de fichiers lourds (archives LinkedIn : souvent des centaines de Mo) directement du navigateur vers Storage.
// - Au-delà de 6 Mo : envoi reprenable (protocole TUS de Supabase Storage, morceaux de 6 Mo, jeton d'envoi signé
//   dans « x-signature »). Après une coupure, on demande au stockage où il en est (HEAD) et on repart de là.
//   L'adresse d'envoi est gardée dans le navigateur : un fichier re-sélectionné après un rechargement reprend aussi.
// - Sinon, ou si l'envoi reprenable est refusé : envoi simple sur l'URL signée.
// Aucune donnée du fichier n'est lue ou journalisée ici (données personnelles).

export type UploadTicket = { file_id: string; signedUrl: string; token: string; tus: string; bucket: string; path: string; type: string };
export type UploadEvents = {
  onProgress: (sent: number, total: number) => void;
  /** coupure : tentative n, prochaine tentative dans `delay` ms */
  onRetry: (attempt: number, delay: number) => void;
};

const CHUNK = 6 * 1024 * 1024; // imposé par Supabase pour TUS
const MAX_ATTEMPTS = 12;
const RESUME_KEY = "cely-discovery-upload:";

export class UploadError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

/** Empreinte locale d'un fichier (nom, taille, date) : permet de reprendre le même fichier après un rechargement. */
export const fingerprint = (projectId: string, step: string, f: File) => `${RESUME_KEY}${projectId}:${step}:${f.name}:${f.size}:${f.lastModified}`;

type Saved = { file_id: string; location: string | null; at: number };
export function savedUpload(key: string): Saved | null {
  try {
    const s = JSON.parse(window.localStorage.getItem(key) ?? "null") as Saved | null;
    return s && Date.now() - s.at < 22 * 3600_000 ? s : null;
  } catch {
    return null;
  }
}
export function rememberUpload(key: string, s: Saved | null) {
  try {
    if (s) window.localStorage.setItem(key, JSON.stringify(s));
    else window.localStorage.removeItem(key);
  } catch {
    /* navigation privée : la reprise après rechargement n'est pas possible, la reprise après coupure reste active */
  }
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = window.setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { window.clearTimeout(t); reject(new DOMException("Annulé", "AbortError")); }, { once: true });
});

/** Attend le retour du réseau (ou le délai) avant une nouvelle tentative. */
async function backoff(attempt: number, ev: UploadEvents, signal: AbortSignal) {
  const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5));
  ev.onRetry(attempt, delay);
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    await new Promise<void>((resolve) => {
      const on = () => { window.removeEventListener("online", on); resolve(); };
      window.addEventListener("online", on);
      signal.addEventListener("abort", on, { once: true });
    });
  } else {
    await sleep(delay, signal);
  }
}

type XhrResult = { status: number; headers: (name: string) => string | null };
function xhr(method: string, url: string, headers: Record<string, string>, body: Blob | null, signal: AbortSignal, onUp?: (loaded: number) => void): Promise<XhrResult> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(method, url);
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
    if (onUp) x.upload.onprogress = (e) => onUp(e.loaded);
    x.onload = () => resolve({ status: x.status, headers: (n) => x.getResponseHeader(n) });
    x.onerror = () => reject(new UploadError("network", true));
    x.ontimeout = () => reject(new UploadError("network", true));
    const abort = () => x.abort();
    signal.addEventListener("abort", abort, { once: true });
    x.onabort = () => reject(new DOMException("Annulé", "AbortError"));
    x.send(body);
  });
}

const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));

async function simplePut(file: File, t: UploadTicket, ev: UploadEvents, signal: AbortSignal) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await xhr("PUT", t.signedUrl, { "content-type": t.type || "application/octet-stream", "x-upsert": "false" }, file, signal, (n) => ev.onProgress(n, file.size));
      if (r.status >= 200 && r.status < 300) return;
      // objet déjà reçu lors d'une tentative précédente
      if (r.status === 409 || r.status === 400) {
        ev.onProgress(file.size, file.size);
        return;
      }
      if (r.status < 500) throw new UploadError(`Envoi refusé par le stockage (${r.status}).`, false);
    } catch (e) {
      if (e instanceof DOMException || (e instanceof UploadError && !e.retryable)) throw e;
    }
    if (attempt >= MAX_ATTEMPTS) throw new UploadError("La connexion est trop instable : envoi interrompu.", true);
    await backoff(attempt, ev, signal);
  }
}

async function tusOffset(location: string, t: UploadTicket, signal: AbortSignal): Promise<number | null> {
  const r = await xhr("HEAD", location, { "tus-resumable": "1.0.0", "x-signature": t.token, "cache-control": "no-store" }, null, signal);
  if (r.status === 404 || r.status === 410 || r.status === 403) return null; // expiré : on recrée l'envoi
  if (r.status < 200 || r.status >= 300) throw new UploadError("network", true);
  return Number(r.headers("upload-offset") ?? "0");
}

async function tusCreate(file: File, t: UploadTicket, signal: AbortSignal): Promise<string | null> {
  const meta = [`bucketName ${b64(t.bucket)}`, `objectName ${b64(t.path)}`, `contentType ${b64(t.type || "application/octet-stream")}`, `cacheControl ${b64("3600")}`].join(",");
  const r = await xhr("POST", t.tus, { "tus-resumable": "1.0.0", "upload-length": String(file.size), "upload-metadata": meta, "x-signature": t.token, "x-upsert": "false" }, null, signal);
  if (r.status === 201 && r.headers("location")) return new URL(r.headers("location")!, t.tus).toString();
  if (r.status >= 500) throw new UploadError("network", true);
  return null; // envoi reprenable indisponible : envoi simple
}

/**
 * Envoie le fichier. `resumeKey` : clé de reprise (fingerprint). Lève UploadError (message lisible) en cas d'échec définitif.
 */
export async function uploadFile(file: File, t: UploadTicket, ev: UploadEvents, signal: AbortSignal, resumeKey: string): Promise<void> {
  if (file.size <= CHUNK) {
    await simplePut(file, t, ev, signal);
    return;
  }
  let location = savedUpload(resumeKey)?.location ?? null;
  let attempt = 0;
  let offset = 0;
  for (;;) {
    try {
      if (location) {
        const o = await tusOffset(location, t, signal);
        if (o === null) location = null;
        else offset = o;
      }
      if (!location) {
        location = await tusCreate(file, t, signal);
        if (!location) {
          rememberUpload(resumeKey, null);
          await simplePut(file, t, ev, signal);
          return;
        }
        offset = 0;
        rememberUpload(resumeKey, { file_id: t.file_id, location, at: Date.now() });
      }
      ev.onProgress(offset, file.size);
      while (offset < file.size) {
        const chunk = file.slice(offset, Math.min(offset + CHUNK, file.size));
        const start = offset;
        const r = await xhr("PATCH", location, {
          "tus-resumable": "1.0.0", "upload-offset": String(offset), "content-type": "application/offset+octet-stream", "x-signature": t.token,
        }, chunk, signal, (n) => ev.onProgress(start + n, file.size));
        if (r.status === 409) { offset = (await tusOffset(location, t, signal)) ?? 0; continue; } // décalage : on se recale
        if (r.status < 200 || r.status >= 300) throw new UploadError(r.status >= 500 ? "network" : `Envoi refusé par le stockage (${r.status}).`, r.status >= 500);
        offset = Number(r.headers("upload-offset") ?? offset + chunk.size);
        attempt = 0; // un morceau est passé : le compteur de coupures repart de zéro
        ev.onProgress(offset, file.size);
      }
      rememberUpload(resumeKey, null);
      return;
    } catch (e) {
      if (e instanceof DOMException) throw e;
      if (e instanceof UploadError && !e.retryable) throw e;
      attempt++;
      if (attempt >= MAX_ATTEMPTS) throw new UploadError("La connexion est trop instable : envoi mis en pause. Relance-le, il reprendra où il s'est arrêté.", true);
      await backoff(attempt, ev, signal);
    }
  }
}
