// Tracking site : classement des sources, normalisation des UTM, reconnaissance et contrôle des robots.
import { describe, expect, test } from "vitest";
import { classifyVisit, browserOf, deviceOf, referrerHost } from "@/lib/tracking/sources";
import { buildUtmUrl, canonicalUtmValue, readUtm, slugUtm, tagSiteUrl } from "@/lib/tracking/utm";
import { identifyBot, inRanges, isBotAgent, parseRanges } from "@/lib/tracking/bots";
import { eventSchema, toDbEvent } from "@/lib/tracking/collect";

const none = {};

describe("classement d'une visite", () => {
  test("les UTM priment sur tout le reste", () => {
    const { utm } = readUtm(new URLSearchParams("utm_source=linkedin&utm_medium=social&utm_campaign=lancement"));
    expect(classifyVisit({ utm, referrer: "https://www.google.com/", clickIds: ["gclid"] })).toMatchObject({ channel: "campaign", source: "linkedin", referrer_host: "google.com" });
  });
  test.each([
    ["https://www.google.fr/", "organic", "google"],
    ["https://www.bing.com/search?q=cely", "organic", "bing"],
    ["https://duckduckgo.com/", "organic", "duckduckgo"],
    ["https://chatgpt.com/", "ai", "chatgpt"],
    ["https://www.perplexity.ai/search/x", "ai", "perplexity"],
    ["https://claude.ai/chat/1", "ai", "claude"],
    ["https://gemini.google.com/app", "ai", "gemini"],
    ["https://copilot.microsoft.com/", "ai", "copilot"],
    ["https://www.linkedin.com/feed/", "social", "linkedin"],
    ["https://lnkd.in/abc", "social", "linkedin"],
    ["android-app://com.linkedin.android/", "social", "linkedin"],
    ["https://t.co/xyz", "social", "x"],
    ["https://mail.google.com/mail/u/0/", "email", "mail.google.com"],
    ["https://outlook.live.com/", "email", "outlook.live.com"],
    ["https://blog.exemple.fr/article", "referral", "blog.exemple.fr"],
  ])("%s → %s (%s)", (referrer, channel, source) => {
    expect(classifyVisit({ utm: none, referrer })).toMatchObject({ channel, source });
  });
  test("sans référent, ou référent interne au site : direct", () => {
    expect(classifyVisit({ utm: none })).toEqual({ channel: "direct", source: null, referrer_host: null });
    expect(classifyVisit({ utm: none, referrer: "https://www.celygrowth.com/services" }).channel).toBe("direct");
    expect(referrerHost("pas une adresse")).toBeNull();
  });
  test("identifiant de clic publicitaire sans UTM : payant ; fbclid seul ne l'est pas", () => {
    expect(classifyVisit({ utm: none, referrer: "https://www.google.com/", clickIds: ["gclid"] })).toMatchObject({ channel: "paid", source: "google" });
    expect(classifyVisit({ utm: none, referrer: "https://www.facebook.com/", clickIds: [] }).channel).toBe("social");
  });
  test("utm_source=chatgpt.com posé par l'IA elle-même : IA générative, pas une campagne", () => {
    const { utm } = readUtm(new URLSearchParams("utm_source=chatgpt.com"));
    expect(classifyVisit({ utm })).toMatchObject({ channel: "ai", source: "chatgpt" });
    const mine = readUtm(new URLSearchParams("utm_source=chatgpt.com&utm_campaign=test-ia")).utm;
    expect(classifyVisit({ utm: mine }).channel).toBe("campaign");
  });
  test("appareil et navigateur", () => {
    expect(deviceOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1")).toBe("mobile");
    expect(deviceOf("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1")).toBe("tablet");
    expect(deviceOf("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36")).toBe("desktop");
    expect(browserOf("Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0")).toBe("Edge");
    expect(browserOf("Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15")).toBe("Safari");
    expect(browserOf("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0")).toBe("Firefox");
  });
});

describe("UTM", () => {
  test("minuscules, sans accents, tirets", () => {
    expect(slugUtm("  Lancement Été 2026 !! ")).toBe("lancement-ete-2026");
    expect(slugUtm("___")).toBe("");
  });
  test("variantes, majuscules et fautes de frappe regroupées ; valeur d'origine conservée", () => {
    const r = readUtm(new URLSearchParams("UTM_Source=LinkedIn&utm_medium=E-Mail&utm_campaign=Offre%20D%C3%A9couverte"));
    expect(r.utm).toEqual({ utm_source: "linkedin", utm_medium: "email", utm_campaign: "offre-decouverte" });
    expect(r.raw).toEqual({ utm_source: "LinkedIn", utm_medium: "E-Mail", utm_campaign: "Offre Découverte" });
    expect(canonicalUtmValue("linkdin")).toBe("linkedin");
    expect(canonicalUtmValue("newsleter")).toBe("newsletter");
    expect(canonicalUtmValue("partenaire-acme")).toBe("partenaire-acme");
    // déjà conforme : rien à conserver à part
    expect(readUtm(new URLSearchParams("utm_source=linkedin")).raw).toBeNull();
  });
  test("UTM incomplets : une seule valeur suffit", () => {
    expect(readUtm(new URLSearchParams("utm_campaign=webinaire")).utm).toEqual({ utm_campaign: "webinaire" });
    expect(readUtm(new URLSearchParams("utm_source=%20")).utm).toEqual({});
  });
  test("construction d'un lien et marquage automatique", () => {
    expect(buildUtmUrl("/services", { utm_source: "LinkedIn", utm_medium: "Post", utm_campaign: "Offre Découverte" }))
      .toBe("https://www.celygrowth.com/services?utm_source=linkedin&utm_medium=post&utm_campaign=offre-decouverte");
    const utm = { utm_source: "email", utm_medium: "email", utm_campaign: "mail-direct" };
    expect(tagSiteUrl("https://celygrowth.com/contact#formulaire", utm)).toBe("https://celygrowth.com/contact?utm_source=email&utm_medium=email&utm_campaign=mail-direct#formulaire");
    // déjà marqué, autre site, adresse illisible : inchangés
    expect(tagSiteUrl("https://www.celygrowth.com/?utm_source=x", utm)).toBe("https://www.celygrowth.com/?utm_source=x");
    expect(tagSiteUrl("https://exemple.fr/", utm)).toBe("https://exemple.fr/");
    expect(tagSiteUrl("https://celygrowth.com.pirate.fr/", utm)).toBe("https://celygrowth.com.pirate.fr/");
    expect(tagSiteUrl("mailto:a@b.fr", utm)).toBe("mailto:a@b.fr");
  });
});

describe("robots", () => {
  const ranges = async () => parseRanges({ prefixes: [{ ipv4Prefix: "66.249.64.0/27" }, { ipv6Prefix: "2001:4860:4801:10::/64" }] });
  const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
  test("plages d'adresses IPv4 et IPv6", async () => {
    const r = await ranges();
    expect(inRanges("66.249.64.5", r)).toBe(true);
    expect(inRanges("66.249.64.40", r)).toBe(false);
    expect(inRanges("2001:4860:4801:10::1f", r)).toBe(true);
    expect(inRanges("2001:4860:4801:11::1", r)).toBe(false);
    expect(inRanges("::ffff:66.249.64.5", r)).toBe(true);
    expect(inRanges("n'importe quoi", r)).toBe(false);
  });
  test("robot connu venant d'une adresse publiée : vérifié ; même nom depuis ailleurs : non vérifié", async () => {
    expect(await identifyBot(GOOGLEBOT, "66.249.64.5", ranges)).toEqual({ bot: "Googlebot", kind: "search", status: "verified" });
    expect(await identifyBot(GOOGLEBOT, "203.0.113.9", ranges)).toEqual({ bot: "Googlebot", kind: "search", status: "unverified" });
    expect(await identifyBot(GOOGLEBOT, null, ranges)).toMatchObject({ status: "unverified" });
  });
  test("éditeur sans liste publiée, ou liste illisible : non vérifiable ; agent humain : pas un robot", async () => {
    expect(await identifyBot("Mozilla/5.0 AppleWebKit/537.36 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", "203.0.113.9", ranges)).toEqual({ bot: "ClaudeBot", kind: "ai", status: "unverifiable" });
    expect(await identifyBot(GOOGLEBOT, "66.249.64.5", async () => null)).toMatchObject({ status: "unverifiable" });
    expect(await identifyBot("Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36", "203.0.113.9", ranges)).toBeNull();
  });
  test("noms précis reconnus avant les noms génériques", async () => {
    expect((await identifyBot("Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)", null, ranges))?.bot).toBe("OAI-SearchBot");
    expect((await identifyBot("Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)", null, ranges))?.kind).toBe("ai");
    expect((await identifyBot("Mozilla/5.0 (compatible; PerplexityBot/1.0)", null, ranges))?.bot).toBe("PerplexityBot");
  });
  test("le point de collecte écarte robots et navigateurs pilotés", () => {
    expect(isBotAgent("")).toBe(true);
    expect(isBotAgent("curl/8.5.0")).toBe(true);
    expect(isBotAgent("Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/130.0")).toBe(true);
    expect(isBotAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15")).toBe(false);
  });
});

describe("événements reçus", () => {
  const V = "11111111-1111-4111-8111-111111111111", P = "22222222-2222-4222-8222-222222222222";
  const client = { userAgent: "Mozilla/5.0 (iPhone) Mobile Safari/604.1", country: "FR" };
  test("forme stricte : identifiants, chemin sans paramètres, tailles bornées", () => {
    expect(eventSchema.safeParse({ t: "pv", v: V, p: P, path: "/services" }).success).toBe(true);
    expect(eventSchema.safeParse({ t: "pv", v: "x", p: P, path: "/services" }).success).toBe(false);
    expect(eventSchema.safeParse({ t: "pv", v: V, p: P, path: "/services?email=a@b.fr" }).success).toBe(false);
    expect(eventSchema.safeParse({ t: "pv", v: V, p: P, path: "/" + "a".repeat(400) }).success).toBe(false);
    expect(eventSchema.safeParse({ t: "inconnu", v: V }).success).toBe(false);
    expect(eventSchema.safeParse({ t: "form", v: V, e: P, path: "/contact", em: "pas-un-email" }).success).toBe(false);
  });
  test("page vue : source classée côté serveur, pays et appareil déduits, aucune adresse IP", () => {
    const ev = eventSchema.parse({ t: "pv", v: V, p: P, path: "/services", q: "utm_source=LinkedIn&utm_campaign=Lancement", r: "https://www.linkedin.com" });
    const out = toDbEvent(ev, client);
    expect(out).toMatchObject({
      type: "pv", visit_id: V, visitor_id: null, path: "/services",
      visit: { channel: "campaign", source: "linkedin", utm_source: "linkedin", utm_campaign: "lancement", country: "FR", device: "mobile", browser: "Safari", utm_raw: { utm_source: "LinkedIn", utm_campaign: "Lancement" } },
    });
    expect(JSON.stringify(out)).not.toMatch(/ip/i);
  });
});
