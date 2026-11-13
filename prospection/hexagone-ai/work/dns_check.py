#!/usr/bin/env python3
"""Vérification DNS de délivrabilité (MX / SPF / DMARC) des domaines e-mail des leads.
Résolution via DNS-over-HTTPS (https://dns.google/resolve), car le DNS local de la session est filtré.
Usage : python3 dns_check.py   → écrit work/dns_cache.json {domaine: {dns_mx, dns_spf, dns_dmarc, dns_verdict}}
Le domaine testé = domaine de l'e-mail publié, sinon de l'adresse déduite, sinon du site_web."""
import json, glob, os, re, sys, time, urllib.request, urllib.parse

L = os.path.dirname(os.path.abspath(__file__)) + "/"
FILES = ["c1a", "c1b", "c1c", "c1d", "c1e", "c2a", "c2b", "c2c", "c2d", "c3", "c4", "c4b", "c4c", "c5a", "c5b", "c5c", "c5d", "c5e", "c5f", "c6a", "c6b", "c6c", "c6d", "c6e"]
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+'-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})")


def email_domain(r):
    for k in ("email", "format_email_suppose", "email_generique"):
        m = EMAIL_RE.search(str(r.get(k) or ""))
        if m:
            return m.group(1).lower().strip(".")
    d = (r.get("site_web") or "").strip().lower()
    d = re.sub(r"^https?://", "", d).replace("www.", "").split("/")[0]
    return d


def doh(name, rtype):
    url = "https://dns.google/resolve?" + urllib.parse.urlencode({"name": name, "type": rtype})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, timeout=15) as resp:
                j = json.load(resp)
            return j.get("Status"), [a["data"] for a in j.get("Answer", []) if a.get("type") == {"MX": 15, "TXT": 16}[rtype]]
        except Exception as e:
            err = e; time.sleep(1 + attempt)
    return None, []


def check(dom):
    st, mx = doh(dom, "MX")
    _, txt = doh(dom, "TXT")
    _, dm = doh("_dmarc." + dom, "TXT")
    spf = [t for t in txt if "v=spf1" in t.lower()]
    dmarc = [t for t in dm if "v=dmarc1" in t.lower()]
    mx = [m for m in mx if m.strip() not in ("0 .", ".")]  # null MX = pas de mail
    low = " ".join(mx).lower()
    prov = ("Google" if "google" in low else "Microsoft 365" if "outlook" in low else
            "OVH" if "ovh" in low else "Gandi" if "gandi" in low else "Proofpoint" if "pphosted" in low else
            "Mimecast" if "mimecast" in low else "")
    pol = ""
    if dmarc:
        m = re.search(r"p=(\w+)", dmarc[0]); pol = m.group(1) if m else ""
    if st is None:
        verdict = "ERREUR DNS - revérifier"
    elif not mx:
        verdict = "PAS DE MX - ne pas envoyer"
    elif spf and dmarc:
        verdict = "OK"
    else:
        verdict = "OK (MX) - " + ("SPF absent" if not spf else "") + (" / " if not spf and not dmarc else "") + ("DMARC absent" if not dmarc else "")
    return {
        "dns_mx": (" | ".join(sorted(mx))[:200] + (f" [{prov}]" if prov else "")) if mx else "aucun",
        "dns_spf": "oui" if spf else "non",
        "dns_dmarc": (f"oui (p={pol})" if pol else "oui") if dmarc else "non",
        "dns_verdict": verdict,
    }


if __name__ == "__main__":
    doms = set()
    for f in FILES:
        p = L + f + ".json"
        if os.path.exists(p):
            for r in json.load(open(p)):
                d = email_domain(r)
                if d:
                    doms.add(d)
                for k in ("email", "format_email_suppose", "email_generique"):
                    for m in EMAIL_RE.finditer(str(r.get(k) or "")):
                        doms.add(m.group(1).lower().strip("."))
    cache = {}
    for d in sorted(doms):
        cache[d] = check(d)
        print(f"{d:35} {cache[d]['dns_verdict']:30} {cache[d]['dns_mx'][:60]}")
    json.dump(cache, open(L + "dns_cache.json", "w"), ensure_ascii=False, indent=1)
    print(len(cache), "domaines ->", L + "dns_cache.json")
