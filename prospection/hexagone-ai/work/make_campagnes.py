"""Répartit TOUS les leads de la dernière base dans 5 campagnes (pas de vagues) et écrit un CSV par campagne dans ../campagnes/.
1 Avocats · 2 Experts-comptables · 3 Partenaires Anthropic · 4 Directions juridiques : leads avec une adresse utilisable (domaine avec MX).
5 LinkedIn uniquement : leads sans adresse mais avec un profil LinkedIn. Les autres = non contactables tels quels."""
import openpyxl, csv, re, os, json, collections
L = os.path.dirname(os.path.abspath(__file__)) + "/"
wb = openpyxl.load_workbook(L + "../Hexagone_AI_leads_M1_V6.xlsx"); ws = wb["Tous"]
h = [c.value for c in ws[1]]; rows = [dict(zip(h, r)) for r in ws.iter_rows(min_row=2, values_only=True)]
CAMP = {1: "1 · Avocats", 2: "2 · Experts-comptables", 3: "3 · Partenaires Anthropic", 4: "4 · Directions juridiques", 5: "5 · LinkedIn uniquement"}
FILE = {1: "C1_avocats", 2: "C2_experts_comptables", 3: "C3_partenaires_anthropic", 4: "C4_directions_juridiques", 5: "C5_linkedin_uniquement"}
F = ["email","firstName","lastName","companyName","jobTitle","linkedinUrl","salutation","ligne_attention","accroche","douleur_confidentialite","score","statut_verification","a_verifier","email_type","perso_faits","source_contact"]
out = collections.defaultdict(list); assign = {}
LIMIT = 350
def rank(r):
    mail = bool(r["email_a_utiliser"]) and not str(r["dns_verdict"]).startswith(("PAS", "ERR"))
    flag = r["statut_verification"] == "à vérifier" or bool(re.search(r"à arbitrer|à vérifier", str(r["qualif_commentaire"] or ""), re.I))
    ch = {"publié": 0, "générique": 2}.get(r["email_a_utiliser_type"], 1) if mail else 3
    mat = str(r["maturite_ia"] or "0")[:1]
    return (flag, {"A": 0, "B": 1, "C": 2}.get(r["score_priorite"], 3), ch, -int(mat) if mat.isdigit() else 0)
contactable = [r for r in rows if (r["email_a_utiliser"] and not str(r["dns_verdict"]).startswith(("PAS", "ERR"))) or r["linkedin_url"]]
contactable.sort(key=rank)
selected = {f"{r['prenom']}|{r['nom']}" for r in contactable[:LIMIT]}
reserve = []
for r in rows:
    mail = bool(r["email_a_utiliser"]) and not str(r["dns_verdict"]).startswith(("PAS", "ERR"))
    k = r["cible"] if mail else (5 if r["linkedin_url"] else None)
    key = f"{r['prenom']}|{r['nom']}"
    if k and key not in selected:
        assign[key] = "Réserve"; reserve.append((k, r)); k = None; continue
    assign[key] = CAMP[k] if k else "Non contactable (ni e-mail ni LinkedIn)"
    if not k: continue
    avocat = r["cible"] == 1 and re.search(r"avocat|associ|lawyer|counsel|fondat", str(r["poste"]), re.I)
    civ = f"Maître {r['prenom']} {r['nom']}" if avocat else f"{r['prenom']} {r['nom']}"
    flag = "oui" if (r["statut_verification"] == "à vérifier" or re.search(r"à arbitrer|à vérifier", str(r["qualif_commentaire"] or ""), re.I)) else ""
    out[k].append(dict(email=r["email_a_utiliser"] if mail else "", firstName=r["prenom"], lastName=r["nom"], companyName=re.sub(r"\s*\(.*?\)", "", r["entreprise"] or "").strip(),
        jobTitle=r["poste"], linkedinUrl=r["linkedin_url"] or "", salutation=(f"Maître {r['nom']}" if avocat else f"Bonjour {r['prenom']}"),
        ligne_attention=(f"À l'attention de {civ}" if mail and r["email_a_utiliser_type"] == "générique" else ""), accroche=r["accroche"],
        douleur_confidentialite=r["douleur_confidentialite"], score=r["score_priorite"], statut_verification=r["statut_verification"], a_verifier=flag,
        email_type=r["email_a_utiliser_type"] if mail else "", perso_faits=r["perso_faits"], source_contact=r["source_contact"]))
for k, lst in out.items():
    lst.sort(key=lambda x: (x["score"], x["companyName"]))
    with open(L + f"../campagnes/{FILE[k]}.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=F); w.writeheader(); w.writerows(lst)
with open(L + "../campagnes/RESERVE.csv", "w", newline="", encoding="utf-8-sig") as f:
    w = csv.writer(f); w.writerow(["campagne_prevue","prenom","nom","entreprise","poste","email","type_email","linkedin","score","statut_verification","pourquoi_en_reserve"])
    for k, r in reserve:
        mail = bool(r["email_a_utiliser"]) and not str(r["dns_verdict"]).startswith(("PAS", "ERR"))
        why = "à vérifier" if rank(r)[0] else ("adresse générique" if r["email_a_utiliser_type"] == "générique" else ("LinkedIn seulement" if not mail else "score plus bas"))
        w.writerow([CAMP[r["cible"]] if mail else CAMP[5], r["prenom"], r["nom"], r["entreprise"], r["poste"], r["email_a_utiliser"] if mail else "", r["email_a_utiliser_type"] if mail else "", r["linkedin_url"] or "", r["score_priorite"], r["statut_verification"], why])
json.dump(assign, open(L + "campagnes_assign.json", "w"), ensure_ascii=False, indent=1)
print({CAMP[k]: len(v) for k, v in sorted(out.items())}, "| réserve", len(reserve), "| non contactables", sum(1 for v in assign.values() if v.startswith("Non")), "| à vérifier", sum(1 for v in out.values() for x in v if x["a_verifier"]))
