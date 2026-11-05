import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto max-w-md px-4 py-16 text-center">
      <h1 className="font-display text-xl font-bold text-ink">Page introuvable</h1>
      <p className="mt-2 text-sm text-muted">Ce contenu n&apos;existe pas ou n&apos;est pas partagé avec vous.</p>
      <Link href="/portail" className="mt-4 inline-block text-sm font-semibold text-violet-strong underline">Retour à mon espace</Link>
    </main>
  );
}
