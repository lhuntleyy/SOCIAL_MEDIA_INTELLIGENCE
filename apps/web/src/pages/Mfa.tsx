import QRCode from "qrcode";
import { type FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { api, refreshSession } from "../api";
import { useAuth } from "../auth";
import { Button, Card, ErrorText, Input } from "../ui";

/** Admin/operator wajib MFA (SECURITY §2): daftar TOTP → verifikasi → token baru ber-mfa=ok. */
export default function Mfa() {
  const { reload } = useAuth();
  const nav = useNavigate();
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    api<{ secret: string; otpauth_uri: string }>("/me/mfa/setup", { method: "POST" })
      .then(async (s) => {
        setSecret(s.secret);
        setQr(await QRCode.toDataURL(s.otpauth_uri, { margin: 1, width: 220 }));
      })
      .catch(setErr);
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api("/me/mfa/verify", { method: "POST", json: { code } });
      await refreshSession();
      await reload();
      nav("/");
    } catch (x) {
      setErr(x);
    }
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-100 p-4">
      <div className="w-full max-w-md">
        <Card title="Aktifkan autentikasi 2 langkah">
          <p className="mb-3 text-sm text-zinc-600">
            Akun admin wajib memakai aplikasi authenticator (Google Authenticator, Authy, dll). Pindai QR lalu masukkan kodenya.
          </p>
          {qr && <img src={qr} alt="QR TOTP" className="mx-auto mb-2" />}
          {secret && <p className="mb-3 break-all text-center font-mono text-xs text-zinc-500">{secret}</p>}
          <form onSubmit={submit} className="space-y-3">
            <Input inputMode="numeric" placeholder="Kode 6 digit" value={code} onChange={(e) => setCode(e.target.value)} required />
            <ErrorText error={err} />
            <Button type="submit" className="w-full py-2">
              Verifikasi
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
