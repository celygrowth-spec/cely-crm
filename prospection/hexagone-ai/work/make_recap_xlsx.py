import openpyxl, csv, json, re, os
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation
B='/home/user/cely-crm/prospection/hexagone-ai/'
src=openpyxl.load_workbook(B+'Hexagone_AI_leads_M1_V6.xlsx'); ws=src['Tous']
h=[c.value for c in ws[1]]; L=[dict(zip(h,r)) for r in ws.iter_rows(min_row=2,values_only=True)]
import glob
FILECAMP={'C1':'1 · Avocats','C2':'2 · Experts-comptables','C3':'3 · Partenaires Anthropic','C4':'4 · Directions juridiques','C5':'5 · LinkedIn uniquement'}
V=[dict(r,_camp=FILECAMP[os.path.basename(p)[:2]]) for p in sorted(glob.glob(B+'campagnes/C*.csv')) for r in csv.DictReader(open(p,encoding='utf-8-sig'))]
ASSIGN=json.load(open(B+'work/campagnes_assign.json'))
RET=json.load(open(B+'work/retires_v2.json'))
CAMP={}
CIB={1:'Avocats',2:'Experts-comptables',3:'Partenaires Anthropic',4:'Directions juridiques'}
vk={(r['firstName'],r['lastName']):r for r in V}
FLAG=re.compile(r"à arbitrer|à vérifier|a verifier",re.I)
def camp(r): return ASSIGN.get(f"{r['prenom']}|{r['nom']}",'Non contactable (ni e-mail ni LinkedIn)')
def hist(r):
    t=str(r['relation_linkedin'] or '')
    if 'a répondu' in t: return 'A déjà répondu à Mariia'
    if 'sans réponse' in t: return 'Contacté par Mariia, sans réponse'
    if t.strip(): return 'Relation / suivi, sans échange'
    return 'Aucun lien'
def deliv(r):
    v=str(r['dns_verdict'] or '')
    if not r['email_a_utiliser']: return 'Pas d\'adresse'
    if v.startswith('PAS'): return 'NE PAS ENVOYER (domaine sans MX)'
    return 'OK'
def etype(t): return {'publié':'Nominatif publié','générique':'Générique (contact@…)'}.get(t, 'Nominatif déduit' if t and t.startswith('déduit') else '—')
def mat(x): x=str(x or ''); return x[:1] if x[:1] in '0123' else ''

AR=Font(name='Arial',size=10); ARB=Font(name='Arial',size=10,bold=True); HF=Font(name='Arial',size=10,bold=True,color='FFFFFF')
NAVY=PatternFill('solid',fgColor='1F3864'); GREY=PatternFill('solid',fgColor='F2F2F2')
SC={'A':'C6EFCE','B':'FFEB9C','C':'F4CCCC'}
CC={'1 · ':'E2EFDA','2 · ':'DDEBF7','3 · ':'FCE4D6','4 · ':'FFF2CC','5 · ':'EDE2F6'}
thin=Side(style='thin',color='D9D9D9'); BD=Border(bottom=thin)
WR=Alignment(wrap_text=True,vertical='top'); TOP=Alignment(vertical='top')
def table(wsx,head,rows,widths,wrapcols=(),start=1):
    for j,hd in enumerate(head,1):
        c=wsx.cell(start,j,hd); c.font=HF; c.fill=NAVY; c.alignment=Alignment(wrap_text=True,vertical='center')
    for i,row in enumerate(rows,start+1):
        for j,val in enumerate(row,1):
            c=wsx.cell(i,j,val); c.font=AR; c.border=BD
            c.alignment=WR if head[j-1] in wrapcols else TOP
    for j,w in enumerate(widths,1): wsx.column_dimensions[get_column_letter(j)].width=w
    wsx.freeze_panes=wsx.cell(start+1,3); wsx.auto_filter.ref=f"A{start}:{get_column_letter(len(head))}{start+len(rows)}"
    wsx.row_dimensions[start].height=30
