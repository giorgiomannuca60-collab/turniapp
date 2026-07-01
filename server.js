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
const notifichePush = require('./notifiche-push');

const app = express();
const PORT = process.env.PORT || 3000;

// Configurazione fissa: il gruppo di Giorgio e quante settimane calcolare in avanti
const GRUPPO_GIORGIO = parseInt(process.env.GRUPPO || '11');
const COGNOME_GIORGIO = process.env.COGNOME || 'MANNUCA';
const SETTIMANE_DA_CALCOLARE = parseInt(process.env.SETTIMANE_AVANTI || '20');
const DATA_MINIMA_PASSATO = process.env.DATA_MINIMA_PASSATO || '2026-01-01'; // 2026: anno corrente
// Anno di riferimento usato per disambiguare i file che non scrivono l'anno nel titolo.
// Sovrascrivibile via variabile d'ambiente ANNO_RIFERIMENTO su Railway.
const ANNO_RIFERIMENTO = parseInt(process.env.ANNO_RIFERIMENTO || '2026');

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
 * Calcola le date a cui si riferisce un giornaliero ricevuto nel giorno
 * `dataRicezione` (formato YYYY-MM-DD), seguendo la regola confermata
 * da Giorgio:
 *
 * - Normalmente: il giornaliero del giorno X si riferisce a X+1 (domani)
 * - Venerdì: si riferisce a sabato, domenica E lunedì (3 giorni)
 * - Se X+1 è festività nazionale: si riferisce a X+1 E X+2 (2 giorni),
 *   perché gli uffici non lavorano nel festivo, quindi includono anche
 *   il giorno dopo il festivo
 *
 * Ritorna un array di stringhe YYYY-MM-DD in ordine cronologico.
 */
function calcolaDateGiornaliero(dataRicezione) {
  const { isFestivita } = require('./festivita-italiane');
  const d = new Date(dataRicezione + 'T00:00:00');
  const giornoSettimana = d.getDay(); // 0=dom, 1=lun, ..., 5=ven, 6=sab

  const dateRiferite = [];

  if (giornoSettimana === 5) {
    // Venerdì: sabato, domenica e lunedì
    for (let i = 1; i <= 3; i++) {
      dateRiferite.push(parserTurni.formattaDataLocale(parserTurni.aggiungiGiorni(d, i)));
    }
  } else {
    // Tutti gli altri giorni: domani
    const domani = parserTurni.aggiungiGiorni(d, 1);
    const domaniStr = parserTurni.formattaDataLocale(domani);
    dateRiferite.push(domaniStr);

    // Se domani è festività nazionale, aggiungi anche dopodomani
    if (isFestivita(domaniStr)) {
      dateRiferite.push(parserTurni.formattaDataLocale(parserTurni.aggiungiGiorni(d, 2)));
    }
  }

  return dateRiferite;
}

/**
 * Calcola la data da usare come "riferimento" per indovinare l'anno quando
 * il titolo del file settimanale non lo specifica (es. "TURNI DAL 22 AL 28
 * GIUGNO", senza anno). Usa ANNO_RIFERIMENTO come ancora fissa (configurabile
 * via variabile d'ambiente su Railway) invece della mediana del database, che
 * può puntare all'anno sbagliato se ci sono vecchi dati storici — esattamente
 * il bug che causava l'interpretazione di file del 2026 come se fossero 2025.
 */
