import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RoastPilot Cloud",
  description:
    "Cloud data plane for RoastPilot: roast sharing, taster reviews, and reference-roast summaries.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background text-foreground">
        <div className="mx-auto min-h-screen max-w-[var(--rp-container)] px-6">
          {children}
        </div>
      </body>
    </html>
  );
}
