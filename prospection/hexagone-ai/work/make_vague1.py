"""Construit la vague 1 (vague1/Hexagone_AI_vague1_leads.csv) depuis la dernière version des leads.
Règle : score A + adresse utilisable (domaine avec MX) + statut ≠ « à vérifier » + pas de mention « à arbitrer / à vérifier » dans la qualification.
Aucun contact déjà approché par Mariia (ils ont été retirés en amont)."""
import openpyxl, csv, re, os, collections
L = os.path.dirname(os.path.abspath(__file__)) + "/"
wb = openpyxl.load_workbook(L + "../Hexagone_AI_leads_M1_V4.xlsx"); ws = wb["Tous"]
h = [c.value for c in ws[1]]; rows = [dict(zip(h, r)) for r in ws.iter_rows(min_row=2, values_only=True)]
SEG = {1: "C_cabinet_premier_contact", 2: "C_cabinet_premier_contact", 3: "P_partenaire_anthropic", 4: "D_direction_juridique"}
W, skip = [], collections.Counter()
for r in rows:
    if r["score_priorite"] != "A": continue
    if not r["email_a_utiliser"] or str(r["dns_verdict"]).startswith(("PAS", "ERR")): skip["pas d'adresse envoyable"] += 1; continue
    if r["statut_verification"] == "à vérifier" or re.search(r"à arbitrer|à vérifier|a verifier", str(r["qualif_commentaire"] or ""), re.I): skip["à vérifier avant envoi"] += 1; continue
    if not r["accroche"]: skip["pas d'accroche"] += 1; continue
    W.append(r)
F = ["email","firstName","lastName","companyName","jobTitle","linkedinUrl","salutation","ligne_attention","segment","cible","score","accroche","douleur_confidentialite","email_type","dns_verdict","perso_faits","source_contact"]
os.makedirs(L + "../vague1", exist_ok=True)
with open(L + "../vague1/Hexagone_AI_vague1_leads.csv", "w", newline="", encoding="utf-8-sig") as f:
    w = csv.DictWriter(f, fieldnames=F); w.writeheader()
    for r in sorted(W, key=lambda r: (SEG[r["cible"]], r["entreprise"] or "")):
        avocat = r["cible"] == 1 and re.search(r"avocat|associ|lawyer|counsel", str(r["poste"]), re.I)
        civ = f"Maître {r['prenom']} {r['nom']}" if avocat else f"{r['prenom']} {r['nom']}"
        w.writerow(dict(email=r["email_a_utiliser"], firstName=r["prenom"], lastName=r["nom"], companyName=re.sub(r"\s*\(.*?\)", "", r["entreprise"] or "").strip(),
            jobTitle=r["poste"], linkedinUrl=r["linkedin_url"] or "", salutation=(f"Maître {r['nom']}" if avocat else f"Bonjour {r['prenom']}"),
            ligne_attention=(f"À l'attention de {civ}" if r["email_a_utiliser_type"] == "générique" else ""), segment=SEG[r["cible"]], cible=r["cible"], score=r["score_priorite"],
            accroche=r["accroche"], douleur_confidentialite=r["douleur_confidentialite"], email_type=r["email_a_utiliser_type"], dns_verdict=r["dns_verdict"],
            perso_faits=r["perso_faits"], source_contact=r["source_contact"]))
print("vague 1 :", len(W), dict(collections.Counter(SEG[r["cible"]] for r in W)), "| écartés", dict(skip), "| types", dict(collections.Counter(r["email_a_utiliser_type"] for r in W)))
