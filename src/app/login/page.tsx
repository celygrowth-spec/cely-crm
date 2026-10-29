import Image from "next/image";
import { LoginForm } from "./login-form";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface px-4">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-white p-7 shadow-sm">
        <Image src="/brand/cely-logo.svg" alt="Cely Growth" width={112} height={38} priority />
        <h1 className="mt-6 font-display text-xl font-extrabold">Connexion au CRM</h1>
        <p className="mt-1 text-sm text-muted">Accès réservé.</p>
        <LoginForm next={next ?? "/"} initialError={error === "not_owner" ? "Ce compte n'est pas autorisé à accéder au CRM." : null} />
      </div>
    </main>
  );
}
