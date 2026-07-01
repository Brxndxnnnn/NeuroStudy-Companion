"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  
  // CHANGED: Now using email instead of username
  const [email, setEmail] = useState(""); 
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    try {
      const res = await fetch("http://139.59.126.77/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // CHANGED: Sending email in the body payload
        body: JSON.stringify(
          { email, password, override: true })
      });

      if (res.ok) {
        const data = await res.json();
        const token = data.accessToken; 
        
        // 1. Grab the user's role from Eugene's API response
        const userRole = data.user.role; 

        // 2. Save both the token and the role to local storage
        localStorage.setItem("token", token);
        localStorage.setItem("userRole", userRole); 

        // 3. Act as a traffic cop based on the role
        if (userRole === "admin" || userRole === "superadmin") {
          // Send admins to the Super Admin Dashboard
          router.push("/admin"); 
          
        } else {
          // Send technicians to the Clinical Portal
          router.push("/history"); 
        }

      } else {
        setError("Invalid email or password.");
      }
    } catch (err) {
      setError("Network error. Could not connect to database.");
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