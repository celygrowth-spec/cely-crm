// Transition discrète entre écrans (opacité seule, sans retarder l'affichage).
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="fade-in">{children}</div>;
}
