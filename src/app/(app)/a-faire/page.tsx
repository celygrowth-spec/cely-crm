import { redirect } from "next/navigation";

// Ancienne adresse : « À faire » est regroupé dans « Aujourd'hui » (vue complète, échéances futures comprises).
export default function AFairePage() {
  redirect("/?vue=tout");
}
