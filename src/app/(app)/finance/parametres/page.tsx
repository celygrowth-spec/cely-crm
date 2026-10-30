import { financeData } from "../load";
import { FinanceSettingsView } from "./settings-view";

export default async function FinanceSettingsPage() {
  const data = await financeData();
  return <FinanceSettingsView data={data} />;
}
