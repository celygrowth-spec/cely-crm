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
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
