import "./index.css";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes } from "react-router";
import { useFilterSearch } from "./analytics";
import { getViewAs, setViewAs } from "./api";
import { AuthProvider, useAuth } from "./auth";
import { AccountForm, AccountList } from "./pages/Accounts";
import Alerts, { useOpenAlerts } from "./pages/Alerts";
import Audience from "./pages/Audience";
import Contributors from "./pages/Contributors";
import Conversation from "./pages/Conversation";
import Dashboard from "./pages/Dashboard";
import Login from "./pages/Login";
import Mfa from "./pages/Mfa";
import Report from "./pages/Report";
import Settings from "./pages/Settings";
import TopicForm from "./pages/TopicForm";
import { TopicList, TopicPage } from "./pages/Topics";
import Users, { AcceptInvite } from "./pages/Users";

const ROLE_NAME: Record<string, string> = { owner: "Admin kantor", admin: "Admin kantor", analyst: "Analis", viewer: "Pembaca" };
const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 15_000, refetchOnWindowFocus: false } } });

/** Pengaturan sumber data/AI (status provider, saldo, key) hanya untuk owner platform — bukan klien (admin/user kantor),
 *  juga tidak saat owner sedang "masuk ke kantor" klien. */
function OwnerOnly({ children }: { children: React.ReactNode }) {
  const { me } = useAuth();
  if (!me?.user.is_platform_operator || getViewAs()) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function AlertsLink({ className }: { className: (s: { isActive: boolean }) => string }) {
  const open = useOpenAlerts(true).data?.open ?? 0;
  return (
    <NavLink to="/alerts" className={className}>
      Alert
      {open > 0 && <span className="ml-1 rounded-full bg-red-600 px-1.5 text-xs text-white">{open}</span>}
    </NavLink>
  );
}

function Shell() {
  const { me, loading, logout } = useAuth();
  const client = useQueryClient();
  const search = useFilterSearch();
  if (loading) return <div className="p-8 text-sm text-zinc-500">Memuat…</div>;
  if (!me) return <Navigate to="/login" replace />;
  if (me.mfa === "setup_required") return <Navigate to="/mfa" replace />;
  const op = me.user.is_platform_operator;
  const view = getViewAs();
  const isAdmin = ["owner", "admin"].includes(me.current_tenant.role) || op;
  const tenantName = me.tenants.find((t) => t.id === me.current_tenant.id)?.name;
  const inOffice = !op || !!view;
  const link = ({ isActive }: { isActive: boolean }) =>
    `rounded-lg px-3 py-1.5 text-sm font-medium ${isActive ? "bg-brand-600 text-white" : "text-zinc-600 hover:bg-zinc-100"}`;
  return (
    <div className="min-h-screen">
      {view && (
        <div className="bg-amber-100 px-4 py-1.5 text-center text-sm text-amber-900 print:hidden">
          Anda (owner) sedang berada di kantor <b>{view.tenantName}</b> — setiap akses tercatat di audit.{" "}
          <button
            type="button"
            className="font-semibold underline"
            onClick={() => {
              setViewAs(null);
              client.clear();
              location.assign("/users");
            }}
          >
            Keluar dari kantor
          </button>
        </div>
      )}
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/90 backdrop-blur print:hidden">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-2 px-4 py-2">
          <span className="mr-4 text-lg font-bold text-brand-600">SMIP</span>
          {/* filter analitik (topik/rentang/platform) ikut terbawa antar halaman analitik */}
          <NavLink to={`/${search}`} end className={link}>
            Dashboard
          </NavLink>
          <NavLink to={`/conversation${search}`} className={link}>
            Percakapan
          </NavLink>
          <NavLink to={`/contributors${search}`} className={link}>
            Kontributor
          </NavLink>
          <NavLink to={`/audience${search}`} className={link}>
            Audiens
          </NavLink>
          <NavLink to={`/report${search}`} className={link}>
            Laporan
          </NavLink>
          <span className="mx-1 hidden h-5 w-px bg-zinc-200 md:inline-block" />
          <NavLink to="/topics" className={link}>
            Topik
          </NavLink>
          <NavLink to="/accounts" className={link}>
            Akun
          </NavLink>
          {inOffice && <AlertsLink className={link} />}
          {isAdmin && (
            <NavLink to="/users" className={link}>
              {op && !view ? "Kantor & pengguna" : "Pengguna"}
            </NavLink>
          )}
          {op && !view && (
            <NavLink to="/settings" className={link}>
              Pengaturan
            </NavLink>
          )}
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-right leading-tight text-zinc-500">
              {me.user.name}
              <br />
              <span className="text-xs">
                {view ? view.tenantName : op ? "Platform" : tenantName} ·{" "}
                {op ? "Owner" : (ROLE_NAME[me.current_tenant.role] ?? me.current_tenant.role)}
              </span>
            </span>
            <button
              type="button"
              onClick={() => {
                setViewAs(null);
                void logout();
              }}
              className="text-brand-600 hover:underline"
            >
              Keluar
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl p-4 print:max-w-none print:p-0">
        <Outlet />
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/mfa" element={<Mfa />} />
            <Route path="/invite" element={<AcceptInvite />} />
            <Route element={<Shell />}>
              <Route index element={<Dashboard />} />
              <Route path="/conversation" element={<Conversation />} />
              <Route path="/contributors" element={<Contributors />} />
              <Route path="/audience" element={<Audience />} />
              <Route path="/report" element={<Report />} />
              <Route path="/topics" element={<TopicList />} />
              <Route path="/topics/new" element={<TopicForm />} />
              <Route path="/topics/:id" element={<TopicPage />} />
              <Route path="/topics/:id/edit" element={<TopicForm />} />
              <Route path="/accounts" element={<AccountList />} />
              <Route path="/accounts/new" element={<AccountForm />} />
              <Route path="/accounts/:id/edit" element={<AccountForm />} />
              <Route path="/alerts" element={<Alerts />} />
              <Route path="/users" element={<Users />} />
              <Route
                path="/settings"
                element={
                  <OwnerOnly>
                    <Settings />
                  </OwnerOnly>
                }
              />
              {/* alamat lama */}
              <Route path="/admin/tenants" element={<Navigate to="/users" replace />} />
              <Route path="/admin/providers" element={<Navigate to="/settings" replace />} />
              <Route path="/admin/llm" element={<Navigate to="/settings?tab=ai" replace />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
