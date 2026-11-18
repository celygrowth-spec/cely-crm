// Onboarding de l'offre découverte, côté client (portail). Chaque opération passe par une fonction
// portal_discovery_* : session, appartenance au projet, case « Offre découverte », archivage, types et tailles.
// Le type d'un fichier est déduit de son extension ici, jamais repris du navigateur.
// Rien de ce que le client dépose ou écrit n'est journalisé (blacklists, archives : données personnelles).
import type { NextRequest } from "next/server";
import { z } from "zod";
import { publicClient } from "@/lib/appointments/server";
import { env } from "@/lib/env";
import { PortalError, portalRpc } from "@/lib/projects/portal";
import { portalFailure, reply, sameOrigin } from "@/lib/projects/portal-http";
import { mimeFromName } from "@/lib/discovery/files";

const BUCKET = "company-files";
const id = z.uuid();
const body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("get"), project: id }),
  z.object({ op: z.literal("position"), project: id, screen: z.string().regex(/^[a-z0-9_:.-]{1,60}$/) }),
  z.object({ op: z.literal("answer"), project: id, key: z.string().regex(/^[a-z0-9_]{1,60}$/), value: z.string().max(5000), rev: z.number().int().min(0) }),
  z.object({ op: z.literal("step"), project: id, step: z.string().max(20), status: z.enum(["done", "none", "later"]).nullable() }),
  z.object({ op: z.literal("file_start"), project: id, step: z.enum(["blacklist", "linkedin", "documents"]), name: z.string().trim().min(1).max(255), size: z.number().int().positive(), account: z.string().trim().max(120).nullable() }),
  z.object({ op: z.literal("file_resume"), file: id }),
  z.object({ op: z.literal("file_confirm"), file: id }),
  z.object({ op: z.literal("file_abort"), file: id }),
  z.object({ op: z.literal("file_remove"), id }),
  z.object({ op: z.literal("file_url"), id }),
  z.object({ op: z.literal("target_fill"), project: id, position: z.number().int().min(1).max(3), field: z.enum(["name", "sector", "company_size", "roles", "geography", "notes"]), value: z.string().max(2000), rev: z.number().int().min(0) }),
  z.object({ op: z.literal("target_validate"), project: id, position: z.number().int().min(1).max(3), rev: z.number().int().min(0), valid: z.boolean() }),
  z.object({ op: z.literal("target_comment"), project: id, position: z.number().int().min(1).max(3), body: z.string().trim().min(1).max(2000) }),
  z.object({ op: z.literal("send"), project: id }),
]);

/** Billet d'envoi : URL signée (envoi simple) et jeton pour l'envoi reprenable (TUS, x-signature). */
async function ticket(start: { file_id: string; path: string }, type: string) {
  const { data, error } = await publicClient().storage.from(BUCKET).createSignedUploadUrl(start.path);
  if (error || !data) throw new PortalError("Préparation de l'envoi impossible. Réessayez.", "server");
  return { file_id: start.file_id, signedUrl: data.signedUrl, token: data.token, tus: `${env.supabaseUrl}/storage/v1/upload/resumable`, bucket: BUCKET, path: start.path, type };
}

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return reply({ error: "Origine refusée" }, 403);
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return reply({ error: "Requête invalide" }, 400);
  const b = parsed.data;
  try {
    switch (b.op) {
      case "get":
        return reply(await portalRpc("portal_discovery", { p_project: b.project }));
      case "position":
        await portalRpc("portal_discovery_position", { p_project: b.project, p_screen: b.screen });
        return reply({ ok: true });
      case "answer":
        return reply(await portalRpc("portal_discovery_answer", { p_project: b.project, p_key: b.key, p_value: b.value, p_base_rev: b.rev }));
      case "step":
        return reply(await portalRpc("portal_discovery_step", { p_project: b.project, p_step: b.step, p_status: b.status }));
      case "file_start": {
        const type = mimeFromName(b.name);
        if (!type) return reply({ error: "Format non accepté pour cette étape" }, 400);
        const ext = b.name.match(/\.([a-zA-Z0-9]{1,8})$/)?.[1] ?? "bin";
        const s = await portalRpc<{ file_id: string; path: string }>("portal_discovery_file_start", {
          p_project: b.project, p_step: b.step, p_name: b.name, p_type: type, p_size: b.size, p_ext: ext, p_account: b.account,
        });
        try {
          return reply(await ticket(s, type));
        } catch (e) {
          await portalRpc("portal_discovery_file_abort", { p_file: s.file_id }).catch(() => undefined);
          throw e;
        }
      }
      case "file_resume": {
        const s = await portalRpc<{ file_id: string; path: string }>("portal_discovery_file_resume", { p_file: b.file });
        return reply(await ticket(s, ""));
      }
      case "file_confirm":
        return reply(await portalRpc("portal_discovery_file_confirm", { p_file: b.file }));
      case "file_abort":
        await portalRpc("portal_discovery_file_abort", { p_file: b.file });
        return reply({ ok: true });
      case "file_remove":
        await portalRpc("portal_discovery_file_remove", { p_id: b.id });
        return reply({ ok: true });
      case "file_url": {
        const g = await portalRpc<{ path: string; name: string }>("portal_discovery_file_grant", { p_id: b.id });
        // lien court, toujours en téléchargement (jamais affiché dans la page)
        const { data, error } = await publicClient().storage.from(BUCKET).createSignedUrl(g.path, 60, { download: g.name });
        if (error || !data) throw new PortalError("Lien temporaire impossible à créer.", "server");
        return reply({ url: data.signedUrl });
      }
      case "target_fill":
        return reply(await portalRpc("portal_discovery_target_fill", { p_project: b.project, p_position: b.position, p_field: b.field, p_value: b.value, p_base_rev: b.rev }));
      case "target_validate":
        return reply(await portalRpc("portal_discovery_target_validate", { p_project: b.project, p_position: b.position, p_base_rev: b.rev, p_valid: b.valid }));
      case "target_comment":
        return reply(await portalRpc("portal_discovery_target_comment", { p_project: b.project, p_position: b.position, p_body: b.body }));
      case "send":
        return reply(await portalRpc("portal_discovery_send", { p_project: b.project }));
    }
  } catch (e) {
    return portalFailure(e);
  }
}
