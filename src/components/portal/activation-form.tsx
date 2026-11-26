"use client";

// « Créer mon accès » : le jeton est lu dans le fragment du lien (#…), qui ne quitte jamais le navigateur, puis
// effacé de la barre d'adresse. L'identifiant affiché est celui que le serveur lit dans l'invitation.
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { PASSWORD_MAX, PASSWORD_RULES, passwordProblem } from "@/lib/projects/password-rules";
import { PortalCard, SubmitButton } from "./login-form";

type Invitation = { email: string; kind: "invitation" | "reset"; firstName: string | null };

const field = "h-12 w-full rounded-lg border border-line bg-white px-3 text-base text-ink focus:border-violet focus:ring-2 focus:ring-violet/20 focus:outline-none";
const label = "mt-4 mb-1 block text-xs font-semibold text-muted";

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, ...((await res.json().catch(() => ({}))) as { ok?: boolean; error?: string } & Partial<Invitation>) };
}

export function ActivationForm() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = window.location.hash.slice(1);
    // le lien ne reste ni dans la barre d'adresse ni dans l'historique
    window.history.replaceState(null, "", window.location.pathname);
    let alive = true;
    (async () => {
      if (!t) {
        if (alive) setFatal("Ce lien est incomplet. Ouvrez le lien reçu par mail, ou contactez votre interlocuteur Cely Growth pour recevoir une nouvelle invitation.");
        return;
      }
      try {
        const r = await post("/api/portail/invitation", { token: t });
        if (!alive) return;
        if (r.ok && r.email && r.kind) {
          setToken(t);
          setInvitation({ email: r.email, kind: r.kind, firstName: r.firstName ?? null });
        } else setFatal(r.error ?? "Ce lien n'est plus valable.");
      } catch {
        if (alive) setFatal("Connexion au serveur impossible. Vérifiez votre réseau puis rouvrez le lien.");
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !token) return;
    const problem = passwordProblem(password) ?? (confirm !== password ? "Les deux mots de passe ne sont pas identiques." : null);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await post("/api/portail/activation", { token, password, confirm });
      if (r.ok) {
        setPassword("");
        setConfirm("");
        router.replace("/portail");
        router.refresh();
        return; // le bouton reste désactivé jusqu'à l'arrivée sur le portail
      }
      if (r.status === 410) setFatal(r.error ?? "Ce lien n'est plus valable.");
      else setError(r.error ?? "Création impossible. Réessayez.");
    } catch {
      setError("Connexion au serveur impossible. Vérifiez votre réseau.");
    }
    setBusy(false);
  }

  const reset = invitation?.kind === "reset";
  if (fatal) return <PortalCard title="Lien non valable" intro={fatal}><span /></PortalCard>;
  if (!invitation) {
    return (
      <PortalCard title="Créer mon accès" intro="Vérification du lien…">
        <Loader2 size={18} className="mt-4 animate-spin text-muted" aria-label="Chargement" />
      </PortalCard>
    );
  }
  return (
    <PortalCard
      title={reset ? "Nouveau mot de passe" : "Créer mon accès"}
      intro={`${invitation.firstName ? `Bonjour ${invitation.firstName}. ` : ""}${reset ? "Choisissez votre nouveau mot de passe." : "Choisissez le mot de passe de votre espace projet."}`}
      onSubmit={submit}
    >
      <label htmlFor="identifiant" className={label}>Identifiant</label>
      <input id="identifiant" name="username" type="email" value={invitation.email} readOnly aria-readonly autoComplete="username" className={`${field} cursor-not-allowed bg-surface text-muted`} />
      <div className="mt-4 rounded-lg bg-surface px-3 py-2 text-xs text-muted" id="regles">
        <p className="font-semibold text-ink">Votre mot de passe doit contenir :</p>
        <ul className="mt-1 list-disc pl-4">{PASSWORD_RULES.map((r) => <li key={r}>{r}</li>)}</ul>
      </div>
      <label htmlFor="password" className={label}>Mot de passe</label>
      <input id="password" name="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" aria-describedby="regles" required maxLength={PASSWORD_MAX} className={field} />
      <label htmlFor="confirm" className={label}>Confirmer le mot de passe</label>
      <input id="confirm" name="confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required maxLength={PASSWORD_MAX} className={field} />
      {error && <p role="alert" className="mt-3 rounded-lg bg-danger/5 px-3 py-2 text-sm text-danger">{error}</p>}
      <SubmitButton busy={busy} disabled={!password || !confirm}>{reset ? "Enregistrer mon mot de passe" : "Créer mon accès"}</SubmitButton>
    </PortalCard>
  );
}
