import "./index.css";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes } from "react-router";
import { getViewAs, setViewAs } from "./api";
import { AuthProvider, useAuth } from "./auth";
import AdminLlm from "./pages/AdminLlm";
import AdminProviders from "./pages/AdminProviders";
import Dashboard from "./pages/Dashboard";
import Login from "./pages/Login";
import Mfa from "./pages/Mfa";
import Tenants from "./pages/Tenants";
import TopicForm from "./pages/TopicForm";
import { TopicList, TopicPage } from "./pages/Topics";
import Users, { AcceptInvite } from "./pages/Users";

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 15_000, refetchOnWindowFocus: false } } });

function Shell() {
  const { me, loading, logout } = useAuth();
  const client = useQueryClient();
  if (loading) return <div className="p-8 text-sm text-zinc-500">Memuat…</div>;
  if (!me) return <Navigate to="/login" replace />;
  if (me.mfa === "setup_required") return <Navigate to="/mfa" replace />;
  const op = me.user.is_platform_operator;
  const view = getViewAs();
  const isAdmin = ["owner", "admin"].includes(me.current_tenant.role) || op;
  const tenantName = me.tenants.find((t) => t.id === me.current_tenant.id)?.name;
  const link = ({ isActive }: { isActive: boolean }) =>
    `rounded-lg px-3 py-1.5 text-sm font-medium ${isActive ? "bg-brand-600 text-white" : "text-zinc-600 hover:bg-zinc-100"}`;
  const soon = "hidden cursor-not-allowed rounded-lg px-3 py-1.5 text-sm text-zinc-400 xl:inline";
  return (
    <div className="min-h-screen">
      {view && (
        <div className="bg-amber-100 px-4 py-1.5 text-center text-sm text-amber-900">
          Anda (administrator) sedang melihat data kantor <b>{view.tenantName}</b> — setiap akses tercatat di audit.{" "}
          <button
            type="button"
            className="font-semibold underline"
            onClick={() => {
              setViewAs(null);
              client.clear();
              location.assign("/admin/tenants");
            }}
          >
            Kembali ke administrator
          </button>
        </div>
      )}
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-2 px-4 py-2">
          <span className="mr-4 text-lg font-bold text-brand-600">SMIP</span>
          <NavLink to="/" end className={link}>
            Dashboard
          </NavLink>
          <NavLink to="/topics" className={link}>
            Topik
          </NavLink>
          <span className={soon} title="Fase 3">
            Conversation
          </span>
          <span className={soon} title="Fase 3">
            Audience
          </span>
          <span className={soon} title="Fase 3">
            Psychography
          </span>
          {isAdmin && (
            <NavLink to="/users" className={link}>
              Pengguna
            </NavLink>
          )}
          {op && !view && (
            <>
              <NavLink to="/admin/tenants" className={link}>
                Kantor
              </NavLink>
              <NavLink to="/admin/providers" className={link}>
                Provider
              </NavLink>
              <NavLink to="/admin/llm" className={link}>
                Pengaturan AI
              </NavLink>
            </>
          )}
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-right leading-tight text-zinc-500">
              {me.user.name}
              <br />
              <span className="text-xs">
                {view ? view.tenantName : tenantName} · {op ? "administrator" : me.current_tenant.role}
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
      <main className="mx-auto max-w-7xl p-4">
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
              <Route path="/topics" element={<TopicList />} />
              <Route path="/topics/new" element={<TopicForm />} />
              <Route path="/topics/:id" element={<TopicPage />} />
              <Route path="/topics/:id/edit" element={<TopicForm />} />
              <Route path="/users" element={<Users />} />
              <Route path="/admin/tenants" element={<Tenants />} />
              <Route path="/admin/providers" element={<AdminProviders />} />
              <Route path="/admin/llm" element={<AdminLlm />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
