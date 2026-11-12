#!/usr/bin/env python3
"""Vérification DNS de délivrabilité des domaines du fichier Hexagone_AI_leads_M1_V0.xlsx.
Usage (sur ta machine) :  pip install dnspython openpyxl  &&  python3 check_dns.py Hexagone_AI_leads_M1_V0.xlsx
Remplit les colonnes dns_mx / dns_spf / dns_dmarc / dns_verdict de l'onglet 'Tous'."""
import sys, openpyxl, dns.resolver
res = dns.resolver.Resolver(); res.lifetime = 8
def q(name, t):
    try: return [r.to_text() for r in res.resolve(name, t)]
    except Exception: return []
wb = openpyxl.load_workbook(sys.argv[1]); ws = wb["Tous"]
hdr = [c.value for c in ws[1]]; col = {h: i for i, h in enumerate(hdr)}
cache = {}
for row in ws.iter_rows(min_row=2):
    dom = (row[col["site_web"]].value or "").strip().lower().replace("www.", "").split("/")[0]
    em = row[col["email"]].value or row[col["format_email_suppose"]].value or ""
    if "@" in str(em): dom = str(em).split("@")[-1].split()[0].strip(").,")
    if not dom: continue
    if dom not in cache:
        mx = q(dom, "MX"); txt = q(dom, "TXT"); dm = q("_dmarc." + dom, "TXT")
        spf = [t for t in txt if "v=spf1" in t]
        prov = "Google" if any("google" in m.lower() for m in mx) else "Microsoft" if any("outlook" in m.lower() for m in mx) else ""
        verdict = "OK" if mx else "PAS DE MX - ne pas envoyer"
        cache[dom] = (" | ".join(mx)[:200] + (f" [{prov}]" if prov else ""), "oui" if spf else "non", "oui" if dm else "non", verdict)
        print(dom, cache[dom][3])
    for k, v in zip(["dns_mx", "dns_spf", "dns_dmarc", "dns_verdict"], cache[dom]):
        row[col[k]].value = v
wb.save(sys.argv[1]); print("OK ->", sys.argv[1])
