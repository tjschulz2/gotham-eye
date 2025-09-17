import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Analytics } from "@vercel/analytics/next";
export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"),
  title: "Gotham Eye | The World's Best Open Crime Map and Data",
  description:
    "Explore detailed crime statistics and patterns with Gotham Eye's interactive map. The world's most comprehensive open crime data visualization platform.",
  openGraph: {
    title: "Gotham Eye | The World's Best Open Crime Map and Data",
    description:
      "Explore detailed crime statistics and patterns with Gotham Eye's interactive map. The world's most comprehensive open crime data visualization platform.",
    url: "/",
    siteName: "Gotham Eye",
    images: [
      {
        url: "/imessageBanner.png",
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
    title: "Gotham Eye | The World's Best Open Crime Map and Data",
    description:
      "Explore detailed crime statistics and patterns with Gotham Eye's interactive map. The world's most comprehensive open crime data visualization platform.",
    images: ["/imessageBanner.png"],
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
