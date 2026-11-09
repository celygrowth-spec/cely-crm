import { PageHeader } from "@/components/ui";
import { MailTabs } from "../tabs";
import { TemplatesView } from "./templates-view";

export default function MailTemplatesPage() {
  return (
    <div className="max-w-4xl">
      <PageHeader title="Mail" description="Modèles réutilisables pour vos emails commerciaux." />
      <MailTabs />
      <TemplatesView />
    </div>
  );
}
