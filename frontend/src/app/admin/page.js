"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AdminDashboard() {
  const router = useRouter();

  //Route Guard: Check if the admin is logged in when the page loads
  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.push("/login"); //Redirect to login if no token is found
    }
  }, [router]);

  // Mock data for the table
  const mockUsers = [
    { id: "U-101", name: "Eugene K.", sessions: 14, avgFocus: "82%" },
    { id: "U-102", name: "Zhengda T.", sessions: 8, avgFocus: "76%" },
    { id: "U-103", name: "Brandon C.", sessions: 22, avgFocus: "88%" }
  ];

  return (
    <main className="min-h-screen bg-slate-50 p-8 font-sans">
      <div className="w-full max-w-6xl mx-auto flex justify-between items-center mb-8">
        <div className="flex items-center gap-3">
          <div className="bg-slate-800 w-8 h-8 rounded-lg flex items-center justify-center text-white font-bold">🛡️</div>
          <span className="font-bold text-slate-800 text-lg">Admin Portal</span>
        </div>
        <button 
          onClick={() => {
            localStorage.removeItem("token"); // Clear the token on logout
            router.push("/login");
          }} 
          className="text-slate-500 hover:text-slate-800 text-sm"
        >
          Logout
        </button>
      </div>

      <div className="w-full max-w-6xl mx-auto">
        <h1 className="text-2xl font-bold text-slate-800 mb-6">User Management</h1>
        
        <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100 text-sm text-slate-500">
                <th className="p-4 font-semibold">User ID</th>
                <th className="p-4 font-semibold">Name</th>
                <th className="p-4 font-semibold">Total Sessions</th>
                <th className="p-4 font-semibold">Avg Focus Score</th>
                <th className="p-4 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {mockUsers.map((user) => (
                <tr key={user.id} className="border-b border-slate-50 hover:bg-slate-50 transition-colors">
                  <td className="p-4 text-slate-600 font-mono text-sm">{user.id}</td>
                  <td className="p-4 text-slate-800 font-medium">{user.name}</td>
                  <td className="p-4 text-slate-600">{user.sessions}</td>
                  <td className="p-4">
                    <span className="bg-green-100 text-green-700 py-1 px-3 rounded-full text-sm font-medium">
                      {user.avgFocus}
                    </span>
                  </td>
                  <td className="p-4 text-right">
                    <button className="text-blue-500 hover:text-blue-700 text-sm font-medium">View Logs</button>
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