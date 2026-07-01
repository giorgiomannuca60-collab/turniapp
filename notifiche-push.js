/**
 * notifiche-push.js
 * Gestisce l'invio delle notifiche push Web Push (standard PWA) al telefono
 * di Giorgio, usando le chiavi VAPID per autenticare il server.
 *
 * Flusso:
 * 1. Il frontend registra il Service Worker e chiede il permesso notifiche
 * 2. Il browser genera una "subscription" (endpoint + chiavi crittografiche)
 * 3. La subscription viene salvata nel database
 * 4. Il server usa web-push per inviare notifiche push a quella subscription
 */

const webpush = require('web-push');

/**
 * Inizializza web-push con le chiavi VAPID.
 * Le chiavi vengono lette dalle variabili d'ambiente (impostate su Railway),
 * oppure generate automaticamente al primo avvio e salvate nel database.
 */
function inizializzaVapid(db) {
  let vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
  let vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;

  if (!vapidPublicKey || !vapidPrivateKey) {
    // Nessuna chiave nelle variabili d'ambiente: leggi dal database
    const chiavi = db.get('vapid_keys').value();
    if (chiavi && chiavi.publicKey && chiavi.privateKey) {
      vapidPublicKey = chiavi.publicKey;
      vapidPrivateKey = chiavi.privateKey;
    } else {
      // Prima volta in assoluto: genera nuove chiavi e salvale nel database
      const nuoveChiavi = webpush.generateVAPIDKeys();
      vapidPublicKey = nuoveChiavi.publicKey;
      vapidPrivateKey = nuoveChiavi.privateKey;
      db.set('vapid_keys', {
        publicKey: vapidPublicKey,
        privateKey: vapidPrivateKey,
        generato_il: new Date().toISOString()
      }).write();
      console.log('✅ Nuove chiavi VAPID generate e salvate nel database');
    }
  }

  webpush.setVapidDetails(
    'mailto:turniapp@notifiche.it',
    vapidPublicKey,
    vapidPrivateKey
  );

  return vapidPublicKey;
}

/**
 * Salva o aggiorna la subscription push di un dispositivo nel database.
 * Se la subscription esiste già (stesso endpoint), la aggiorna.
 */
function salvaSubscription(db, subscription) {
  const subs = db.get('push_subscriptions').value() || [];
  const esistente = subs.findIndex(s => s.endpoint === subscription.endpoint);
  if (esistente >= 0) {
    db.get('push_subscriptions').nth(esistente).assign({
      ...subscription,
      aggiornato_il: new Date().toISOString()
    }).write();
  } else {
    db.get('push_subscriptions').push({
      ...subscription,
      salvato_il: new Date().toISOString()
    }).write();
  }
}

/**
 * Rimuove una subscription dal database (es. se il browser la revoca).
 */
function rimuoviSubscription(db, endpoint) {
  db.get('push_subscriptions').remove({ endpoint }).write();
}

/**
 * Invia una notifica push a TUTTE le subscription salvate.
 * Se una subscription non è più valida (410 Gone), la rimuove automaticamente.
 *
 * payload: { title, body, tipo, url }
 *   tipo: 'turno_giorno' | 'discrepanza' | 'nuova_email' | 'generico'
 *   url: percorso a cui navigare al click (es. '/#email', '/')
 */
async function inviaNotifica(db, payload) {
  const subs = db.get('push_subscriptions').value() || [];
  if (!subs.length) return { inviati: 0, errori: 0 };

  // Controlla le preferenze notifiche dell'utente prima di inviare
  const impostazioni = db.get('impostazioni').value() || {};
  if (payload.tipo === 'turno_giorno' && impostazioni.notif_mattina === '0') return { inviati: 0, saltato: true };
  if (payload.tipo === 'discrepanza' && impostazioni.notif_discrepanze === '0') return { inviati: 0, saltato: true };
  if (payload.tipo === 'nuova_email' && impostazioni.notif_email === '0') return { inviati: 0, saltato: true };

  const payloadStr = JSON.stringify(payload);
  let inviati = 0, errori = 0;

  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payloadStr);
      inviati++;
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Subscription scaduta o revocata: rimuovi dal database
        rimuoviSubscription(db, sub.endpoint);
        console.log('Subscription rimossa (scaduta):', sub.endpoint.slice(0, 50) + '...');
      } else {
        console.error('Errore invio notifica push:', err.message);
        errori++;
      }
    }
  }

  return { inviati, errori };
}

module.exports = {
  inizializzaVapid,
  salvaSubscription,
  rimuoviSubscription,
  inviaNotifica
};
