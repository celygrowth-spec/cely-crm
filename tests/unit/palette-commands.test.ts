import { expect, test } from "vitest";
import { matchCommands, PALETTE_COMMANDS } from "@/components/palette-commands";

test("sans saisie : tous les raccourcis", () => {
  expect(matchCommands("  ")).toHaveLength(PALETTE_COMMANDS.length);
});

test("filtre par libellé ou mot-clé, accents et casse ignorés", () => {
  expect(matchCommands("parametres").map((c) => c.id)).toEqual(["go-settings"]);
  expect(matchCommands("REVENU").map((c) => c.id)).toEqual(["go-revenue", "new-revenue"]);
  expect(matchCommands("créer fiche").map((c) => c.id)).toEqual(["new-company"]);
  expect(matchCommands("agenda").map((c) => c.id)).toEqual(["go-rdv"]);
  expect(matchCommands("introuvable")).toEqual([]);
});
