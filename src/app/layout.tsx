import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Campus | AI College Assistant",
  description: "A trusted campus assistant for college information, notices, timetables, and attendance.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