def colorize(wsx,head,n,start=1):
    for i in range(start+1,start+1+n):
        if 'Priorité' in head:
            c=wsx.cell(i,head.index('Priorité')+1); c.fill=PatternFill('solid',fgColor=SC.get(c.value,'FFFFFF')); c.font=ARB; c.alignment=Alignment(horizontal='center',vertical='top')
        if 'Campagne' in head:
            c=wsx.cell(i,head.index('Campagne')+1); k=str(c.value)[:4]
            if k in CC: c.fill=PatternFill('solid',fgColor=CC[k])
        if 'Délivrabilité' in head:
            c=wsx.cell(i,head.index('Délivrabilité')+1)
            if str(c.value).startswith('NE PAS'): c.font=Font(name='Arial',size=10,bold=True,color='C00000')
        for key in ('LinkedIn','Source (preuve)'):
            if key in head:
                c=wsx.cell(i,head.index(key)+1); v=str(c.value or '')
                m=re.search(r'https?://\S+',v)
                if m: c.hyperlink=m.group(0).rstrip(';,)'); c.font=Font(name='Arial',size=10,color='0563C1',underline='single')

wb=Workbook()
# ---------- Lisez-moi
rd=wb.active; rd.title='Lisez-moi'
lines=[('Hexagone AI × Cely — Prospects et campagnes',True,14),('Mis à jour le 13/11/2026 · 423 prospects · 5 campagnes, tous les prospects contactables sont dedans (395) · aucun prospect déjà contacté par Mariia',False,10),('',False,10),
('LES ONGLETS',True,11),
('Tableau de bord — les chiffres clés (se recalculent si vous modifiez les onglets).',False,10),
('Campagnes — les 5 campagnes : pour qui, quel angle, quelles étapes, combien de prospects.',False,10),
('Prospects par campagne — les 395 prospects contactables, rangés par campagne, avec l\'accroche de chacun et une colonne Statut à mettre à jour.',False,10),
('Tous les leads — les 423 prospects avec leur campagne (ou « Non contactable » s\'il n\'y a ni e-mail ni LinkedIn).',False,10),
('Séquences — le texte exact de chaque e-mail / message LinkedIn, étape par étape.',False,10),
('Retirés — les prospects écartés et pourquoi.',False,10),('',False,10),
('LES 5 CAMPAGNES',True,11),
('1 · Avocats · 2 · Experts-comptables · 3 · Partenaires Anthropic (angle partenariat) · 4 · Directions juridiques : e-mail + LinkedIn.',False,10),
('5 · LinkedIn uniquement : prospects sans e-mail trouvé mais avec un profil LinkedIn (invitation + messages).',False,10),
('Colonne « À vérifier » = oui : poste ou adresse encore à confirmer — à relire ou retirer avant l\'envoi.',False,10),('',False,10),
('COMMENT LIRE UN PROSPECT',True,11),
('Priorité A = décideur + signal IA concret et sourcé · B = décideur + un signal (IA du cabinet ou relation) · C = décideur sans signal IA public (accroche liée au métier).',False,10),
('Maturité IA (0-3) : 0 aucune trace · 1 parle de l\'IA · 2 utilise un outil IA nommé · 3 construit ou vend sa propre IA.',False,10),
('Type d\'e-mail : nominatif publié · nominatif déduit (format observé sur une vraie adresse du même domaine) · générique (contact@…, avec « À l\'attention de »).',False,10),
('Accroche : première phrase de l\'e-mail, écrite à partir de faits publics datés et sourcés (colonne « Faits / preuves »), ou liée au métier pour les C.',False,10)]
for i,(t,b,s) in enumerate(lines,1):
    c=rd.cell(i,1,t); c.font=Font(name='Arial',size=s,bold=b,color='1F3864' if b else '000000'); c.alignment=Alignment(wrap_text=True,vertical='top')
rd.column_dimensions['A'].width=140

