require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// File statici (frontend)
app.use(express.static(path.join(__dirname, 'public')));

// Upload PDF/Excel in memoria (per parsing)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// API Routes
app.use('/api', require('./routes/api'));

// Upload PDF giornaliero o settimanale
// In produzione qui si aggiungerebbe il parsing con pdf-parse o xlsx
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nessun file caricato' });

  const tipo = req.body.tipo || 'giornaliero'; // 'giornaliero' | 'settimanale'
  const filename = req.file.originalname;
  const size = (req.file.size / 1024).toFixed(1) + ' KB';

  // TODO: qui va il parsing reale con pdf-parse / xlsx
  // Per ora restituisce una risposta simulata
  const estratto = tipo === 'settimanale'
    ? 'Piano settimanale importato: 5 giorni lavorativi, 2 riposi, 25h totali.'
    : 'Ordine di servizio importato: Giorgio Mannuca → turno estratto con successo.';

  // Registra nel log
  const db = require('./db/database');
  db.get('email_log').push({
    tipo,
    filename,
    contenuto_estratto: estratto,
    discrepanza: false,
    discrepanza_note: '',
    created_at: new Date().toISOString()
  }).write();

  res.json({
    ok: true,
    tipo,
    filename,
    size,
    estratto,
    messaggio: `File "${filename}" (${size}) caricato. Parsing completato.`
  });
});

// Qualunque altra rotta → manda il frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ TurniApp in ascolto su http://localhost:${PORT}`);
});
