import "./index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes } from "react-router";
import { AuthProvider, useAuth } from "./auth";
import AdminProviders from "./pages/AdminProviders";
import Dashboard from "./pages/Dashboard";
import Login from "./pages/Login";
import Mfa from "./pages/Mfa";
import { TopicList, TopicPage } from "./pages/Topics";

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 15_000, refetchOnWindowFocus: false } } });

function Shell() {
  const { me, loading, logout } = useAuth();
  if (loading) return <div className="p-8 text-sm text-zinc-500">Memuat…</div>;
  if (!me) return <Navigate to="/login" replace />;
  if (me.mfa === "setup_required") return <Navigate to="/mfa" replace />;
  const link = ({ isActive }: { isActive: boolean }) =>
    `rounded-lg px-3 py-1.5 text-sm font-medium ${isActive ? "bg-brand-600 text-white" : "text-zinc-600 hover:bg-zinc-100"}`;
  const soon = "cursor-not-allowed rounded-lg px-3 py-1.5 text-sm text-zinc-400";
  return (
    <div className="min-h-screen">
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
          {me.user.is_platform_operator && (
            <NavLink to="/admin/providers" className={link}>
              Provider
            </NavLink>
          )}
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-zinc-500">{me.user.name}</span>
            <button type="button" onClick={() => void logout()} className="text-brand-600 hover:underline">
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
            <Route element={<Shell />}>
              <Route index element={<Dashboard />} />
              <Route path="/topics" element={<TopicList />} />
              <Route path="/topics/:id" element={<TopicPage />} />
              <Route path="/admin/providers" element={<AdminProviders />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
