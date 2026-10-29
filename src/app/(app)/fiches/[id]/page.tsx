import { CompanyRecord } from "@/components/company-record";
import { requireOwner } from "@/lib/auth";

export default async function FichePage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;
  return (
    <div className="mx-auto max-w-4xl">
      <CompanyRecord key={id} id={id} page />
    </div>
  );
}
