"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

export default function ClinicalDashboard() {
  const router = useRouter();
  
  // MOCK DATA: Replace with GET /api/clients later
  const [clients, setClients] = useState([
    { id: "c0000000-0000-0000-0000-000000000001", name: "Eleanor Vance", age: 42, gender: "Female", lastSession: "Oct 12, 2023" },
    { id: "c0000000-0000-0000-0000-000000000002", name: "Marcus Thorne", age: 28, gender: "Male", lastSession: "Oct 12, 2023" },
    { id: "c0000000-0000-0000-0000-000000000003", name: "Sarah Connor", age: 35, gender: "Female", lastSession: "Oct 11, 2023" },
  ]);

  // Form State
  const [newName, setNewName] = useState("");
  const [newAge, setNewAge] = useState("");
  const [newGender, setNewGender] = useState("");
  const [feedback, setFeedback] = useState("");

  const handleRegisterClient = (e) => {
    e.preventDefault();
    if (!newName || !newAge || !newGender) {
      setFeedback("Please fill out all fields.");
      return;
    }

    // MOCK SUBMIT: Replace with POST /api/clients later
    const newClient = {
      id: `mock-id-${Math.random()}`,
      name: newName,
      age: newAge,
      gender: newGender,
      lastSession: "No sessions yet"
    };
    
    setClients([newClient, ...clients]);
    setNewName(""); setNewAge(""); setNewGender("");
    setFeedback("Client successfully registered!");
    setTimeout(() => setFeedback(""), 3000);
  };

  return (
    <main className="min-h-screen bg-slate-100 p-8 font-sans text-slate-800">
      {/* Top Header */}
      <div className="max-w-7xl mx-auto flex justify-between items-center mb-8 bg-white p-4 rounded-xl shadow-sm border border-slate-200">
        <div className="flex items-center gap-3">
          <div className="bg-blue-600 w-8 h-8 rounded-lg flex items-center justify-center text-white font-bold">NP</div>
          <span className="font-bold text-xl text-blue-900 tracking-tight">NeuroPrecise</span>
          <span className="text-slate-400 ml-2">Clinical Portal</span>
        </div>
        <button onClick={() => router.push("/session")} className="bg-blue-50 hover:bg-blue-100 text-blue-600 px-4 py-2 rounded-lg font-bold text-sm transition-colors">
          Go to EEG Pairing →
        </button>
      </div>

      <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-8">
        
        {/* Left Column: Registration Form */}
        <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200 h-fit">
          <div className="flex justify-between items-center mb-6">
            <h2 className="font-bold text-lg text-slate-800">Client Registration</h2>
            <span className="text-blue-500">👤+</span>
          </div>

          {feedback && <div className={`mb-4 p-3 rounded text-sm font-medium ${feedback.includes('success') ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>{feedback}</div>}

          <form onSubmit={handleRegisterClient} className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Full Name</label>
              <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} className="w-full p-2.5 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500" placeholder="e.g. Johnathan Doe" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Age</label>
                <input type="number" value={newAge} onChange={(e) => setNewAge(e.target.value)} className="w-full p-2.5 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500" placeholder="e.g. 34" />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Gender</label>
                <select value={newGender} onChange={(e) => setNewGender(e.target.value)} className="w-full p-2.5 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 bg-white">
                  <option value="">Select</option>
                  <option value="Male">Male</option>
                  <option value="Female">Female</option>
                  <option value="Other">Other</option>
                </select>
              </div>
            </div>
            
            <div className="pt-4 flex gap-3">
              <button type="submit" className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 rounded-lg text-sm transition-colors shadow-sm">
                Register Patient
              </button>
              <button type="button" onClick={() => {setNewName(""); setNewAge(""); setNewGender("");}} className="px-4 py-2.5 border border-slate-200 hover:bg-slate-50 text-slate-600 font-medium rounded-lg text-sm transition-colors">
                Clear
              </button>
            </div>
          </form>
        </div>

        {/* Right Column: Client Directory */}
        <div className="md:col-span-2 bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
            <div>
              <h2 className="font-bold text-lg text-slate-800">Client Directory</h2>
              <p className="text-xs text-slate-500">Select a client from the EEG Setup page to begin a session.</p>
            </div>
          </div>
          
          <table className="w-full text-left">
            <thead className="bg-slate-50 border-b border-slate-100 text-xs text-slate-500 uppercase font-bold tracking-wide">
              <tr>
                <th className="p-4">Patient Name</th>
                <th className="p-4">Demographics</th>
                <th className="p-4">Last Session Date</th>
                <th className="p-4"></th>
              </tr>
            </thead>
            <tbody>
              {clients.map((client) => (
                <tr key={client.id} className="border-b border-slate-50 hover:bg-slate-50 transition-colors">
                  <td className="p-4">
                    <div className="font-bold text-slate-800">{client.name}</div>
                    <div className="text-xs text-slate-400 font-mono mt-0.5">ID: {client.id.substring(0, 8)}...</div>
                  </td>
                  <td className="p-4 text-sm text-slate-600">{client.age} yrs • {client.gender}</td>
                  <td className="p-4 text-sm text-slate-600">{client.lastSession}</td>
                  <td className="p-4 text-right">
                    <button className="text-blue-500 hover:text-blue-700 font-medium text-sm">View &gt;</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

      </div>
    </main>
  );
}