function calcolaDataRiferimentoAnno(db) {
  // Usa ANNO_RIFERIMENTO come ancora: produce una data al 1° luglio dell'anno
  // configurato, che sarà sempre la scelta più vicina per qualsiasi settimana
  // di quell'anno, indipendentemente da cosa c'è nel database.
  return `${ANNO_RIFERIMENTO}-07-01`;
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
 * Elabora il GIORNALIERO (PDF): trova il turno di Giorgio, lo confronta con
 * quelli già calcolati/salvati per le date di riferimento (che possono essere
 * più di una: es. venerdì si riferisce a sab+dom+lun), e segnala discrepanze.
 *
 * dateRiferite: array di stringhe YYYY-MM-DD a cui si riferisce questo giornaliero
 */
function elaboraGiornaliero(risultatoPdf, dateRiferite, db) {
  if (!risultatoPdf.trovato) {
    return { discrepanza: false, messaggio: risultatoPdf.messaggio, dettagli: null };
  }

  if (!Array.isArray(dateRiferite)) dateRiferite = [dateRiferite]; // compatibilità retroattiva

  const discrepanze = [];
  const messaggi = [];

  for (const dataDaControllare of dateRiferite) {
    const turnoSalvato = db.get('turni').find({ data: dataDaControllare }).value();

    if (risultatoPdf.assente) {
      if (turnoSalvato && turnoSalvato.tipo !== 'r') {
        discrepanze.push({ data: dataDaControllare, tipo: 'assente' });
        messaggi.push(`${dataDaControllare}: giornaliero segnala ASSENTE ma nel piano c'è turno ${turnoSalvato.orario}`);
      }
      continue;
    }

    if (!turnoSalvato) {
      messaggi.push(`${dataDaControllare}: nessun turno calcolato salvato, impossibile confrontare`);
      continue;
    }

    if (!risultatoPdf.orario) {
      messaggi.push(`${dataDaControllare}: orario non estratto dal PDF`);
      continue;
    }

    const normalizza = s => (s || '').replace(/\s/g, '').replace('–','-').replace('—','-');
    const uguale = normalizza(turnoSalvato.orario) === normalizza(risultatoPdf.orario);

    if (!uguale) {
      discrepanze.push({ data: dataDaControllare, atteso: turnoSalvato.orario, reale: risultatoPdf.orario });
      messaggi.push(`⚠️ DISCREPANZA ${dataDaControllare}: piano="${turnoSalvato.orario}" · giornaliero="${risultatoPdf.orario}"`);
    } else {
      messaggi.push(`${dataDaControllare}: ✅ confermato ${risultatoPdf.orario}`);
    }
  }

  return {
    discrepanza: discrepanze.length > 0,
    date_riferite: dateRiferite,
    messaggio: messaggi.join(' | '),
    discrepanze,
    dettagli: risultatoPdf
  };
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

      // Se il client passa esplicitamente una data, usala; altrimenti calcola
      // automaticamente le date di riferimento in base al giorno della settimana
      // (es. venerdì → sab+dom+lun, pre-festivo → domani+dopodomani, ecc.)
      const dateRiferite = req.body.data
        ? [req.body.data]
        : calcolaDateGiornaliero(oggiLocale());

      const confronto = elaboraGiornaliero(risultatoPdf, dateRiferite, db);

      db.get('email_log').push({
        tipo, filename,
        contenuto_estratto: confronto.messaggio,
        discrepanza: confronto.discrepanza,
        discrepanza_note: confronto.discrepanza ? confronto.messaggio : '',
        created_at: new Date().toISOString()
      }).write();

      // Invia notifica push se c'è una discrepanza
      if (confronto.discrepanza) {
        notifichePush.inizializzaVapid(db);
        await notifichePush.inviaNotifica(db, {
          title: '⚠️ TurniApp — Discrepanza rilevata',
          body: confronto.messaggio,
          tipo: 'discrepanza',
          url: '/#email'
        });
      }

      fs.unlinkSync(filePath);
      return res.json({
        ok: true, tipo, filename,
        date_riferite: dateRiferite,
        messaggio: confronto.messaggio,
        discrepanza: confronto.discrepanza,
        dettagli: confronto.dettagli
      });
    }
  } catch (err) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    console.error('Errore parsing file:', err);
    return res.status(500).json({ error: 'Errore durante la lettura del file: ' + err.message });
  }
});

// ===== NOTIFICHE PUSH =====

// Restituisce la chiave pubblica VAPID al frontend (serve per creare la subscription)
app.get('/api/push/vapid-public-key', (req, res) => {
  const db = require('./db/database');
  const chiavePublica = notifichePush.inizializzaVapid(db);
  res.json({ publicKey: chiavePublica });
});

