"use client";

// Changement d'étape, depuis l'en-tête comme depuis « Suivi commercial » : mêmes règles, même service.
import { toast } from "sonner";
import { moveCompanyAction } from "@/app/actions";
import { useCrm } from "./app-shell";
import type { RecordCtx } from "./company-record";

export function useMoveCompany(ctx: RecordCtx) {
  const { pipelines } = useCrm();
  const c = ctx.detail.company;
  const activeFollowups = ctx.detail.participants.filter((p) => ["a_contacter", "en_cours", "a_repondu"].includes(p.status)).length;

  return async function move(stageId: string) {
    // une fiche gagnée ou perdue reste clôturée : seule « Rouvrir l'opportunité » la rouvre (C01)
    if (c.deal_status !== "open") {
      toast.error(`Opportunité ${c.deal_status === "won" ? "gagnée" : "perdue"} : utilisez « Rouvrir l'opportunité » avant de changer d'étape.`);
      return;
    }
    const entering = !c.pipeline_id && stageId;
    let stop = true;
    if (entering && activeFollowups > 0) {
      stop = confirm(
        `Cette fiche a ${activeFollowups} relance(s) de prospection active(s).\n\nOK : les arrêter (recommandé)\nAnnuler : les conserver`,
      );
    }
    const pipeline = pipelines.find((p) => p.stages.some((st) => st.id === stageId)) ?? null;
    const stage = pipeline?.stages.find((st) => st.id === stageId) ?? null;
    let stopped = 0;
    const ok = await ctx.mutate(
      {
        stage_id: stage?.id ?? null,
        pipeline_id: pipeline?.id ?? null,
        stage: stage ? { id: stage.id, name: stage.name } : null,
        pipeline: pipeline ? { id: pipeline.id, name: pipeline.name } : null,
      },
      async () => {
        const res = await moveCompanyAction(c.id, stageId || null, stop);
        if (!res.ok) return res;
        stopped = res.data.stopped_followups ?? 0;
        return { ok: true };
      },
    );
    if (ok && stopped) {
      toast.info(`${stopped} relance(s) de prospection arrêtée(s). L'historique reste consultable.`);
      ctx.reload();
    }
  };
}
