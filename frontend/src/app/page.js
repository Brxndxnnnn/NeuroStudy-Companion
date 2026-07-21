"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { BrandMark, Spinner } from "@/components/ui";

// The root route is never a destination in its own right — it just routes the
// visitor to wherever they belong based on stored auth state.
export default function Home() {
  const router = useRouter();

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.replace("/login");
      return;
    }
    const role = localStorage.getItem("userRole");
    router.replace(role === "admin" || role === "superadmin" ? "/admin" : "/history");
  }, [router]);

  return (
    <main className="min-h-screen flex items-center justify-center bg-ground">
      <div className="flex flex-col items-center gap-4">
        <BrandMark size={40} />
        <Spinner size={20} className="text-accent" />
      </div>
    </main>
  );
}
