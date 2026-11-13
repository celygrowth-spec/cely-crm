"""Applique fix_mails.json (e-mails récupérés pour les leads non contactables) aux fichiers c*.json."""
import json, glob, os, re, unicodedata
L = os.path.dirname(os.path.abspath(__file__)) + "/"
n = lambda x: re.sub(r"[^a-z]", "", unicodedata.normalize("NFKD", x or "").encode("ascii", "ignore").decode().lower())
fx = {n(f["prenom"] + f["nom"]): f for f in json.load(open(L + "fix_mails.json"))}
k = 0
for p in sorted(glob.glob(L + "c[0-9]*.json")):
    if "raw" in p: continue
    d = json.load(open(p)); ch = False
    for r in d:
        f = fx.get(n(r["prenom"] + r["nom"]))
        if not f or r.get("email"): continue
        if f.get("format_email_suppose") and "non confirm" not in f["format_email_suppose"].lower():
            r["format_email_suppose"] = f["format_email_suppose"]; ch = True; k += 1
        elif f.get("email_generique"):
            r["email_generique"] = f["email_generique"]; ch = True; k += 1
    if ch: json.dump(d, open(p, "w"), ensure_ascii=False, indent=1)
print("leads complétés :", k)
