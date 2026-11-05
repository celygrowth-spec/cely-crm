# Contrat d'intégration : service mail

Pour tout module qui envoie un email (prospection, rendez-vous, notifications). Un module n'appelle jamais Gmail et ne
lit jamais de jeton : il appelle `src/lib/mail/service.ts`, côté serveur uniquement.

## Envoyer

```ts
import { sendMail } from "@/lib/mail/service";

const m = await sendMail(supabase, {
  to: ["client@exemple.fr"],
  subject: "Votre rendez-vous est confirmé",
  text: "Bonjour…",                         // obligatoire, même avec html
  html: "<p>Bonjour…</p>",                  // facultatif, nettoyé avant envoi
  origin: "appointment",                    // manual | prospection | appointment | system
  companyId, personId,                      // facultatif : avec companyId, l'envoi entre dans l'historique
  business: { type: "appointment", id },    // référence métier
  dedupeKey: `appointment:${id}:v${version}:confirmation`,
  fileIds: [],                              // fichiers de la fiche companyId uniquement
});
```

`supabase` est le client de la session du propriétaire.

## Résultat

`m.status` dit ce qui s'est réellement passé. Lancer une exception signifie que rien n'a été créé (données invalides,
aucun compte connecté).

| `status` | Sens | Ce que fait le module |
|---|---|---|
| `accepted` | Gmail a accepté le message. **Ni livré, ni lu.** | Rien |
| `failed` | Certainement pas parti (`error_code`, `last_error`) | Son action métier reste valable |
| `uncertain` | Peut-être parti | **Ne jamais renvoyer** : l'utilisateur tranche dans le CRM |
| `sending` | Un autre appel s'en occupe | Rien |

`m.duplicate === true` : cette `dedupeKey` existait déjà, rien n'a été renvoyé, et `m` donne l'état de l'envoi existant.

## Règles

- **Clé de déduplication** : à fournir pour tout envoi automatique, et à changer si le contenu métier change (par
  exemple avec la version du rendez-vous).
- **Une erreur d'email ne doit pas annuler l'action métier** : une réservation réussie reste réussie.
- **Pas de nouvel essai côté module.** Les reprises seront gérées par la file d'envoi (phase 3).
- **Envoi programmé** : `scheduledAt` est refusé tant que la file d'envoi n'existe pas. Aucun rappel ne peut donc
  encore être programmé par ce service.
- **Session requise** : `sendMail` s'exécute aujourd'hui avec la session du propriétaire. Un envoi déclenché par un
  visiteur public (réservation) n'a pas cette session : il devra passer par la file d'envoi de la phase 3. Ne contournez
  pas ce point avec une clé `service_role`.
- **Connexion distincte de Google Calendar** : autre client OAuth, autres jetons.

## Réponse dans un fil

Passez `threadId`, `inReplyTo` et `references`, et gardez le même objet. La lecture des messages reçus arrivera à la
phase 2.