# ---------- Tous les leads
HT=['Campagne','Priorité','Cible','Entreprise','Prénom','Nom','Poste','Ville','E-mail à utiliser','Type d\'e-mail','Délivrabilité','LinkedIn','Historique Mariia','Origine','Maturité IA (0-3)','Pourquoi lui (douleur confidentialité)','Accroche (1re phrase de l\'e-mail)','Signal IA','Faits / preuves','Source (preuve)','À savoir / qualification','Statut']
order={}
rows=[]
for r in L:
    cp=camp(r)
    rows.append([cp,r['score_priorite'],CIB[r['cible']],r['entreprise'],r['prenom'],r['nom'],r['poste'],r['ville'],r['email_a_utiliser'] or '',etype(r['email_a_utiliser_type']),deliv(r),r['linkedin_url'] or '',hist(r),'Relations LinkedIn de Mariia' if str(r['origine']).startswith('relations') else ('Recherche V4 (13/11)' if 'V4' in str(r['origine']) else 'Recherche web'),mat(r['maturite_ia']),r['douleur_confidentialite'] or '',r['accroche'] or '',r['signal'] or '',r['perso_faits'] or '',r['source_contact'] or '',r['qualif_commentaire'] or '','À contacter' if not cp.startswith('Non') else ''])
rows.sort(key=lambda x:(x[0].startswith('Non'),x[0],x[1],x[3] or ''))
tl=wb.create_sheet('Tous les leads')
table(tl,HT,rows,[30,9,18,28,13,16,30,14,32,18,16,30,24,18,10,45,60,45,60,35,45,16],wrapcols=('Poste','Pourquoi lui (douleur confidentialité)','Accroche (1re phrase de l\'e-mail)','Signal IA','Faits / preuves','À savoir / qualification','Entreprise'))
colorize(tl,HT,len(rows)); NT=len(rows)
for i in range(2,NT+2): tl.row_dimensions[i].height=60

# ---------- Prospects par campagne
HP=['Campagne','Priorité','Cible','Entreprise','Prénom','Nom','Poste','E-mail à utiliser','Type d\'e-mail','Formule d\'appel','LinkedIn','À vérifier','Accroche (1re phrase de l\'e-mail)','Pourquoi lui (douleur confidentialité)','À faire avant envoi','Statut']
idx={(r['prenom'],r['nom']):r for r in L}
PR=[]
for v in V:
    r=idx[(v['firstName'],v['lastName'])]
    todo='Adresse générique : ligne « À l\'attention de » ajoutée' if v['email_type']=='générique' else ('E-mail déduit : vérifier le format' if v['email_type'].startswith('déduit') else ('Pas d\'e-mail : LinkedIn uniquement' if not v['email'] else '—'))
    PR.append([v['_camp'],r['score_priorite'],CIB[r['cible']],r['entreprise'],v['firstName'],v['lastName'],v['jobTitle'],v['email'],etype(v['email_type']) if v['email'] else '—',v['salutation'],v['linkedinUrl'],v['a_verifier'],v['accroche'],v['douleur_confidentialite'],todo,'À contacter'])
PR.sort(key=lambda x:(x[0],x[1],x[3] or ''))
pc=wb.create_sheet('Prospects par campagne',1)
table(pc,HP,PR,[32,9,18,28,13,16,30,32,18,18,30,24,65,45,30,16],wrapcols=('Poste','Accroche (1re phrase de l\'e-mail)','Pourquoi lui (douleur confidentialité)','Entreprise','À faire avant envoi'))
colorize(pc,HP,len(PR))
for i in range(2,len(PR)+2): pc.row_dimensions[i].height=75
dv=DataValidation(type='list',formula1='"À contacter,E-mail 1 envoyé,Relancé,A répondu – intéressé,A répondu – pas intéressé,RDV pris,Ne pas contacter"',allow_blank=True)
dv2=DataValidation(type='list',formula1='"À contacter,E-mail 1 envoyé,Relancé,A répondu – intéressé,A répondu – pas intéressé,RDV pris,Ne pas contacter"',allow_blank=True)
pc.add_data_validation(dv); dv.add(f"P2:P{len(PR)+1}")
tl.add_data_validation(dv2); dv2.add(f"V2:V{NT+1}")

