// Portail client : jeton d'invitation, empreinte du mot de passe, règles de robustesse, contenu du mail.
import { beforeAll, describe, expect, test } from "vitest";

beforeAll(() => {
  process.env.APPOINTMENTS_SECRET = "s".repeat(48);
});

describe("jeton et mot de passe", () => {
  test("jeton de 256 bits, empreinte HMAC dépendante du secret serveur", async () => {
    const { newInviteToken, inviteHash, emailHash } = await import("@/lib/projects/portal-auth");
    const t = newInviteToken();
    expect(t.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(t.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(inviteHash(t.token)).toBe(t.hash);
    expect(new Set(Array.from({ length: 200 }, () => newInviteToken().token)).size).toBe(200);
    expect(emailHash("  Alice@Exemple.TEST ")).toBe(emailHash("alice@exemple.test"));
  });

  test("scrypt : salé, vérifié en temps constant, empreinte inconnue ou malformée refusée", async () => {
    const { hashPassword, verifyPassword } = await import("@/lib/projects/portal-auth");
    const a = await hashPassword("mot de passe fictif 42");
    const b = await hashPassword("mot de passe fictif 42");
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("fictif");
    expect(await verifyPassword("mot de passe fictif 42", a)).toBe(true);
    expect(await verifyPassword("mot de passe fictif 43", a)).toBe(false);
    expect(await verifyPassword("mot de passe fictif 42", null)).toBe(false);
    expect(await verifyPassword("x", "scrypt$99999999$8$1$AAAA$AAAA")).toBe(false);
  });

  test("règles de robustesse", async () => {
    const { passwordProblem, PASSWORD_RULES } = await import("@/lib/projects/password-rules");
    expect(PASSWORD_RULES.length).toBeGreaterThan(0);
    expect(passwordProblem("court1")).toMatch(/12 caractères/);
    expect(passwordProblem("aaaaaaaaaaaaaa")).toMatch(/chiffre/);
    expect(passwordProblem("12345678901234")).toMatch(/lettre/);
    expect(passwordProblem("x".repeat(129) + "1")).toMatch(/dépasser/);
    expect(passwordProblem("éléphant rose 2026")).toBeNull();
  });
});

describe("contenu du mail", () => {
  test("invitation : nom du projet, lien d'activation, validité ; jamais de mot de passe ni de code", async () => {
    const { invitationContent, activationLink } = await import("@/lib/projects/invitations");
    const link = activationLink("https://crm.exemple.test", "JETON");
    expect(link).toBe("https://crm.exemple.test/portail/activer#JETON");
    const m = invitationContent("invitation", { firstName: "Alice", project: "Refonte <b>", link });
    expect(m.subject).toBe("Votre espace projet « Refonte <b> »");
    expect(m.text).toContain(link);
    expect(m.text).toMatch(/7 jours/);
    expect(m.html).toContain(`href="${link}"`);
    expect(m.html).toContain("Refonte &lt;b&gt;");
    expect(m.html).toContain("Créer mon accès");
    expect(`${m.text}${m.html}`).not.toMatch(/mot de passe :|code d'accès/i);
    const r = invitationContent("reset", { firstName: null, project: "Refonte", link });
    expect(r.text).toMatch(/^Bonjour,/);
    expect(r.text).toMatch(/24 heures/);
  });
});
