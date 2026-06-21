/**
 * gmail-integration.js
 * Gestisce il collegamento OAuth con Gmail e la lettura automatica
 * delle email contenenti il piano settimanale e il giornaliero,
 * scaricandone gli allegati e passandoli ai parser esistenti.
 *
 * Flusso:
 * 1. L'utente clicca "Connetti Gmail" → reindirizzato a Google per autorizzare
 * 2. Google rimanda a /auth/google/callback con un "code"
 * 3. Scambiamo il code per un access_token + refresh_token, salvati nel database
 * 4. Un controllo periodico (cron, ogni N minuti) usa il refresh_token per
 *    cercare nuove email con allegati, scaricarli ed elaborarli automaticamente
 */

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
 */
async function scambiaCodeConToken(code, db) {
  const oauth2Client = creaOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);

  db.set('gmail_tokens', {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
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
 * Determina se un'email/allegato è probabilmente il SETTIMANALE o il GIORNALIERO,
 * in base a parole chiave nell'oggetto dell'email e nel nome del file.
 */
function indovinaTipo(oggetto, nomeFile) {
  const testo = (oggetto + ' ' + nomeFile).toLowerCase();
  if (testo.includes('settiman') || testo.includes('dal ') || testo.includes(' al ')) return 'settimanale';
  if (testo.includes('giornal') || testo.includes('ordine di servizio') || testo.includes('giorno')) return 'giornaliero';
  // Fallback sull'estensione: PDF piccoli singola pagina sono spesso giornalieri,
  // ma non è affidabile al 100% — meglio segnalarlo come incerto.
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
