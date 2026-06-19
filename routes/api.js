const express = require('express');
const router = express.Router();
const db = require('../db/database');

// ===== TURNI =====

router.get('/turni', (req, res) => {
  const { mese } = req.query;
  let turni = db.get('turni').value();
  if (mese) {
    turni = turni.filter(t => t.data.startsWith(mese));
  }
  turni = [...turni].sort((a, b) => a.data.localeCompare(b.data));
  res.json(turni);
});

router.get('/turni/:data', (req, res) => {
  const turno = db.get('turni').find({ data: req.params.data }).value();
  res.json(turno || null);
});

router.post('/turni', (req, res) => {
  const { data, orario, tipo, fonte, note } = req.body;
  if (!data || !orario || !tipo) return res.status(400).json({ error: 'data, orario e tipo sono obbligatori' });

  const exists = db.get('turni').find({ data }).value();
  if (exists) {
    db.get('turni').find({ data }).assign({ orario, tipo, fonte: fonte || 'manuale', note: note || '' }).write();
    res.json({ ok: true, action: 'updated' });
  } else {
    db.get('turni').push({ data, orario, tipo, fonte: fonte || 'manuale', note: note || '' }).write();
    res.json({ ok: true, action: 'created' });
  }
});

router.delete('/turni/:data', (req, res) => {
  db.get('turni').remove({ data: req.params.data }).write();
  res.json({ ok: true });
});

// ===== CAMBI TURNO =====

router.get('/cambi', (req, res) => {
  const cambi = [...db.get('cambi').value()].sort((a, b) => b.data_ceduta.localeCompare(a.data_ceduta));
  res.json(cambi);
});

router.post('/cambi', (req, res) => {
  const { data_ceduta, orario_ceduto, collega, data_ricevuta, orario_ricevuto, stato, note } = req.body;
  if (!data_ceduta || !orario_ceduto || !collega) {
    return res.status(400).json({ error: 'data_ceduta, orario_ceduto e collega sono obbligatori' });
  }
  const id = db.get('next_cambio_id').value();
  db.get('cambi').push({
    id,
    data_ceduta,
    orario_ceduto,
    collega,
    data_ricevuta: data_ricevuta || '',
    orario_ricevuto: orario_ricevuto || '',
    stato: stato || 'pending',
    note: note || '',
    created_at: new Date().toISOString()
  }).write();
  db.set('next_cambio_id', id + 1).write();
  res.json({ ok: true, id });
});

router.put('/cambi/:id', (req, res) => {
  const { stato, note } = req.body;
  db.get('cambi').find({ id: parseInt(req.params.id) }).assign({ stato, note: note || '' }).write();
  res.json({ ok: true });
});

router.delete('/cambi/:id', (req, res) => {
  db.get('cambi').remove({ id: parseInt(req.params.id) }).write();
  res.json({ ok: true });
});

// ===== EMAIL LOG =====

router.get('/email-log', (req, res) => {
  const logs = [...db.get('email_log').value()]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 20);
  res.json(logs);
});

router.post('/email-log', (req, res) => {
  const { tipo, filename, contenuto_estratto, discrepanza, discrepanza_note } = req.body;
  db.get('email_log').push({
    tipo,
    filename: filename || '',
    contenuto_estratto: contenuto_estratto || '',
    discrepanza: !!discrepanza,
    discrepanza_note: discrepanza_note || '',
    created_at: new Date().toISOString()
  }).write();
  res.json({ ok: true });
});

// ===== IMPOSTAZIONI =====

router.get('/impostazioni', (req, res) => {
  res.json(db.get('impostazioni').value());
});

router.put('/impostazioni/:chiave', (req, res) => {
  const { valore } = req.body;
  db.set(`impostazioni.${req.params.chiave}`, valore).write();
  res.json({ ok: true });
});

// ===== DISCREPANZE =====

router.post('/controlla-discrepanza', (req, res) => {
  const { data, orario_giornaliero } = req.body;
  const turno = db.get('turni').find({ data }).value();
  if (!turno) return res.json({ discrepanza: false, messaggio: 'Nessun turno salvato per questa data' });

  const normalizza = str => str.replace(/\s/g, '').replace('–', '-').replace('—', '-');
  const uguale = normalizza(turno.orario) === normalizza(orario_giornaliero);

  res.json({
    discrepanza: !uguale,
    turno_salvato: turno.orario,
    turno_giornaliero: orario_giornaliero,
    messaggio: uguale
      ? 'Nessuna discrepanza: il giornaliero corrisponde al piano.'
      : `⚠️ DISCREPANZA: piano = "${turno.orario}" · giornaliero = "${orario_giornaliero}"`
  });
});

module.exports = router;
