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
      <div className="w-full max-w-md bg-white p-8 rounded-xl shadow-md border border-slate-200">
        
        <div className="flex flex-col items-center mb-8">
          <div className="bg-blue-600 w-12 h-12 rounded-xl flex items-center justify-center text-white font-bold text-xl mb-4 shadow-sm">
            NS
          </div>
          <h1 className="text-2xl font-bold text-slate-800">NeuroStudy</h1>
          <p className="text-sm text-slate-500">Clinical Login Portal</p>
        </div>

        {error && (
          <div className="mb-6 p-3 bg-red-50 text-red-700 text-sm font-medium rounded-lg text-center">
            {error}
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-5">
          <div>
            {/* CHANGED: Updated label and input type to email */}
            <label className="block text-xs font-bold text-slate-500 uppercase mb-2">Email Address</label>
            <input 
              type="email" 
              value={email} 
              onChange={(e) => setEmail(e.target.value)} 
              className="w-full p-3 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 text-slate-800"
              placeholder=""
              required
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-500 uppercase mb-2">Password</label>
            <input 
              type="password" 
              value={password} 
              onChange={(e) => setPassword(e.target.value)} 
              className="w-full p-3 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 text-slate-800"
              placeholder="••••••••"
              required
            />
          </div>
          <button 
            type="submit" 
            disabled={isLoading}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-lg transition-colors shadow-sm disabled:bg-blue-300"
          >
            {isLoading ? "Authenticating..." : "Sign In"}
          </button>
        </form>
      </div>
    </main>
  );
}