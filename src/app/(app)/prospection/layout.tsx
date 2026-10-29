import { ProspectionTabs } from "./tabs";

export default function ProspectionLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <ProspectionTabs />
      {children}
    </div>
  );
}
