const express = require('express');
const router = express.Router();
const db = require('../db/database');
const parserTurni = require('../parser-turni');
const { cercaCollega, trovaGruppoEsatto } = require('../colleghi');
const calcolaPaga = require('../calcolo-paga');

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
  const {
    data_ceduta, orario_ceduto, collega, gruppo_collega,
    data_ricevuta, orario_ricevuto, stato, note,
    tipo,
    // Campi aggiuntivi per cambio a 3 persone
    collega_c, gruppo_collega_c, data_ceduta_b, orario_ceduto_b
  } = req.body;

  if (!data_ceduta || !orario_ceduto || !collega) {
    return res.status(400).json({ error: 'data_ceduta, orario_ceduto e collega sono obbligatori' });
  }

  const id = db.get('next_cambio_id').value();
  const record = {
    id,
    tipo: tipo || 'due',  // 'due' = cambio normale, 'tre' = catena a 3
    data_ceduta,
    orario_ceduto,
    collega,
    gruppo_collega: gruppo_collega || null,
    data_ricevuta: data_ricevuta || '',
    orario_ricevuto: orario_ricevuto || '',
    stato: stato || 'pending',
    note: note || '',
    created_at: new Date().toISOString()
  };

  // Dati aggiuntivi solo per cambio a 3
  if (tipo === 'tre') {
    record.collega_c = collega_c || '';
    record.gruppo_collega_c = gruppo_collega_c || null;
    record.data_ceduta_b = data_ceduta_b || '';   // giorno in cui B cede a C
    record.orario_ceduto_b = orario_ceduto_b || ''; // orario ceduto da B a C
  }

  db.get('cambi').push(record).write();
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

// ===== COLLEGHI (autocompletamento) =====

// GET /api/colleghi?q=man -> suggerimenti nome + gruppo
router.get('/colleghi', (req, res) => {
  const { q } = req.query;
  const risultati = cercaCollega(q || '');
  res.json(risultati);
});

// GET /api/colleghi/:nome -> gruppo esatto di un collega (match esatto)
router.get('/colleghi/:nome', (req, res) => {
  const gruppo = trovaGruppoEsatto(req.params.nome);
  res.json({ nome: req.params.nome, gruppo });
});

// ===== VALIDAZIONE 11H =====

// POST /api/valida-cambio -> verifica che cedere un turno e riceverne un altro rispetti le 11h
// body: { data_ceduta, orario_ricevuto_al_posto } (l'orario che Giorgio avrà quel giorno DOPO il cambio)
router.post('/valida-cambio', (req, res) => {
  const { data_ceduta, nuovo_orario } = req.body;
  if (!data_ceduta) return res.status(400).json({ error: 'data_ceduta obbligatoria' });

  // Prendi tutti i turni ordinati, sostituendo quello del giorno del cambio col nuovo orario (se fornito)
  const turni = [...db.get('turni').value()].sort((a, b) => a.data.localeCompare(b.data));
  const turniSimulati = turni.map(t => {
    if (t.data === data_ceduta && nuovo_orario) {
      const classificato = parserTurni.classificaTurno(nuovo_orario);
      return { ...t, orario: classificato.orario, tipo: classificato.tipo };
    }
    return t;
  });

  const risultato = parserTurni.verificaRiposo11h(turniSimulati, data_ceduta);
  res.json(risultato);
});

// ===== SUGGERIMENTI VACANZA =====

// GET /api/suggerimenti-vacanza -> riposi doppi già esistenti + proposte di cambio per crearne
router.get('/suggerimenti-vacanza', (req, res) => {
  const turni = [...db.get('turni').value()].sort((a, b) => a.data.localeCompare(b.data));

  // Limita ai prossimi 90 giorni da oggi per non proporre cose troppo lontane
  const oggi = new Date().toISOString().slice(0, 10);
  const turniFuturi = turni.filter(t => t.data >= oggi);

  const riposiEsistenti = parserTurni.trovaRiposiConsecutivi(turniFuturi);
  const proposteCambio = parserTurni.suggerisciRiposiDoppi(turniFuturi);

  // Per ogni proposta, verifica anche che cedere quel turno non violi le 11h
  // (controllo del turno adiacente a quello che RESTA scoperto se lo cedo, dal lato opposto al riposo)
  const proposteValidate = proposteCambio.map(p => {
    const turniSimulati = turniFuturi.map(t => {
      if (t.data === p.data_da_cedere) {
        return { ...t, tipo: 'r', orario: 'Riposo' };
      }
      return t;
    });
    const validazione = parserTurni.verificaRiposo11h(turniSimulati, p.data_da_cedere);
    return { ...p, validazione_11h: validazione.valido ? 'ok' : 'attenzione', dettagli_11h: validazione.problemi };
  });

  res.json({
    riposi_doppi_esistenti: riposiEsistenti,
    proposte_cambio: proposteValidate
  });
});

