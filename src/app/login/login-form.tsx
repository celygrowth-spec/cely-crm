"use client";

import { useActionState } from "react";
import { Button, Field, Input } from "@/components/ui";
import { signInAction } from "./actions";

export function LoginForm({ next, initialError }: { next: string; initialError: string | null }) {
  const [error, formAction, pending] = useActionState(signInAction, initialError);
  return (
    <form action={formAction} className="mt-6 space-y-4">
      <input type="hidden" name="next" value={next} />
      <Field label="Email">
        <Input name="email" type="email" autoComplete="email" required autoFocus />
      </Field>
      <Field label="Mot de passe">
        <Input name="password" type="password" autoComplete="current-password" required />
      </Field>
      {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">{error}</p>}
      <Button type="submit" variant="primary" className="w-full" disabled={pending}>
        {pending ? "Connexion…" : "Se connecter"}
      </Button>
    </form>
  );
}
