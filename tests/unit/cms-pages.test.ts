// CMS lot 3 : format d'import JSON des pages (« cely-cms-pages », version 1) et chemins.
import { expect, test } from "vitest";
import { normalizePath, parsePagesImport } from "@/lib/cms/pages";

test("chemins normalisés", () => {
  expect(normalizePath("offres")).toBe("/offres");
  expect(normalizePath("/offres/")).toBe("/offres");
  expect(normalizePath("https://www.celygrowth.com/blog/a?x=1#y")).toBe("/blog/a");
  expect(normalizePath("/")).toBe("/");
  expect(normalizePath("/a b")).toBeNull();
  expect(normalizePath("")).toBeNull();
});

test("format d'import : pages valides gardées, erreurs nommées", () => {
  const r = parsePagesImport(JSON.stringify({ format: "cely-cms-pages", version: 1, pages: [
    { path: "/", label: "Accueil", defaults: { title: " Cely ", description: "", noindex: false } },
    { path: "/offres/" },
    { path: "/offres" },
    { path: "/a b" },
  ] }));
  expect(r.pages).toEqual([
    { path: "/", label: "Accueil", defaults: { title: "Cely", description: null, noindex: false } },
    { path: "/offres", label: null, defaults: {} },
  ]);
  expect(r.errors).toEqual(["Chemin en double : /offres", "Chemin invalide : « /a b »"]);
  expect(parsePagesImport("{").errors[0]).toMatch(/illisible/);
  expect(parsePagesImport(JSON.stringify({ format: "autre", version: 1, pages: [] })).errors[0]).toMatch(/cely-cms-pages/);
  expect(parsePagesImport(JSON.stringify({ format: "cely-cms-pages", version: 1, pages: [{ path: "/", defaults: { og_image: "javascript:alert(1)" } }] })).errors[0]).toMatch(/http/);
});
