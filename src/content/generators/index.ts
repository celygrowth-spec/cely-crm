import type { GeneratorKind, Question } from "@/lib/generators/rules";
import { ONBOARDING_QUESTIONS } from "./onboarding";
import { PROPOSAL_QUESTIONS } from "./proposition";

export const QUESTIONS: Record<GeneratorKind, Question[]> = { proposal: PROPOSAL_QUESTIONS, onboarding: ONBOARDING_QUESTIONS };
