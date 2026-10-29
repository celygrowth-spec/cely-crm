import type { Metadata } from "next";
import { M_PLUS_Rounded_1c, Manrope, Space_Grotesk } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";

const manrope = Manrope({ subsets: ["latin"], variable: "--font-manrope", weight: ["400", "500", "600", "700"] });
const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-space-grotesk", weight: ["500", "600", "700"] });
const rounded = M_PLUS_Rounded_1c({ subsets: ["latin"], variable: "--font-rounded", weight: ["700", "800"] });

export const metadata: Metadata = {
  title: "Cely CRM",
  description: "Prospection et pipelines de Cely Growth",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr" className={`${manrope.variable} ${spaceGrotesk.variable} ${rounded.variable}`}>
      <body>
        {children}
        <Toaster position="bottom-right" richColors closeButton />
      </body>
    </html>
  );
}
