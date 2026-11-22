// CMS lot 4 : appel de rafraîchissement vers le site (adresse et secret en variables d'environnement).
import { afterEach, expect, test, vi } from "vitest";
import { callSite, revalidateConfig } from "@/lib/cms/revalidate";

afterEach(() => vi.unstubAllEnvs());

test("non configuré (ou secret trop court, ou adresse non https) : échec explicite, aucun appel", async () => {
  const f = vi.fn();
  expect(await callSite(["cms:articles"], [], f as never)).toEqual({ ok: false, error: expect.stringMatching(/non configuré/) });
  vi.stubEnv("CMS_SITE_REVALIDATE_URL", "http://site.test/api/cms/revalidate");
  vi.stubEnv("CMS_SITE_REVALIDATE_SECRET", "s".repeat(32));
  expect(revalidateConfig()).toBeNull();
  vi.stubEnv("CMS_SITE_REVALIDATE_URL", "https://site.test/api/cms/revalidate");
  vi.stubEnv("CMS_SITE_REVALIDATE_SECRET", "court");
  expect(revalidateConfig()).toBeNull();
  expect(f).not.toHaveBeenCalled();
});

test("appel : POST JSON, secret en Bearer, étiquette « cms » toujours présente ; réponses d'erreur nommées", async () => {
  vi.stubEnv("CMS_SITE_REVALIDATE_URL", "https://site.test/api/cms/revalidate");
  vi.stubEnv("CMS_SITE_REVALIDATE_SECRET", "s".repeat(32));
  const f = vi.fn(async () => new Response(null, { status: 200 }));
  expect(await callSite(["cms:article:a"], ["publication : a"], f as never)).toEqual({ ok: true });
  const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://site.test/api/cms/revalidate");
  expect(init.method).toBe("POST");
  expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${"s".repeat(32)}`);
  expect(JSON.parse(String(init.body))).toMatchObject({ tags: ["cms", "cms:article:a"], reasons: ["publication : a"] });
  expect(await callSite([], [], (async () => new Response(null, { status: 401 })) as never)).toEqual({ ok: false, error: expect.stringMatching(/401.*secret/) });
  expect(await callSite([], [], (async () => { throw new TypeError("fetch failed"); }) as never)).toEqual({ ok: false, error: "Site injoignable." });
});
