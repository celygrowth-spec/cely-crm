import { redirect } from "next/navigation";

// Ancienne adresse : Temps est dans Productivité. Les paramètres (période, client, session) sont conservés.
export default async function TempsAncienneAdresse({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) {
    for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) sp.append(k, x);
  }
  const q = sp.toString();
  redirect(q ? `/productivite/temps?${q}` : "/productivite/temps");
}
