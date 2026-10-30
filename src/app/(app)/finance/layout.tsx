import { FinanceTabs } from "./tabs";

export default function FinanceLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <FinanceTabs />
      {children}
    </div>
  );
}
