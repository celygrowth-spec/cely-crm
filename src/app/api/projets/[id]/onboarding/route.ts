// Préparation du projet (écran privé) : lecture, relance, réponses, demandes au client et slides.
import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiRead, apiWrite } from "@/lib/api";
import { startUpload } from "@/lib/crm/files";
import { CrmError } from "@/lib/crm/service";
import { SECTION_KEYS } from "@/lib/projects/onboarding-rules";
import * as ob from "@/lib/projects/onboarding";

const id = z.uuid();
const body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("prepare") }),
  z.object({ op: z.literal("analyze") }),
  z.object({ op: z.literal("section"), key: z.enum(SECTION_KEYS), items: z.array(ob.sectionItemSchema).max(30) }),
  z.object({ op: z.literal("answer"), item: id, action: z.enum(["text", "date", "file", "choice", "not_applicable", "reopen"]), value: z.string().max(5000).nullable().optional(), file: id.nullable().optional() }),
  z.object({ op: z.literal("upload_start"), item: id, name: z.string().min(1).max(200), type: z.string().max(150), size: z.number().int().positive() }),
  z.object({ op: z.literal("upload_confirm"), item: id, file: id }),
  z.object({ op: z.literal("request"), item: id, text: z.string().max(5000), person: id.nullable().optional() }),
  z.object({ op: z.literal("deck") }),
  z.object({ op: z.literal("deck_share"), deck: id, share: z.boolean() }),
  z.object({ op: z.literal("document_url"), file: id }),
]);

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: pid } = await params;
  return apiRead((sb) => ob.getOnboarding(sb, pid));
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: pid } = await params;
  const raw = await req.json().catch(() => null);
  return apiWrite(req, async (sb) => {
    const b = body.parse(raw);
    switch (b.op) {
      case "prepare": {
        const r = await ob.prepare(sb, pid);
        const a = await ob.requestAnalysis(sb, pid);
        return { ...r, analysis: a };
      }
      case "analyze": {
        await sb.rpc("onboarding_analysis_result", { p_project: pid, p_session_url: null, p_error: null });
        return ob.requestAnalysis(sb, pid);
      }
      case "section":
        return ob.saveSection(sb, pid, b.key, b.items);
      case "answer":
        return ob.answerItem(sb, b.item, b.action, b.value ?? null, b.file ?? null);
      case "upload_start": {
        const o = await ob.getOnboarding(sb, pid);
        const item = o?.items.find((i) => i.id === b.item);
        if (!o || !item) throw new CrmError("Point introuvable dans ce projet.");
        // un document signé importé pour la proposition est rangé comme contrat sur la fiche
        const s = await startUpload(sb, { companyId: o.company_id, name: b.name, type: b.type, size: b.size, category: item.kind === "proposal" ? "Contrat" : null });
        return { file_id: s.id, signedUrl: s.signedUrl };
      }
      case "upload_confirm":
        return ob.attachAnswerFile(sb, pid, b.item, b.file);
      case "request":
        return ob.shareRequest(sb, b.item, b.text, b.person ?? null);
      case "deck":
        return ob.requestDeck(sb, pid);
      case "deck_share":
        return ob.shareDeck(sb, pid, b.deck, b.share);
      case "document_url":
        return { url: await ob.documentUrl(sb, pid, b.file) };
    }
  });
}
