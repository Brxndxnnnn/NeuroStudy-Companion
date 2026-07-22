"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { login } from "@/utils/api";
import { useAuth } from "@/context/AuthContext";
import { BrandMark, Button, Field, Input, Alert } from "@/components/ui";
import ThemeToggle from "@/components/ThemeToggle";

export default function LoginPage() {
  const router = useRouter();
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    try {
      const res = await login(email, password, true);

      if (res.ok) {
        const data = await res.json();
        const token = data.accessToken;
        const userRole = data.user.role;

        signIn({ accessToken: token, user: data.user });

        if (userRole === "admin" || userRole === "superadmin") {
          router.push("/admin");
        } else {
          router.push("/history");
        }
      } else {
        const errorData = await res.json();
        setError(errorData.message || errorData.error || "Invalid email or password.");
      }
    } catch (err) {
      console.error("CODE CRASHED DURING LOGIN:", err);
      setError("Something went wrong signing in. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className="ns-aura min-h-screen flex flex-col justify-center items-center p-5">
      <div className="absolute top-5 right-5">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm anim-rise">
        <div className="flex flex-col items-center mb-8">
          <BrandMark size={48} className="mb-4" />
          <h1 className="text-2xl font-bold tracking-tight text-ink">NeuroStudy</h1>
          <p className="text-sm text-muted mt-1">Clinical login portal</p>
        </div>

        <div className="bg-surface border border-border rounded-2xl shadow-[0_8px_30px_rgba(13,28,37,.08)] p-8">
          {error && (
            <Alert tone="crit" className="mb-5">
              {error}
            </Alert>
          )}

          <form onSubmit={handleLogin} className="space-y-5">
            <Field label="Email address" htmlFor="email">
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@clinic.com"
                autoComplete="email"
                required
              />
            </Field>

            <Field label="Password" htmlFor="password">
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••"
                  autoComplete="current-password"
                  className="pr-11"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-accent transition-colors p-1"
                  title={showPassword ? "Hide password" : "Show password"}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? (
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
                    </svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-5 h-5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                    </svg>
                  )}
                </button>
              </div>
            </Field>

            <Button type="submit" size="lg" fullWidth loading={isLoading} className="mt-1">
              {isLoading ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </div>
      </div>
    </main>
  );
}
