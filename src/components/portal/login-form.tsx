"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import Image from "next/image";
import { KeyRound, Loader2 } from "lucide-react";

export function PortalLogin({ expired }: { expired?: boolean }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(expired ? "Votre session a expiré ou l'accès a été modifié. Saisissez votre code." : null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/portail/connexion", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && body.ok) {
        setCode("");
        router.replace("/portail");
        router.refresh();
        return;
      }
      setError(body.error ?? "Connexion impossible.");
    } catch {
      setError("Connexion au serveur impossible. Vérifiez votre réseau.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <form onSubmit={submit} className="fade-in w-full max-w-sm rounded-2xl border border-line bg-white p-6 shadow-sm sm:p-8">
        <Image src="/brand/cely-logo.svg" alt="Cely Growth" width={84} height={29} priority />
        <h1 className="mt-6 font-display text-2xl font-bold text-ink">Votre espace projet</h1>
        <p className="mt-1 text-sm text-muted">Saisissez le code d&apos;accès personnel qui vous a été transmis.</p>
        <label htmlFor="code" className="mt-6 mb-1 block text-xs font-semibold text-muted">Code d&apos;accès</label>
        <div className="relative">
          <KeyRound size={16} className="absolute top-3.5 left-3 text-muted" aria-hidden />
          <input
            id="code"
            name="code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            required
            maxLength={40}
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"
            className="h-12 w-full rounded-lg border border-line bg-white pr-3 pl-9 font-label text-base tracking-wider text-ink focus:border-violet focus:ring-2 focus:ring-violet/20 focus:outline-none"
          />
        </div>
        {error && <p role="alert" className="mt-3 rounded-lg bg-danger/5 px-3 py-2 text-sm text-danger">{error}</p>}
        <button type="submit" disabled={busy || !code.trim()} className="mt-5 inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-ink text-sm font-semibold text-white hover:bg-violet-strong disabled:opacity-60">
          {busy && <Loader2 size={16} className="animate-spin" aria-hidden />} Accéder à mon espace
        </button>
        <p className="mt-4 text-xs text-muted">Code perdu ou expiré ? Demandez-en un nouveau à votre interlocuteur Cely Growth.</p>
      </form>
    </main>
  );
}
