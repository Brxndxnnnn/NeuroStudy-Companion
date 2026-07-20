"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import TopNav from "@/components/TopNav";
import {
  createUser,
  deleteUser,
  getUsers,
  updateUser,
  getClinicsDatabaseAccessOverview,
  revokeClinicDatabaseAccess,
  grantClinicDatabaseAccess,
  getClinics
} from "@/utils/api";
import {
  PageContainer,
  PageHeading,
  Card,
  Button,
  Field,
  Input,
  StatCard,
  Pill,
  Alert,
  Spinner,
  Select
} from "@/components/ui";

export default function AdminDashboard() {
  const router = useRouter();

  const [activeTab, setActiveTab] = useState("overview");
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [databaseAccess, setDatabaseAccess] = useState([]);
  const [databaseAccessLoading, setDatabaseAccessLoading] = useState(false);
  const [pendingDatabaseAction, setPendingDatabaseAction] = useState(null);
  const [issuedDatabaseAccess, setIssuedDatabaseAccess] = useState(null);
  const [clinicOptions, setClinicOptions] = useState([])
  const [clinicOptionsLoading, setClinicOptionsLoading] = useState(false)

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState("create");
  const [selectedUserId, setSelectedUserId] = useState(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [clinicId, setClinicId] = useState("");
  const [roleId, setRoleId] = useState("");

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

  const fetchClinicOptions = async () => {
    setClinicOptionsLoading(true)
    try {
      const response = await getClinics()
      if (response.ok) {
        const data = await response.json()
        setClinicOptions(Array.isArray(data) ? data : data.data || data.clinics || [])
      } else if (response.status === 401 || response.status === 403) {
        router.push("/login")
      } else {
        setErrorMessage("Failed to retrieve clinics.")
      }
    } catch {
      setErrorMessage("Network error: could not retrieve clinics.")
    } finally {
      setClinicOptionsLoading(false)
    }
  }

  const fetchDatabaseAccess = async () => {
    setDatabaseAccessLoading(true);
    setErrorMessage("");
    try {
      const response = await getClinicsDatabaseAccessOverview();
      if (response.ok) {
        const data = await response.json();
        let usableClinics = Array.isArray(data) ? data : data.data
        setDatabaseAccess(usableClinics.filter(c => c.name !== '⟨Unclaimed⟩ — bridge placeholder clinic'));
      } else if (response.status === 401 || response.status === 403) {
        router.push("/login");
      } else {
        setErrorMessage("Failed to retrieve clinic database access.");
      }
    } catch (error) {
      setErrorMessage("Network error: could not retrieve clinic database access.");
    } finally {
      setDatabaseAccessLoading(false);
    }
  };

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      router.push("/login");
    } else {
      fetchUsers();
      fetchClinicOptions()
    }
  }, [router]);

  useEffect(() => {
    if (activeTab === "database") fetchDatabaseAccess();
  }, [activeTab]);

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
        const payload = { email: email.trim(), password };
        if (displayName.trim()) payload.display_name = displayName.trim();
        if (clinicId.trim()) payload.clinic_id = clinicId.trim();
        if (roleId.trim()) payload.role_id = roleId.trim();

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

  const handleDeleteUser = async (userId, name) => {
    if (!confirm(`Revoke account access for ${name}?`)) return;
    setErrorMessage("");
    setSuccessMessage("");
    try {
      const response = await deleteUser(userId);
      if (response.ok) {
        setSuccessMessage("Account access revoked.");
        fetchUsers();
      } else {
        setErrorMessage("The server rejected the deactivation request.");
      }
    } catch (error) {
      setErrorMessage("Network error while revoking access.");
    }
  };

  const confirmDatabaseAction = async () => {
    if (!pendingDatabaseAction) return;

    const action = pendingDatabaseAction;
    setErrorMessage("");
    setSuccessMessage("");

    try {
      const response = action.type === "grant"
        ? await grantClinicDatabaseAccess(action.clinicId)
        : await revokeClinicDatabaseAccess(action.activationId);
      const result = await response.json();

      if (!response.ok) {
        setErrorMessage(result.message || result.error?.message || "The server rejected the database access request.");
        return;
      }

      if (action.type === "grant") {
        setIssuedDatabaseAccess(result.data);
        setSuccessMessage("Database role and activation code granted.");
      } else {
        setSuccessMessage("Activation code revoked.");
      }
      setPendingDatabaseAction(null);
      fetchDatabaseAccess();
    } catch (error) {
      setErrorMessage("Network error while updating database access.");
    }
  };

  const TabButton = ({ id, children }) => (
    <button
      onClick={() => setActiveTab(id)}
      className={`pb-3 -mb-px text-sm font-semibold transition-colors border-b-2 ${activeTab === id ? "border-accent text-accent" : "border-transparent text-muted hover:text-ink"
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
          <TabButton id="database">Manage Database Access</TabButton>
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
                <UserTable users={users} readOnly clinicOptions={clinicOptions} />
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
                <UserTable users={users} onEdit={openEditModal} onDelete={handleDeleteUser} clinicOptions={clinicOptions} />
              )}
            </Card>
          </div>
        )}

        {/* DATABASE ACCESS */}
        {activeTab === "database" && (
          <div className="anim-fade space-y-5">
            <Card className="overflow-hidden">
              <div className="px-6 py-5 border-b border-border">
                <h2 className="text-[15px] font-bold tracking-tight text-ink">Clinic database access</h2>
                <p className="text-[12.5px] text-muted mt-0.5">
                  Grant a database role and one-time activation code for each clinic installation.
                </p>
              </div>
              {databaseAccessLoading ? (
                <div className="p-12 text-center text-muted">
                  <Spinner size={18} className="mr-2 align-[-3px] text-accent" /> Syncing database access...
                </div>
              ) : databaseAccess.length === 0 ? (
                <div className="p-12 text-center text-muted">No clinics found.</div>
              ) : (
                <DatabaseAccessTable
                  clinics={databaseAccess}
                  onGrant={(clinic) => setPendingDatabaseAction({ type: "grant", clinicId: clinic.clinic_id, clinicName: clinic.name })}
                  onRevoke={(activationCode, clinicName) => setPendingDatabaseAction({
                    type: "revoke",
                    activationId: activationCode.activation_id,
                    clinicName,
                    activationCode,
                  })}
                />
              )}
            </Card>

            {issuedDatabaseAccess && (
              <Card className="p-6 bg-good-soft">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-bold text-ink">New activation code</h2>
                    <p className="mt-1 text-sm text-ink-2">Record this code now; it is not shown again after this page is refreshed.</p>
                  </div>
                  <button onClick={() => setIssuedDatabaseAccess(null)} className="text-muted hover:text-ink text-2xl leading-none" aria-label="Dismiss activation code">&times;</button>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div><p className="text-xs text-muted">Database role</p><p className="font-mono text-sm text-ink break-all">{issuedDatabaseAccess.database_role}</p></div>
                  <div><p className="text-xs text-muted">Activation code</p><p className="font-mono text-sm font-bold text-ink break-all">{issuedDatabaseAccess.activation_code}</p></div>
                  <div><p className="text-xs text-muted">Expires</p><p className="text-sm text-ink">{formatDateTime(issuedDatabaseAccess.expires_at)}</p></div>
                </div>
              </Card>
            )}
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
                  <Field label="Role ID (UUID)" htmlFor="u-role">
                    <Input id="u-role" type="text" className="font-mono text-xs" placeholder="Optional — valid role UUID" value={roleId} onChange={(e) => setRoleId(e.target.value)} />
                  </Field>
                </>
              )}

              <Field label="Clinic" htmlFor="u-clinic" hint="Leave empty for admin/global accounts.">
                <Select
                  id="u-clinic"
                  value={clinicId}
                  onChange={e => setClinicId(e.target.value)}
                  disabled={clinicOptionsLoading}
                  className="w-full rounded-lg border border-border px-3 py-2 text-sm text-ink outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <option value="">
                    {clinicOptionsLoading ? "Loading clinics..." : "No clinic / global account"}
                  </option>

                  {clinicOptions.map(clinic => (
                    <option key={clinic.clinic_id} value={clinic.clinic_id}>
                      {clinic.name} ({clinic.clinic_id.slice(0, 8)})
                    </option>
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

      {pendingDatabaseAction && (
        <ConfirmationModal
          title={pendingDatabaseAction.type === "grant" ? "Grant database access?" : "Revoke activation code?"}
          description={pendingDatabaseAction.type === "grant"
            ? `This will create a database role and one-time activation code for ${pendingDatabaseAction.clinicName}.`
            : `This will permanently revoke the available activation code for ${pendingDatabaseAction.clinicName}.`}
          confirmLabel={pendingDatabaseAction.type === "grant" ? "Grant access" : "Revoke code"}
          tone={pendingDatabaseAction.type === "grant" ? "primary" : "danger"}
          onCancel={() => setPendingDatabaseAction(null)}
          onConfirm={confirmDatabaseAction}
        />
      )}
    </main>
  );
}

function UserTable({ users, onEdit, onDelete, readOnly = false, clinicOptions = [] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left min-w-[560px]">
        <thead>
          <tr className="border-b border-border">
            <th className="px-6 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-muted font-semibold">User</th>
            <th className="px-6 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-muted font-semibold">Email</th>
            <th className="px-6 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-muted font-semibold">Clinic</th>
            <th className="px-6 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-muted font-semibold">Role</th>
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
              {user.clinic_id && user.role === 'technician' ? (
                <>
                  <td className="px-6 py-4">
                    <span className="font-mono text-[11px] text-accent-strong bg-accent-soft px-2 py-1 rounded">{clinicOptions.find(c => c.clinic_id === user.clinic_id)?.name || user.clinic_id.slice(0, 12)}</span>
                  </td>
                  <td className="px-6 py-4">
                    <span className="font-mono text-[11px] text-accent-strong bg-accent-soft px-2 py-1 rounded">{user.role}</span>
                  </td>
                </>
              ) : (
                <>
                  <td className="px-6 py-4">
                    <Pill tone="neutral">Global admin</Pill>
                  </td>
                  <td className="px-6 py-4">
                    <Pill tone="neutral">Global admin</Pill>
                  </td>
                </>
              )}
              {!readOnly && ['technician'].includes(user.role) && (
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

function DatabaseAccessTable({ clinics, onGrant, onRevoke }) {
  return (
    <div className="divide-y divide-border">
      {clinics.map((clinic) => (
        <section key={clinic.clinic_id} className="p-6 space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="font-bold text-ink">{clinic.name}</h3>
              <p className="font-mono text-[11px] text-muted mt-0.5">{clinic.clinic_id}</p>
            </div>
            <Button size="sm" onClick={() => onGrant(clinic)}>Grant database access</Button>
          </div>

          {clinic.database_roles?.length ? (
            <div className="overflow-x-auto border border-border rounded-lg">
              <table className="w-full min-w-[720px] text-left">
                <thead>
                  <tr className="bg-inset/40 border-b border-border">
                    <th className="px-4 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-muted">Database role</th>
                    <th className="px-4 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-muted">Connection limit</th>
                    <th className="px-4 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-muted">Activation codes</th>
                    <th className="px-4 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-muted text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {clinic.database_roles.map((role) => (
                    role.activation_codes?.length ? role.activation_codes.map((activationCode, index) => (
                      <tr key={activationCode.activation_id} className="border-b border-border last:border-0">
                        <td className="px-4 py-3 font-mono text-xs text-ink">{index === 0 ? role.database_role : ""}</td>
                        <td className="px-4 py-3 text-sm text-ink-2">{index === 0 ? role.connection_limit : ""}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <Pill tone={activationTone(activationCode.status)}>{activationCode.status}</Pill>
                            <span className="text-xs text-muted">Expires {formatDateTime(activationCode.expires_at)}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right">
                          {activationCode.status === "available" && (
                            <Button variant="danger" size="sm" onClick={() => onRevoke(activationCode, clinic.name)}>Revoke code</Button>
                          )}
                        </td>
                      </tr>
                    )) : (
                      <tr key={role.database_role} className="border-b border-border last:border-0">
                        <td className="px-4 py-3 font-mono text-xs text-ink">{role.database_role}</td>
                        <td className="px-4 py-3 text-sm text-ink-2">{role.connection_limit}</td>
                        <td className="px-4 py-3 text-sm text-muted">No activation codes</td>
                        <td className="px-4 py-3" />
                      </tr>
                    )
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted">No database roles have been granted for this clinic.</p>
          )}
        </section>
      ))}
    </div>
  );
}

function ConfirmationModal({ title, description, confirmLabel, tone, onCancel, onConfirm }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/40 backdrop-blur-sm anim-fade" role="dialog" aria-modal="true" aria-labelledby="database-confirmation-title">
      <Card className="w-full max-w-md overflow-hidden anim-pop">
        <div className="px-6 py-5 border-b border-border">
          <h2 id="database-confirmation-title" className="text-lg font-bold tracking-tight text-ink">{title}</h2>
        </div>
        <div className="p-6">
          <p className="text-sm text-ink-2">{description}</p>
          <div className="flex justify-end gap-3 mt-6">
            <Button variant="ghost" onClick={onCancel}>Cancel</Button>
            <Button variant={tone === "danger" ? "danger" : "primary"} onClick={onConfirm}>{confirmLabel}</Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function activationTone(status) {
  if (status === "available") return "good";
  if (status === "used" || status === "expired") return "warn";
  return "crit";
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
