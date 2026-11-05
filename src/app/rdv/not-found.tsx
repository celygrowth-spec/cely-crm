import { Unavailable } from "@/components/rdv/public-bits";

export default function NotFound() {
  return <Unavailable title="Page introuvable" text="Ce lien de rendez-vous n'existe pas ou n'est plus proposé." />;
}
