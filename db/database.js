const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');

const adapter = new FileSync(path.join(__dirname, 'turni.json'));
const db = low(adapter);

// Stato iniziale del database
db.defaults({
  turni: [],
  cambi: [],
  email_log: [],
  impostazioni: {
    nome: 'Giorgio Mannuca',
    gruppo: 'P.T. 11',
    ore_settimanali: '25',
    paga_oraria: '12',
    notif_mattina: '1',
    notif_email: '1',
    notif_promemoria: '0',
    notif_discrepanze: '1'
  },
  next_cambio_id: 1,
  gmail_tokens: null,
  gmail_ultima_scansione: null,
  gmail_email_elaborate: [],
  straordinari: [],
  next_straordinario_id: 1,
  note_calendario: [],
  push_subscriptions: [],   // subscription push di ogni dispositivo registrato
  vapid_keys: null           // chiavi VAPID generate al primo avvio
}).write();

// Inserisci dati di esempio solo se il database è vuoto
if (db.get('turni').size().value() === 0) {
  db.get('turni').push(
    { data: '2025-06-23', orario: '13:00-18:00', tipo: 'p', fonte: 'email', note: '' },
    { data: '2025-06-24', orario: 'Riposo', tipo: 'r', fonte: 'email', note: '' },
    { data: '2025-06-25', orario: '07:00-13:00', tipo: 'm', fonte: 'email', note: '' },
    { data: '2025-06-26', orario: '20:00-01:00', tipo: 's', fonte: 'email', note: '' },
    { data: '2025-06-27', orario: '13:00-18:00', tipo: 'p', fonte: 'email', note: '' },
    { data: '2025-06-28', orario: '07:00-13:00', tipo: 'm', fonte: 'email', note: '' },
    { data: '2025-06-29', orario: 'Riposo', tipo: 'r', fonte: 'email', note: '' }
  ).write();

  db.get('cambi').push(
    { id: 1, data_ceduta: '2025-06-23', orario_ceduto: '13:00-18:00', collega: 'Francesco M.', data_ricevuta: '2025-06-25', orario_ricevuto: '07:00-13:00', stato: 'ok', note: 'Accordo resp. Carbone', created_at: new Date().toISOString() },
    { id: 2, data_ceduta: '2025-06-29', orario_ceduto: '07:00-13:00', collega: 'Andrea T.', data_ricevuta: '2025-06-28', orario_ricevuto: '13:00-18:00', stato: 'pending', note: 'Via WhatsApp 17/06', created_at: new Date().toISOString() }
  ).write();

  db.set('next_cambio_id', 3).write();
}

module.exports = db;
