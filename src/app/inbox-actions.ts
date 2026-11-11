"use server";

// Emails reçus (Q03) et passages planifiés (C07) : actions du propriétaire.
import { z } from "zod";
import { run } from "@/lib/action";
import { CrmError } from "@/lib/crm/service";

/** Rattache un email reçu « à rattacher » à une fiche (et une personne) : décision manuelle, conservée ensuite. */
export async function linkInboundAction(messageId: string, companyId: string, personId: string | null) {
  return run(async (sb) => {
    const { data, error } = await sb.rpc("mail_inbound_link", { p_message: z.uuid().parse(messageId), p_company: z.uuid().parse(companyId), p_person: personId ? z.uuid().parse(personId) : null });
    if (error) throw new CrmError(error.message);
    return data as { id: string };
  });
}
