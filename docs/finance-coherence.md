# Finance : règles de cohérence (audit, lot 3)

## Un revenu, ses factures, sa vente : toujours le même client (C04)
- Contrôle en base, quel que soit le chemin (formulaires, Claude, scripts) : une facture ne vise que le revenu de son
  client, un avoir reste chez le client de sa facture, une vente ne pointe que vers un revenu de son client. Le
  contrôle se fait en fin de transaction : une fusion qui déplace revenus et factures ensemble reste possible.
- Un revenu lié à une vente, ou déjà facturé, ne change pas de client (fusionnez les fiches, ou créez un revenu).
- Modification partielle : un champ absent reste inchangé ; `mission_id: null` retire explicitement le lien.
- Chaque facture rattachée à un revenu couvre une échéance précise : la date demandée, sinon l'échéance non facturée
  la plus proche de la date d'émission. Une échéance mensuelle n'est jamais facturée deux fois.
- Référence de facture unique par client ; pour un ponctuel, le total facturé ne dépasse pas le montant prévu.

## États d'encaissement (C05) — même règle en base (`finance_revenue_state`) et dans l'interface
| Ponctuel | Mensuel |
| --- | --- |
| Prévu · Date passée (rien facturé) · À encaisser · En retard · **Partiellement encaissé** · **Encaissé** (tout facturé ET réglé) | Prévu (aucune échéance due) · **À jour** · **Partiellement réglé** · **En retard** (facture en retard ou échéance passée non facturée) · Terminé |

- Revenu mensuel récurrent et clients actifs : un contrat dont la date de fin est passée n'est plus compté.
- Annuler un paiement déjà remboursé est refusé (jamais d'encaissé négatif).
- Un avoir réduit ce que le client doit, pas l'engagement : le « reste à facturer » se calcule sur le facturé brut.
  Réduire aussi le montant prévu du revenu est une case explicite dans le formulaire d'avoir.

## Acompte puis solde (Q06)
Un ponctuel accepte plusieurs factures tant que le total ne dépasse pas le montant prévu. Après un acompte, le détail et
la liste proposent « Encaisser le solde (X €) » en un clic.

## Un seul formulaire de revenu (K02)
Finance › Revenus, Finance › Revenus par client (ex « Clients actifs ») et « Marquer comme gagné » utilisent le même
composant (`RevenueTerms`) et la même règle (`revenueTermsError`) : ponctuel ou mensuel, montant, date prévue ou date
de début, date de fin facultative pour un mensuel, aperçu des échéances. L'ancien formulaire « Mission » est retiré.
« Enregistrer une facture » reste disponible pour une facture émise ailleurs.

## Calculs (K14)
- Prévisions de trésorerie : les échéances estimées sont comptées TTC (taux de la dernière facture du revenu, sinon
  20 % si la TVA est activée), comme les factures « prévu » ; la base des cotisations reste HT.
- Arrondis : TTC = HT + arrondi au centime de HT × taux, identique en base et dans l'interface.
- Une écriture Finance rafraîchit aussi Ventes et la fiche.
