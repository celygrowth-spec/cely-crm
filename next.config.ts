import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // réutilise les écrans déjà visités ; toute mutation purge ce cache via router.refresh()
    staleTimes: { dynamic: 30, static: 180 },
    optimizePackageImports: ["lucide-react", "recharts"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      {
        // portail client : jamais en cache partagé, jamais indexé
        source: "/portail/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
      {
        // aucune page ne peut s'afficher dans un autre site, SAUF la page de réservation intégrable
        // /rdv/<lien>/integre (widgets de réservation), seule exclue ici
        source: "/:path((?!rdv/[^/]+/integre/?$).*)",
        headers: [{ key: "X-Frame-Options", value: "DENY" }],
      },
    ];
  },
};

export default nextConfig;
