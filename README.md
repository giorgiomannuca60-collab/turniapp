# TurniApp – Giorgio Mannuca

App web per la gestione dei turni di lavoro. Si aggiorna in tempo reale grazie a un backend Node.js con database SQLite.

---

## Struttura progetto

```
turniapp/
├── server.js          ← server principale
├── package.json
├── .env.example       ← copia in .env e configura
├── db/
│   └── database.js    ← SQLite: turni, cambi, email_log, impostazioni
├── routes/
│   └── api.js         ← tutte le API REST
└── public/
    └── index.html     ← frontend (HTML + CSS + JS in un file)
```

---

## Avvio in locale (PC)

**Requisiti:** Node.js 18+ installato (https://nodejs.org)

```bash
# 1. Entra nella cartella
cd turniapp

# 2. Installa le dipendenze
npm install

# 3. Copia il file di configurazione
cp .env.example .env

# 4. Avvia il server
npm start
```

Apri il browser su: **http://localhost:3000**

Per sviluppo con auto-riavvio:
```bash
npm run dev
```

---

## Deploy gratuito su Railway (online, aggiornabile)

1. Crea un account su https://railway.app
2. Clicca "New Project" → "Deploy from GitHub"
3. Carica il codice su GitHub (o usa "Deploy from local" con Railway CLI)
4. Railway detecta automaticamente Node.js e avvia `npm start`
5. Ottieni un URL tipo `https://turniapp-production.up.railway.app`
6. Apri l'URL dal telefono → aggiungi alla schermata Home

**Alternativa gratuita: Render.com**
- Stessa procedura, gratis fino a 750 ore/mese

---

## API disponibili

| Metodo | Endpoint | Descrizione |
|--------|----------|-------------|
| GET | /api/turni?mese=2025-06 | Turni del mese |
| POST | /api/turni | Aggiungi/aggiorna turno |
| DELETE | /api/turni/:data | Elimina turno |
| GET | /api/cambi | Tutti i cambi |
| POST | /api/cambi | Nuovo cambio |
| PUT | /api/cambi/:id | Aggiorna stato cambio |
| DELETE | /api/cambi/:id | Elimina cambio |
| POST | /api/upload | Carica PDF/Excel |
| GET | /api/email-log | Storico elaborazioni |
| POST | /api/controlla-discrepanza | Confronta turni |
| GET | /api/impostazioni | Leggi impostazioni |
| PUT | /api/impostazioni/:chiave | Aggiorna impostazione |

---

## Prossimi sviluppi

- [ ] Parsing reale PDF con `pdf-parse`
- [ ] Parsing Excel con `xlsx`
- [ ] Connessione Gmail OAuth (credenziali in .env)
- [ ] Notifiche push con Web Push API
- [ ] Calcolo automatico rotazione griglia gruppi fino a ottobre
