/**
 * gmail-integration.js
 * Gestisce il collegamento OAuth con Gmail e la lettura automatica
 * delle email contenenti il piano settimanale e il giornaliero,
 * scaricandone gli allegati e passandoli ai parser esistenti.
 *
 * PATCH Railway/Node 22+: googleapis usa internamente node-fetch per lo
 * scambio token OAuth, che dal 19 giugno 2026 fallisce con "Premature close"
 * su Railway a causa di un bug keep-alive con le nuove versioni di Node.
 * La soluzione confermata: sostituire node-fetch con il fetch globale di Node
 * (basato su undici), che non ha questo problema.
 */

// Patch PRIMA di importare googleapis: forza l'uso del fetch globale di Node
// al posto di node-fetch in tutta la catena googleapis → google-auth-library → gaxios
if (typeof globalThis.fetch === 'function') {
  process.env.GAXIOS_FETCH = 'native'; // segnala a gaxios di usare il fetch nativo
  try {
    // Override diretto del fetch usato da gaxios (il client HTTP di googleapis)
    const gaxios = require('gaxios');
    if (gaxios && gaxios.instance) {
      gaxios.instance.defaults = gaxios.instance.defaults || {};
      gaxios.instance.defaults.fetchImplementation = globalThis.fetch.bind(globalThis);
    }
  } catch (e) {
    // Se gaxios non è disponibile direttamente, la variabile GAXIOS_FETCH è sufficiente
  }
}

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

function creaOAuthClient() {
  const redirectUri = process.env.GMAIL_REDIRECT_URI ||
    `${process.env.APP_BASE_URL || 'http://localhost:3000'}/auth/google/callback`;

  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    redirectUri
  );
}

/**
 * Genera l'URL a cui reindirizzare l'utente per l'autorizzazione Google.
 */
function generaUrlAutorizzazione() {
  const oauth2Client = creaOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline', // necessario per ottenere un refresh_token riutilizzabile
    prompt: 'consent',      // forza Google a restituire sempre il refresh_token
    scope: SCOPES
  });
}

/**
 * Scambia il "code" ricevuto da Google (dopo l'autorizzazione) con i token
 * di accesso, e li salva nel database per riutilizzarli nei controlli futuri.
 *
 * Usa direttamente il fetch globale di Node (undici) per lo scambio token,
 * bypassando completamente node-fetch/gaxios che causa "Premature close" su
 * Railway con Node 22+.
 */
async function scambiaCodeConToken(code, db) {
  const redirectUri = process.env.GMAIL_REDIRECT_URI ||
    `${process.env.APP_BASE_URL || 'http://localhost:3000'}/auth/google/callback`;

  // Usa fetch nativo (undici) invece di googleapis per questo scambio critico
  const params = new URLSearchParams({
    code,
    client_id: process.env.GMAIL_CLIENT_ID,
    client_secret: process.env.GMAIL_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  });

  const risposta = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  if (!risposta.ok) {
    const errore = await risposta.text();
    throw new Error(`Errore Google OAuth: ${risposta.status} — ${errore}`);
  }

  const tokens = await risposta.json();

  db.set('gmail_tokens', {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date || (Date.now() + (tokens.expires_in || 3600) * 1000),
    connesso_il: new Date().toISOString()
  }).write();

  return tokens;
}

/**
 * Crea un client OAuth già autenticato con i token salvati, pronto per
 * chiamare le API Gmail. Ritorna null se non c'è ancora un collegamento attivo.
 */
function clientAutenticato(db) {
  const tokens = db.get('gmail_tokens').value();
  if (!tokens || !tokens.refresh_token) return null;

  const oauth2Client = creaOAuthClient();
  oauth2Client.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date
  });

  // Se Google emette un nuovo access_token durante l'uso, lo salviamo aggiornato
  oauth2Client.on('tokens', (nuoviTokens) => {
    const aggiornati = { ...tokens, ...nuoviTokens };
    db.set('gmail_tokens', aggiornati).write();
  });

  return oauth2Client;
}

function isConnesso(db) {
  const tokens = db.get('gmail_tokens').value();
  return !!(tokens && tokens.refresh_token);
}

function disconnetti(db) {
  db.unset('gmail_tokens').write();
}

