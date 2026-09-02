import "./design-system.css";
import "./globals.css";
import type { Metadata } from "next";
import type { Viewport } from "next";
import type { ReactNode } from "react";
import { ProductCapabilitiesProvider } from "@/components/product-system/product-capabilities";
import { isWorkReviewEnabled } from "@/lib/server/work-review/runtime-config";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Daily Brief",
  description: "把重要的表达留给未来",
  icons: {
    icon: "/icon.svg",
    apple: "/icon.svg"
  }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <ProductCapabilitiesProvider workReviewEnabled={isWorkReviewEnabled()}>
          {children}
        </ProductCapabilitiesProvider>
      </body>
    </html>
  );
}
