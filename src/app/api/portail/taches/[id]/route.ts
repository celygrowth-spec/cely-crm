import { portalRpc } from "@/lib/projects/portal";
import { portalFailure, reply } from "@/lib/projects/portal-http";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return reply({ error: "Tâche introuvable" }, 404);
  try {
    return reply(await portalRpc("portal_task", { p_task: id }));
  } catch (e) {
    return portalFailure(e);
  }
}