# ---------- Campagnes
cg=wb.create_sheet('Campagnes',1)
HC=['Campagne','Pour qui','Angle du message','Étapes','Canal','Objet de l\'e-mail 1','Nb prospects','dont priorité A','dont adresse générique','Statut','Prérequis avant lancement']
CD=[
('1 · Avocats','Associés / fondateurs de cabinets d\'avocats (5-50 avocats)','Accroche personnalisée + ChatGPT/Claude sans exposer les dossiers + guide CNB / charte Barreau de Paris','J0 e-mail · J2 invitation LinkedIn · J5 relance · J12 clôture','E-mail + LinkedIn','{{companyName}} : ChatGPT et Claude sans exposer vos dossiers','Relire les lignes « À vérifier »'),
('2 · Experts-comptables','Associés / dirigeants de cabinets d\'expertise comptable','Secret professionnel et RGPD : l\'IA sur les dossiers clients sans les exposer','J0 e-mail · J2 invitation LinkedIn · J5 relance · J12 clôture','E-mail + LinkedIn','{{companyName}} : l\'IA sur les dossiers clients, sans les exposer','Relire les lignes « À vérifier »'),
('3 · Partenaires Anthropic','Décideurs IA chez les partenaires Claude (KPMG, Capgemini, IBM, Bain, BCG, Sia, SFEIR, Wesype, Galadrim…)','Partenariat / co-vente : brique de pseudonymisation pour leurs projets Claude chez des clients réglementés','J0 e-mail · J2 invitation LinkedIn · J6 relance · J13 clôture','E-mail + LinkedIn','Claude chez vos clients réglementés : une brique de pseudonymisation','Vérifier les e-mails déduits avec particule'),
('4 · Directions juridiques','Directeurs juridiques / DPO / legal ops de groupes','Secret des affaires : les juristes gardent ChatGPT / Claude, rien ne sort de l\'entreprise','J0 e-mail · J3 invitation LinkedIn · J8 relance · J15 clôture','E-mail + LinkedIn','IA générative et confidentialité à la direction juridique de {{companyName}}','Relire les lignes « À vérifier »'),
('5 · LinkedIn uniquement','Prospects sans e-mail trouvé, avec profil LinkedIn (toutes cibles)','Invitation avec note, puis message avec l\'accroche personnalisée','J0 visite + invitation · J1 message si accepté · J6 relance','LinkedIn','—','—')]
for j,hd in enumerate(HC,1):
    c=cg.cell(1,j,hd); c.font=HF; c.fill=NAVY; c.alignment=Alignment(wrap_text=True,vertical='center')
for i,d in enumerate(CD,2):
    vals=[d[0],d[1],d[2],d[3],d[4],d[5],
          f"=COUNTIF('Prospects par campagne'!$A:$A,A{i})",
          f"=COUNTIFS('Prospects par campagne'!$A:$A,A{i},'Prospects par campagne'!$B:$B,\"A\")",
          f"=COUNTIFS('Prospects par campagne'!$A:$A,A{i},'Prospects par campagne'!$I:$I,\"Générique*\")",
          'À lancer le 13/11/2026',d[6]]
    for j,v in enumerate(vals,1):
        c=cg.cell(i,j,v); c.font=AR; c.alignment=WR; c.border=BD
    cg.cell(i,1).fill=PatternFill('solid',fgColor=CC[d[0][:4]]); cg.cell(i,1).font=ARB
    cg.row_dimensions[i].height=60
