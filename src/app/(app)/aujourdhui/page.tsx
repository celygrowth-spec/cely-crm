import { redirect } from "next/navigation";

// Ancienne adresse : « Aujourd'hui » est remplacé par l'Accueil.
export default function AujourdhuiPage() {
  redirect("/");
}
