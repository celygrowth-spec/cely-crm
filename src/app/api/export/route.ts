import Papa from "papaparse";
import { createSupabase } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/crm/service";

// Export CSV : une ligne par entreprise, une ligne par personne, ou l'historique.
// Les personnes ne sont jamais concaténées dans une cellule.
export async function GET(req: Request) {
  const supabase = await createSupabase();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return new Response("Non authentifié", { status: 401 });
  const { data: owner } = await supabase.from("app_owner").select("user_id").eq("user_id", auth.user.id).maybeSingle();
  if (!owner) return new Response("Accès refusé", { status: 403 });

  const type = new URL(req.url).searchParams.get("type") ?? "companies";
  let rows: Record<string, unknown>[] = [];

  if (type === "companies") {
    const [{ data, error }, { data: lists }, { data: sources }, { data: stages }] = await Promise.all([
      fetchAll<Record<string, unknown>>((f, t) => supabase.from("company_overview").select("*").order("name").range(f, t)),
      supabase.from("lists").select("id, name"),
      supabase.from("lead_sources").select("id, name"),
      supabase.from("stages").select("id, name, pipeline:pipelines(name)"),
    ]);
    if (error) return new Response(error, { status: 500 });
    const ln = new Map((lists ?? []).map((l) => [l.id, l.name]));
    const sn = new Map((sources ?? []).map((s) => [s.id, s.name]));
    const st = new Map((stages ?? []).map((s) => [s.id, { stage: s.name, pipeline: (s.pipeline as unknown as { name: string })?.name }]));
    rows = data.map((c) => ({
      id: c.id,
      entreprise: c.name,
      site_web: c.website,
      domaine: c.domain_norm,
      description: c.description,
      source: c.source_id ? sn.get(c.source_id as string) : "",
      tags: (c.tags as string[]).join(", "),
      listes: (c.list_ids as string[]).map((id) => ln.get(id)).join(" | "),
      statut_prospection: c.prospect_status,
      pipeline: c.stage_id ? st.get(c.stage_id as string)?.pipeline : "",
      etape: c.stage_id ? st.get(c.stage_id as string)?.stage : "",
      statut_commercial: c.deal_status,
      montant_eur: c.amount,
      closing_estime: c.expected_close_date,
      motif_perte: c.lost_reason,
      contact_principal: c.primary_person_name,
      nb_personnes: c.people_count,
      dernier_echange: c.last_interaction_at,
      archivee_le: c.archived_at,
      creee_le: c.created_at,
      modifiee_le: c.updated_at,
    }));
  } else if (type === "people") {
    const { data, error } = await fetchAll<Record<string, unknown>>((f, t) =>
      supabase.from("people").select("*, company:companies!inner(id, name, website, merged_into_id)").is("company.merged_into_id", null).order("created_at").range(f, t),
    );
    if (error) return new Response(error, { status: 500 });
    rows = data.map((p) => {
      const c = p.company as { id: string; name: string; website: string | null };
      return {
        id: p.id,
        entreprise_id: c.id,
        entreprise: c.name,
        site_web: c.website,
        prenom: p.first_name,
        nom: p.last_name,
        poste: p.title,
        email: p.email,
        telephone: p.phone,
        linkedin: p.linkedin_url,
        contact_principal: p.is_primary ? "oui" : "non",
        creee_le: p.created_at,
      };
    });
  } else if (type === "interactions") {
    const { data, error } = await fetchAll<Record<string, unknown>>((f, t) =>
      supabase.from("interactions").select("*, company:companies(name), person:people(first_name, last_name)").order("occurred_at").range(f, t),
    );
    if (error) return new Response(error, { status: 500 });
    rows = data.map((i) => {
      const person = i.person as { first_name: string | null; last_name: string | null } | null;
      return {
        id: i.id,
        entreprise_id: i.company_id,
        entreprise: (i.company as { name: string }).name,
        date: i.occurred_at,
        type: i.kind,
        canal: i.channel,
        personne: person ? `${person.first_name ?? ""} ${person.last_name ?? ""}`.trim() : "",
        contenu: i.content,
        origine: i.source,
      };
    });
  } else {
    return new Response("Type inconnu", { status: 400 });
  }

  // escapeFormulae : protège contre l'injection de formules dans Excel / Sheets
  const csv = Papa.unparse(rows, { escapeFormulae: true });
  const date = new Date().toISOString().slice(0, 10);
  return new Response("﻿" + csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="cely-crm-${type}-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