n=len(CD)+2
cg.cell(n,1,'TOTAL').font=ARB
for col in 'GHI': cg[f'{col}{n}']=f'=SUM({col}2:{col}{n-1})'; cg[f'{col}{n}'].font=ARB
for j,w in enumerate([34,40,48,40,22,42,12,12,14,20,30],1): cg.column_dimensions[get_column_letter(j)].width=w
cg.freeze_panes='B2'
cg.cell(n+2,1,'Tous les prospects contactables sont dans une campagne. Les prospects sans e-mail ni LinkedIn sont listés « Non contactable » dans l\'onglet Tous les leads.').font=Font(name='Arial',size=10,italic=True)

# ---------- Séquences
sq=wb.create_sheet('Séquences')
md=open(B+'campagnes/SEQUENCES.md',encoding='utf-8').read()
HS=['Campagne','Étape','Jour','Canal','Objet','Message']
segmap={'## Campagne 1':'1 · Avocats','## Campagne 2':'2 · Experts-comptables','## Campagne 3':'3 · Partenaires Anthropic','## Campagne 4':'4 · Directions juridiques','## Campagne 5':'5 · LinkedIn uniquement'}
SR=[]
for block in re.split(r'\n(?=## Campagne )',md)[1:]:
    head=block.split('\n',1)[0]; cname=next(v for k,v in segmap.items() if head.startswith(k))
    for st in re.split(r'\n(?=\*\*J\d+)',block)[1:]:
        m=re.match(r'\*\*(J\d+) · ([^*]+)\*\*(.*)',st,re.S)
        if not m: continue
        jour,lab,rest=m.groups(); rest=rest.split('\n---')[0]
        obj=re.search(r'Objet : `([^`]+)`',rest); objet=obj.group(1) if obj else ('(même fil)' if 'E-mail' in lab else '')
        msg='\n'.join(l[2:] if l.startswith('> ') else ('' if l.strip()=='>' else l) for l in rest.splitlines() if not l.startswith('Objet'))
        msg=re.sub(r'\n{3,}','\n\n',msg).strip(' \n:')
        canal='LinkedIn' if ('LinkedIn' in lab or 'invitation' in lab.lower() or 'Message' in lab or ('Relance' in lab and cname.startswith('5'))) else 'E-mail'
        SR.append([cname,lab.strip(),jour,canal,objet,msg])
CLO="{{salutation}},\n\nJe ne voudrais pas encombrer votre boîte : je clos ce fil. Si la question de l'IA et de la confidentialité revient chez {{companyName}}, il suffit de répondre à ce message et je vous montre l'outil en 20 minutes.\n\nBonne continuation,\nMariia"
for x in SR:
    if x[5].startswith('identique au J12'): x[5]=CLO; x[4]='(même fil)'
SR.sort(key=lambda x:(x[0],int(x[2][1:])))
table(sq,HS,SR,[34,30,7,10,45,110],wrapcols=('Message','Objet','Étape'))
for i in range(2,len(SR)+2):
    sq.row_dimensions[i].height=max(30,min(300,15*(str(sq.cell(i,6).value).count('\n')+2)))
    k=str(sq.cell(i,1).value)[:4]; sq.cell(i,1).fill=PatternFill('solid',fgColor=CC.get(k,'FFFFFF'))
sq.cell(len(SR)+3,1,'Variables : {{salutation}} = « Maître Nom » ou « Bonjour Prénom » ; {{ligne_attention}} = « À l\'attention de … » pour les adresses génériques ; {{accroche}} = colonne Accroche du prospect ; {{companyName}} = cabinet / entreprise.').font=Font(name='Arial',size=10,italic=True)

# ---------- Retirés
rt=wb.create_sheet('Retirés')
table(rt,['Entreprise','Prénom','Nom','Poste','Pourquoi retiré'],[[r['entreprise'],r['prenom'],r['nom'],r['poste'],r['qualif_commentaire']] for r in RET],[30,14,18,40,100],wrapcols=('Pourquoi retiré','Poste'))

