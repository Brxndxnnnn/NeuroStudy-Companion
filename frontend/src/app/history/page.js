"use client";
import { useRouter } from "next/navigation";

export default function History() {
  const router = useRouter();

  // Mock data for the table
  const mockSessions = [
    { id: 1, date: "2026-06-05", time: "09:15 AM", duration: "15 min", score: "86%" },
    { id: 2, date: "2026-06-04", time: "02:30 PM", duration: "15 min", score: "74%" },
    { id: 3, date: "2026-06-03", time: "10:00 AM", duration: "10 min", score: "92%" },
    { id: 4, date: "2026-06-02", time: "08:45 PM", duration: "15 min", score: "81%" },
  ];

  return (
    <main className="min-h-screen bg-slate-50 p-8 font-sans text-slate-800">
      {/* Top Navigation */}
      <div className="w-full max-w-6xl mx-auto flex justify-between items-center mb-8 border-b border-slate-200 pb-4">
        <div className="flex items-center gap-3">
          <div className="bg-teal-400 w-8 h-8 rounded-lg flex items-center justify-center text-white font-bold">🧠</div>
          <div>
            <span className="font-bold text-lg block leading-none">NeuroStudy Companion</span>
            <span className="text-xs text-slate-500">Track your focus, improve your study habits</span>
          </div>
        </div>
        <div className="flex gap-6 text-sm font-medium">
          <button onClick={() => router.push("/session")} className="text-slate-500 hover:text-blue-500">~ Session</button>
          <button className="text-blue-500 border-b-2 border-blue-500 pb-1">↺ History</button>
          <button onClick={() => router.push("/insights")} className="text-slate-500 hover:text-blue-500">💡 Insights</button>
          <button onClick={() => router.push("/login")} className="text-slate-400 hover:text-slate-600">Logout</button>
        </div>
      </div>

      <div className="w-full max-w-6xl mx-auto">
        <h1 className="text-3xl font-bold mb-1">Session History</h1>
        <p className="text-slate-500 mb-8">Track your focus performance over time</p>
        
        {/* Trend Chart Placeholder */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6 mb-6">
          <div className="flex justify-between items-start mb-6">
            <div>
              <h2 className="font-bold text-lg">15-Day Focus Trend</h2>
              <p className="text-sm text-slate-500">Average focus score across recent sessions</p>
            </div>
            <span className="bg-green-50 text-green-600 text-xs font-bold px-3 py-1 rounded-full border border-green-100">
              ↗ +8% this week
            </span>
          </div>
          <div className="w-full h-48 bg-slate-50 rounded border border-dashed border-slate-200 flex items-center justify-center">
            <span className="text-slate-400 font-medium">[ Recharts Line Graph Will Render Here ]</span>
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-4 gap-6 mb-6">
          <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-100">
            <p className="text-sm text-slate-500 mb-1">Total Sessions</p>
            <p className="text-3xl font-bold">47</p>
          </div>
          <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-100">
            <p className="text-sm text-slate-500 mb-1">Avg Focus Score</p>
            <p className="text-3xl font-bold text-blue-500">82%</p>
          </div>
          <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-100">
            <p className="text-sm text-slate-500 mb-1">Total Study Time</p>
            <p className="text-3xl font-bold">11.75h</p>
          </div>
          <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-100">
            <p className="text-sm text-slate-500 mb-1">Best Session</p>
            <p className="text-3xl font-bold text-green-500">94%</p>
          </div>
        </div>

        {/* Session Log Table */}
        <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
          <h2 className="font-bold text-lg p-6 border-b border-slate-50">All Sessions</h2>
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100 text-xs text-slate-500 uppercase tracking-wider">
                <th className="p-4 font-semibold">📅 Date</th>
                <th className="p-4 font-semibold">🕒 Time</th>
                <th className="p-4 font-semibold">Duration</th>
                <th className="p-4 font-semibold">Focus Score</th>
              </tr>
            </thead>
            <tbody>
              {mockSessions.map((session) => (
                <tr key={session.id} className="border-b border-slate-50 hover:bg-slate-50 transition-colors text-sm">
                  <td className="p-4 font-medium">{session.date}</td>
                  <td className="p-4 text-slate-600">{session.time}</td>
                  <td className="p-4 text-slate-600">{session.duration}</td>
                  <td className="p-4">
                    <span className="text-green-600 font-medium bg-green-50 px-2 py-1 rounded">
                      {session.score}
                    </span>
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