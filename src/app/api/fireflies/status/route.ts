// État de l'import pour l'écran de suivi : propriétaire uniquement, sans aucun contenu d'appel.
import { apiRead } from "@/lib/api";
import { appointmentsSecretOrNull } from "@/lib/appointments/config";
import { ensureServerKey } from "@/lib/appointments/owner";
import { CrmError, friendlyError } from "@/lib/crm/service";
import { firefliesApiKey, firefliesWebhookSecret } from "@/lib/fireflies/config";

export async function GET() {
  return apiRead(async (sb) => {
    const serverKey = await ensureServerKey(sb);
    const [connection, jobs] = await Promise.all([
      sb.from("fireflies_connection").select("account_email, last_webhook_at, last_success_at, last_sync_at, last_error_code, last_error_at, api_paused_until").maybeSingle(),
      sb.from("fireflies_import_overview").select("job_id, meeting_id, source, display_state, attempts, next_attempt_at, last_error_code, last_error, received_at, finished_at, title, occurred_at, line_count").order("received_at", { ascending: false }).limit(50),
    ]);
    if (connection.error || jobs.error) throw new CrmError(friendlyError((connection.error ?? jobs.error)!));
    return {
      configured: {
        apiKey: !!firefliesApiKey(),
        webhookSecret: !!firefliesWebhookSecret(),
        serverSecret: !!appointmentsSecretOrNull() && serverKey,
        cronSecret: (process.env.CRON_SECRET ?? "").length >= 16,
      },
      connection: connection.data,
      jobs: jobs.data,
    };
  });
}
