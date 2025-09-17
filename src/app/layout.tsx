import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
export const metadata: Metadata = {
  title: "Gotham Eye | The World's Best Open Crime Map and Data",
  description: "Explore detailed crime statistics and patterns with Gotham Eye's interactive map. The world's most comprehensive open crime data visualization platform.",
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
      </body>
    </html>
  );
}
