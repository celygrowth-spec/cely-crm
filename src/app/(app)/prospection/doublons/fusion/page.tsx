import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { getCompanyDetail } from "@/lib/crm/service";
import { MergeForm } from "./merge-form";

export default async function FusionPage({ searchParams }: { searchParams: Promise<{ a?: string; b?: string }> }) {
  const { supabase } = await requireOwner();
  const { a, b } = await searchParams;
  if (!a || !b || a === b) notFound();
  const [da, db] = await Promise.all([getCompanyDetail(supabase, a), getCompanyDetail(supabase, b)]);
  if (!da || !db) notFound();
  return <MergeForm a={da} b={db} />;
}
