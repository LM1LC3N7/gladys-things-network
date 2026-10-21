// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys (connection status, test button), en and fr.
// -----------------------------------------------------------------------------

/** "2026-10-20T18:00:00Z" -> "18:00 UTC". */
export const utcTime = (ms) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

/** Why the Storage API gives nothing. */
export const REASONS = {
  key: {
    en: 'API key refused (check it, or create a new one)',
    fr: 'clé API refusée (vérifiez-la, ou créez-en une nouvelle)',
  },
  rights: {
    en: 'the API key lacks the "Read application traffic" right',
    fr: "la clé API n'a pas le droit « Read application traffic »",
  },
  notFound: {
    en: 'application not found, or its Storage Integration is not activated',
    fr: "application introuvable, ou son intégration Storage n'est pas activée",
  },
  busy: { en: 'server busy (pause)', fr: 'serveur occupé (pause)' },
  failed: { en: 'no answer from the server', fr: 'pas de réponse du serveur' },
};

export const reason = (error) =>
  error?.kind === 'refused'
    ? (REASONS[error.why] ?? REASONS.key)
    : (REASONS[error?.kind] ?? REASONS.failed);

const PROBLEMS = {
  host: { en: 'server address not understood', fr: 'adresse du serveur non comprise' },
  hostMissing: { en: 'server address missing', fr: 'adresse du serveur manquante' },
  application: { en: 'application ID not understood', fr: "ID d'application non compris" },
  applicationMissing: { en: 'application ID missing', fr: "ID d'application manquant" },
  key: { en: 'API key not understood', fr: 'clé API non comprise' },
  keyMissing: { en: 'API key missing', fr: 'clé API manquante' },
};

export const T = {
  notConfigured: (problems) => ({
    en: `Enter the application ID and an API key of your The Things Stack application (${problems.map((p) => PROBLEMS[p].en).join(', ')}).`,
    fr: `Saisissez l'ID et une clé API de votre application The Things Stack (${problems.map((p) => PROBLEMS[p].fr).join(', ')}).`,
  }),
  refusedHelp: {
    en: 'One new try every 6 hours, or at once when the configuration changes.',
    fr: 'Un nouvel essai toutes les 6 heures, ou tout de suite si la configuration change.',
  },
  nextRead: (at) => ({
    en: `next read possible at ${utcTime(at)}`,
    fr: `prochaine lecture possible à ${utcTime(at)}`,
  }),
  pausedUntil: (until) => ({
    en: `paused until ${utcTime(until)}`,
    fr: `en pause jusqu'à ${utcTime(until)}`,
  }),
  noUplink: {
    en: 'No uplink with a decoded payload yet: check that the Storage Integration of the application is activated and that the devices have a payload formatter.',
    fr: "Aucun message montant avec une charge décodée pour l'instant : vérifiez que l'intégration Storage de l'application est activée et que les appareils ont un décodeur (payload formatter).",
  },
  truncated: (limit) => ({
    en: `The last read reached the limit of ${limit} uplinks: shorten the interval.`,
    fr: `La dernière lecture a atteint la limite de ${limit} messages : réduisez l'intervalle.`,
  }),
  tooLarge: {
    en: 'The last answer was too large (over 8 MB): only its newest part was read; shorten the interval.',
    fr: "La dernière réponse était trop grosse (plus de 8 Mo) : seule sa partie la plus récente a été lue ; réduisez l'intervalle.",
  },
  skipped: (n) => ({
    en: `${n} uplink(s) too large (over 256 KB) were skipped.`,
    fr: `${n} message(s) trop gros (plus de 256 Ko) ignoré(s).`,
  }),
  tooMany: (max) => ({
    en: `Only the first ${max} devices are kept.`,
    fr: `Seuls les ${max} premiers appareils sont gardés.`,
  }),
  /** The connected status: what is read, and what fails. */
  ok: ({ application, devices, interval, lastRead }) => ({
    en: `Application ${application}: ${devices} device(s) with known values, read every ${interval} min${lastRead ? `, last read at ${utcTime(lastRead)}` : ''}.`,
    fr: `Application ${application} : ${devices} appareil(s) avec des valeurs connues, lu(s) toutes les ${interval} min${lastRead ? `, dernière lecture à ${utcTime(lastRead)}` : ''}.`,
  }),
  failing: (error, until) => ({
    en: `Without new value: ${reason(error).en}${until ? `, ${T.pausedUntil(until).en}` : ''}.`,
    fr: `Sans nouvelle valeur : ${reason(error).fr}${until ? `, ${T.pausedUntil(until).fr}` : ''}.`,
  }),
};
