import { financeData } from "../load";
import { UrssafView } from "./urssaf-view";

export default async function UrssafPage() {
  const data = await financeData();
  return <UrssafView data={data} />;
}
