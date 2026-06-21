require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cron = require('node-cron');
const parserTurni = require('./parser-turni');
const parserPdf = require('./parser-pdf');
const gmailIntegration = require('./gmail-integration');

const app = express();
const PORT = process.env.PORT || 3000;

// Configurazione fissa: il gruppo di Giorgio e quante settimane calcolare in avanti
const GRUPPO_GIORGIO = 11;
const COGNOME_GIORGIO = 'MANNUCA';
const SETTIMANE_DA_CALCOLARE = 20; // ~ fino a ottobre
const DATA_MINIMA_PASSATO = '2025-04-01'; // fin dove calcolare i turni passati a ritroso

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// File statici (frontend)
app.use(express.static(path.join(__dirname, 'public')));

// Upload: salva temporaneamente su disco per poterlo leggere con xlsx / pdf-parse
const upload = multer({ dest: path.join(__dirname, 'tmp_uploads'), limits: { fileSize: 10 * 1024 * 1024 } });
if (!fs.existsSync(path.join(__dirname, 'tmp_uploads'))) {
  fs.mkdirSync(path.join(__dirname, 'tmp_uploads'));
}

// API Routes
app.use('/api', require('./routes/api'));

/**
 * Trova il lunedì della settimana di una data qualsiasi (formato ISO YYYY-MM-DD)
 */
function lunediDellaSettimana(dataIso) {
  const d = new Date(dataIso + 'T00:00:00');
  const giorno = d.getDay();
  const diff = (giorno === 0) ? -6 : 1 - giorno;
  const lun = new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff);
  return parserTurni.formattaDataLocale(lun);
}

/**
 * Data odierna in formato ISO YYYY-MM-DD usando il fuso orario LOCALE del server
 * (mai .toISOString(), che converte in UTC e può sbagliare giorno).
 */
function oggiLocale() {
  return parserTurni.formattaDataLocale(new Date());
}

/**
 * Calcola la data da usare come "riferimento" per indovinare l'anno quando
 * il titolo del file settimanale non lo specifica (es. "TURNI DAL 22 AL 28
 * GIUGNO", senza anno). Usa la mediana delle date già presenti nel database,
 * molto più affidabile della semplice data odierna del server: quest'ultima
 * può discostarsi di mesi o anni dal periodo che l'utente sta effettivamente
 * caricando (bug storico riscontrato: un file di giugno 2025 veniva
 * interpretato come giugno 2026 solo perché "oggi" sul server era già il
 * 2026, anche se tutti gli altri turni nel database erano del 2025).
 */
function calcolaDataRiferimentoAnno(db) {
  const tuttiTurni = db.get('turni').value();
  if (tuttiTurni && tuttiTurni.length > 0) {
    const dateOrdinate = tuttiTurni.map(t => t.data).sort();
    return dateOrdinate[Math.floor(dateOrdinate.length / 2)]; // mediana
  }
  return oggiLocale(); // database vuoto: nessun altro riferimento disponibile
}

/**
 * Elabora il PIANO SETTIMANALE (Excel o PDF, stesso risultato): calcola la
 * rotazione su tutte le settimane future E passate (fino a DATA_MINIMA_PASSATO)
 * e salva/aggiorna i turni nel database. Funzione condivisa sia dall'upload
 * manuale che dal parsing automatico email.
 */
function elaboraSettimanale(griglia, dataLunediRilevata, dataLunediForzata, db) {
  if (!griglia[GRUPPO_GIORGIO]) {
    throw new Error(`Gruppo ${GRUPPO_GIORGIO} non trovato nel file caricato`);
  }

  const dataLunedi = dataLunediForzata || dataLunediRilevata || lunediDellaSettimana(oggiLocale());

  const turniFuturi = parserTurni.calcolaTurniFuturi(dataLunedi, griglia, GRUPPO_GIORGIO, SETTIMANE_DA_CALCOLARE);
  const turniPassati = parserTurni.calcolaTurniPassati(dataLunedi, griglia, GRUPPO_GIORGIO, DATA_MINIMA_PASSATO);
  const turniCalcolati = [...turniPassati, ...turniFuturi];

  const { discrepanze } = parserTurni.confrontaConNuovoFile(turniFuturi, griglia, dataLunedi, GRUPPO_GIORGIO);

  turniCalcolati.forEach(t => {
    const exists = db.get('turni').find({ data: t.data }).value();
    if (exists) {
      db.get('turni').find({ data: t.data }).assign({
        orario: t.orario, tipo: t.tipo, fonte: 'calcolato', note: t.nota
      }).write();
    } else {
      db.get('turni').push({
        data: t.data, orario: t.orario, tipo: t.tipo, fonte: 'calcolato', note: t.nota
      }).write();
    }
  });

  return { dataLunedi, turniCalcolati, turniFuturi, turniPassati, discrepanze };
}

