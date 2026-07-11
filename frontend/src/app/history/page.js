"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { getClients, createClient } from "@/utils/api";
import { Toaster, toast } from "react-hot-toast";

export default function ClinicalDashboard() {
  const router = useRouter();
  const [clients, setClients] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  //Search and filter client
  const [searchQuery, setSearchQuery] = useState("");
  const [filterGender, setFilterGender] = useState("");
  const [filterRace, setFilterRace] = useState("");

  // Form States
  const [newName, setNewName] = useState("");
  const [newDob, setNewDob] = useState("");
  const [newGender, setNewGender] = useState("");
  const [newRace, setNewRace] = useState("");
  const [customRace, setCustomRace] = useState("");// For other race to type 
  const [newNotes, setNewNotes] = useState("");
  const [feedback, setFeedback] = useState({ type: "", message: "" });

  const raceOptions = ["Chinese", "Malay", "Indian", "Caucasian", "Eurasian", "Other"];


  // 1. FETCH CLIENTS ON LOAD
  const fetchClients = async () => {
    try {
      const res = await getClients();
      if (res.ok) {
        const data = await res.json();
        setClients(data); 
      }
    } catch (err) {
      toast.error("Failed to fetch clients from database."); //Error Toast
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
      setFeedback({ type: "error", message: "Name, Date Of Birth, and Gender are required." });
      return;
    }

      const finalRace = newRace === "Other" ? customRace : newRace;

      const toastId = toast.loading("Registering patient...");

      try {
      const res = await createClient({
        name: newName,
        dob: newDob,
        gender: newGender,
        race: finalRace,
        notes: newNotes,
      });

      if (res.ok) {
        toast.success("Patient successfully registered!", { id: toastId });        
        setNewName(""); setNewDob(""); setNewGender(""); setNewRace(""); setCustomRace(""); setNewNotes("");
        fetchClients(); // Instantly refresh the table with the new client
        setTimeout(() => setFeedback({ type: "", message: "" }), 3000);
      } else {
        toast.error("Failed to register patient on server.", { id: toastId });
      }
      } catch (err) {
      toast.error("Network error while registering.", { id: toastId });
      }
  };

  // 3. SELECT CLIENT & PROCEED TO SESSION
  const handleSelectClient = (clientId, clientName) => {
    // Save the real database ID to local storage so the Setup page can use it
    localStorage.setItem("currentClientId", clientId);
    localStorage.setItem("currentClientName", clientName);
    router.push("/session");
  };

  //Calculate Age
  const calculateAge = (dobString) => {
    if (!dobString) return "N/A";
    const dob = new Date(dobString);
    const ageDifMs = Date.now() - dob.getTime();
    const ageDate = new Date(ageDifMs);
    return Math.abs(ageDate.getUTCFullYear() - 1970);
  };

  //filter logic
  const filteredClients = clients.filter(client => {
    const matchesName = client.name?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesGender = filterGender ? client.gender === filterGender : true;
    const matchesRace = filterRace ? client.race === filterRace : true;
    
    return matchesName && matchesGender && matchesRace;
  });

  const clearFilters = () => {
    setSearchQuery("");
    setFilterGender("");
    setFilterRace("");
  };

  return (
    <main className="min-h-screen bg-slate-50 p-8 font-sans text-slate-800">
      <Toaster position="bottom-right" toastOptions={{ duration: 4000, style: { background: '#334155', color: '#fff', fontWeight: 'bold' } }} />

      <div className="max-w-7xl mx-auto space-y-8">
        
        {/* Client Directory */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          
          <div className="p-6 border-b border-slate-100 bg-slate-50/50">
            <div className="mb-4">
              <h2 className="font-bold text-xl text-slate-800 tracking-tight">Client Directory</h2>
              <p className="text-sm text-slate-500 mt-1">Select an existing patient or filter the database.</p>
            </div>
            
            {/* --- ADVANCED FILTER BAR --- */}
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative w-full sm:w-1/2">
                <input 
                  type="text" placeholder="Search patient name..." 
                  value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-2.5 bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm transition-all"
                />
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <select 
                value={filterGender} onChange={(e) => setFilterGender(e.target.value)}
                className="w-full sm:w-1/4 p-2.5 bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm text-slate-600"
              >
                <option value="">All Genders</option>
                <option value="Male">Male</option>
                <option value="Female">Female</option>
              </select>
              <select 
                value={filterRace} onChange={(e) => setFilterRace(e.target.value)}
                className="w-full sm:w-1/4 p-2.5 bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm text-slate-600"
              >
                <option value="">All Races</option>
                {raceOptions.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-slate-50 text-xs text-slate-400 uppercase font-bold tracking-wider border-b border-slate-100">
                <tr>
                  <th className="p-4 pl-6">Patient</th>
                  <th className="p-4">Demographics</th>
                  <th className="p-4 pr-6 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {isLoading ? (
                  <tr><td colSpan="3" className="p-8 text-center text-slate-400 font-medium">Loading patients...</td></tr>
                ) : filteredClients.length === 0 ? (
                  <tr>
                    <td colSpan="3" className="p-12 text-center">
                      <div className="text-slate-400 font-medium mb-3">No patients found matching your filters.</div>
                      {(searchQuery || filterGender || filterRace) && (
                        <button onClick={clearFilters} className="text-blue-600 hover:text-blue-700 font-bold text-sm bg-blue-50 hover:bg-blue-100 px-4 py-2 rounded-lg transition-colors">
                          Clear Filters
                        </button>
                      )}
                    </td>
                  </tr>
                ) : (
                  filteredClients.map((client) => (
                  <tr key={client.client_id} className="hover:bg-blue-50/30 transition-colors group">
                    <td className="p-4 pl-6 font-bold text-slate-800">{client.name}</td>
                    <td className="p-4 text-sm text-slate-500">
                      <span className="font-medium text-slate-700">{calculateAge(client.dob)} yrs</span> • {client.gender || "N/A"} • {client.race || "N/A"}
                    </td>
                    <td className="p-4 pr-6 text-right">
                      <button 
                        onClick={() => handleSelectClient(client.client_id, client.name)} 
                        className="bg-blue-50 text-blue-600 hover:bg-blue-600 hover:text-white px-5 py-2 rounded-lg text-sm font-bold transition-all active:scale-[0.97] opacity-90 group-hover:opacity-100 shadow-sm"
                      >
                        Start Session →
                      </button>
                    </td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Client Registration */}
        <div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-200">
          <div className="mb-6">
            <h2 className="font-bold text-xl text-slate-800 tracking-tight">Register New Client</h2>
            <p className="text-sm text-slate-500 mt-1">Add a new patient to the database.</p>
          </div>

          <form onSubmit={handleRegisterClient} className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">Full Name <span className="text-red-500">*</span></label>
              <input type="text" placeholder="e.g. John Doe" value={newName} onChange={(e) => setNewName(e.target.value)} className="w-full p-3.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all bg-slate-50 focus:bg-white" required />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">Date of Birth <span className="text-red-500">*</span></label>
              <input type="date" value={newDob} onChange={(e) => setNewDob(e.target.value)} className="w-full p-3.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all bg-slate-50 focus:bg-white" required />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">Gender <span className="text-red-500">*</span></label>
              <select value={newGender} onChange={(e) => setNewGender(e.target.value)} className="w-full p-3.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all bg-slate-50 focus:bg-white" required>
                <option value="">Select Gender</option><option value="Male">Male</option><option value="Female">Female</option>
              </select>
            </div>
            
            {/* --- UPGRADED RACE SELECTION --- */}
            <div>
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">Race (Optional)</label>
              <div className="flex gap-2">
                <select 
                  value={newRace} onChange={(e) => { setNewRace(e.target.value); if(e.target.value !== "Other") setCustomRace(""); }} 
                  className={`p-3.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all bg-slate-50 focus:bg-white ${newRace === "Other" ? "w-1/3" : "w-full"}`}
                >
                  <option value="">Select Race</option>
                  {raceOptions.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                
                {/* Conditionally show custom input if 'Other' is selected */}
                {newRace === "Other" && (
                  <input 
                    type="text" placeholder="Please specify..." value={customRace} onChange={(e) => setCustomRace(e.target.value)} 
                    className="w-2/3 p-3.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all bg-slate-50 focus:bg-white animate-in fade-in" required 
                  />
                )}
              </div>
            </div>

            <div className="md:col-span-2">
              <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-2">Clinical Notes (Optional)</label>
              <textarea placeholder="Any relevant medical history..." rows="3" value={newNotes} onChange={(e) => setNewNotes(e.target.value)} className="w-full p-3.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all bg-slate-50 focus:bg-white resize-none" />
            </div>
            <button type="submit" className="md:col-span-2 mt-2 bg-slate-800 hover:bg-slate-900 active:scale-[0.99] text-white py-4 rounded-xl font-bold shadow-sm hover:shadow transition-all">
              Register Client
            </button>
          </form>
        </div>
        
      </div>
    </main>
  );
}