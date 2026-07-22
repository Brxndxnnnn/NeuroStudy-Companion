"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { getCurrentUser } from "@/utils/api";
import TopNav from "@/components/TopNav";
import { useAuth } from "@/context/AuthContext";
import { PageContainer, PageHeading, Card, Button, Label, Pill, Spinner } from "@/components/ui";

function roleLabel(role) {
  if (!role) return "Technician";
  const map = { admin: "Administrator", superadmin: "Super administrator", technician: "Technician", clinician: "Clinician" };
  return map[role] || role.charAt(0).toUpperCase() + role.slice(1);
}

function DetailRow({ label, children }) {
  return (
    <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-border last:border-0">
      <Label>{label}</Label>
      <span className="text-sm text-ink text-right font-medium">
        {children || <span className="text-muted font-normal">—</span>}
      </span>
    </div>
  );
}

export default function ProfilePage() {
  const router = useRouter();
  const { user: authenticatedUser, isLoading: isAuthLoading, isAuthenticated, signOut } = useAuth();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (isAuthLoading) return;
    if (!isAuthenticated) {
      router.push("/login");
      return;
    }

    const load = async () => {
      try {
        const res = await getCurrentUser();
        if (res.ok) {
          const data = await res.json();
          setUser(data.user || data);
        } else {
          // Fall back to whatever we stored at login so the page is still useful offline.
          setUser({
            display_name: authenticatedUser?.display_name || "",
            role: authenticatedUser?.role || "",
          });
          setError("Showing saved details — could not reach the server for the latest profile.");
        }
      } catch (err) {
        setUser({
          display_name: authenticatedUser?.display_name || "",
          role: authenticatedUser?.role || "",
        });
        setError("Showing saved details — could not reach the server for the latest profile.");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [authenticatedUser, isAuthenticated, isAuthLoading, router]);

  const handleSignOut = async () => {
    await signOut();
    router.replace("/login");
  };

  const name = user?.display_name || "Unnamed technician";
  const initials = (user?.display_name || "NS")
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const isAdmin = user?.role === "admin" || user?.role === "superadmin";

  return (
    <main className="min-h-screen bg-ground">
      <TopNav />

      <PageContainer width="mid" className="py-8 space-y-7">
        <PageHeading title="Your profile" subtitle="Account details for the signed-in technician." />

        {loading ? (
          <Card className="p-12 text-center text-muted">
            <Spinner size={20} className="mr-2 align-[-3px] text-accent" /> Loading profile…
          </Card>
        ) : (
          <>
            {error && (
              <Card className="px-4 py-3 bg-warn-soft border-warn/25 text-warn-strong text-sm font-medium">{error}</Card>
            )}

            {/* Identity header */}
            <Card className="p-6 flex items-center gap-5">
              <span className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-accent text-on-accent text-xl font-bold shadow-sm">
                {initials}
              </span>
              <div className="min-w-0">
                <h2 className="text-xl font-bold tracking-tight text-ink truncate">{name}</h2>
                <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                  <Pill tone={isAdmin ? "accent" : "neutral"}>{roleLabel(user?.role)}</Pill>
                  {user?.email && <span className="text-[13px] text-muted">{user.email}</span>}
                </div>
              </div>
            </Card>

            {/* Details */}
            <Card className="overflow-hidden">
              <div className="px-6 py-5 border-b border-border">
                <h3 className="text-[15px] font-bold tracking-tight text-ink">Account details</h3>
              </div>
              <DetailRow label="Full name">{user?.display_name}</DetailRow>
              <DetailRow label="Email">{user?.email}</DetailRow>
              <DetailRow label="Role">{roleLabel(user?.role)}</DetailRow>
            </Card>

            <div className="flex items-center justify-between gap-4">
              <Button variant="ghost" onClick={() => router.push("/history")}>← Back to dashboard</Button>
              <Button variant="danger" onClick={handleSignOut}>Sign out</Button>
            </div>
          </>
        )}
      </PageContainer>
    </main>
  );
}
