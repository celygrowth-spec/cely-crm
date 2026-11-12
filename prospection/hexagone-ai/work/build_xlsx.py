import json, glob, csv, re
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter
import os; L = os.path.dirname(os.path.abspath(__file__)) + "/"
COLS = ["cible","entreprise","site_web","taille","ville","specialite_secteur","prenom","nom","poste","linkedin_url","email","email_generique","format_email_suppose","signal","source_signal","source_contact","perso_angle","score_priorite","statut_verification","date_recherche"]
DNS = ["email_a_utiliser","email_a_utiliser_type","dns_mx","dns_spf","dns_dmarc","dns_verdict"]
rows = []
import sys, unicodedata; sys.path.insert(0, L)
from dns_check import FILES, email_domain, EMAIL_RE
DNSC = json.load(open(L+"dns_cache.json")) if os.path.exists(L+"dns_cache.json") else {}
def _ascii(x): return re.sub(r"[^a-z]", "", unicodedata.normalize("NFKD", x or "").encode("ascii","ignore").decode().lower())
def email_envoi(r):
    """E-mail publié, sinon adresse déduite (seulement si elle contient le nom de la personne)."""
    if r.get("email"): return r["email"].strip(), "publié"
    for m in EMAIL_RE.finditer(str(r.get("format_email_suppose") or "")):
        loc = _ascii(m.group(0).split("@")[0]); nom = _ascii(r.get("nom"))
        if nom and nom[:5] in loc and "non confirm" not in str(r.get("format_email_suppose")).lower(): return m.group(0).strip(".,;)"), "déduit (motif observé)"
    m = EMAIL_RE.search(str(r.get("email_generique") or ""))
    if m: return m.group(0).strip(".,;)"), "générique"
    return "", ""
for f in [f for f in FILES if os.path.exists(L+f+".json")]:
    for r in json.load(open(L+f+".json")):
        r["email_a_utiliser"], r["email_a_utiliser_type"] = email_envoi(r)
        r.update(DNSC.get(email_domain(r), {}))
        r["segment"] = f.upper(); rows.append(r)
rows.sort(key=lambda r: (int(r["cible"]), r["score_priorite"], r.get("entreprise") or "zz"))
HEAD = ["segment"]+COLS+DNS
fill = {"A":"C6EFCE","B":"FFEB9C","C":"F4CCCC"}
def sheet(ws, data, head):
    ws.append(head)
    for c in ws[1]: c.font = Font(bold=True, color="FFFFFF"); c.fill = PatternFill("solid", fgColor="1F3864")
    for r in data:
        ws.append([r.get(h, "") if not isinstance(r.get(h), (list, dict)) else json.dumps(r.get(h), ensure_ascii=False) for h in head])
        if "score_priorite" in head:
            ws.cell(ws.max_row, head.index("score_priorite")+1).fill = PatternFill("solid", fgColor=fill.get(r.get("score_priorite"), "FFFFFF"))
    for i, h in enumerate(head, 1):
        w = {"signal":60,"perso_angle":60,"poste":40,"source_signal":40,"source_contact":40,"entreprise":28,"linkedin_url":38,"taille":25,"specialite_secteur":30}.get(h, 16)
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = "C2"; ws.auto_filter.ref = ws.dimensions
wb = Workbook(); s = wb.active; s.title = "Synthèse"
from collections import Counter
s.append(["Hexagone AI × Cely — Listes M1 — V1 (recherche du 2026-11-12)"]); s["A1"].font = Font(bold=True, size=14)
s.append([]); s.append(["Cible","Objectif","Obtenus","A","B","C","Vérifié","Déduit","À vérifier","Avec LinkedIn","E-mail publié","E-mail déduit","Générique seul","Domaine sans MX"])
for c in s[3]: c.font = Font(bold=True)
names = {1:"1 · Avocats d'affaires",2:"2 · Expertise comptable",3:"3 · Partenaires Anthropic",4:"4 · Directions juridiques"}
goal = {1:55,2:35,3:30,4:30}
for k in [1,2,3,4]:
    d = [r for r in rows if int(r["cible"])==k]; sc = Counter(r["score_priorite"] for r in d); st = Counter(r["statut_verification"] for r in d)
    s.append([names[k], goal[k], len(d), sc["A"], sc["B"], sc["C"], st["vérifié"], st["déduit"], st["à vérifier"], sum(1 for r in d if r.get("linkedin_url")), sum(1 for r in d if r.get("email")), sum(1 for r in d if r["email_a_utiliser_type"].startswith("déduit")), sum(1 for r in d if r["email_a_utiliser_type"]=="générique"), sum(1 for r in d if r.get("dns_verdict","").startswith("PAS DE MX"))])
