import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Analytics } from "@vercel/analytics/next";
const siteUrl = "https://gothameye.com";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Gotham Eye | Find out if your neighborhood is safe from crime",
  description:
    "The ultimate crime map for discovering if your neighborhood is safe from crime. Keep cities safe and hold politicians accountable by contributing more data.",
  openGraph: {
    title: "Gotham Eye | Find out if your neighborhood is safe from crime",
    description:
      "The ultimate crime map for discovering if your neighborhood is safe from crime. Keep cities safe and hold politicians accountable by contributing more data.",
    url: siteUrl,
    siteName: "Gotham Eye",
    images: [
      {
        url: `${siteUrl}/imessageBanner.png?v=2`,
        width: 1200,
        height: 630,
        alt: "Gotham Eye preview image",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Gotham Eye | Find out if your neighborhood is safe from crime",
    description:
      "The ultimate crime map for discovering if your neighborhood is safe from crime. Keep cities safe and hold politicians accountable by contributing more data.",
    images: [`${siteUrl}/imessageBanner.png?v=2`],
  },
};

const cabinetGrotesk = localFont({
  src: [
    {
      path: "../../public/HeaderFont/CabinetGrotesk-Medium.otf",
      weight: "600",
      style: "normal",
    },
  ],
  display: "swap",
  variable: "--font-cabinet",
});

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={cabinetGrotesk.variable}>
        <div className="relative z-10">
          {children}
        </div>
        <Analytics />
      </body>
    </html>
  );
}
