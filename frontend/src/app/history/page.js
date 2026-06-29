"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

export default function ClinicalDashboard() {
  const router = useRouter();
  const [clients, setClients] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  // Form States (Matching Eugene's POST payload)
  const [newName, setNewName] = useState("");
  const [newDob, setNewDob] = useState("");
  const [newGender, setNewGender] = useState("");
  const [newRace, setNewRace] = useState("");
  const [newNotes, setNewNotes] = useState("");
  const [feedback, setFeedback] = useState({ type: "", message: "" });

  const getCleanToken = () => localStorage.getItem("token")?.replace(/^["']|["']$/g, '').trim();

  // ==========================================
  // 1. FETCH CLIENTS ON LOAD
  // ==========================================
  const fetchClients = async () => {
    try {
      const res = await fetch("http://139.59.126.77/api/clients", {
        headers: { "Authorization": `Bearer ${getCleanToken()}` }
      });
      if (res.ok) {
        const data = await res.json();
        setClients(data); 
      }
    } catch (err) {
      console.error("Failed to fetch clients from database", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchClients();
  }, []);

  // ==========================================
  // 2. REGISTER A NEW CLIENT
  // ==========================================
  const handleRegisterClient = async (e) => {
    e.preventDefault();
    if (!newName || !newDob || !newGender) {
      setFeedback({ type: "error", message: "Name, DOB, and Gender are required." });
      return;
    }

    try {
      const res = await fetch("http://139.59.126.77/api/clients", {
        method: "POST",
        headers: { 
          "Content-Type": "application/json", 
          "Authorization": `Bearer ${getCleanToken()}` 
        },
        body: JSON.stringify({
          name: newName,
          dob: newDob,
          gender: newGender,
          race: newRace,
          notes: newNotes
        })
      });

      if (res.ok) {
        setFeedback({ type: "success", message: "Client successfully registered!" });
        setNewName(""); setNewDob(""); setNewGender(""); setNewRace(""); setNewNotes("");
        fetchClients(); // Instantly refresh the table with the new client
        setTimeout(() => setFeedback({ type: "", message: "" }), 3000);
      } else {
        setFeedback({ type: "error", message: "Failed to register client on server." });
      }
    } catch (err) {
      setFeedback({ type: "error", message: "Network error while registering." });
    }
  };

  // ==========================================
  // 3. SELECT CLIENT & PROCEED TO SESSION
  // ==========================================
  const handleSelectClient = (clientId, clientName) => {
    // Save the real database ID to local storage so the Setup page can use it
    localStorage.setItem("currentClientId", clientId);
    localStorage.setItem("currentClientName", clientName);
    router.push("/session");
  };

  return (
    <main className="min-h-screen bg-slate-50 p-8 font-sans text-slate-800">
      {/* Top Header */}
      <div className="max-w-7xl mx-auto flex justify-between items-center mb-8 bg-white p-4 rounded-xl shadow-sm border border-slate-200">
        <div className="flex items-center gap-3">
          <div className="bg-blue-600 w-8 h-8 rounded-lg flex items-center justify-center text-white font-bold">NP</div>
          <span className="font-bold text-xl text-blue-900 tracking-tight">NeuroPrecise</span>
          <span className="text-slate-400 ml-2">Clinical Portal</span>
        </div>
      </div>

      <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-8">
        
        {/* Left Column: Registration Form */}
        <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 h-fit">
          <div className="flex justify-between items-center mb-6">
            <h2 className="font-bold text-lg text-slate-800">Client Registration</h2>
          </div>

          {feedback.message && (
            <div className={`mb-4 p-3 rounded text-sm font-medium ${feedback.type === 'success' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
              {feedback.message}
            </div>
          )}

          <form onSubmit={handleRegisterClient} className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Full Name</label>
              <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} className="w-full p-2.5 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500" placeholder="e.g. Johnathan Doe" />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Date of Birth</label>
              <input type="date" value={newDob} onChange={(e) => setNewDob(e.target.value)} className="w-full p-2.5 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 bg-white" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Gender</label>
                <select value={newGender} onChange={(e) => setNewGender(e.target.value)} className="w-full p-2.5 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 bg-white">
                  <option value="">Select</option>
                  <option value="Male">Male</option>
                  <option value="Female">Female</option>
                  <option value="Other">Other</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Race</label>
                <input type="text" value={newRace} onChange={(e) => setNewRace(e.target.value)} className="w-full p-2.5 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500" placeholder="e.g. Chinese" />
              </div>
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Clinical Notes</label>
              <textarea value={newNotes} onChange={(e) => setNewNotes(e.target.value)} rows="3" className="w-full p-2.5 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500" placeholder="Medical history..." />
            </div>
            
            <div className="pt-2">
              <button type="submit" className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 rounded-lg text-sm transition-colors shadow-sm">
                Register Patient
              </button>
            </div>
          </form>
        </div>

        {/* Right Column: Client Directory */}
        <div className="md:col-span-2 bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
            <div>
              <h2 className="font-bold text-lg text-slate-800">Client Directory</h2>
              <p className="text-xs text-slate-500">Select a patient to begin an EEG session.</p>
            </div>
          </div>
          
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-slate-50 border-b border-slate-100 text-xs text-slate-500 uppercase font-bold tracking-wide">
                <tr>
                  <th className="p-4">Patient Details</th>
                  <th className="p-4">Demographics</th>
                  <th className="p-4">Actions</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr><td colSpan="3" className="p-8 text-center text-slate-400">Loading clients...</td></tr>
                ) : clients.length === 0 ? (
                  <tr><td colSpan="3" className="p-8 text-center text-slate-400">No clients found. Register one to begin.</td></tr>
                ) : (
                  clients.map((client) => (
                    <tr key={client.client_id} className="border-b border-slate-50 hover:bg-slate-50 transition-colors">
                      <td className="p-4">
                        <div className="font-bold text-slate-800">{client.name}</div>
                        <div className="text-xs text-slate-400 font-mono mt-0.5">ID: {client.client_id?.substring(0, 8)}...</div>
                      </td>
                      <td className="p-4 text-sm text-slate-600">
                        {client.gender || "N/A"} • {client.dob || "N/A"}
                      </td>
                      <td className="p-4">
                        <button 
                          onClick={() => handleSelectClient(client.client_id, client.name)}
                          className="bg-blue-50 text-blue-600 hover:bg-blue-600 hover:text-white px-4 py-2 rounded font-bold text-xs transition-colors"
                        >
                          Start Session →
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

      </div>
    </main>
  );
}