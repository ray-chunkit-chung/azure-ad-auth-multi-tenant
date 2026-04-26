import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OAuth2 Azure AD Chat",
  description: "AWS hosted chat app with Azure AD authentication",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
