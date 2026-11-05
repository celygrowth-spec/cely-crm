# Contrat Rendez-vous ↔ Mail

**Statut : Rendez-vous prêt, envoi non raccordé.** Le module Rendez-vous calcule les rappels mais n'envoie
rien. Le module Mail (connexion Gmail, file d'envoi, livraison, historique, interface Mail) les prend en
charge quand il est prêt.

| Responsabilité | Module |
| --- | --- |
| Règles de rappel, échéancier, personnalisation par rendez-vous, validité | Rendez-vous |
| Rendu des variables et des liens privés (HMAC) | Rendez-vous (adaptateur) |
| File d'envoi, tentatives, fournisseur (Gmail), historique des emails | Mail |
| Statut final « envoyé » / « échec » d'un rappel | Mail (l'écrit via l'adaptateur) |

**Une seule file** : `appt_reminders` est un échéancier, pas une file d'envoi. Le module Mail lit les
échéances dues, les place dans **sa** file avec la clé de déduplication, puis rend compte du résultat.

## Point d'entrée

`src/lib/appointments/mail-adapter.ts` (serveur uniquement) :

```ts
dueReminders({ limit?, graceMinutes?, origin? }): Promise<ReminderMessage[]>
isReminderStillValid(reminderId, revision): Promise<boolean>
markReminder(reminderId, revision, { status: "sent", messageId? } | { status: "failed", error }): Promise<boolean>
connectMailDelivery(): Promise<string>          // une seule fois, quand l'envoi est opérationnel
bookingEventsSince(afterEventId, limit?): Promise<AppointmentMailEvent[]>
```

Ces fonctions utilisent la clé publique Supabase + la clé serveur dérivée de `APPOINTMENTS_SECRET`
(aucune session nécessaire : utilisables depuis un worker ou une route planifiée). Équivalents SQL :
`appt_mail_due_reminders`, `appt_mail_reminder_valid`, `appt_mail_mark_reminder`, `appt_mail_connect`,
`appt_mail_events` (paramètre `p_server_key`, ou session du propriétaire).

## Données transmises (`ReminderMessage`)

| Champ | Signification |
| --- | --- |
| `bookingId` | Identifiant stable du rendez-vous (`appt_bookings.id`). |
| `bookingVersion` | Version du rendez-vous ; incrémentée à chaque report ou annulation. |
| `reminderKey` | Identifiant stable du rappel (conservé lors d'un report). |
| `reminderId` | Identifiant de l'échéance (une ligne par rappel et par version du rendez-vous). |
| `dedupKey` | `appt-reminder:<reminderKey>:v<bookingVersion>` — clé d'unicité à imposer dans la file Mail. |
| `revision` | Incrémentée à chaque modification locale (horaire, contenu, annulation). |
| `to` | Destinataire `{ email, name }` (contact qui a réservé). |
| `sendAt` | Date d'envoi prévue (UTC). |
| `validUntil` | Début du rendez-vous : au-delà, ne plus envoyer. |
| `subject`, `text` | Contenu final, variables déjà remplacées (texte brut). |
| `variables` | `prenom, nom, entreprise, type, date, heure, fuseau, duree, lien_reunion, lien_annulation, lien_report` (date/heure dans le fuseau du contact). |
| `crm` | `{ companyId, personId }` : fiche CRM rattachée (peut être `null` si « À rattacher »). |

Événements de rendez-vous (`bookingEventsSince`, curseur `event_id` croissant) : `confirmed`,
`rescheduled`, `cancelled`, avec `booking_id`, `booking_version`, `status`, `starts_at`, `email`,
`company_id`, `person_id`. Ils permettent au module Mail d'envoyer confirmations / avis de report /
d'annulation s'il le souhaite. **La page de confirmation n'affiche jamais « email envoyé »** : à faire
évoluer seulement quand un envoi réel existe.

## Conditions de validité (vérifiées en base)

Un rappel n'est remis par `dueReminders` que si **toutes** ces conditions sont vraies :

1. statut `scheduled` ;
2. `send_at <= maintenant` et `send_at > maintenant − graceMinutes` (15 min par défaut, 120 max) :
   un rappel trop ancien n'est jamais envoyé ;
3. envoi raccordé (`mail_connected_at` renseigné) et `send_at >= mail_connected_at` :
   **aucun stock d'anciens rappels lors du raccordement** ;
4. pas de suspension globale (`appt_settings.reminders_paused`) — une échéance passée pendant la
   suspension n'est pas rattrapée (fenêtre de validité) ;
5. rendez-vous `confirmed`, rappels non désactivés pour ce rendez-vous (`reminders_off`),
   `booking_version` = version courante, rendez-vous pas encore commencé.

Juste avant l'envoi effectif, appeler `isReminderStillValid(reminderId, revision)`. `markReminder` est
refusé (renvoie `false`) si la révision a changé ou si le rappel n'est plus `scheduled` : l'envoi doit
alors être abandonné. Un rappel marqué `sent` ne peut plus l'être une seconde fois.

## Cycle de vie (géré par Rendez-vous)

- Réservation confirmée → une échéance par règle active **encore future** (réservation tardive : les
  échéances dépassées ne sont pas créées).
- Annulation → échéances `scheduled` passées à `cancelled`.
- Report → nouvelles échéances recalculées pour la nouvelle version (même `reminderKey`, nouvelle
  `dedupKey`), anciennes `superseded` ; personnalisations conservées ; rappels envoyés conservés ;
  un rappel annulé à la main n'est pas recréé.
- Modifier les règles d'un type n'affecte que les nouvelles réservations, sauf réapplication explicite
  (aperçu puis confirmation dans l'interface).

## États attendus côté Mail

`queued` (en file, clé `dedupKey`) → `sending` → `sent` (appeler `markReminder(..., { status: "sent", messageId })`)
ou `failed` définitif (appeler `markReminder(..., { status: "failed", error })`). Les nouvelles tentatives
restent internes au module Mail tant que `isReminderStillValid` est vrai. Au raccordement : appeler
`connectMailDelivery()` une fois, puis interroger `dueReminders()` à intervalle régulier (≤ 5 min
recommandé, la fenêtre de validité étant de 15 min).

## Coordination

- Migrations Rendez-vous : `20261105120000_rendez_vous.sql`, `20261105130000_rendez_vous_rappels.sql`.
  Elles ne touchent aucune table du module Mail.
- Ne pas exécuter `revoke execute on all functions in schema public from anon` dans une migration
  ultérieure : cela fermerait la réservation publique et cet adaptateur (le test
  `tests/db/rendez-vous.test.ts` le détecterait).
- Le rendu est en texte brut ; si le module Mail veut du HTML, il peut habiller `text` ou recomposer à
  partir de `variables`.
