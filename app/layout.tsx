import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
    title: "Operation Desert Haze",
    description: "A Phonk / Warcore visualizer syncing military footage to slowed Macarena beats",
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
