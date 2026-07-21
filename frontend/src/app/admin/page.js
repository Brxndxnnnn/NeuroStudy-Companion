"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import TopNav from "@/components/TopNav";
import { createUser, deleteUser, getUsers, updateUser, getClinics, getRoles } from "@/utils/api";
import {
  PageContainer,
  PageHeading,
  Card,
  Button,
  Field,
  Input,
  Select,
  Label,
  StatCard,
  Pill,
  Alert,
  Spinner,
} from "@/components/ui";

export default function AdminDashboard() {
  const router = useRouter();

  const [activeTab, setActiveTab] = useState("overview");
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  const [clinics, setClinics] = useState([]);
  const [roles, setRoles] = useState([]);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState("create");
  const [selectedUserId, setSelectedUserId] = useState(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [clinicId, setClinicId] = useState("");
  const [roleId, setRoleId] = useState("");

  const [deleteTarget, setDeleteTarget] = useState(null); // { id, name } | null

  const fetchUsers = async () => {
    setLoading(true);
    setErrorMessage("");
    try {
      const response = await getUsers();
      if (response.ok) {
        const data = await response.json();
        setUsers(Array.isArray(data) ? data : data.users || []);
      } else if (response.status === 401 || response.status === 403) {
        router.push("/login");
      } else {
        setErrorMessage("Failed to retrieve the user directory.");
      }
    } catch (error) {
      setErrorMessage("Network error: could not reach the cloud database server.");
    } finally {
      setLoading(false);
    }
  };
  

  const fetchClinics = async () => {
    try {
      const response = await getClinics();
      if (response.ok) {
        const data = await response.json();
        setClinics(Array.isArray(data) ? data : data.clinics || data.data || []);
      }
    } catch (error) {
      // Non-fatal: the clinic picker just falls back to an empty list.
    }
  };

  const fetchRoles = async () => {
    try {
      const response = await getRoles();
      if (response.ok) {
        const data = await response.json();
        setRoles(Array.isArray(data) ? data : data.roles || data.data || []);
      }
    } catch (error) {
      // Non-fatal: the role picker just falls back to an empty list.
    }
  };

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.push("/login");
    } else {
      fetchUsers();
      fetchClinics();
      fetchRoles();
    }
  }, [router]);

  const openCreateModal = () => {
    setModalMode("create");
    setSelectedUserId(null);
    setEmail(""); setPassword(""); setDisplayName(""); setClinicId(""); setRoleId("");
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
        if (!roleId) {
          setErrorMessage("Choose a role for this account.");
          return;
        }
        const chosenRole = roles.find((r) => r.role_id === roleId);
        if (chosenRole?.requires_clinic && !clinicId) {
          setErrorMessage(`The ${chosenRole.name} role requires a clinic — pick one above.`);
          return;
        }

        const payload = { email: email.trim(), password, role_id: roleId };
        if (displayName.trim()) payload.display_name = displayName.trim();
        if (clinicId.trim()) payload.clinic_id = clinicId.trim();

        const response = await createUser(payload);
        if (response.ok) {
          setSuccessMessage("User account provisioned successfully.");
          setIsModalOpen(false);
          fetchUsers();
        } else {
          const errData = await response.json();
          setErrorMessage(errData.message || "Failed to create user account.");
        }
      } else {
        const payload = {};
        if (displayName.trim()) payload.display_name = displayName.trim();
        if (clinicId.trim()) payload.clinic_id = clinicId.trim();

        const response = await updateUser(selectedUserId, payload);
        if (response.ok) {
          setSuccessMessage("User details updated successfully.");
          setIsModalOpen(false);
          fetchUsers();
        } else {
          const errData = await response.json();
          setErrorMessage(errData.message || "Failed to update account data.");
        }
      }
    } catch (error) {
      setErrorMessage("Server error while saving the user.");
    }
  };

  const handleDeleteUser = async () => {
    if (!deleteTarget) return;
    setErrorMessage("");
    setSuccessMessage("");
    try {
      const response = await deleteUser(deleteTarget.id);
      if (response.ok) {
        setSuccessMessage("Account access revoked.");
        fetchUsers();
      } else {
        setErrorMessage("The server rejected the deactivation request.");
      }
    } catch (error) {
      setErrorMessage("Network error while revoking access.");
    } finally {
      setDeleteTarget(null);
    }
  };

  const TabButton = ({ id, children }) => (
    <button
      onClick={() => setActiveTab(id)}
      className={`pb-3 -mb-px text-sm font-semibold transition-colors border-b-2 ${
        activeTab === id ? "border-accent text-accent" : "border-transparent text-muted hover:text-ink"
      }`}
    >
      {children}
    </button>
  );

  return (
    <main className="min-h-screen bg-ground">
      <TopNav />

      <PageContainer width="full" className="py-8 space-y-7">
        <PageHeading
          title="Admin portal"
          subtitle="System oversight, user provisioning, and access control."
          actions={
            activeTab === "manage" ? (
              <Button onClick={openCreateModal}>+ Provision user</Button>
            ) : null
          }
        />

        {successMessage && <Alert tone="good">{successMessage}</Alert>}
        {errorMessage && <Alert tone="crit">{errorMessage}</Alert>}

        <div className="flex gap-7 border-b border-border">
          <TabButton id="overview">Overview</TabButton>
          <TabButton id="manage">Manage users &amp; access</TabButton>
        </div>

        {/* OVERVIEW */}
        {activeTab === "overview" && (
          <div className="anim-fade space-y-6">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              <StatCard label="Registered users" value={loading ? "—" : users.length} />
              <StatCard label="Database" value="Cloud" hint="live instance" />
              <StatCard
                label="Global admins"
                value={loading ? "—" : users.filter((u) => !u.clinic_id).length}
                className="hidden sm:block"
              />
            </div>

            <Card className="overflow-hidden">
              <div className="px-6 py-5 border-b border-border">
                <h2 className="text-[15px] font-bold tracking-tight text-ink">User directory</h2>
                <p className="text-[12.5px] text-muted mt-0.5">Read-only view of active accounts.</p>
              </div>
              {loading ? (
                <div className="p-12 text-center text-muted">
                  <Spinner size={18} className="mr-2 align-[-3px] text-accent" /> Syncing directory…
                </div>
              ) : (
                <UserTable users={users} readOnly />
              )}
            </Card>
          </div>
        )}

        {/* MANAGE */}
        {activeTab === "manage" && (
          <div className="anim-fade">
            <Card className="overflow-hidden">
              {loading ? (
                <div className="p-12 text-center text-muted">
                  <Spinner size={18} className="mr-2 align-[-3px] text-accent" /> Syncing directory…
                </div>
              ) : users.length === 0 ? (
                <div className="p-12 text-center text-muted">No active system accounts found.</div>
              ) : (
                <UserTable users={users} onEdit={openEditModal} onDelete={(id, name) => setDeleteTarget({ id, name })} />
              )}
            </Card>
          </div>
        )}
      </PageContainer>

      {/* MODAL */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/40 backdrop-blur-sm anim-fade">
          <Card className="w-full max-w-md overflow-hidden anim-pop">
            <div className="flex justify-between items-center px-6 py-5 border-b border-border">
              <h2 className="text-lg font-bold tracking-tight text-ink">
                {modalMode === "create" ? "Provision new account" : "Edit user profile"}
              </h2>
              <button onClick={() => setIsModalOpen(false)} className="text-muted hover:text-ink text-2xl leading-none" aria-label="Close">
                &times;
              </button>
            </div>

            <form onSubmit={handleFormSubmit} className="p-6 space-y-4">
              <Field label="Display name" htmlFor="u-name">
                <Input id="u-name" type="text" placeholder="e.g. Dr. Jane Smith" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              </Field>

              {modalMode === "create" && (
                <>
                  <Field label="Login email" htmlFor="u-email">
                    <Input id="u-email" type="email" required placeholder="user@neurostudy.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                  </Field>
                  <Field label="Password" htmlFor="u-pw" hint="Minimum 8 characters.">
                    <Input id="u-pw" type="password" required minLength="8" placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} />
                  </Field>
                  <Field label="Role" required htmlFor="u-role">
                    <Select id="u-role" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
                      <option value="">Select a role…</option>
                      {roles.map((r) => (
                        <option key={r.role_id} value={r.role_id}>
                          {r.name}{r.requires_clinic ? " (requires a clinic)" : ""}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </>
              )}

              <Field
                label="Clinic"
                htmlFor="u-clinic"
                hint={
                  roles.find((r) => r.role_id === roleId)?.requires_clinic
                    ? "This role requires a clinic."
                    : "Leave unset for admin/global accounts."
                }
              >
                <Select id="u-clinic" value={clinicId} onChange={(e) => setClinicId(e.target.value)}>
                  <option value="">No clinic (admin/global)</option>
                  {clinics.map((c) => (
                    <option key={c.clinic_id} value={c.clinic_id}>{c.name || c.clinic_id}</option>
                  ))}
                </Select>
              </Field>

              <div className="flex justify-end gap-3 pt-4 border-t border-border">
                <Button type="button" variant="ghost" onClick={() => setIsModalOpen(false)}>Cancel</Button>
                <Button type="submit">{modalMode === "create" ? "Create account" : "Save changes"}</Button>
              </div>
            </form>
          </Card>
        </div>
      )}

      {/* DELETE CONFIRMATION */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/40 backdrop-blur-sm anim-fade">
          <Card className="w-full max-w-sm overflow-hidden anim-pop">
            <div className="px-6 py-5 border-b border-border">
              <h2 className="text-lg font-bold tracking-tight text-ink">Revoke account access?</h2>
            </div>
            <div className="px-6 py-5">
              <p className="text-sm text-ink-2">
                This revokes access for <span className="font-semibold text-ink">{deleteTarget.name}</span>.
                This action cannot be undone from here.
              </p>
            </div>
            <div className="flex justify-end gap-3 px-6 py-4 border-t border-border">
              <Button variant="ghost" onClick={() => setDeleteTarget(null)}>Cancel</Button>
              <Button variant="danger" onClick={handleDeleteUser}>Revoke access</Button>
            </div>
          </Card>
        </div>
      )}
    </main>
  );
}

