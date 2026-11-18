"use client";

// « Générer l'onboarding », sur le projet d'un client dont la proposition est signée : l'écran commun des
// générateurs. La génération remplit la préparation ci-dessus (« Préparer l'onboarding ») : mêmes sections, mêmes
// slides, même partage explicite au client.
import { GeneratorPanel, type PersonOption } from "@/components/generator/panel";
import { Card } from "@/components/ui";

export function OnboardingGenerator({ projectId, companyId, people, signedVersion, older }: { projectId: string; companyId: string; people: PersonOption[]; signedVersion: number | null; older: boolean }) {
  return (
    <Card className="mb-4 p-4" data-onboarding-generator>
      <h2 className="font-display text-base font-bold">Générer l&apos;onboarding</h2>
      <p className="mt-0.5 mb-3 text-sm text-muted">
        {signedVersion ? `À partir de la proposition signée (V${signedVersion}), des échanges et du diagnostic. ` : ""}
        La génération complète « Préparer l&apos;onboarding » et ses slides ; à la validation, le planning et les premières actions alimentent le projet. Rien n&apos;est visible du client sans votre partage.
      </p>
      {older && <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-warning" data-signed-older>La V{signedVersion} a été signée alors qu&apos;une version plus récente de la proposition existe : c&apos;est la V{signedVersion} qui fait foi ici.</p>}
      <GeneratorPanel companyId={companyId} kind="onboarding" projectId={projectId} people={people}
        slots={{ versionExtra: (_, v) => (v.validated_at ? <p className="mt-1 text-xs text-muted">Pour montrer les slides au client : « Partager » dans « Préparer l&apos;onboarding », ci-dessus.</p> : null) }} />
    </Card>
  );
}
