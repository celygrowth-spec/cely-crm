// Emplacement facultatif de la mascotte Cely Growth. Aucun visuel n'existe aujourd'hui dans le dépôt :
// déposer un fichier (SVG ou PNG transparent, ~64 px) et renseigner MASCOT_SRC pour l'activer.
// Elle reste petite, ne masque aucun contenu et respecte la réduction des animations.
import Image from "next/image";

export const MASCOT_SRC: string | null = null; // ex. "/brand/mascotte.svg"

export function Mascot({ phase }: { phase: string }) {
  if (!MASCOT_SRC) return null;
  return (
    <span className="mascot-bob inline-flex items-center gap-2 text-xs text-muted">
      <Image src={MASCOT_SRC} alt="" width={28} height={28} aria-hidden />
      <span>Phase en cours : {phase}</span>
    </span>
  );
}
