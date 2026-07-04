/**
 * gmail-integration.js
 * Gestisce il collegamento OAuth con Gmail e la lettura automatica
 * delle email contenenti il piano settimanale e il giornaliero.
 *
 * FIX Railway/Node 22+: googleapis usa node-fetch internamente che causa
 * "Premature close" su Railway. Forziamo il fetch nativo (undici) ovunque.
 */

// Override AGGRESSIVO prima di qualsiasi import: intercetta il modulo gaxios
// (client HTTP usato da googleapis) e sostituisce il suo fetch con quello nativo.
if (typeof globalThis.fetch === 'function') {
  process.env.GAXIOS_FETCH = 'native';

  const Module = require('module');
  const _originalLoad = Module._load;
  let _gaxiosPatchato = false;

  Module._load = function(request, parent, isMain) {
    const mod = _originalLoad.apply(this, arguments);
    if (!_gaxiosPatchato && (request === 'gaxios' || (typeof request === 'string' && request.includes('gaxios')))) {
      try {
        if (mod && mod.instance && mod.instance.defaults !== undefined) {
          mod.instance.defaults = mod.instance.defaults || {};
          mod.instance.defaults.fetchImplementation = globalThis.fetch.bind(globalThis);
          _gaxiosPatchato = true;
        }
      } catch(e) { /* silenzioso */ }
    }
    return mod;
  };
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

function generaUrlAutorizzazione() {
  const oauth2Client = creaOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES
  });
}

/**
 * Scambia il codice OAuth con i token usando il fetch NATIVO di Node
 * (bypassa completamente googleapis/gaxios/node-fetch per questo step critico).
 */
async function scambiaCodeConToken(code, db) {
  const redirectUri = process.env.GMAIL_REDIRECT_URI ||
    `${process.env.APP_BASE_URL || 'http://localhost:3000'}/auth/google/callback`;

  const params = new URLSearchParams({
    code,
    client_id: process.env.GMAIL_CLIENT_ID,
    client_secret: process.env.GMAIL_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  });

  const risposta = await globalThis.fetch('https://oauth2.googleapis.com/token', {
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
 * Rinnova l'access token usando il refresh token, sempre con fetch nativo.
 */
async function rinnovaAccessToken(tokens) {
  const params = new URLSearchParams({
    client_id: process.env.GMAIL_CLIENT_ID,
    client_secret: process.env.GMAIL_CLIENT_SECRET,
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token'
  });

  const risposta = await globalThis.fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  if (!risposta.ok) {
    const errore = await risposta.text();
    throw new Error(`Errore rinnovo token: ${risposta.status} — ${errore}`);
  }

  return await risposta.json();
}

/**
 * Crea un client OAuth autenticato. Se il token è scaduto, lo rinnova.
 */
async function clientAutenticato(db) {
  const tokens = db.get('gmail_tokens').value();
  if (!tokens || !tokens.refresh_token) return null;

  // Rinnova il token se è scaduto o mancante
  if (!tokens.access_token || (tokens.expiry_date && Date.now() > tokens.expiry_date - 60000)) {
    try {
      const nuovi = await rinnovaAccessToken(tokens);
      const aggiornati = {
        ...tokens,
        access_token: nuovi.access_token,
        expiry_date: nuovi.expiry_date || (Date.now() + (nuovi.expires_in || 3600) * 1000)
      };
      db.set('gmail_tokens', aggiornati).write();
      tokens.access_token = aggiornati.access_token;
      tokens.expiry_date = aggiornati.expiry_date;
    } catch (err) {
      console.error('Errore rinnovo token Gmail:', err.message);
      return null;
    }
  }

  const oauth2Client = creaOAuthClient();
  oauth2Client.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date
  });

  // Se googleapis emette nuovi token, li salviamo
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
 * Cerca email con allegati relativi ai turni usando le API Gmail.
 * Usa il fetch nativo tramite googleapis (già patchato sopra).
 */
async function cercaEmailTurni(oauth2Client, dopoData) {
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  const query = [
    '(turni OR settimanale OR giornaliero OR "ordine di servizio" OR "part time" OR partime)',
    'has:attachment',
    dopoData ? `after:${dopoData}` : ''
  ].filter(Boolean).join(' ');

  const lista = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: 20
  });

  return lista.data.messages || [];
}

/**
 * Scarica gli allegati di un'email specifica.
 */
async function scaricaAllegati(oauth2Client, messageId, cartellaDestinazione) {
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const messaggio = await gmail.users.messages.get({ userId: 'me', id: messageId });

  const allegatiScaricati = [];

  const elaboraParti = async (parti) => {
    for (const parte of (parti || [])) {
      // Ricorsione per parti nidificate (es. multipart/mixed)
      if (parte.parts) {
        await elaboraParti(parte.parts);
        continue;
      }
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
      const nomeFile = `gmail_${Date.now()}_${parte.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const percorsoLocale = path.join(cartellaDestinazione, nomeFile);
      fs.writeFileSync(percorsoLocale, buffer);

      allegatiScaricati.push({
        percorsoLocale,
        nomeOriginale: parte.filename,
        estensione
      });
    }
  };

  const parti = messaggio.data.payload.parts || [messaggio.data.payload];
  await elaboraParti(parti);

  const headers = messaggio.data.payload.headers || [];
  const oggetto = (headers.find(h => h.name === 'Subject') || {}).value || '';
  const dataRicezione = (headers.find(h => h.name === 'Date') || {}).value || '';

  return { allegatiScaricati, oggetto, dataRicezione };
}

/**
 * Determina se un'email è il SETTIMANALE o il GIORNALIERO.
 */
function indovinaTipo(oggetto, nomeFile) {
  const testo = (oggetto + ' ' + nomeFile).toLowerCase();
  const estensione = nomeFile.toLowerCase().split('.').pop();

  if (estensione === 'xlsx' || estensione === 'xls') return 'settimanale';
  if (/dal\s+\d{1,2}\s+al\s+\d{1,2}/.test(testo)) return 'settimanale';
  if (testo.includes('settiman') || testo.includes('partime') || testo.includes('part time')) return 'settimanale';
  if (testo.includes('giornal') || testo.includes('ordine di servizio') || testo.includes('giorno')) return 'giornaliero';
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