// ===== STRAORDINARI =====

// GET /api/straordinari?mese=2025-06 -> straordinari inseriti manualmente, filtrati per mese
router.get('/straordinari', (req, res) => {
  const { mese } = req.query;
  let lista = db.get('straordinari').value() || [];
  if (mese) lista = lista.filter(s => s.data.startsWith(mese));
  res.json([...lista].sort((a, b) => a.data.localeCompare(b.data)));
});

// POST /api/straordinari -> aggiungi ore di straordinario per una data
// body: { data, ore, notturno: bool, giornoRiposo: bool, note }
router.post('/straordinari', (req, res) => {
  const { data, ore, notturno, giornoRiposo, note } = req.body;
  if (!data || !ore) return res.status(400).json({ error: 'data e ore sono obbligatori' });

  const id = db.get('next_straordinario_id').value() || 1;
  db.get('straordinari').push({
    id, data, ore: parseFloat(ore),
    notturno: !!notturno, giornoRiposo: !!giornoRiposo,
    note: note || '', created_at: new Date().toISOString()
  }).write();
  db.set('next_straordinario_id', id + 1).write();
  res.json({ ok: true, id });
});

router.delete('/straordinari/:id', (req, res) => {
  db.get('straordinari').remove({ id: parseInt(req.params.id) }).write();
  res.json({ ok: true });
});

// ===== CALCOLO PAGA MENSILE (consapevole dei cambi turno) =====

/**
 * Calcola i turni EFFETTIVAMENTE lavorati in un dato mese, tenendo conto
 * dei cambi turno: se un giorno ha un cambio, il turno da considerare ai
 * fini della paga non è più quello originale (calcolato dalla rotazione),
 * ma quello realmente lavorato — Riposo se Giorgio ha solo CEDUTO il turno
 * quel giorno, oppure l'orario RICEVUTO se quel giorno coincide con la data
 * di un turno ricevuto da un collega.
 *
 * Questo garantisce che le ore notturne/festive ricevute tramite scambio
 * vengano conteggiate correttamente nello stipendio, e quelle cedute no.
 */
function calcolaTurniEffettiviMese(mese) {
  const turniMese = db.get('turni').value().filter(t => t.data.startsWith(mese));
  const tuttiCambi = db.get('cambi').value() || [];

  // Mappa rapida: data -> cambio, sia per il giorno ceduto che per quello ricevuto
  const cambiPerDataCeduta = {};
  const cambiPerDataRicevuta = {};
  tuttiCambi.forEach(c => {
    cambiPerDataCeduta[c.data_ceduta] = c;
    if (c.data_ricevuta) cambiPerDataRicevuta[c.data_ricevuta] = c;
  });

  return turniMese.map(t => {
    const cambioCeduto = cambiPerDataCeduta[t.data];
    if (cambioCeduto) {
      // Quel giorno Giorgio ha ceduto il turno originale: ai fini paga conta come Riposo,
      // A MENO CHE quello stesso giorno non coincida ANCHE con una data di ricezione
      // (caso raro ma possibile: scambio nello stesso giorno).
      if (cambioCeduto.data_ricevuta === t.data && cambioCeduto.orario_ricevuto) {
        return { ...t, orario: cambioCeduto.orario_ricevuto, tipo: classificaOrarioPerTipo(cambioCeduto.orario_ricevuto), fonte: 'cambio_ricevuto' };
      }
      return { ...t, orario: 'Riposo', tipo: 'r', fonte: 'cambio_ceduto' };
    }
    return t;
  }).concat(
    // Aggiunge eventuali giorni RICEVUTI che cadono in questo mese ma che
    // NON corrispondono a una data già presente in turniMese (es. ricevuto
    // un turno in un giorno che nella griglia originale non era nemmeno
    // calcolato, scenario limite ma da coprire per correttezza).
    tuttiCambi
      .filter(c => c.data_ricevuta && c.data_ricevuta.startsWith(mese) && c.orario_ricevuto)
      .filter(c => !turniMese.some(t => t.data === c.data_ricevuta))
      .map(c => ({
        data: c.data_ricevuta,
        orario: c.orario_ricevuto,
        tipo: classificaOrarioPerTipo(c.orario_ricevuto),
        fonte: 'cambio_ricevuto'
      }))
  );
}

