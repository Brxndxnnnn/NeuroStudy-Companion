"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { BrandMark, Spinner } from "@/components/ui";
import { useAuth } from "@/context/AuthContext";

// The root route is never a destination in its own right — it just routes the
// visitor to wherever they belong based on stored auth state.
export default function Home() {
  const router = useRouter();
  const { user, isLoading } = useAuth();

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      router.replace("/login");
      return;
    }
    router.replace(user.role === "admin" || user.role === "superadmin" ? "/admin" : "/history");
  }, [isLoading, router, user]);

  return (
    <main className="min-h-screen flex items-center justify-center bg-ground">
      <div className="flex flex-col items-center gap-4">
        <BrandMark size={40} />
        <Spinner size={20} className="text-accent" />
      </div>
    </main>
  );
}
