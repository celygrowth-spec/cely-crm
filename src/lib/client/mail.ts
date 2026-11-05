// Appels du navigateur vers les routes mail. Aucun jeton ne transite ici.
import type { MailAccount, MailMessage, MailStatus } from "@/lib/mail/types";

export type MailResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Lève une exception si le serveur n'a pas pu répondre : à l'appelant de dire ce que cela signifie. */
export async function mailCall<T>(url: string, method: "POST" | "PUT", body: unknown): Promise<MailResult<T>> {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return (await res.json()) as MailResult<T>;
}

export const mailOp = <T = MailMessage>(id: string, body: Record<string, unknown>) => mailCall<T>(`/api/mail/messages/${id}`, "POST", body);

export type RecentMail = Pick<MailMessage, "id" | "origin" | "to_addrs" | "subject" | "company_id" | "sent_at" | "last_error" | "updated_at"> & { status: MailStatus };
export type MailOverview = { configured: boolean; accounts: MailAccount[]; recent: RecentMail[] };
