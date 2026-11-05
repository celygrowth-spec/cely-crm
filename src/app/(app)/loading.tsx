import { PageSkeleton } from "@/components/ui";

// Affiché instantanément à chaque navigation : jamais d'écran figé ni blanc.
export default function Loading() {
  return <PageSkeleton />;
}
