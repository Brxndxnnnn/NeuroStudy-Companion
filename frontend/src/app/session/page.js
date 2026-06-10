"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

export default function SessionSetup() {
  const router = useRouter();
  const [pairingCode, setPairingCode] = useState("");

  //This is the guard that checks if the technician is logged in
  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.push("/login"); //Redirect back to login if no token found
    }
  }, [router]);

  const handleVerify = (e) => {
    e.preventDefault();
    if (pairingCode.length === 6) {
      router.push("/session/active");
    } else {
      alert("Please enter a valid 6-digit code.");
    }
  };

  return (
    <main className="min-h-screen bg-slate-50 p-8 font-sans flex flex-col items-center">
      <div className="w-full max-w-4xl flex justify-between items-center mb-12">
        <div className="flex items-center gap-3">
          <div className="bg-teal-400 w-8 h-8 rounded-lg flex items-center justify-center text-white font-bold">🧠</div>
          <span className="font-bold text-slate-800 text-lg">NeuroStudy Companion</span>
        </div>
        <button 
          onClick={() => {
            localStorage.removeItem("token"); // Clear token on logout
            router.push("/login");
          }} 
          className="text-slate-500 hover:text-slate-800 text-sm"
        >
          Logout
        </button>
      </div>

      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold text-slate-800 mb-2">Session Setup</h1>
        <p className="text-slate-500">Link your desktop session and start tracking your focus</p>
      </div>

      <div className="bg-white w-full max-w-xl p-8 rounded-xl shadow-sm border border-slate-100 mb-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="bg-slate-100 p-2 rounded-lg text-slate-500">🔗</div>
          <h2 className="font-bold text-slate-800">Link Desktop Session</h2>
        </div>

        <div className="bg-slate-50 p-6 rounded-lg text-center border border-slate-100 mb-6">
          <p className="text-sm text-slate-600 mb-4">
            Open the Windows Bridge app and enter the 6-digit code shown on your screen.
          </p>
          <form onSubmit={handleVerify}>
            <input 
              type="text" 
              maxLength="6"
              placeholder="E.g. 847293"
              className="w-48 text-center text-3xl font-bold tracking-widest p-4 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-400 mb-4"
              value={pairingCode}
              onChange={(e) => setPairingCode(e.target.value.replace(/\D/g, ''))}
            />
            <button 
              type="submit"
              disabled={pairingCode.length !== 6}
              className={`w-full py-4 rounded-lg font-bold text-white transition-all ${
                pairingCode.length === 6 ? 'bg-blue-500 hover:bg-blue-600 shadow-md' : 'bg-slate-300 cursor-not-allowed'
              }`}
            >
              Verify Code & Start Session
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}