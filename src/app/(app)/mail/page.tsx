import { PageHeader } from "@/components/ui";
import { MailSettings } from "./mail-settings";
import { MailTabs } from "./tabs";

export default async function MailPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const q = await searchParams;
  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Mail" description="Connexion de votre compte Gmail et suivi des envois du CRM." />
      <MailTabs />
      <MailSettings connected={q.connected === "1"} error={q.error} />
    </div>
  );
}
