import { redirect } from "next/navigation";

// Ancienne adresse : la file du jour est la page d'accueil « Aujourd'hui ».
export default function AujourdhuiPage() {
  redirect("/");
}
