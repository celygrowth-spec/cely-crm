import { expect, test } from "vitest";
import { attempt } from "@/lib/client/query";

test("attempt rend le résultat de l'action", async () => {
  expect(await attempt(async () => ({ ok: true as const, data: 1 }))).toEqual({ ok: true, data: 1 });
  expect(await attempt(async () => ({ ok: false as const, error: "refus" }))).toEqual({ ok: false, error: "refus" });
});

test("attempt transforme une coupure en échec, jamais en succès ni en exception", async () => {
  const r = await attempt(async (): Promise<{ ok: true }> => {
    throw new TypeError("Failed to fetch");
  });
  expect(r.ok).toBe(false);
});
