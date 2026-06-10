"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  const handleLogin = async (e) => {
    e.preventDefault();
    setErrorMessage(""); // Clear old errors

    try {
      const response = await fetch("http://localhost:5000/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json();

      if (response.ok) {
        localStorage.setItem("token", data.token);
        const role = data.user?.role;
        
        if (role === "admin") {
          router.push("/admin");
        } else if (role === "technician") {
          router.push("/session");
        } else {
          setErrorMessage("Access denied: No valid role assigned to this account.");
        }
      } else {
        // If password/email is wrong, pull the error text directly from the database API
        setErrorMessage(data.message || "Invalid email or password.");
      }
    } catch (error) {
      setErrorMessage("Could not connect to the authentication server.");
    }
  };

  return (
    <main className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4 font-sans">
      <div className="text-center mb-8">
        <div className="bg-teal-400 w-16 h-16 rounded-2xl mx-auto flex items-center justify-center shadow-lg mb-4">
          <span className="text-white text-3xl font-bold">🧠</span>
        </div>
        <h1 className="text-3xl font-bold text-slate-800">NeuroStudy Companion</h1>
        <p className="text-slate-500 mt-2">Track your focus, improve your study habits</p>
      </div>

      <div className="bg-white w-full max-w-md p-8 rounded-xl shadow-sm border border-slate-100">
        <h2 className="text-xl font-bold text-slate-800 mb-6">Welcome Back</h2>
        
        {/* DYNAMIC ERROR PROMPT DISPLAY */}
        {errorMessage && (
          <div className="bg-red-50 text-red-600 border border-red-100 p-3 rounded-lg text-sm mb-4 font-medium flex items-center gap-2">
            ⚠️ {errorMessage}
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-sm text-slate-600 mb-1">Email</label>
            <input 
              type="email" 
              required
              placeholder="tech@neurostudy.com"
              className="w-full px-4 py-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-teal-400 focus:border-transparent transition-all"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          
          <div>
            <label className="block text-sm text-slate-600 mb-1">Password</label>
            <input 
              type="password" 
              required
              placeholder="Enter your password"
              className="w-full px-4 py-3 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-teal-400 focus:border-transparent transition-all"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <button 
            type="submit" 
            className="w-full bg-blue-500 hover:bg-blue-600 text-white font-semibold py-3 rounded-lg transition-colors mt-4 shadow-sm"
          >
            Log In
          </button>
        </form>
      </div>
    </main>
  );
}