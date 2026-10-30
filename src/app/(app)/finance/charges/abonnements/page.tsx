import { financeData } from "../../load";
import { SubscriptionsView } from "./subscriptions-view";

export default async function AbonnementsPage() {
  const data = await financeData();
  return <SubscriptionsView data={data} />;
}