function UserTable({ users, onEdit, onDelete, readOnly = false }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left min-w-[560px]">
        <thead>
          <tr className="border-b border-border">
            <th className="px-6 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-muted font-semibold">User</th>
            <th className="px-6 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-muted font-semibold">Email</th>
            <th className="px-6 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-muted font-semibold">Clinic</th>
            {!readOnly && <th className="px-6 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-muted font-semibold text-right">Actions</th>}
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.user_id} className="border-b border-border last:border-0 hover:bg-inset/50 transition-colors">
              <td className="px-6 py-4">
                <div className="font-semibold text-ink">{user.display_name || "Unassigned"}</div>
                {!readOnly && <div className="font-mono text-[11px] text-muted mt-0.5">{user.user_id}</div>}
              </td>
              <td className="px-6 py-4 text-sm text-ink-2">{user.email}</td>
              <td className="px-6 py-4">
                {user.clinic_id ? (
                  <span className="font-mono text-[11px] text-accent-strong bg-accent-soft px-2 py-1 rounded">{user.clinic_id.slice(0, 12)}</span>
                ) : (
                  <Pill tone="neutral">Global admin</Pill>
                )}
              </td>
              {!readOnly && ['technician'].includes(user.role) &&  (
                <td className="px-6 py-4 text-right">
                  <div className="flex justify-end gap-2">
                    <Button variant="subtle" size="sm" onClick={() => onEdit(user)}>Edit</Button>
                    <Button variant="danger" size="sm" onClick={() => onDelete(user.user_id, user.display_name || user.email)}>Revoke</Button>
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
