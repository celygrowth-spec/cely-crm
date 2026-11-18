# Make : scénarios lancés depuis le CRM

Paramètres › Connecteurs › **Make**. Le connecteur est générique : un scénario est un nom et l'adresse de son
webhook, ajouté sans code. Le premier attendu est **Créer le devis** (identifiant `creer_le_devis`, tiré du nom).

## Ce qui est protégé
- L'adresse d'un webhook est chiffrée par le serveur avant d'être enregistrée (clé dérivée de `APPOINTMENTS_SECRET`).
  Elle n'est jamais renvoyée au navigateur, ni écrite dans un log, une erreur ou le journal. Si `APPOINTMENTS_SECRET`
  change, les adresses sont à ressaisir.
- Seules les adresses de webhook Make sont acceptées (`https://hook.….make.com/…`), plus l'origine de recette
  `MAKE_TEST_WEBHOOK_ORIGIN` si elle est définie.
- Scénarios, journal et retours : réservés au propriétaire dans l'application (ni autre compte, ni Claude).

## Variables
| Variable | Usage |
| --- | --- |
| `MAKE_CALLBACK_SECRET` | secret partagé avec Make pour la route de retour ; 24 caractères au moins |
| `MAKE_TEST_WEBHOOK_ORIGIN` | recette seulement : origine d'un webhook de test ; vide en production |
| `APPOINTMENTS_SECRET` | déjà présent : chiffre les adresses et autorise la route de retour en base |

## CRM → Make
`POST` sur le webhook du scénario, JSON, délai de 10 s. Enveloppe commune :

```json
{ "event": "test", "test": true, "request_id": "uuid", "sent_at": "2026-11-18T10:00:00.000Z",
  "callback_url": "https://<application>/api/make/retour" }
```

**Tester la connexion** envoie exactement cela (`event: "test"`, `test: true`, aucune donnée de client) : le scénario
doit s'arrêter sur ce filtre. Une réponse `2xx` vaut accusé de réception ; le résultat réel arrive par le retour.

## Make → CRM
`POST /api/make/retour`, en-tête `Authorization: Bearer <MAKE_CALLBACK_SECRET>` :

```json
{ "event": "quote.created | quote.sent | quote.signed | quote.error",
  "request_id": "repris de l'appel",
  "quote": { "number": "D-2026-041", "url": "https://…", "signed_at": "2026-11-25" },
  "error": { "message": "texte court, sans donnée personnelle" } }
```

- Aucun autre champ n'est accepté ; un champ vide ou `null` est traité comme absent.
- Réponses : `200` (`duplicate: true` si ce retour a déjà été reçu, `ignored: true` s'il ne correspond à rien),
  `400` contenu invalide, `401` secret refusé, `429` au-delà de 60 retours par minute, `503` à réessayer.
- Idempotence : un couple `request_id` + `event` ne produit qu'un effet.

## Journal
Les 200 derniers appels : date, scénario, événement, statut, et un message d'erreur écrit par le CRM. Jamais le
contenu envoyé ou reçu.

## Recette
`npm run test-env` lance un faux Make (`scripts/test-env/make-fake.mjs`, port 54410) : enregistrez le scénario avec
`http://127.0.0.1:54410/hook/devis` (`/hook/panne` répond 500, `/hook/lent` dépasse le délai). `GET /calls` liste ce
que le CRM a envoyé.