s.append(["TOTAL", 150, len(rows), *[sum(1 for r in rows if r["score_priorite"]==x) for x in "ABC"], *[sum(1 for r in rows if r["statut_verification"]==x) for x in ["vérifié","déduit","à vérifier"]], sum(1 for r in rows if r.get("linkedin_url")), sum(1 for r in rows if r.get("email")), sum(1 for r in rows if r["email_a_utiliser_type"].startswith("déduit")), sum(1 for r in rows if r["email_a_utiliser_type"]=="générique"), sum(1 for r in rows if r.get("dns_verdict","").startswith("PAS DE MX"))])
s.append([])
NOTES = open(L+"notes_v1.txt").read().splitlines() if os.path.exists(L+"notes_v1.txt") else []
for line in NOTES: s.append([line])
s.column_dimensions["A"].width = 32
for k in range(2,12): s.column_dimensions[get_column_letter(k)].width = 13
sheet(wb.create_sheet("Tous"), rows, HEAD)
for k in [1,2,3,4]:
    sheet(wb.create_sheet(f"Cible {k}"), [r for r in rows if int(r["cible"])==k], HEAD)
# Cible 3 firm list
md = open(L+"c3_cabinets.md").read().split("\n")
def table(start, stop):
    out=[]; hdr=None
    for ln in md[start:stop]:
        if ln.startswith("|") and not re.match(r"^\|[\s\-|:]+\|$", ln):
            cells=[c.strip().replace("**","") for c in ln.strip("|").split("|")]
            if hdr is None: hdr=cells
            else: out.append(dict(zip(hdr,cells)))
    return hdr, out
idx = {l: i for i, l in enumerate(md) if l.startswith("## ")}
keys = sorted(idx.values())
def sec(prefix):
    a = [i for l, i in idx.items() if l.startswith(prefix)][0]; b = min([k for k in keys if k > a] + [len(md)]); return a, b
for title, pre in [("C3 cabinets retenus","## Étape 1"),("C3 rejetés","## Cabinets testés"),("C3 annexe FR-Benelux","## Annexe A")]:
    h, d = table(*sec(pre))
    if h: sheet(wb.create_sheet(title), d, h)
# pistes
P = [
 ("1","Saint-Louis Avocats","Lauréat JINOV 2026 « Meilleure solution IA dans un cabinet d'avocats » — contact à identifier"),
 ("1","Kalder","Cabinet d'affaires pour entreprises innovantes, fondateur actif en droit de l'IA"),
 ("1","Caprioli & Associés / Vercken & Gaullier / Pierrat & Associés / Sekri Valentin Zerrouk / Lawways / entropy.law / Kohen Avocats","Boutiques numérique-IT-PI à qualifier"),
 ("1","Lexing (Alain Bensoussan)","Très fort signal IA, taille possiblement > 50 avocats → à vérifier"),
 ("1","Adaltys","Client déclaré de l'outil IA Haiku"),
 ("1","Solvoxia (Nantes) / Soulier Avocats (Lyon) / Akilys (Lyon) / Forward & Stack Avocats (Bordeaux) / Arvor (Rennes)","Signaux IA en régions, contacts à identifier"),
 ("1","Témoignages clients doctrine.fr/avis et blog Jimini","Mine de cabinets utilisateurs d'IA (signal) — inaccessibles depuis la session"),
 ("2","Vincent Lacomme, Vénissien Ducarré (Aum Conseil), Julien Younes (Auris Advisory), Nexco, Elisa Tomasini-Bartoli (FIFM)","EC actifs sur l'IA, cabinet / localisation à confirmer"),
 ("2","Cyril Degrilart, Luc Vandenbeuck (Lille), Régis Ouazou (Quimper), Cyril de Sousa Cardoso","EC à vérifier"),
 ("2","Podcasts Les Geeks des Chiffres / CodEC / Accounting Business Club (Ausha)","Meilleure source d'EC parlant d'IA"),
 ("3","Wesype","Partenaire Claude citant Legal, Accounting, Private Equity, secure AI → priorité n°1 cible 3"),
 ("3","Sia, SFEIR, Galadrim, Eleven Labs, Talan","Partenaires déclarant le secteur Professional & Legal Services"),
 ("4","Banques, mutuelles, énergie, défense","Peu couverts dans cette V0 (seulement BNP, Covéa, CCR, Thales)"),
]
if os.path.exists(L+"pistes_v1.json"): P = [tuple(x) for x in json.load(open(L+"pistes_v1.json"))]
sheet(wb.create_sheet("Pistes à creuser"), [dict(cible=a, piste=b, pourquoi=c) for a,b,c in P], ["cible","piste","pourquoi"])
out = L + "../Hexagone_AI_leads_M1_V1.xlsx"; wb.save(out)
# Lemlist : uniquement les lignes avec une adresse à utiliser (nominative publiée > déduite d'un motif observé > générique) sur un domaine qui a un MX
send = [r for r in rows if r["email_a_utiliser"] and not r.get("dns_verdict","").startswith(("PAS DE MX","ERREUR"))]
with open(L + "../Hexagone_AI_leads_M1_V1_lemlist.csv","w",newline="",encoding="utf-8-sig") as f:
    w = csv.DictWriter(f, fieldnames=COLS+["email_a_utiliser","email_a_utiliser_type","dns_verdict"], extrasaction="ignore"); w.writeheader(); [w.writerow(r) for r in send]
print("lemlist:", len(send))
print(out, len(rows))
