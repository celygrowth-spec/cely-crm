"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import Image from "next/image";
import { KeyRound, Loader2 } from "lucide-react";

type Mode = "password" | "forgot" | "code";

const field = "h-12 w-full rounded-lg border border-line bg-white px-3 text-base text-ink focus:border-violet focus:ring-2 focus:ring-violet/20 focus:outline-none";
const label = "mt-4 mb-1 block text-xs font-semibold text-muted";
const link = "text-xs font-semibold text-violet-strong hover:underline";

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; message?: string };
  return { ...data, ok: res.ok && !!data.ok };
}

export function PortalLogin({ expired }: { expired?: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(expired ? "Votre session a expiré ou l'accès a été modifié. Reconnectez-vous." : null);
  const [notice, setNotice] = useState<string | null>(null);

  function switchTo(m: Mode) {
    setMode(m);
    setError(null);
    setNotice(null);
    setPassword("");
    setCode("");
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = mode === "forgot" ? await post("/api/portail/mot-de-passe-oublie", { email })
        : mode === "code" ? await post("/api/portail/connexion", { code })
          : await post("/api/portail/connexion", { email, password });
      if (!r.ok) {
        setError(r.error ?? "Connexion impossible.");
        return;
      }
      if (mode === "forgot") {
        setNotice(r.message ?? null);
        return;
      }
      setPassword("");
      setCode("");
      router.replace("/portail");
      router.refresh();
    } catch {
      setError("Connexion au serveur impossible. Vérifiez votre réseau.");
    } finally {
      setBusy(false);
    }
  }

  const title = mode === "forgot" ? "Mot de passe oublié" : "Votre espace projet";
  const intro = mode === "forgot" ? "Indiquez l'email de votre accès : votre interlocuteur Cely Growth vous enverra un lien pour choisir un nouveau mot de passe."
    : mode === "code" ? "Saisissez le code d'accès personnel qui vous a été transmis."
      : "Connectez-vous avec votre email et le mot de passe que vous avez choisi.";
  const ready = mode === "forgot" ? !!email.trim() : mode === "code" ? !!code.trim() : !!email.trim() && !!password;

  return (
    <PortalCard title={title} intro={intro} onSubmit={submit}>
      {mode !== "code" && (
        <>
          <label htmlFor="email" className={label}>Email</label>
          <input id="email" name="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required maxLength={320} className={field} />
        </>
      )}
      {mode === "password" && (
        <>
          <label htmlFor="password" className={label}>Mot de passe</label>
          <input id="password" name="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required maxLength={128} className={field} />
        </>
      )}
      {mode === "code" && (
        <>
          <label htmlFor="code" className={label}>Code d&apos;accès</label>
          <div className="relative">
            <KeyRound size={16} className="absolute top-3.5 left-3 text-muted" aria-hidden />
            <input id="code" name="code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} required maxLength={40}
              placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" className={`${field} pl-9 font-label tracking-wider`} />
          </div>
        </>
      )}
      {error && <p role="alert" className="mt-3 rounded-lg bg-danger/5 px-3 py-2 text-sm text-danger">{error}</p>}
      {notice && <p role="status" className="mt-3 rounded-lg bg-success/10 px-3 py-2 text-sm text-success">{notice}</p>}
      <SubmitButton busy={busy} disabled={!ready}>{mode === "forgot" ? "Envoyer la demande" : "Accéder à mon espace"}</SubmitButton>
      <div className="mt-4 flex flex-wrap justify-between gap-2">
        {mode === "password" ? (
          <>
            <button type="button" className={link} onClick={() => switchTo("forgot")}>Mot de passe oublié ?</button>
            <button type="button" className={link} onClick={() => switchTo("code")}>J&apos;ai reçu un code d&apos;accès</button>
          </>
        ) : (
          <button type="button" className={link} onClick={() => switchTo("password")}>Retour à la connexion</button>
        )}
      </div>
      <p className="mt-4 text-xs text-muted">Pas encore d&apos;accès ? Votre interlocuteur Cely Growth vous envoie une invitation par mail.</p>
    </PortalCard>
  );
}

export function PortalCard({ title, intro, onSubmit, children }: { title: string; intro: string; onSubmit?: (e: FormEvent) => void; children?: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <form onSubmit={onSubmit ?? ((e) => e.preventDefault())} className="fade-in w-full max-w-sm rounded-2xl border border-line bg-white p-6 shadow-sm sm:p-8">
        <Image src="/brand/cely-logo.svg" alt="Cely Growth" width={84} height={29} priority />
        <h1 className="mt-6 font-display text-2xl font-bold text-ink">{title}</h1>
        <p className="mt-1 text-sm text-muted">{intro}</p>
        {children}
      </form>
    </main>
  );
}

export function SubmitButton({ busy, disabled, children }: { busy: boolean; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="submit" disabled={busy || disabled} aria-busy={busy} className="mt-5 inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-ink text-sm font-semibold text-white hover:bg-violet-strong disabled:opacity-60">
      {busy && <Loader2 size={16} className="animate-spin" aria-hidden />} {children}
    </button>
  );
}
