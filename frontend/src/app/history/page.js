"use client";
import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { getClients, createClient } from "@/utils/api";
import { useAuth } from "@/context/AuthContext";
import { Toaster, toast } from "react-hot-toast";
import TopNav from "@/components/TopNav";
import {
  PageContainer,
  PageHeading,
  Card,
  CardHeader,
  Button,
  Field,
  Input,
  Select,
  Textarea,
  Label,
  StatCard,
  Spinner,
} from "@/components/ui";

const RACE_OPTIONS = ["Chinese", "Malay", "Indian", "Caucasian", "Eurasian", "Other"];

export default function ClinicalDashboard() {
  const router = useRouter();
  const { user } = useAuth();
  // Captured once instead of read fresh (Date.now()) inside calculateAge, which
  // is called during render — reading the wall clock there is an impure call.
  const [now] = useState(() => Date.now());
  const [clients, setClients] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  const [searchQuery, setSearchQuery] = useState("");
  const [filterGender, setFilterGender] = useState("");
  const [filterRace, setFilterRace] = useState("");

  const [newName, setNewName] = useState("");
  const [newDob, setNewDob] = useState("");
  const [newGender, setNewGender] = useState("");
  const [newRace, setNewRace] = useState("");
  const [customRace, setCustomRace] = useState("");
  const [newNotes, setNewNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const greetName = user?.display_name?.split(" ")[0] || "";

  const greeting = () => {
    const h = new Date().getHours();
    const part = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
    return greetName ? `${part}, ${greetName}` : `${part}`;
  };

  const fetchClients = async () => {
    try {
      const res = await getClients();
      if (res.ok) {
        const data = await res.json();
        setClients(data);
      }
    } catch (err) {
      toast.error("Failed to fetch clients from database.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchClients();
  }, []);

  const handleRegisterClient = async (e) => {
    e.preventDefault();
    if (!newName || !newDob || !newGender) {
      toast.error("Name, date of birth, and gender are required.");
      return;
    }

    const finalRace = newRace === "Other" ? customRace : newRace;
    const toastId = toast.loading("Registering patient…");
    setSubmitting(true);

    try {
      const res = await createClient({
        name: newName,
        dob: newDob,
        gender: newGender,
        race: finalRace,
        notes: newNotes,
      });

      if (res.ok) {
        toast.success("Patient registered.", { id: toastId });
        setNewName(""); setNewDob(""); setNewGender(""); setNewRace(""); setCustomRace(""); setNewNotes("");
        fetchClients();
      } else {
        toast.error("Failed to register patient on server.", { id: toastId });
      }
    } catch (err) {
      toast.error("Network error while registering.", { id: toastId });
    } finally {
      setSubmitting(false);
    }
  };

  const handleSelectClient = (clientId, clientName) => {
    localStorage.setItem("currentClientId", clientId);
    localStorage.setItem("currentClientName", clientName);
    router.push("/session");
  };

  const calculateAge = (dobString) => {
    if (!dobString) return "N/A";
    const dob = new Date(dobString);
    const ageDate = new Date(now - dob.getTime());
    return Math.abs(ageDate.getUTCFullYear() - 1970);
  };

  const filteredClients = useMemo(
    () =>
      clients.filter((client) => {
        const matchesName = client.name?.toLowerCase().includes(searchQuery.toLowerCase());
        const matchesGender = filterGender ? client.gender === filterGender : true;
        const matchesRace = filterRace ? client.race === filterRace : true;
        return matchesName && matchesGender && matchesRace;
      }),
    [clients, searchQuery, filterGender, filterRace]
  );

  const hasFilters = searchQuery || filterGender || filterRace;
  const clearFilters = () => {
    setSearchQuery(""); setFilterGender(""); setFilterRace("");
  };

  return (
    <main className="min-h-screen bg-ground">
      <Toaster
        position="bottom-right"
        toastOptions={{ duration: 4000, style: { background: "#33434e", color: "#fff", fontWeight: 600, borderRadius: "12px" } }}
      />
      <TopNav />

      <PageContainer width="wide" className="py-8 space-y-7">
        <PageHeading
          title={greeting()}
          subtitle="Select a patient to begin a session, or register a new one."
        />

        <div className="grid grid-cols-2 gap-4">
          <StatCard label="Registered patients" value={isLoading ? "—" : clients.length} />
          <StatCard label="Matching filters" value={isLoading ? "—" : filteredClients.length} hint={hasFilters ? "filtered view" : "all patients"} />
        </div>

        {/* Directory */}
        <Card className="overflow-hidden">
          <CardHeader
            title="Patients"
            subtitle="Search and filter the registry, then start a session."
          />
          <div className="flex flex-col sm:flex-row gap-3 px-6 py-4 bg-inset/40 border-b border-border">
            <div className="relative w-full sm:flex-1">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <Input
                type="text"
                placeholder="Search patient name…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 py-2.5 text-sm"
              />
            </div>
            <Select value={filterGender} onChange={(e) => setFilterGender(e.target.value)} className="w-full sm:w-40 py-2.5 text-sm">
              <option value="">All genders</option>
              <option value="Male">Male</option>
              <option value="Female">Female</option>
            </Select>
            <Select value={filterRace} onChange={(e) => setFilterRace(e.target.value)} className="w-full sm:w-40 py-2.5 text-sm">
              <option value="">All races</option>
              {RACE_OPTIONS.map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </Select>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left min-w-[560px]">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-6 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-muted font-semibold">Patient</th>
                  <th className="px-6 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-muted font-semibold">Demographics</th>
                  <th className="px-6 py-3 font-mono text-[10px] uppercase tracking-[0.1em] text-muted font-semibold text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan="3" className="px-6 py-12 text-center text-muted font-medium">
                      <Spinner size={18} className="mr-2 align-[-3px]" />
                      Loading patients…
                    </td>
                  </tr>
                ) : filteredClients.length === 0 ? (
                  <tr>
                    <td colSpan="3" className="px-6 py-14 text-center">
                      <p className="text-muted font-medium mb-3">No patients match your filters.</p>
                      {hasFilters && (
                        <Button variant="subtle" size="sm" onClick={clearFilters}>Clear filters</Button>
                      )}
                    </td>
                  </tr>
                ) : (
                  filteredClients.map((client) => (
                    <tr key={client.client_id} className="border-b border-border last:border-0 hover:bg-accent-soft/30 transition-colors group">
                      <td className="px-6 py-4">
                        <div className="font-semibold text-ink">{client.name}</div>
                        <div className="font-mono text-[11px] text-muted mt-0.5">{client.client_id?.slice(0, 8) || "—"}</div>
                      </td>
                      <td className="px-6 py-4 text-sm text-ink-2">
                        <span className="font-semibold text-ink tnum">{calculateAge(client.dob)}</span> yrs
                        <span className="text-muted"> · {client.gender || "N/A"} · {client.race || "N/A"}</span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <Button size="sm" onClick={() => handleSelectClient(client.client_id, client.name)}>
                          Start session →
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Registration */}
        <Card>
          <CardHeader title="Register new client" subtitle="Add a new patient to the database." />
          <form onSubmit={handleRegisterClient} className="grid grid-cols-1 md:grid-cols-2 gap-5 p-6">
            <Field label="Full name" required htmlFor="c-name">
              <Input id="c-name" type="text" placeholder="e.g. John Doe" value={newName} onChange={(e) => setNewName(e.target.value)} required />
            </Field>
            <Field label="Date of birth" required htmlFor="c-dob">
              <Input id="c-dob" type="date" value={newDob} onChange={(e) => setNewDob(e.target.value)} required />
            </Field>
            <Field label="Gender" required htmlFor="c-gender">
              <Select id="c-gender" value={newGender} onChange={(e) => setNewGender(e.target.value)} required>
                <option value="">Select gender</option>
                <option value="Male">Male</option>
                <option value="Female">Female</option>
              </Select>
            </Field>
            <Field label="Race (optional)">
              <div className="flex gap-2">
                <Select
                  value={newRace}
                  onChange={(e) => { setNewRace(e.target.value); if (e.target.value !== "Other") setCustomRace(""); }}
                  className={newRace === "Other" ? "w-1/3" : "w-full"}
                >
                  <option value="">Select race</option>
                  {RACE_OPTIONS.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </Select>
                {newRace === "Other" && (
                  <Input
                    type="text"
                    placeholder="Please specify…"
                    value={customRace}
                    onChange={(e) => setCustomRace(e.target.value)}
                    className="w-2/3 anim-fade"
                    required
                  />
                )}
              </div>
            </Field>
            <Field label="Clinical notes (optional)" className="md:col-span-2">
              <Textarea placeholder="Any relevant medical history…" rows={3} value={newNotes} onChange={(e) => setNewNotes(e.target.value)} />
            </Field>
            <div className="md:col-span-2">
              <Button type="submit" size="lg" fullWidth loading={submitting}>
                Register client
              </Button>
            </div>
          </form>
        </Card>
      </PageContainer>
    </main>
  );
}
