"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { getClients, createClient } from "@/utils/api";

export default function ClinicalDashboard() {
  const router = useRouter();
  const [clients, setClients] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  // Form States
  const [newName, setNewName] = useState("");
  const [newDob, setNewDob] = useState("");
  const [newGender, setNewGender] = useState("");
  const [newRace, setNewRace] = useState("");
  const [newNotes, setNewNotes] = useState("");
  const [feedback, setFeedback] = useState({ type: "", message: "" });


  // 1. FETCH CLIENTS ON LOAD
  const fetchClients = async () => {
    try {
      const res = await getClients();
      if (res.ok) {
        const data = await res.json();
        setClients(data); 
      } else {
        console.error("Failed to fetch clients");
      }
    } catch (err) {
      console.error("Network error while fetching clients:", err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchClients();
  }, []);


  // 2. REGISTER A NEW CLIENT
  const handleRegisterClient = async (e) => {
    e.preventDefault();
    if (!newName || !newDob || !newGender) {
      setFeedback({ type: "error", message: "Name, DOB, and Gender are required." });
      return;
    }

    try {
      const res = await createClient({
        name: newName,
        dob: newDob,
        gender: newGender,
        race: newRace,
        notes: newNotes,
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

  // 3. SELECT CLIENT & PROCEED TO SESSION
  const handleSelectClient = (clientId, clientName) => {
    // Save the real database ID to local storage so the Setup page can use it
    localStorage.setItem("currentClientId", clientId);
    localStorage.setItem("currentClientName", clientName);
    router.push("/session");
  };



return (
    <main className="min-h-screen bg-slate-50 p-8 font-sans text-slate-800">
      <div className="max-w-7xl mx-auto space-y-8">
        
        {/*Client Directory */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="p-6 border-b border-slate-100 bg-slate-50/50">
            <h2 className="font-bold text-lg text-slate-800">Client Directory</h2>
            <p className="text-xs text-slate-500">Select an existing patient to start a session.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-slate-50 text-xs text-slate-500 uppercase font-bold">
                <tr><th className="p-4">Patient</th><th className="p-4">Demographics</th><th className="p-4">Action</th></tr>
              </thead>
              <tbody>
                {isLoading ? <tr><td colSpan="3" className="p-8 text-center">Loading...</td></tr> : 
                 clients.map((client) => (
                  <tr key={client.client_id} className="border-b hover:bg-slate-50">
                    <td className="p-4 font-bold">{client.name}</td>
                    <td className="p-4 text-sm">{client.gender} • {client.dob}</td>
                    <td className="p-4">
                      <button onClick={() => handleSelectClient(client.client_id, client.name)} className="bg-blue-600 text-white px-4 py-1 rounded text-xs font-bold">Start</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/*Client Registration*/}
        <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
          <h2 className="font-bold text-lg text-slate-800 mb-4">Register New Client</h2>
          {feedback.message && <div className={`mb-4 p-2 text-sm ${feedback.type === 'success' ? 'bg-green-100' : 'bg-red-100'}`}>{feedback.message}</div>}
          <form onSubmit={handleRegisterClient} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <input type="text" placeholder="Full Name" value={newName} onChange={(e) => setNewName(e.target.value)} className="p-2 border rounded" required />
            <input type="date" value={newDob} onChange={(e) => setNewDob(e.target.value)} className="p-2 border rounded" required />
            <select value={newGender} onChange={(e) => setNewGender(e.target.value)} className="p-2 border rounded" required>
              <option value="">Select Gender</option><option value="Male">Male</option><option value="Female">Female</option>
            </select>
            <input type="text" placeholder="Race" value={newRace} onChange={(e) => setNewRace(e.target.value)} className="p-2 border rounded" />
            <textarea placeholder="Clinical Notes" value={newNotes} onChange={(e) => setNewNotes(e.target.value)} className="md:col-span-2 p-2 border rounded" />
            <button type="submit" className="md:col-span-2 bg-slate-800 text-white py-2 rounded font-bold">Register Client</button>
          </form>
        </div>
        
      </div>
    </main>
  );
}