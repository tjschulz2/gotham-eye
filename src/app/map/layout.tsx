import type { Metadata } from "next";
import "../globals.css";

export const metadata: Metadata = {
  title: "Gotham Eye | The World's Best Open Crime Map and Data",
  description: "Explore detailed crime statistics and patterns with Gotham Eye's interactive map. The world's most comprehensive open crime data visualization platform.",
};

export default function MapLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return children;
}
