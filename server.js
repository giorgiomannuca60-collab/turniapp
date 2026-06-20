require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const parserTurni = require('./parser-turni');

const app = express();
const PORT = process.env.PORT || 3000;

// Configurazione fissa: il gruppo di Giorgio e quante settimane calcolare in avanti
const GRUPPO_GIORGIO = 11;
const SETTIMANE_DA_CALCOLARE = 20; // ~ fino a ottobre

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// File statici (frontend)
app.use(express.static(path.join(__dirname, 'public')));

// Upload: salva temporaneamente su disco per poterlo leggere con la libreria xlsx
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
  return lun.toISOString().slice(0, 10);
}

// Upload piano SETTIMANALE (Excel) → calcola automaticamente i turni futuri
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nessun file caricato' });

  const tipo = req.body.tipo || 'giornaliero';
  const filename = req.file.originalname;
  const filePath = req.file.path;
  const db = require('./db/database');

  try {
    if (tipo === 'settimanale') {
      // ===== PARSING REALE DEL FILE EXCEL =====
      const { griglia, dateSettimana } = parserTurni.leggiGrigliaSettimanale(filePath);

      if (!griglia[GRUPPO_GIORGIO]) {
        throw new Error(`Gruppo ${GRUPPO_GIORGIO} non trovato nel file caricato`);
      }

      // Determina il lunedì della settimana del file caricato.
      // Se l'utente specifica una data nel body la usiamo, altrimenti assumiamo la settimana corrente.
      const dataLunedi = req.body.data_lunedi || lunediDellaSettimana(new Date().toISOString().slice(0,10));

      // 1. Calcola i turni futuri seguendo la rotazione (per le prossime N settimane)
      const turniCalcolati = parserTurni.calcolaTurniFuturi(dataLunedi, griglia, GRUPPO_GIORGIO, SETTIMANE_DA_CALCOLARE);

      // 2. Confronta con i turni già calcolati in precedenza per la STESSA settimana → rileva discrepanze
      const { discrepanze } = parserTurni.confrontaConNuovoFile(
        turniCalcolati,
        griglia,
        dataLunedi,
        GRUPPO_GIORGIO
      );

      // 3. Salva/aggiorna tutti i turni calcolati nel database
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

      const estratto = `Calcolati ${turniCalcolati.length} turni (${SETTIMANE_DA_CALCOLARE} settimane) dal Gruppo ${GRUPPO_GIORGIO}, rotazione applicata su 15 gruppi.`;

      db.get('email_log').push({
        tipo, filename,
        contenuto_estratto: estratto,
        discrepanza: discrepanze.length > 0,
        discrepanza_note: discrepanze.map(d => d.messaggio).join(' | '),
        created_at: new Date().toISOString()
      }).write();

      fs.unlinkSync(filePath); // pulizia file temporaneo

      return res.json({
        ok: true, tipo, filename,
        turni_calcolati: turniCalcolati.length,
        discrepanze,
        messaggio: estratto
      });

    } else {
      // ===== GIORNALIERO (PDF) — confronto con turno già salvato =====
      // Parsing PDF non incluso in questa versione: registriamo solo il caricamento.
      const estratto = `File giornaliero "${filename}" caricato. Parsing PDF automatico non ancora attivo — confronto manuale consigliato.`;
      db.get('email_log').push({
        tipo, filename, contenuto_estratto: estratto,
        discrepanza: false, discrepanza_note: '',
        created_at: new Date().toISOString()
      }).write();

      fs.unlinkSync(filePath);
      return res.json({ ok: true, tipo, filename, messaggio: estratto });
    }
  } catch (err) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    console.error('Errore parsing file:', err);
    return res.status(500).json({ error: 'Errore durante la lettura del file: ' + err.message });
  }
});

// Qualunque altra rotta → manda il frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ TurniApp in ascolto su http://localhost:${PORT}`);
});