// Registra la subscription push di un dispositivo
app.post('/api/push/subscribe', (req, res) => {
  const { subscription } = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Subscription non valida' });
  }
  const db = require('./db/database');
  notifichePush.inizializzaVapid(db);
  notifichePush.salvaSubscription(db, subscription);
  res.json({ ok: true });
});

// Rimuove la subscription (quando l'utente disattiva le notifiche)
app.post('/api/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  const db = require('./db/database');
  notifichePush.rimuoviSubscription(db, endpoint);
  res.json({ ok: true });
});

// Test notifica (per verificare che funzioni dal pannello impostazioni)
app.post('/api/push/test', async (req, res) => {
  const db = require('./db/database');
  notifichePush.inizializzaVapid(db);
  const risultato = await notifichePush.inviaNotifica(db, {
    title: '✅ TurniApp — Test notifica',
    body: 'Le notifiche funzionano correttamente!',
    tipo: 'generico',
    url: '/'
  });
  res.json(risultato);
});

// Cron mattutino: ogni giorno alle 07:00 invia il turno del giorno
cron.schedule('0 7 * * *', async () => {
  try {
    const db = require('./db/database');
    const oggi = oggiLocale();
    const turno = db.get('turni').find({ data: oggi }).value();

    let body = turno
      ? `${turno.orario} — ${turno.tipo === 'r' ? 'Giorno di riposo 😴' : 'Buona giornata! 💪'}`
      : 'Nessun turno trovato per oggi';

    // Controlla anche i cambi turno per modificare il messaggio
    const cambio = db.get('cambi').value().find(c => c.data_ceduta === oggi);
    if (cambio) {
      body = cambio.data_ricevuta === oggi && cambio.orario_ricevuto
        ? `${cambio.orario_ricevuto} (cambio con ${cambio.collega})`
        : `Riposo — turno ceduto a ${cambio.collega}`;
    }

    await notifichePush.inviaNotifica(db, {
      title: `📅 Turno di oggi — ${oggi}`,
      body,
      tipo: 'turno_giorno',
      url: '/'
    });
  } catch (err) {
    console.error('Errore cron notifica mattutina:', err.message);
  }
}, { timezone: 'Europe/Rome' });

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
        if (tipoIndovinato === 'settimanale') {
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
          // Giornaliero PDF — usa la data di ricezione dell'email (non "oggi"
          // del server) per calcolare le date di riferimento corrette, perché
          // le email possono arrivare di notte o al mattino presto e il server
          // potrebbe trovarsi in un fuso orario diverso.
          const dataRicezioneEmail = dataRicezione
            ? parserTurni.formattaDataLocale(new Date(dataRicezione))
            : oggiLocale();

          const dateRiferite = calcolaDateGiornaliero(dataRicezioneEmail);
          const risultatoPdf = await parserPdf.leggiGiornalieroPdf(allegato.percorsoLocale, COGNOME_GIORGIO);
          const confronto = elaboraGiornaliero(risultatoPdf, dateRiferite, db);

          db.get('email_log').push({
            tipo: 'giornaliero', filename: allegato.nomeOriginale,
            contenuto_estratto: `[Auto da Gmail] ${confronto.messaggio}`,
            discrepanza: confronto.discrepanza,
            discrepanza_note: confronto.discrepanza ? confronto.messaggio : '',
            created_at: new Date().toISOString()
          }).write();

          // Notifica push: discrepanza (alta priorità) o conferma turno
          notifichePush.inizializzaVapid(db);
          if (confronto.discrepanza) {
            await notifichePush.inviaNotifica(db, {
              title: '⚠️ TurniApp — Discrepanza rilevata',
              body: confronto.messaggio,
              tipo: 'discrepanza',
              url: '/#email'
            });
          } else if (risultatoPdf.trovato && risultatoPdf.orario) {
            // Notifica di conferma: "domani il tuo turno è confermato"
            const dataRif = dateRiferite[0] || '';
            await notifichePush.inviaNotifica(db, {
              title: `📋 Turno confermato — ${dataRif}`,
              body: `${risultatoPdf.orario} — nessuna variazione rispetto al piano`,
              tipo: 'nuova_email',
              url: '/'
            });
          }

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
