"use client";

// Envoi d'une image du CMS : ligne réservée en base, envoi direct au stockage par lien signé, puis confirmation.
import { confirmMediaUploadAction, startMediaUploadAction } from "@/app/cms-actions";
import { attempt } from "@/lib/client/query";

export async function uploadImage(file: File): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const start = await attempt(() => startMediaUploadAction({ name: file.name, size: file.size }));
  if (!start.ok) return start;
  const put = await fetch(start.data.signedUrl, { method: "PUT", headers: { "content-type": start.data.mime }, body: file }).catch(() => null);
  if (!put?.ok) return { ok: false, error: `Envoi de « ${file.name} » interrompu. Réessayez.` };
  const done = await attempt(() => confirmMediaUploadAction(start.data.id));
  if (!done.ok) return done;
  return { ok: true, url: done.data.url };
}
