"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

export default function SessionSetup() {
  const router = useRouter();
  const [pairingCode, setPairingCode] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [feedback, setFeedback] = useState({ type: "", message: "" });

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.push("/login");
    }
  }, [router]);

  const handleVerify = async (e) => {
    e.preventDefault();
    setFeedback({ type: "", message: "" });
    
    if (pairingCode.length !== 6) return;
    
    setIsLoading(true);

    try {
      const rawToken = localStorage.getItem("token") || "";
      const cleanToken = rawToken.replace(/^["']|["']$/g, '').trim();
      
      //Updated to PATCH and the exact /pair endpoint
      const response = await fetch("http://139.59.126.77/api/sessions/pair", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${cleanToken}`
        },
        body: JSON.stringify({ 
          pairing_code: pairingCode,
          //passed the required test client UUID from the Swagger docs
          client_id: "c0000000-0000-0000-0000-000000000001" 
        }),
      });

      if (response.ok) {
        setFeedback({ 
          type: "success", 
          message: "Successfully paired with Windows Bridge! Initializing session..." 
        });
        
        setTimeout(() => {
          router.push("/session/active");
        }, 1500);
      } else if (response.status === 404) {
        setFeedback({ 
          type: "error", 
          message: "Invalid pairing code or session already claimed." 
        });
      } else {
        const errData = await response.json();
        setFeedback({ 
          type: "error", 
          message: errData.message || "Failed to pair with the device." 
        });
      }
    } catch (error) {
      setFeedback({ 
        type: "error", 
        message: "Network error: Could not reach the cloud database." 
      });
    } finally {
      setIsLoading(false);
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
            localStorage.removeItem("token");
            router.push("/login");
          }} 
          className="text-slate-500 hover:text-slate-800 text-sm font-medium"
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

        {feedback.type === "error" && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm font-medium flex items-center gap-2">
            ⚠️ {feedback.message}
          </div>
        )}
        
        {feedback.type === "success" && (
          <div className="mb-6 p-4 bg-green-50 border border-green-200 text-green-700 rounded-lg text-sm font-medium flex items-center gap-2 animate-pulse">
            ✅ {feedback.message}
          </div>
        )}

        <div className="bg-slate-50 p-6 rounded-lg text-center border border-slate-100 mb-6">
          <p className="text-sm text-slate-600 mb-4">
            Open the Windows Bridge app and enter the 6-character code shown on your screen.
          </p>
          <form onSubmit={handleVerify}>
            <input 
              type="text" 
              maxLength="6"
              placeholder="E.g. C2E2AA"
              disabled={isLoading || feedback.type === "success"}
              className="w-48 text-center text-3xl font-bold tracking-widest p-4 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-400 mb-4 disabled:opacity-50 uppercase"
              value={pairingCode}
              //Regex allows Letters A-Z and Numbers 0-9
              onChange={(e) => setPairingCode(e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase())}
            />
            <button 
              type="submit"
              disabled={pairingCode.length !== 6 || isLoading || feedback.type === "success"}
              className={`w-full py-4 rounded-lg font-bold text-white transition-all flex justify-center items-center gap-2 ${
                pairingCode.length === 6 && !isLoading && feedback.type !== "success" 
                  ? 'bg-blue-500 hover:bg-blue-600 shadow-md' 
                  : 'bg-slate-300 cursor-not-allowed'
              }`}
            >
              {isLoading ? "Verifying with Cloud..." : "Verify Code & Start Session"}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}