// Classifica rapidamente un orario "HH:MM-HH:MM" nel tipo turno (m/p/s/n/r),
// usata per i turni ricevuti via cambio che non hanno già un tipo assegnato.
function classificaOrarioPerTipo(orarioStr) {
  if (!orarioStr || orarioStr.toLowerCase().includes('riposo')) return 'r';
  const match = orarioStr.match(/(\d{1,2}):/);
  if (!match) return 'r';
  const ora = parseInt(match[1]);
  if (ora >= 5 && ora < 11) return 'm';
  if (ora >= 11 && ora < 16) return 'p';
  if (ora >= 16 && ora < 20) return 's';
  return 'n';
}

// GET /api/paga-mensile?mese=2026-05 -> riepilogo completo, mese DI PAGAMENTO
// (calcola automaticamente il mese di competenza precedente, secondo lo
// sfasamento contrattuale confermato da Giorgio: lo stipendio di un mese
// paga le ore del mese precedente), tenendo conto dei cambi turno.
router.get('/paga-mensile', (req, res) => {
  const { mese, mese_competenza_diretto } = req.query;
  if (!mese) return res.status(400).json({ error: 'parametro mese (YYYY-MM) obbligatorio' });

  // Se il chiamante passa esplicitamente mese_competenza_diretto=1, il
  // parametro "mese" è già il mese di competenza (utile per la card "Questo
  // mese" in home, che mostra le ore maturate ora, non lo stipendio futuro).
  const meseCompetenza = mese_competenza_diretto ? mese : calcolaPaga.calcolaMeseCompetenza(mese);

  const turniEffettivi = calcolaTurniEffettiviMese(meseCompetenza);
  const straordinariDelMese = (db.get('straordinari').value() || []).filter(s => s.data.startsWith(meseCompetenza));
  const pagaOraria = parseFloat(db.get('impostazioni.paga_oraria').value() || 12);

  const riepilogo = calcolaPaga.calcolaRiepilogoMensile(turniEffettivi, straordinariDelMese, pagaOraria);
  res.json({
    mese_pagamento: mese,
    mese_competenza: meseCompetenza,
    pagaOraria,
    ...riepilogo
  });
});

// GET /api/ore-notturne-mese?mese=2026-06 -> totale ore notturne MATURATE in
// questo mese di competenza (per la card "Questo mese" in home), tenendo
// conto dei cambi turno in tempo reale.
router.get('/ore-notturne-mese', (req, res) => {
  const { mese } = req.query;
  const meseTarget = mese || new Date().toISOString().slice(0, 7);
  const turniEffettivi = calcolaTurniEffettiviMese(meseTarget);

  let oreNotturneTotali = 0;
  turniEffettivi.forEach(t => {
    if (t.tipo === 'r') return;
    const { oreNotturne } = calcolaPaga.scomponiOreNotteGiorno(t.orario);
    oreNotturneTotali += oreNotturne;
  });

  res.json({ mese: meseTarget, ore_notturne: oreNotturneTotali });
});

// ===== NOTE CALENDARIO =====

// GET /api/note?mese=2025-06 -> tutte le note del mese
router.get('/note', (req, res) => {
  const { mese } = req.query;
  let note = db.get('note_calendario').value() || [];
  if (mese) note = note.filter(n => n.data.startsWith(mese));
  res.json(note);
});

// GET /api/note/:data -> nota di un giorno specifico
router.get('/note/:data', (req, res) => {
  const nota = (db.get('note_calendario').value() || []).find(n => n.data === req.params.data);
  res.json(nota || null);
});

// POST /api/note -> crea o aggiorna la nota di un giorno
// body: { data, testo }
router.post('/note', (req, res) => {
  const { data, testo } = req.body;
  if (!data) return res.status(400).json({ error: 'data obbligatoria' });

  const exists = (db.get('note_calendario').value() || []).find(n => n.data === data);
  if (exists) {
    if (!testo || !testo.trim()) {
      // testo vuoto = elimina la nota
      db.get('note_calendario').remove({ data }).write();
      return res.json({ ok: true, action: 'deleted' });
    }
    db.get('note_calendario').find({ data }).assign({ testo, updated_at: new Date().toISOString() }).write();
    return res.json({ ok: true, action: 'updated' });
  } else {
    if (!testo || !testo.trim()) return res.json({ ok: true, action: 'noop' });
    db.get('note_calendario').push({ data, testo, created_at: new Date().toISOString() }).write();
    return res.json({ ok: true, action: 'created' });
  }
});

router.delete('/note/:data', (req, res) => {
  db.get('note_calendario').remove({ data: req.params.data }).write();
  res.json({ ok: true });
});

module.exports = router;

