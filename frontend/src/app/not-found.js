"use client";
import Link from "next/link";
import { BrandMark, Button } from "@/components/ui";

export default function NotFound() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-6 bg-ground px-5 text-center">
      <BrandMark size={44} />
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink">Page not found</h1>
        <p className="mt-2 text-muted">The page you&rsquo;re looking for doesn&rsquo;t exist or has moved.</p>
      </div>
      <Link href="/">
        <Button>Back to NeuroStudy</Button>
      </Link>
    </main>
  );
}
