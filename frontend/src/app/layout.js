import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "@/context/AuthContext";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata = {
  title: "NeuroStudy — Clinical Companion",
  description:
    "NeuroStudy clinician companion — pair the EEG headset, run stimulus sessions, and review results.",
};

// Applied before first paint so a stored theme choice never flashes the wrong
// colors. If nothing is stored, no attribute is set and prefers-color-scheme wins.
const themeScript = `(function(){try{var t=localStorage.getItem('ns-theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;

export default function RootLayout({ children }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full flex flex-col bg-ground text-ink"><AuthProvider>{children}</AuthProvider></body>
    </html>
  );
}
