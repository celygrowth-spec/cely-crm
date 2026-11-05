// Fichiers d'un projet côté administrateur : réutilise le module Fichiers de la fiche CRM
// (envoi direct vers Storage, vérification de l'objet, liens temporaires) et gère la référence projet.
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth";
import { CrmError, friendlyError } from "@/lib/crm/service";
import { abortUpload, confirmUpload, deleteFile, fileUrl, startUpload, updateFile } from "@/lib/crm/files";

const reply = (b: unknown, status = 200) => NextResponse.json(b, { status, headers: { "Cache-Control": "private, no-store" } });
const id = z.uuid();
const body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("start"), project: id, name: z.string().min(1).max(255), type: z.string().max(150), size: z.number().int().positive() }),
  z.object({ op: z.literal("confirm"), project: id, file: id, folder: id.nullable() }),
  z.object({ op: z.literal("abort"), file: id }),
  z.object({ op: z.literal("url"), id, download: z.boolean() }),
  z.object({ op: z.literal("rename"), id, name: z.string().trim().min(1).max(200) }),
  z.object({ op: z.literal("move"), id, folder: id.nullable() }),
  z.object({ op: z.literal("unshare"), id }),
  z.object({ op: z.literal("delete"), id }),
  z.object({ op: z.literal("share"), project: id, files: z.array(id).max(50), folder: id.nullable() }),
  z.object({ op: z.literal("folder"), project: id, name: z.string().trim().min(1).max(80), parent: id.nullable() }),
  z.object({ op: z.literal("folder-rename"), id, name: z.string().trim().min(1).max(80) }),
  z.object({ op: z.literal("folder-delete"), id }),
]);

export async function POST(req: NextRequest) {
  if (req.headers.get("origin") !== req.nextUrl.origin) return reply({ error: "Origine refusée" }, 403);
  const session = await getSession();
  if (!session) return reply({ error: "Session expirée" }, 401);
  const sb = session.supabase;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return reply({ error: "Requête invalide" }, 400);
  const b = parsed.data;
  const q = async (res: PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>) => {
    const { data, error } = await res;
    if (error) throw new CrmError(friendlyError(error));
    return data;
  };
  try {
    switch (b.op) {
      case "start": {
        const p = (await q(sb.from("projects").select("company_id").eq("id", b.project).single())) as { company_id: string };
        const s = await startUpload(sb, { companyId: p.company_id, name: b.name, type: b.type, size: b.size });
        return reply({ file_id: s.id, signedUrl: s.signedUrl });
      }
      case "confirm": {
        await confirmUpload(sb, b.file);
        await q(sb.from("project_files").insert({ project_id: b.project, file_id: b.file, folder_id: b.folder }));
        return reply({ ok: true });
      }
      case "abort":
        await abortUpload(sb, b.file);
        return reply({ ok: true });
      case "url": {
        const r = (await q(sb.from("project_files").select("file_id").eq("id", b.id).single())) as { file_id: string };
        return reply({ url: await fileUrl(sb, r.file_id, b.download) });
      }
      case "rename": {
        const r = (await q(sb.from("project_files").select("file_id").eq("id", b.id).single())) as { file_id: string };
        await updateFile(sb, r.file_id, { display_name: b.name });
        return reply({ ok: true });
      }
      case "move":
        await q(sb.from("project_files").update({ folder_id: b.folder }).eq("id", b.id));
        return reply({ ok: true });
      case "unshare":
        // retrait du projet uniquement : le document reste dans la fiche CRM
        await q(sb.from("project_files").delete().eq("id", b.id));
        return reply({ ok: true });
      case "delete": {
        const r = (await q(sb.from("project_files").select("file_id").eq("id", b.id).single())) as { file_id: string };
        await deleteFile(sb, r.file_id);
        return reply({ ok: true });
      }
      case "share":
        await q(sb.from("project_files").insert(b.files.map((f) => ({ project_id: b.project, file_id: f, folder_id: b.folder }))));
        return reply({ ok: true });
      case "folder":
        return reply(await q(sb.from("project_folders").insert({ project_id: b.project, name: b.name, parent_id: b.parent }).select("id").single()));
      case "folder-rename":
        await q(sb.from("project_folders").update({ name: b.name }).eq("id", b.id));
        return reply({ ok: true });
      case "folder-delete":
        // les fichiers du dossier remontent à la racine (rien n'est supprimé)
        await q(sb.from("project_folders").delete().eq("id", b.id));
        return reply({ ok: true });
    }
  } catch (e) {
    if (e instanceof CrmError) return reply({ error: e.message }, 400);
    console.error(e);
    return reply({ error: "L'opération a échoué. Réessayez." }, 500);
  }
}
