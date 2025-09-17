import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_MAPBOX_TOKEN: process.env.MAPBOX_API_KEY,
  },
  webpack: (config) => {
    config.module.rules.push({
      test: /\.geojson$/i,
      type: "json",
    });
    return config;
  },
};

export default nextConfig;
