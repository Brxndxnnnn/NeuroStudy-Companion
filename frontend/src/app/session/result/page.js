"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { fetchWithAuth } from "@/utils/api";

export default function SessionResults() {
  const router = useRouter();
  const [eegData, setEegData] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [patientName, setPatientName] = useState("Unknown Patient");

  useEffect(() => {
    const fetchResults = async () => {
      const sessionId = localStorage.getItem("currentSessionId");
      setPatientName(localStorage.getItem("currentClientName") || "Unknown Patient");
      
      if (!sessionId) {
        setError("No active session found. Please select a patient from the dashboard.");
        setIsLoading(false);
        return;
      }

      try {
        const res = await fetchWithAuth(`http://139.59.126.77/api/sessions/${sessionId}/results`);

        if (res.ok) {
          const data = await res.json();
          // Adjust based on Eugene's actual return array format
          setEegData(Array.isArray(data) ? data : data.results || []);
        } else {
          setError("Failed to load EEG data from the database.");
        }
      } catch (err) {
        setError("Network error while attempting to fetch results.");
      } finally {
        setIsLoading(false);
      }
    };

    fetchResults();
  }, [router]);

  return (
    <main className="min-h-screen bg-slate-50 p-8 font-sans">
      <div className="max-w-6xl mx-auto">
        
        {/* Header */}
        <div className="flex justify-between items-center bg-white p-4 rounded-xl shadow-sm border border-slate-200 mb-8">
          <div>
            <h1 className="font-bold text-2xl text-slate-800">Session Results</h1>
            <p className="text-slate-500">Patient: <span className="font-bold text-blue-600">{patientName}</span></p>
          </div>
          <button 
            onClick={() => router.push("/history")} 
            className="px-4 py-2 bg-slate-100 text-slate-700 hover:bg-slate-200 font-bold rounded-lg transition-colors text-sm"
          >
            ← Back to Dashboard
          </button>
        </div>

        {/* Content Area */}
        <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
          {isLoading ? (
            <div className="h-96 flex items-center justify-center text-slate-400 font-bold">
              Loading EEG Data Visualizations...
            </div>
          ) : error ? (
            <div className="h-96 flex items-center justify-center text-red-500 font-bold">
              {error}
            </div>
          ) : eegData.length === 0 ? (
            <div className="h-96 flex items-center justify-center text-slate-500 font-medium">
              No data points recorded for this session.
            </div>
          ) : (
            <>
              <h2 className="text-lg font-bold text-slate-800 mb-6">Brainwave Frequencies (Band Power)</h2>
              <div className="h-[500px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={eegData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                    <XAxis dataKey="timestamp" stroke="#94a3b8" fontSize={12} tickFormatter={(tick) => new Date(tick).toLocaleTimeString()} />
                    <YAxis stroke="#94a3b8" fontSize={12} />
                    <Tooltip 
                      contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                      labelFormatter={(label) => new Date(label).toLocaleTimeString()}
                    />
                    <Legend iconType="circle" wrapperStyle={{ paddingTop: '20px' }}/>
                    
                    <Line type="monotone" dataKey="alpha" stroke="#3b82f6" strokeWidth={2} dot={false} name="Alpha (Relaxation)" />
                    <Line type="monotone" dataKey="beta" stroke="#ef4444" strokeWidth={2} dot={false} name="Beta (Focus)" />
                    <Line type="monotone" dataKey="theta" stroke="#10b981" strokeWidth={2} dot={false} name="Theta (Drowsy)" />
                    <Line type="monotone" dataKey="gamma" stroke="#8b5cf6" strokeWidth={2} dot={false} name="Gamma (Cognitive)" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </div>
        
      </div>
    </main>
  );
}