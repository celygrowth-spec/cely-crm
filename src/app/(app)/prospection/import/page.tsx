import { requireOwner } from "@/lib/auth";
import { ImportWizard } from "./import-wizard";

export default async function ImportPage() {
  await requireOwner();
  return <ImportWizard />;
}
