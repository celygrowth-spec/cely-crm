import type { Metadata } from "next";
import { ActivationForm } from "@/components/portal/activation-form";

export const metadata: Metadata = { title: "Créer mon accès — Cely Growth", referrer: "no-referrer" };

// Lien reçu par mail : aucune session n'est lue ici, l'identifiant vient de l'invitation.
export default function ActivationPage() {
  return <ActivationForm />;
}
