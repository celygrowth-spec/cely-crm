// Outils partagés des tests Projets / portail client.
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "./harness";

export const SERVER_KEY = "test-server-key-0123456789abcdef0123456789";
export const sha = (s: string) => createHash("sha256").update(s).digest("hex");


/** Entreprise CRM avec ses contacts. */
export async function company(d: Db, name: string, people: { first_name: string; email: string }[]) {
  await d.as("owner");
  const id = (await d.rpc<{ id: string }>("create_company", { p_company: JSON.stringify({ name }), p_people: JSON.stringify(people), p_force: true })).id;
  const rows = (await d.query<{ id: string; email: string }>(`select id, email from people where company_id = $1 order by email`, [id])).rows;
  return { id, people: Object.fromEntries(rows.map((r) => [r.email, r.id])) as Record<string, string> };
}

export async function project(d: Db, companyId: string, name: string, people: string[], publish = true) {
  await d.as("owner");
  const id = await d.rpc<string>("project_create", { p_data: JSON.stringify({ company_id: companyId, name, start_date: "2026-11-01", end_date: "2027-01-31" }), p_person_ids: `{${people.join(",")}}` });
  if (publish) await d.query(`update projects set portal_published = true, status = 'en_cours', internal_note = 'NOTE-INTERNE-SECRETE' where id = $1`, [id]);
  return id;
}

/** Accès + connexion : renvoie l'empreinte du jeton de session. */
export async function login(d: Db, personId: string, code = `CODE-${randomUUID()}`) {
  await d.as("owner");
  await d.rpc("portal_access_issue", { p_person: personId, p_code_hash: sha(code), p_code_hint: code.slice(-4), p_expires_at: null });
  const session = sha(randomUUID());
  await d.as("anon");
  const r = await d.rpc<{ status: string }>("portal_login", { p_server_key: SERVER_KEY, p_code_hash: sha(code), p_ip_hash: sha("1.2.3.4"), p_session_hash: session, p_user_agent: "test" });
  return { status: r.status, session, code };
}

export async function portal<T = unknown>(d: Db, fn: string, session: string, args: Record<string, unknown> = {}) {
  await d.as("anon");
  return d.rpc<T>(fn, { p_server_key: SERVER_KEY, p_session_hash: session, ...args });
}

