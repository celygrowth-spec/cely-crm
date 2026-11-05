import { AlertTriangle } from "lucide-react";
import { requireOwner } from "@/lib/auth";
import { ensureServerKey } from "@/lib/appointments/owner";
import { BookingDetailHost } from "@/components/rdv/booking-detail";
import { RdvTabs } from "./tabs";

export default async function RendezVousLayout({ children }: { children: React.ReactNode }) {
  const { supabase } = await requireOwner();
  // la page publique n'est ouverte qu'une fois la clé serveur enregistrée par le propriétaire
  const ready = await ensureServerKey(supabase);
  return (
    <div>
      <RdvTabs />
      {!ready && (
        <p role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-warning">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>
            Réservation publique désactivée : la variable d&apos;environnement <code>APPOINTMENTS_SECRET</code> (32 caractères minimum) n&apos;est
            pas définie sur le serveur. Voir <code>docs/integrations/google-calendar.md</code>.
          </span>
        </p>
      )}
      {children}
      <BookingDetailHost />
    </div>
  );
}
