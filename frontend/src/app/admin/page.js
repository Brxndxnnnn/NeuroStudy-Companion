"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AdminDashboard() {
  const router = useRouter();
  
  // Navigation State
  const [activeTab, setActiveTab] = useState("overview"); // "overview" or "manage"

  // Data State
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  // Modal and Form States
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState("create");
  const [selectedUserId, setSelectedUserId] = useState(null);

  // Form Fields
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [clinicId, setClinicId] = useState("");
  const [roleId, setRoleId] = useState("");

  const API_BASE_URL = "http://139.59.126.77/api";

  const getAuthHeaders = () => {
    const token = localStorage.getItem("token");
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    };
  };

  const fetchUsers = async () => {
    setLoading(true);
    setErrorMessage("");
    try {
      const response = await fetch(`${API_BASE_URL}/users`, {
        method: "GET",
        headers: getAuthHeaders(),
      });

      if (response.ok) {
        const data = await response.json();
        setUsers(Array.isArray(data) ? data : data.users || []);
      } else if (response.status === 401 || response.status === 403) {
        router.push("/login");
      } else {
        setErrorMessage("Failed to retrieve the user directory.");
      }
    } catch (error) {
      setErrorMessage("Network error: Could not reach the cloud database server.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.push("/login");
    } else {
      fetchUsers();
    }
  }, [router]);

  const openCreateModal = () => {
    setModalMode("create");
    setSelectedUserId(null);
    setEmail("");
    setPassword("");
    setDisplayName("");
    setClinicId("");
    setRoleId("");
    setErrorMessage("");
    setIsModalOpen(true);
  };

  const openEditModal = (user) => {
    setModalMode("edit");
    setSelectedUserId(user.user_id);
    setEmail(user.email);
    setPassword(""); 
    setDisplayName(user.display_name || "");
    setClinicId(user.clinic_id || "");
    setRoleId(""); 
    setErrorMessage("");
    setIsModalOpen(true);
  };

  const handleFormSubmit = async (e) => {
    e.preventDefault();
    setErrorMessage("");
    setSuccessMessage("");

    try {
      if (modalMode === "create") {
        // --- SAFE CREATE PAYLOAD (Prevents 400 Bad Request Errors) ---
        const payload = {
          email: email.trim(),
          password: password
        };
        
        if (displayName.trim()) payload.display_name = displayName.trim();
        if (clinicId.trim()) payload.clinic_id = clinicId.trim();
        if (roleId.trim()) payload.role_id = roleId.trim();

        const response = await fetch(`${API_BASE_URL}/users`, {
          method: "POST",
          headers: getAuthHeaders(),
          body: JSON.stringify(payload),
        });

        if (response.ok) {
          setSuccessMessage("User account provisioned successfully!");
          setIsModalOpen(false);
          fetchUsers();
        } else {
          const errData = await response.json();
          setErrorMessage(errData.message || "Failed to create user account.");
        }
      } else {
        // --- SAFE UPDATE PAYLOAD ---
        const payload = {};
        if (displayName.trim()) payload.display_name = displayName.trim();
        if (clinicId.trim()) payload.clinic_id = clinicId.trim();

        const response = await fetch(`${API_BASE_URL}/users/${selectedUserId}`, {
          method: "PATCH",
          headers: getAuthHeaders(),
          body: JSON.stringify(payload),
        });

        if (response.ok) {
          setSuccessMessage("User details adjusted successfully!");
          setIsModalOpen(false);
          fetchUsers();
        } else {
          const errData = await response.json();
          setErrorMessage(errData.message || "Failed to update account data.");
        }
      }
    } catch (error) {
      setErrorMessage("Server error while saving user metrics.");
    }
  };

  const handleDeleteUser = async (userId, name) => {
    if (!confirm(`Are you sure you want to deactivate account access for ${name}?`)) return;
    
    setErrorMessage("");
    setSuccessMessage("");
    try {
      const response = await fetch(`${API_BASE_URL}/users/${userId}`, {
        method: "DELETE",
        headers: getAuthHeaders(),
      });

      if (response.ok) {
        setSuccessMessage("Account authorization safely revoked.");
        fetchUsers();
      } else {
        setErrorMessage("Deactivation script rejected by host database.");
      }
    } catch (error) {
      setErrorMessage("Network error: Deactivation payload dropped.");
    }
  };

  return (
    <main className="min-h-screen bg-slate-50 p-8 font-sans text-slate-800">
      {/* Top Bar Header Layout */}
      <div className="w-full max-w-6xl mx-auto flex justify-between items-center mb-8 border-b border-slate-200 pb-4">
        <div className="flex items-center gap-3">
          <div className="bg-slate-800 w-8 h-8 rounded-lg flex items-center justify-center text-white font-bold">🛡️</div>
          <div>
            <span className="font-bold text-lg block leading-none">Admin Portal</span>
            <span className="text-xs text-slate-500">System oversight & provisioning</span>
          </div>
        </div>
        <button 
          onClick={() => {
            localStorage.removeItem("token");
            router.push("/login");
          }} 
          className="bg-slate-200 hover:bg-slate-300 px-4 py-2 rounded-lg font-medium text-sm transition-all text-slate-600"
        >
          Logout
        </button>
      </div>

      <div className="w-full max-w-6xl mx-auto">
        
        {/* --- TAB NAVIGATION BAR --- */}
        <div className="flex gap-8 border-b border-slate-200 mb-8">
          <button 
            onClick={() => setActiveTab("overview")}
            className={`pb-3 text-sm font-bold transition-all ${
              activeTab === "overview" 
                ? "border-b-2 border-blue-600 text-blue-600" 
                : "text-slate-500 hover:text-slate-800"
            }`}
          >
            Dashboard Preview
          </button>
          <button 
            onClick={() => setActiveTab("manage")}
            className={`pb-3 text-sm font-bold transition-all ${
              activeTab === "manage" 
                ? "border-b-2 border-blue-600 text-blue-600" 
                : "text-slate-500 hover:text-slate-800"
            }`}
          >
            Manage Users & Access
          </button>
        </div>

        {/* Global Notifications */}
        {successMessage && <div className="mb-6 p-3 bg-green-50 border border-green-200 text-green-700 rounded-lg text-sm font-medium">✅ {successMessage}</div>}
        {errorMessage && <div className="mb-6 p-3 bg-red-50 border border-red-200 text-red-700 rounded-lg text-sm font-medium">⚠️ {errorMessage}</div>}

        {/* ========================================= */}
        {/* TAB 1: OVERVIEW (READ-ONLY PREVIEW)       */}
        {/* ========================================= */}
        {activeTab === "overview" && (
          <div className="animate-in fade-in duration-300">
            {/* Quick Stats Row */}
            <div className="grid grid-cols-3 gap-6 mb-8">
              <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-100">
                <p className="text-sm text-slate-500 mb-1 font-medium">Total Registered Users</p>
                <p className="text-3xl font-bold text-slate-800">{users.length}</p>
              </div>
              <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-100">
                <p className="text-sm text-slate-500 mb-1 font-medium">Active Database</p>
                <p className="text-lg font-bold text-slate-800 mt-2">Cloud Instance</p>
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
              <div className="p-6 border-b border-slate-50">
                <h2 className="font-bold text-lg text-slate-800">User Directory Preview</h2>
                <p className="text-sm text-slate-500">Read-only view of active accounts.</p>
              </div>
              {loading ? (
                <div className="p-12 text-center text-slate-400 font-medium animate-pulse">Syncing directory...</div>
              ) : (
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-100 text-xs text-slate-500 uppercase tracking-wider">
                      <th className="p-4 font-semibold">User Identity</th>
                      <th className="p-4 font-semibold">Email</th>
                      <th className="p-4 font-semibold">Clinic UUID Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user) => (
                      <tr key={`prev-${user.user_id}`} className="border-b border-slate-50 hover:bg-slate-50 transition-colors text-sm">
                        <td className="p-4 font-semibold text-slate-800">{user.display_name || "Unassigned"}</td>
                        <td className="p-4 text-slate-600">{user.email}</td>
                        <td className="p-4 font-mono text-xs text-slate-500">
                          {user.clinic_id ? (
                            <span className="bg-blue-50 text-blue-700 px-2 py-1 rounded border border-blue-100">{user.clinic_id}</span>
                          ) : (
                            <span className="bg-slate-100 text-slate-600 px-2 py-1 rounded border border-slate-200">Global Admin</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* ========================================= */}
        {/* TAB 2: MANAGE USERS (CRUD OPERATIONS)     */}
        {/* ========================================= */}
        {activeTab === "manage" && (
          <div className="animate-in fade-in duration-300">
            <div className="flex justify-between items-center mb-6">
              <div>
                <h2 className="text-xl font-bold tracking-tight">Access Control Center</h2>
                <p className="text-sm text-slate-500">Create, modify, and revoke user credentials.</p>
              </div>
              <button 
                onClick={openCreateModal}
                className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-lg text-sm font-bold shadow-sm transition-colors flex items-center gap-2"
              >
                ➕ Provision New User
              </button>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-slate-100 overflow-hidden">
              {loading ? (
                <div className="p-12 text-center text-slate-400 font-medium animate-pulse">Syncing directory...</div>
              ) : users.length === 0 ? (
                <div className="p-12 text-center text-slate-400">No active system accounts found.</div>
              ) : (
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-100 text-xs text-slate-500 uppercase tracking-wider">
                      <th className="p-4 font-semibold">User Identity</th>
                      <th className="p-4 font-semibold">Email Anchor</th>
                      <th className="p-4 font-semibold">Clinic UUID</th>
                      <th className="p-4 font-semibold text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user) => (
                      <tr key={`crud-${user.user_id}`} className="border-b border-slate-50 hover:bg-slate-50 transition-colors text-sm">
                        <td className="p-4">
                          <div className="font-semibold text-slate-900">{user.display_name || "Unassigned"}</div>
                          <div className="text-xs font-mono text-slate-400">{user.user_id}</div>
                        </td>
                        <td className="p-4 text-slate-600 font-medium">{user.email}</td>
                        <td className="p-4 font-mono text-xs text-slate-500">{user.clinic_id || "Global"}</td>
                        <td className="p-4 text-right flex justify-end gap-3 mt-1.5">
                          <button 
                            onClick={() => openEditModal(user)}
                            className="text-blue-600 hover:text-blue-800 font-medium text-xs bg-blue-50 px-3 py-1.5 rounded transition-colors"
                          >
                            ✏️ Edit
                          </button>
                          <button 
                            onClick={() => handleDeleteUser(user.user_id, user.display_name || user.email)}
                            className="text-red-600 hover:text-red-800 font-medium text-xs bg-red-50 px-3 py-1.5 rounded transition-colors"
                          >
                            ❌ Revoke
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </div>

      {/* --- CRUD PROVISIONING DYNAMIC MODAL WINDOW --- */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white w-full max-w-md rounded-xl shadow-xl border border-slate-100 overflow-hidden animate-in zoom-in-95 duration-150">
            <div className="p-6 border-b border-slate-100 flex justify-between items-center">
              <h2 className="text-lg font-bold text-slate-900">
                {modalMode === "create" ? "Provision New Account" : "Modify User Profile"}
              </h2>
              <button onClick={() => setIsModalOpen(false)} className="text-slate-400 hover:text-slate-600 text-xl font-medium">&times;</button>
            </div>
            
            <form onSubmit={handleFormSubmit} className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">Display Name</label>
                <input 
                  type="text" 
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                  placeholder="E.g. Dr. Jane Smith"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </div>

              {modalMode === "create" && (
                <>
                  <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">System Login Email</label>
                    <input 
                      type="email" 
                      required
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                      placeholder="user@neurostudy.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">Account Password</label>
                    <input 
                      type="password" 
                      required
                      minLength="8"
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                      placeholder="Minimum 8 characters"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">Primary Role ID (UUID)</label>
                    <input 
                      type="text" 
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="Leave empty or provide valid role uuid"
                      value={roleId}
                      onChange={(e) => setRoleId(e.target.value)}
                    />
                  </div>
                </>
              )}

              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wide mb-1">Bound Clinic ID (UUID)</label>
                <input 
                  type="text" 
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Leave empty for Admin/Global accounts"
                  value={clinicId}
                  onChange={(e) => setClinicId(e.target.value)}
                />
              </div>

              <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
                <button 
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 border border-slate-200 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-50 transition-colors"
                >
                  Cancel
                </button>
                <button 
                  type="submit"
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-bold shadow-sm transition-colors"
                >
                  {modalMode === "create" ? "Create Account" : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  );
}