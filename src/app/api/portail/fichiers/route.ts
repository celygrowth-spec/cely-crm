// Fichiers du portail. Chaque opération passe d'abord par la base (session, projet, propriété du dépôt) ;
// le stockage n'est ensuite accessible au rôle anon que pour l'objet autorisé, quelques secondes.
import type { NextRequest } from "next/server";
import { z } from "zod";
import { publicClient } from "@/lib/appointments/server";
import { isPreviewable } from "@/lib/crm/file-rules";
import { PortalError, portalRpc } from "@/lib/projects/portal";
import { portalFailure, reply, sameOrigin } from "@/lib/projects/portal-http";

const BUCKET = "company-files";
const id = z.uuid();
const body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("start"), project: id, folder: id.nullable(), task: id.nullable().optional(), name: z.string().min(1).max(255), type: z.string().max(150), size: z.number().int().positive() }),
  z.object({ op: z.literal("confirm"), file: id }),
  z.object({ op: z.literal("abort"), file: id }),
  z.object({ op: z.literal("url"), id, download: z.boolean() }),
  z.object({ op: z.literal("rename"), id, name: z.string().trim().min(1).max(200) }),
  z.object({ op: z.literal("move"), id, folder: id.nullable() }),
  z.object({ op: z.literal("delete"), id }),
]);

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return reply({ error: "Origine refusée" }, 403);
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return reply({ error: "Requête invalide" }, 400);
  const b = parsed.data;
  try {
    const storage = publicClient().storage.from(BUCKET);
    switch (b.op) {
      case "start": {
        const ext = b.name.match(/\.([a-zA-Z0-9]{1,8})$/)?.[1] ?? "bin";
        const s = await portalRpc<{ file_id: string; path: string }>("portal_file_start", {
          p_project: b.project, p_folder: b.folder, p_task: b.task ?? null, p_name: b.name, p_type: b.type, p_size: b.size, p_ext: ext,
        });
        const { data, error } = await storage.createSignedUploadUrl(s.path);
        if (error || !data) {
          await portalRpc("portal_file_abort", { p_file: s.file_id }).catch(() => undefined);
          throw new PortalError("Préparation de l'envoi impossible. Réessayez.", "server");
        }
        return reply({ file_id: s.file_id, signedUrl: data.signedUrl });
      }
      case "confirm":
        return reply(await portalRpc("portal_file_confirm", { p_file: b.file }));
      case "abort":
        await portalRpc("portal_file_abort", { p_file: b.file });
        return reply({ ok: true });
      case "url": {
        const g = await portalRpc<{ path: string; name: string; mime_type: string }>("portal_file_grant", { p_project_file: b.id });
        // prévisualisation pour PDF et images uniquement ; tout autre format est téléchargé, jamais affiché
        const download = b.download || !isPreviewable(g.mime_type);
        const { data, error } = await storage.createSignedUrl(g.path, 300, download ? { download: g.name } : undefined);
        if (error || !data) throw new PortalError("Lien temporaire impossible à créer.", "server");
        return reply({ url: data.signedUrl, preview: !download, mime_type: g.mime_type, name: g.name });
      }
      case "rename":
        return reply(await portalRpc("portal_file_update", { p_project_file: b.id, p_name: b.name, p_folder: null, p_move: false }));
      case "move":
        return reply(await portalRpc("portal_file_update", { p_project_file: b.id, p_name: null, p_folder: b.folder, p_move: true }));
      case "delete": {
        const d = await portalRpc<{ path: string; file_id: string }>("portal_file_delete", { p_project_file: b.id });
        // le document est déjà invisible ; si le retrait de l'objet échoue, le nettoyage administrateur le reprendra
        const { error } = await storage.remove([d.path]);
        if (!error) await portalRpc("portal_file_purge", { p_file: d.file_id }).catch(() => undefined);
        return reply({ ok: true });
      }
    }
  } catch (e) {
    return portalFailure(e);
  }
}
