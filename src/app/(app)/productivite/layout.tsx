import { ProductiviteTabs } from "./tabs";

export default function ProductiviteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <ProductiviteTabs />
      {children}
    </div>
  );
}
