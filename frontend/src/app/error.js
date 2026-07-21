"use client";
import { BrandMark, Button } from "@/components/ui";

export default function Error({ reset }) {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-6 bg-ground px-5 text-center">
      <BrandMark size={44} />
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink">Something went wrong</h1>
        <p className="mt-2 text-muted max-w-md">
          An unexpected error occurred while loading this page. You can try again, or head back to the dashboard.
        </p>
      </div>
      <div className="flex gap-3">
        <Button variant="subtle" onClick={reset}>Try again</Button>
        <Button onClick={() => { window.location.href = "/history"; }}>Back to dashboard</Button>
      </div>
    </main>
  );
}
