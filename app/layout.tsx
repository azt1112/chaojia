import type { Metadata } from "next";
import { Noto_Sans_SC } from "next/font/google";
import "./globals.css";

const notoSans = Noto_Sans_SC({
  weight: ["400", "500", "700"],
  subsets: ["latin"],
  display: "swap"
});

export const metadata: Metadata = {
  title: "吵架包赢",
  description: "生成三条快速、犀利的反击，让你在聊天里绝地反杀。"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className={notoSans.className}>{children}</body>
    </html>
  );
}