/**
 * Elabora il GIORNALIERO (PDF): trova il turno di oggi/della data indicata,
 * lo confronta con quello già calcolato/salvato per quella data, e segnala
 * eventuali discrepanze.
 */
function elaboraGiornaliero(risultatoPdf, dataDaControllare, db) {
  if (!risultatoPdf.trovato) {
    return { discrepanza: false, messaggio: risultatoPdf.messaggio, dettagli: null };
  }

  const turnoSalvato = db.get('turni').find({ data: dataDaControllare }).value();

  if (risultatoPdf.assente) {
    return {
      discrepanza: !!turnoSalvato && turnoSalvato.tipo !== 'r',
      messaggio: `Giornaliero segnala ASSENTE per ${dataDaControllare}.`,
      dettagli: risultatoPdf
    };
  }

  if (!turnoSalvato) {
    return { discrepanza: false, messaggio: 'Nessun turno calcolato salvato per questa data, impossibile confrontare.', dettagli: risultatoPdf };
  }

  const normalizza = s => (s || '').replace(/\s/g, '').replace('–', '-').replace('—', '-');
  const uguale = normalizza(turnoSalvato.orario) === normalizza(risultatoPdf.orario);

  if (!uguale) {
    return {
      discrepanza: true,
      messaggio: `⚠️ DISCREPANZA ${dataDaControllare}: piano = "${turnoSalvato.orario}" · giornaliero = "${risultatoPdf.orario}"`,
      dettagli: risultatoPdf
    };
  }

  return { discrepanza: false, messaggio: `Nessuna discrepanza: il giornaliero conferma ${risultatoPdf.orario}.`, dettagli: risultatoPdf };
}

// Upload manuale dal frontend (Excel/PDF settimanale, PDF giornaliero)
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nessun file caricato' });

  const tipo = req.body.tipo || 'giornaliero';
  const filename = req.file.originalname;
  const filePath = req.file.path;
  const estensione = path.extname(filename).toLowerCase();
  const db = require('./db/database');

  try {
    if (tipo === 'settimanale') {
      // ===== PARSING REALE: Excel oppure PDF, stesso flusso di calcolo dopo =====
      let griglia, dataLunediRilevata;
      const dataRiferimentoAnno = calcolaDataRiferimentoAnno(db);

      if (estensione === '.pdf') {
        const risultato = await parserPdf.leggiGrigliaSettimanalePdf(filePath, dataRiferimentoAnno);
        griglia = risultato.griglia;
        dataLunediRilevata = risultato.dataLunediRilevata;
      } else {
        const risultato = parserTurni.leggiGrigliaSettimanale(filePath, dataRiferimentoAnno);
        griglia = risultato.griglia;
        dataLunediRilevata = risultato.dataLunediRilevata;
      }

      const { dataLunedi, turniCalcolati, turniFuturi, turniPassati, discrepanze } = elaboraSettimanale(
        griglia, dataLunediRilevata, req.body.data_lunedi, db
      );

      const estratto = `Calcolati ${turniCalcolati.length} turni totali dal Gruppo ${GRUPPO_GIORGIO}: ${turniPassati.length} passati (fino a ${DATA_MINIMA_PASSATO}) + ${turniFuturi.length} futuri, settimana di riferimento ${dataLunedi} (file ${estensione}).`;


      db.get('email_log').push({
        tipo, filename,
        contenuto_estratto: estratto,
        discrepanza: discrepanze.length > 0,
        discrepanza_note: discrepanze.map(d => d.messaggio).join(' | '),
        created_at: new Date().toISOString()
      }).write();

      fs.unlinkSync(filePath);

      return res.json({
        ok: true, tipo, filename,
        turni_calcolati: turniCalcolati.length,
        discrepanze,
        messaggio: estratto
      });

    } else {
      // ===== GIORNALIERO (PDF) — parsing reale + confronto discrepanza =====
      if (estensione !== '.pdf') {
        throw new Error('Il giornaliero va caricato in formato PDF.');
      }

      const risultatoPdf = await parserPdf.leggiGiornalieroPdf(filePath, COGNOME_GIORGIO);
      const dataDaControllare = req.body.data || oggiLocale();
      const confronto = elaboraGiornaliero(risultatoPdf, dataDaControllare, db);

      db.get('email_log').push({
        tipo, filename,
        contenuto_estratto: confronto.messaggio,
        discrepanza: confronto.discrepanza,
        discrepanza_note: confronto.discrepanza ? confronto.messaggio : '',
        created_at: new Date().toISOString()
      }).write();

      fs.unlinkSync(filePath);
      return res.json({ ok: true, tipo, filename, messaggio: confronto.messaggio, discrepanza: confronto.discrepanza, dettagli: confronto.dettagli });
    }
  } catch (err) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    console.error('Errore parsing file:', err);
    return res.status(500).json({ error: 'Errore durante la lettura del file: ' + err.message });
  }
});

