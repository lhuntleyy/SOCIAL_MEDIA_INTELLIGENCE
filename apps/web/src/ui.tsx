import type { ReactNode } from "react";

export const Card = ({ title, children, right }: { title?: string; children: ReactNode; right?: ReactNode }) => (
  <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
    {title && (
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-600">{title}</h2>
        {right}
      </header>
    )}
    {children}
  </section>
);

export const Badge = ({ tone = "zinc", children }: { tone?: "zinc" | "green" | "red" | "amber" | "blue"; children: ReactNode }) => {
  const c = {
    zinc: "bg-zinc-100 text-zinc-700",
    green: "bg-emerald-100 text-emerald-800",
    red: "bg-red-100 text-red-800",
    amber: "bg-amber-100 text-amber-800",
    blue: "bg-sky-100 text-sky-800",
  }[tone];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${c}`}>{children}</span>;
};

export const Button = ({
  children,
  variant = "primary",
  ...p
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) => {
  const c = {
    primary: "bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50",
    ghost: "border border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 disabled:opacity-50",
    danger: "bg-zinc-800 text-white hover:bg-black disabled:opacity-50",
  }[variant];
  return (
    <button type="button" {...p} className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${c} ${p.className ?? ""}`}>
      {children}
    </button>
  );
};

export const Input = (p: React.InputHTMLAttributes<HTMLInputElement>) => (
  <input
    {...p}
    className={`w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100 ${p.className ?? ""}`}
  />
);

export const Empty = ({ children }: { children: ReactNode }) => <p className="py-6 text-center text-sm text-zinc-500">{children}</p>;
export const ErrorText = ({ error }: { error: unknown }) =>
  error ? <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{(error as Error).message}</p> : null;

export const fmtTime = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" }) : "—";
export const PLATFORM_LABEL: Record<string, string> = {
  x: "X / Twitter",
  instagram: "Instagram",
  facebook: "Facebook",
  threads: "Threads",
  tiktok: "TikTok",
  youtube: "YouTube",
};
