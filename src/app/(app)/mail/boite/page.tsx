import { PageHeader } from "@/components/ui";
import { MailTabs } from "../tabs";
import { Mailbox } from "./mailbox";

export default function MailboxPage() {
  return (
    <div className="space-y-5">
      <PageHeader title="Mail" description="Toute votre boîte Gmail, lue depuis Cely Growth." />
      <MailTabs />
      <Mailbox />
    </div>
  );
}
