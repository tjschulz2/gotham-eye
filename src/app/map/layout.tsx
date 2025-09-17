import type { Metadata } from "next";
import "../globals.css";

export const metadata: Metadata = {
  title: "Gotham Eye | Find out if your neighborhood is safe from crime",
  description: "The ultimate crime map for discovering if your neighborhood is safe from crime. Keep cities safe and hold politicians accountable by contributing more data.",
};

export default function MapLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return children;
}
