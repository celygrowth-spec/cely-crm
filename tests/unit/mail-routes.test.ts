// Connexion OAuth et protections des routes, Google et session simulés.
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const rpc = vi.fn();
const supabase = { rpc };
vi.mock("@/lib/auth", () => ({
  requireAppOwner: async () => ({ supabase }),
  getSession: vi.fn(async () => ({ supabase })),
}));

const { GET: start } = await import("@/app/api/mail/oauth/start/route");
const { GET: callback } = await import("@/app/api/mail/oauth/callback/route");
const { POST: accounts } = await import("@/app/api/mail/accounts/route");
const { POST: message } = await import("@/app/api/mail/messages/[id]/route");
const { getSession } = await import("@/lib/auth");

const ORIGIN = "https://crm.test";
const SCOPE = "https://www.googleapis.com/auth/gmail.send";
const idToken = `x.${Buffer.from(JSON.stringify({ email: "moi@cely.fr", name: "Moi" })).toString("base64url")}.y`;

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: "acc", error: null });
  vi.stubEnv("GOOGLE_MAIL_CLIENT_ID", "client-id");
  vi.stubEnv("GOOGLE_MAIL_CLIENT_SECRET", "client-secret");
  vi.stubEnv("MAIL_TOKEN_KEY", Buffer.alloc(32, 1).toString("base64"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const cb = (qs: string, cookie?: string) =>
  callback(new NextRequest(`${ORIGIN}/api/mail/oauth/callback?${qs}`, { headers: cookie ? { cookie: `mail_oauth=${cookie}` } : {} }));

describe("connexion", () => {
  test("le départ pose un cookie protégé et n'expose pas le secret client", async () => {
    const res = await start(new NextRequest(`${ORIGIN}/api/mail/oauth/start`));
    const loc = res.headers.get("location")!;
    expect(loc).toContain("accounts.google.com");
    expect(loc).toContain(encodeURIComponent(`${ORIGIN}/api/mail/oauth/callback`));
    expect(loc).not.toContain("client-secret");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/mail_oauth=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(loc).toContain(`state=${cookie.match(/mail_oauth=([^.]+)\./)![1]}`);
  });

  test("sans configuration : retour vers Mail, pas d'appel à Google", async () => {
    vi.stubEnv("MAIL_TOKEN_KEY", "");
    const res = await start(new NextRequest(`${ORIGIN}/api/mail/oauth/start`));
    expect(res.headers.get("location")).toBe(`${ORIGIN}/mail?error=config`);
  });

  test("état absent ou différent : refus, aucun échange de code", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    for (const r of [await cb("code=c&state=abc"), await cb("code=c&state=abc", "autre.verif")]) {
      expect(r.headers.get("location")).toContain("error=state");
    }
    expect(f).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  test("refus de l'utilisateur chez Google", async () => {
    const r = await cb("error=access_denied&state=st", "st.verif");
    expect(r.headers.get("location")).toContain("error=denied");
    expect(rpc).not.toHaveBeenCalled();
  });

  test("succès : code échangé avec le vérificateur, jetons chiffrés, cookie effacé", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ access_token: "AT-secret", refresh_token: "RT-secret", expires_in: 3600, scope: `openid ${SCOPE}`, id_token: idToken })));
    vi.stubGlobal("fetch", f);
    const r = await cb("code=le-code&state=st", "st.verif");
    expect(r.headers.get("location")).toBe(`${ORIGIN}/mail?connected=1`);
    expect(r.headers.get("set-cookie")).toMatch(/mail_oauth=;/);
    const sent = String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body);
    expect(sent).toContain("code_verifier=verif");
    const [fn, args] = rpc.mock.calls[0];
    expect(fn).toBe("mail_connect");
    expect(args.p_email).toBe("moi@cely.fr");
    expect(JSON.stringify(args)).not.toMatch(/AT-secret|RT-secret/);
  });

  test("autorisation d'envoi décochée : message clair, rien d'enregistré", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "openid email", id_token: idToken })));
    const r = await cb("code=c&state=st", "st.verif");
    expect(r.headers.get("location")).toContain("error=scope");
    expect(rpc).not.toHaveBeenCalled();
  });

  test("Google refuse le code : aucun détail de la réponse n'est transmis", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "détail interne" }), { status: 400 }));
    const r = await cb("code=c&state=st", "st.verif");
    expect(r.headers.get("location")).toContain("error=failed");
    expect(decodeURIComponent(r.headers.get("location")!)).not.toContain("détail interne");
  });
});

describe("écritures", () => {
  const post = (fn: typeof accounts, url: string, body: unknown, origin = ORIGIN) =>
    fn(new NextRequest(`${ORIGIN}${url}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }));
  const params = { params: Promise.resolve({ id: "33333333-3333-4333-8333-333333333333" }) };

  test("une autre origine ne peut pas déclencher d'envoi", async () => {
    const r = await message(new NextRequest(`${ORIGIN}/api/mail/messages/x`, { method: "POST", headers: { origin: "https://evil.example" }, body: JSON.stringify({ op: "send" }) }), params);
    expect(r.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
    expect((await post(accounts, "/api/mail/accounts", { op: "test", to: "a@b.fr" }, "https://evil.example")).status).toBe(403);
  });

  test("sans session : 401", async () => {
    vi.mocked(getSession).mockResolvedValueOnce(null);
    expect((await post(accounts, "/api/mail/accounts", { op: "test", to: "a@b.fr" })).status).toBe(401);
  });

  test("opération inconnue refusée", async () => {
    const r = await post(accounts, "/api/mail/accounts", { op: "autre" });
    expect(r.status).toBe(400);
    expect((await r.json()).ok).toBe(false);
  });
});