// ===== GMAIL OAUTH E SCANSIONE AUTOMATICA =====

// Avvia il collegamento: reindirizza l'utente alla pagina di autorizzazione Google
app.get('/auth/google', (req, res) => {
  try {
    const url = gmailIntegration.generaUrlAutorizzazione();
    res.redirect(url);
  } catch (err) {
    res.status(500).send('Errore avvio autorizzazione Google: ' + err.message + '<br><br>Verifica che GMAIL_CLIENT_ID e GMAIL_CLIENT_SECRET siano configurati su Railway.');
  }
});

// Google rimanda qui dopo l'autorizzazione, con un "code" da scambiare per i token
app.get('/auth/google/callback', async (req, res) => {
  const { code, error } = req.query;
  const db = require('./db/database');

  if (error) {
    return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;">
      <h2>Autorizzazione annullata</h2><p>${error}</p>
      <a href="/">Torna all'app</a></body></html>`);
  }

  try {
    await gmailIntegration.scambiaCodeConToken(code, db);
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;">
      <h2>✅ Gmail collegato con successo!</h2>
      <p>L'app ora leggerà automaticamente le email con il piano turni.</p>
      <a href="/" style="display:inline-block;margin-top:16px;padding:10px 20px;background:#4f8ef7;color:#fff;text-decoration:none;border-radius:8px;">Torna all'app</a>
      </body></html>`);
  } catch (err) {
    console.error('Errore scambio token Google:', err);
    res.status(500).send('Errore durante il collegamento: ' + err.message);
  }
});

// Stato del collegamento (usato dal frontend per mostrare "Connesso" / "Connetti Gmail")
app.get('/api/gmail/stato', (req, res) => {
  const db = require('./db/database');
  const connesso = gmailIntegration.isConnesso(db);
  const tokens = db.get('gmail_tokens').value();
  res.json({
    connesso,
    connesso_il: connesso ? tokens.connesso_il : null
  });
});

// Disconnette Gmail
app.post('/api/gmail/disconnetti', (req, res) => {
  const db = require('./db/database');
  gmailIntegration.disconnetti(db);
  res.json({ ok: true });
});

// Forza una scansione email immediata (oltre a quella automatica periodica)
app.post('/api/gmail/scansiona-ora', async (req, res) => {
  try {
    const risultato = await scansionaEmailTurni();
    res.json({ ok: true, ...risultato });
  } catch (err) {
    console.error('Errore scansione manuale:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Funzione principale di scansione automatica: cerca nuove email con
 * allegati relativi ai turni, li scarica e li elabora con gli stessi
 * parser usati per l'upload manuale (settimanale Excel/PDF, giornaliero PDF).
 */
async function scansionaEmailTurni() {
  const db = require('./db/database');

  if (!gmailIntegration.isConnesso(db)) {
    return { scansionato: false, motivo: 'Gmail non collegato' };
  }

  const oauth2Client = gmailIntegration.clientAutenticato(db);
  const ultimaScansione = db.get('gmail_ultima_scansione').value();

  const messaggi = await gmailIntegration.cercaEmailTurni(oauth2Client, ultimaScansione);

  const risultati = [];

  for (const msg of messaggi) {
    // Evita di rielaborare la stessa email più volte
    const giaElaborata = db.get('gmail_email_elaborate').find({ id: msg.id }).value();
    if (giaElaborata) continue;

    const { allegatiScaricati, oggetto } = await gmailIntegration.scaricaAllegati(
      oauth2Client, msg.id, path.join(__dirname, 'tmp_uploads')
    );

    for (const allegato of allegatiScaricati) {
      const tipoIndovinato = gmailIntegration.indovinaTipo(oggetto, allegato.nomeOriginale);

      try {
        if (tipoIndovinato === 'settimanale' || (tipoIndovinato === 'incerto' && allegato.estensione !== '.pdf')) {
          // Excel è quasi sempre il settimanale; i PDF "incerti" li trattiamo come giornaliero di default
          let griglia, dataLunediRilevata;
          const dataRiferimentoAnno = calcolaDataRiferimentoAnno(db);
          if (allegato.estensione === '.pdf') {
            const r = await parserPdf.leggiGrigliaSettimanalePdf(allegato.percorsoLocale, dataRiferimentoAnno);
            griglia = r.griglia; dataLunediRilevata = r.dataLunediRilevata;
          } else {
            const r = parserTurni.leggiGrigliaSettimanale(allegato.percorsoLocale, dataRiferimentoAnno);
            griglia = r.griglia; dataLunediRilevata = r.dataLunediRilevata;
          }
          const { dataLunedi, turniCalcolati, discrepanze } = elaboraSettimanale(griglia, dataLunediRilevata, null, db);

          db.get('email_log').push({
            tipo: 'settimanale', filename: allegato.nomeOriginale,
            contenuto_estratto: `[Auto da Gmail] Calcolati ${turniCalcolati.length} turni, settimana ${dataLunedi}.`,
            discrepanza: discrepanze.length > 0,
            discrepanza_note: discrepanze.map(d => d.messaggio).join(' | '),
            created_at: new Date().toISOString()
          }).write();

          risultati.push({ tipo: 'settimanale', file: allegato.nomeOriginale, ok: true });

        } else {
          // Giornaliero PDF
          const risultatoPdf = await parserPdf.leggiGiornalieroPdf(allegato.percorsoLocale, COGNOME_GIORGIO);
          const confronto = elaboraGiornaliero(risultatoPdf, oggiLocale(), db);

          db.get('email_log').push({
            tipo: 'giornaliero', filename: allegato.nomeOriginale,
            contenuto_estratto: `[Auto da Gmail] ${confronto.messaggio}`,
            discrepanza: confronto.discrepanza,
            discrepanza_note: confronto.discrepanza ? confronto.messaggio : '',
            created_at: new Date().toISOString()
          }).write();

          risultati.push({ tipo: 'giornaliero', file: allegato.nomeOriginale, ok: true, discrepanza: confronto.discrepanza });
        }
      } catch (errParsing) {
        console.error(`Errore elaborazione allegato ${allegato.nomeOriginale}:`, errParsing.message);
        risultati.push({ file: allegato.nomeOriginale, ok: false, errore: errParsing.message });
      } finally {
        if (fs.existsSync(allegato.percorsoLocale)) fs.unlinkSync(allegato.percorsoLocale);
      }
    }

    db.get('gmail_email_elaborate').push({ id: msg.id, elaborata_il: new Date().toISOString() }).write();
  }

  db.set('gmail_ultima_scansione', oggiLocale()).write();

  return { scansionato: true, email_trovate: messaggi.length, risultati };
}

// Controllo automatico periodico: ogni 30 minuti cerca nuove email.
// (cron: minuto 0 e 30 di ogni ora — leggero, non sovraccarica le API Gmail)
cron.schedule('0,30 * * * *', async () => {
  try {
    const db = require('./db/database');
    if (!gmailIntegration.isConnesso(db)) return; // niente da fare se non collegato
    console.log('🔄 Scansione automatica email turni...');
    const risultato = await scansionaEmailTurni();
    if (risultato.scansionato) {
      console.log(`✅ Scansione completata: ${risultato.email_trovate} nuove email trovate`);
    }
  } catch (err) {
    console.error('Errore durante la scansione automatica email:', err.message);
  }
});

// Qualunque altra rotta → manda il frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ TurniApp in ascolto su http://localhost:${PORT}`);
});