# ---------- Tableau de bord (formulas)
db=wb.create_sheet('Tableau de bord',1)
T="'Tous les leads'"
db['A1']='Tableau de bord — prospects Hexagone AI'; db['A1'].font=Font(name='Arial',size=14,bold=True,color='1F3864')
db['A2']='Calculé à partir de l\'onglet « Tous les leads » (se met à jour si vous le modifiez).'; db['A2'].font=Font(name='Arial',size=9,italic=True)
hd=['Cible','Prospects','Priorité A','Priorité B','Priorité C','Avec e-mail utilisable','Dans une campagne','Dont test à froid']
for j,x in enumerate(hd,1):
    c=db.cell(4,j,x); c.font=HF; c.fill=NAVY; c.alignment=Alignment(wrap_text=True,vertical='center')
for i,cb in enumerate(['Avocats','Experts-comptables','Partenaires Anthropic','Directions juridiques'],5):
    db.cell(i,1,cb).font=ARB
    f=[f'=COUNTIF({T}!$C:$C,A{i})',f'=COUNTIFS({T}!$C:$C,A{i},{T}!$B:$B,"A")',f'=COUNTIFS({T}!$C:$C,A{i},{T}!$B:$B,"B")',f'=COUNTIFS({T}!$C:$C,A{i},{T}!$B:$B,"C")',
       f'=COUNTIFS({T}!$C:$C,A{i},{T}!$K:$K,"OK")',f'=COUNTIFS({T}!$C:$C,A{i},{T}!$A:$A,"<>Non contactable*")',f'=COUNTIFS({T}!$C:$C,A{i},{T}!$U:$U,"TEST À FROID*")']
    for j,x in enumerate(f,2): db.cell(i,j,x).font=AR
db.cell(9,1,'TOTAL').font=ARB
for j in range(2,9):
    cl=get_column_letter(j); db.cell(9,j,f'=SUM({cl}5:{cl}8)').font=ARB
hd2=['Prospects par campagne','Prospects']
for j,x in enumerate(hd2,1):
    c=db.cell(11,j,x); c.font=HF; c.fill=NAVY
cats=[c for c in ['1 · Avocats','2 · Experts-comptables','3 · Partenaires Anthropic','4 · Directions juridiques','5 · LinkedIn uniquement','Non contactable (ni e-mail ni LinkedIn)']]
for i,cname in enumerate(cats,12):
    db.cell(i,1,cname).font=AR; db.cell(i,2,f'=COUNTIF({T}!$A:$A,A{i})').font=AR
    k=cname[:4]
    if k in CC: db.cell(i,1).fill=PatternFill('solid',fgColor=CC[k])
e=12+len(cats); db.cell(e,1,'TOTAL').font=ARB; db.cell(e,2,f'=SUM(B12:B{e-1})').font=ARB
hd3=['Suivi (colonne Statut, onglet Prospects par campagne)','Prospects']
for j,x in enumerate(hd3,1):
    c=db.cell(e+2,j,x); c.font=HF; c.fill=NAVY
for i,s in enumerate(['À contacter','E-mail 1 envoyé','Relancé','A répondu – intéressé','A répondu – pas intéressé','RDV pris','Ne pas contacter'],e+3):
    db.cell(i,1,s).font=AR; db.cell(i,2,f"=COUNTIF('Prospects par campagne'!$P:$P,A{i})").font=AR
db.column_dimensions['A'].width=42
for j in range(2,9): db.column_dimensions[get_column_letter(j)].width=16
db.row_dimensions[4].height=32
wb.move_sheet('Tableau de bord',-(len(wb.sheetnames)-2))
wb._sheets=[wb['Lisez-moi'],wb['Tableau de bord'],wb['Campagnes'],wb['Prospects par campagne'],wb['Tous les leads'],wb['Séquences'],wb['Retirés']]
out=B+'Hexagone_AI_Prospects_et_Campagnes.xlsx'; wb.save(out); print(out, 'leads',NT,'v1',len(PR),'steps',len(SR))
