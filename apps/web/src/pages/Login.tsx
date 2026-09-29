import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router";
import { ApiError } from "../api";
import { useAuth } from "../auth";
import { Button, ErrorText, Input } from "../ui";

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [needOtp, setNeedOtp] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const mfa = await login(email, password, needOtp ? otp : undefined);
      nav(mfa === "setup_required" ? "/mfa" : "/");
    } catch (x) {
      if (x instanceof ApiError && x.code === "MFA_REQUIRED") setNeedOtp(true);
      else setErr(x);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-zinc-100 to-brand-50 p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-2xl bg-white p-8 shadow-lg">
        <div>
          <div className="text-2xl font-bold text-brand-600">SMIP</div>
          <p className="text-sm text-zinc-500">Social Media Intelligence Platform</p>
        </div>
        <Input type="email" placeholder="Email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <Input
          type="password"
          placeholder="Password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {needOtp && (
          <Input
            inputMode="numeric"
            placeholder="Kode authenticator (6 digit)"
            value={otp}
            onChange={(e) => setOtp(e.target.value)}
            autoFocus
            required
          />
        )}
        <ErrorText error={err} />
        <Button type="submit" disabled={busy} className="w-full py-2">
          {busy ? "Memproses…" : "Masuk"}
        </Button>
      </form>
    </div>
  );
}