/**
 * Cerca le email più recenti che sembrano contenere il piano turni
 * (settimanale o giornaliero), basandosi su parole chiave nell'oggetto.
 * Ritorna solo quelle con allegati PDF/Excel non ancora elaborati.
 */
async function cercaEmailTurni(oauth2Client, dopoData) {
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  // Query Gmail: cerca per parole chiave comuni nei due tipi di documento,
  // solo email con allegati, ricevute dopo l'ultima scansione.
  const query = `(turni OR settimanale OR giornaliero OR "ordine di servizio") has:attachment ${dopoData ? 'after:' + dopoData : ''}`;

  const lista = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: 10
  });

  return lista.data.messages || [];
}

/**
 * Scarica gli allegati di un'email specifica e li salva temporaneamente su disco,
 * ritornando i percorsi locali insieme al tipo file e nome originale.
 */
async function scaricaAllegati(oauth2Client, messageId, cartellaDestinazione) {
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const messaggio = await gmail.users.messages.get({ userId: 'me', id: messageId });

  const allegatiScaricati = [];
  const parti = messaggio.data.payload.parts || [];

  for (const parte of parti) {
    if (!parte.filename || !parte.body) continue;
    const estensione = path.extname(parte.filename).toLowerCase();
    if (!['.pdf', '.xlsx', '.xls'].includes(estensione)) continue;

    let attachmentData;
    if (parte.body.data) {
      attachmentData = parte.body.data;
    } else if (parte.body.attachmentId) {
      const dettaglio = await gmail.users.messages.attachments.get({
        userId: 'me', messageId, id: parte.body.attachmentId
      });
      attachmentData = dettaglio.data.data;
    } else {
      continue;
    }

    const buffer = Buffer.from(attachmentData, 'base64');
    const nomeFile = `gmail_${Date.now()}_${parte.filename}`;
    const percorsoLocale = path.join(cartellaDestinazione, nomeFile);
    fs.writeFileSync(percorsoLocale, buffer);

    allegatiScaricati.push({
      percorsoLocale,
      nomeOriginale: parte.filename,
      estensione
    });
  }

  // Estrae anche oggetto e data dell'email, utili per capire se è settimanale o giornaliero
  const headers = messaggio.data.payload.headers || [];
  const oggetto = (headers.find(h => h.name === 'Subject') || {}).value || '';
  const dataRicezione = (headers.find(h => h.name === 'Date') || {}).value || '';

  return { allegatiScaricati, oggetto, dataRicezione };
}

/**
 * Determina se un'email/allegato è probabilmente il SETTIMANALE o il GIORNALIERO.
 * Logica migliorata:
 * - Excel (.xlsx/.xls) → quasi sempre settimanale
 * - PDF con "DAL ... AL ..." nell'oggetto → settimanale
 * - PDF con parole chiave giornaliero → giornaliero
 * - PDF senza indicazioni → giornaliero (default per i PDF, perché il
 *   settimanale viene spesso mandato in Excel, il giornaliero sempre in PDF)
 */
function indovinaTipo(oggetto, nomeFile) {
  const testo = (oggetto + ' ' + nomeFile).toLowerCase();
  const estensione = nomeFile.toLowerCase().split('.').pop();

  // Excel → sicuramente settimanale
  if (estensione === 'xlsx' || estensione === 'xls') return 'settimanale';

  // PDF con range di date nel titolo → settimanale
  if (/dal\s+\d{1,2}\s+al\s+\d{1,2}/.test(testo)) return 'settimanale';
  if (testo.includes('settiman')) return 'settimanale';

  // PDF con parole chiave giornaliero → giornaliero
  if (testo.includes('giornal') || testo.includes('ordine di servizio') ||
      testo.includes('giorno') || testo.includes('servizio del')) return 'giornaliero';

  // PDF senza indicazioni chiare → giornaliero (default per i PDF)
  if (estensione === 'pdf') return 'giornaliero';

  return 'incerto';
}

module.exports = {
  generaUrlAutorizzazione,
  scambiaCodeConToken,
  clientAutenticato,
  isConnesso,
  disconnetti,
  cercaEmailTurni,
  scaricaAllegati,
  indovinaTipo
};
