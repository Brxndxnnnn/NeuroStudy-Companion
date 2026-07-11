"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { login } from "@/utils/api";

export default function LoginPage() {
  const router = useRouter();
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
      // 1. Send the login request (override set to true for concurrent login)
      const res = await login(email, password, true);

      if (res.ok) {
        // 2. Read the JSON exactly ONCE
        const data = await res.json();
        console.log("Login Success! Welcome:", data.user.display_name);
        
        // 3. Extract the exact fields Eugene's backend just sent us
        const token = data.accessToken; 
        const userRole = data.user.role; 
        
        // 4. Save them to local storage so the rest of the app can use them
        localStorage.setItem("token", token);
        localStorage.setItem("userRole", userRole);

        // 5. Redirect to your clinical dashboard
        if (userRole === "admin" || userRole === "superadmin") {
          router.push("/admin");
        } else {
          router.push("/history"); // Ensure your dashboard folder is named "history"
        }
      } else {
        // If login failed (wrong password), read the error JSON
        const errorData = await res.json();
        setError(errorData.message || errorData.error || "Invalid email or password.");
      }
    } catch (err) {
      console.error("CODE CRASHED DURING LOGIN:", err);
      setError("An unexpected code error occurred. Check the console.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-50 flex flex-col justify-center items-center p-4">
      <div className="w-full max-w-lg bg-white p-10 rounded-3xl shadow-xl border border-slate-100">
        
        <div className="flex flex-col items-center mb-10">
          <div className="bg-blue-600 w-16 h-16 rounded-2xl flex items-center justify-center text-white font-bold text-3xl mb-5 shadow-md">
            NS
          </div>
          <h1 className="text-3xl font-extrabold text-slate-800 tracking-tight">NeuroStudy</h1>
          <p className="text-base text-slate-500 font-medium mt-2">Clinical Login Portal</p>
        </div>

        {error && (
          <div className="mb-6 p-4 bg-red-50 text-red-700 text-sm font-bold rounded-xl text-center border border-red-100">
            {error}
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-6">
          <div>
            <label className="block text-sm font-bold text-slate-500 uppercase tracking-wide mb-2">Email Address</label>
            <input 
              type="email" 
              value={email} 
              onChange={(e) => setEmail(e.target.value)} 
              className="w-full p-4 text-lg border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all text-slate-800 bg-slate-50 focus:bg-white"
              placeholder="name@clinic.com"
              required
            />
          </div>
          
          <div>
            <label className="block text-sm font-bold text-slate-500 uppercase tracking-wide mb-2">Password</label>
            {/* NEW: Relative wrapper for the input and button */}
            <div className="relative">
              <input 
                // NEW: Toggle between password and text types
                type={showPassword ? "text" : "password"} 
                value={password} 
                onChange={(e) => setPassword(e.target.value)} 
                className="w-full p-4 pr-12 text-lg border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all text-slate-800 bg-slate-50 focus:bg-white"
                placeholder="••••••••"
                required
              />
              {/* NEW: The Show/Hide toggle button */}
              <button 
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 hover:text-blue-600 transition-colors p-1"
                title={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? (
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" className="w-6 h-6">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                  </svg>
                )}
              </button>
            </div>
          </div>
          
          <button 
            type="submit" 
            disabled={isLoading}
            className="w-full mt-4 bg-blue-600 hover:bg-blue-700 active:scale-[0.98] text-white font-bold text-lg py-4 rounded-xl transition-all shadow-md hover:shadow-lg disabled:bg-blue-300 disabled:cursor-not-allowed flex justify-center items-center gap-2"
          >
            {isLoading ? (
              <span className="flex items-center gap-2">
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                Authenticating...
              </span>
            ) : "Sign In"}
          </button>
        </form>
      </div>
    </main>
  );
}