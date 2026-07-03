/**
 * parser-pdf.js
 * Legge i PDF che arrivano via email: il piano SETTIMANALE e l'ordine di
 * servizio GIORNALIERO.
 *
 * Gestisce DUE formati diversi osservati nei file reali:
 *
 * FORMATO A (vecchio): ogni riga ha "GRUPPO N" davanti ai 7 turni
 *   es. "GRUPPO 11   RIPOSO  18/23  12/17  ..."
 *
 * FORMATO B (nuovo - part-time luglio 2026): griglia senza etichette,
 *   con la lista ordinata dei gruppi in fondo al documento dopo
 *   "TURNI DAL X al Y Mese":
 *   Riga 1: RIPOSO 20/01 16/21 ...  → GRUPPO 1 (dalla legenda)
 *   Riga 2: 11/16 8/13 7/12 ...     → GRUPPO 14 (dalla legenda)
 *   ...
 */

const fs = require('fs');
const pdfParse = require('pdf-parse');
const { classificaTurno, formattaDataLocale } = require('./parser-turni');

const MESI_IT = {
  GENNAIO: 0, FEBBRAIO: 1, MARZO: 2, APRILE: 3, MAGGIO: 4, GIUGNO: 5,
  LUGLIO: 6, AGOSTO: 7, SETTEMBRE: 8, OTTOBRE: 9, NOVEMBRE: 10, DICEMBRE: 11
};

async function estraiTestoPdf(filePath) {
  const buffer = fs.readFileSync(filePath);
  const dati = await pdfParse(buffer);
  return dati.text;
}

function estraiDataLunediDaTestoPdf(testo, dataRiferimento) {
  const meseRegex = new RegExp(`\\b(${Object.keys(MESI_IT).join('|')})\\b`, 'i');
  const matchGiorni = testo.match(/DAL\s+(\d{1,2})\s+[Aa][Ll]?\s+(\d{1,2})/i);
  const matchMese = testo.match(meseRegex);
  const matchAnno = testo.match(/\b(20\d{2})\b/);

  if (!matchGiorni || !matchMese) return null;

  const giornoInizio = parseInt(matchGiorni[1]);
  const mese = MESI_IT[matchMese[1].toUpperCase()];
  let anno = matchAnno ? parseInt(matchAnno[1]) : null;

  if (anno === null) {
    const riferimento = dataRiferimento ? new Date(dataRiferimento + 'T00:00:00') : new Date();
    const candidati = [riferimento.getFullYear() - 1, riferimento.getFullYear(), riferimento.getFullYear() + 1];
    let migliore = null, distanzaMin = Infinity;
    candidati.forEach(annoTest => {
      const d = new Date(annoTest, mese, giornoInizio);
      const dist = Math.abs(d - riferimento);
      if (dist < distanzaMin) { distanzaMin = dist; migliore = annoTest; }
    });
    anno = migliore;
  }

  return formattaDataLocale(new Date(anno, mese, giornoInizio));
}

/**
 * FORMATO B: griglia senza etichette, ordine gruppi in fondo al documento.
 */
function tentaFormatoB(testo) {
  const TOKEN = /RIPOSO|\b[Rr]\b|\d{1,2}\/\d{1,2}/g;

  // Trova il separatore "TURNI DAL" che divide griglia da legenda
  const idxSeparatore = testo.search(/TURNI\s+DAL\s+\d{1,2}/i);
  if (idxSeparatore === -1) return null;

  const testoGriglia = testo.slice(0, idxSeparatore);
  const testoLegenda = testo.slice(idxSeparatore);

  // Estrae righe della griglia: righe con almeno 7 token turno validi
  const righeGriglia = [];
  for (const riga of testoGriglia.split('\n')) {
    const token = riga.match(TOKEN) || [];
    if (token.length >= 7) {
      righeGriglia.push(token.slice(0, 7));
    }
  }

  // Estrae l'ordine dei gruppi dalla legenda (deduplica mantenendo ordine)
  const ordineGruppi = [];
  const seen = new Set();
  const regexGruppo = /GRUPPO\s*(\d{1,2})/gi;
  let m;
  while ((m = regexGruppo.exec(testoLegenda)) !== null) {
    const n = parseInt(m[1]);
    if (!seen.has(n)) { seen.add(n); ordineGruppi.push(n); }
  }

  if (righeGriglia.length === 0 || ordineGruppi.length === 0) return null;

  const n = Math.min(righeGriglia.length, ordineGruppi.length);
  const griglia = {};
  for (let i = 0; i < n; i++) {
    griglia[ordineGruppi[i]] = righeGriglia[i].map(t =>
      classificaTurno(t.toUpperCase() === 'R' ? 'RIPOSO' : t)
    );
  }
  return griglia;
}

/**
 * FORMATO A: ogni riga ha "GRUPPO N" + 7 turni sulla stessa riga.
 * Seconda difesa: evita di sovrascrivere dati già corretti con righe
 * della sezione "elenco nomi" (che riusa GRUPPO N come intestazione colonna).
 */
function tentaFormatoA(testo) {
  const griglia = {};
  const regexGruppo = /GRUPPO\s*(\d{1,2})/gi;
  const tokenTurnoRegex = /RIPOSO|\d{1,2}\/\d{1,2}/g;
  let match;
  const posizioni = [];

  while ((match = regexGruppo.exec(testo)) !== null) {
    posizioni.push({ numGruppo: parseInt(match[1]), fineMatch: regexGruppo.lastIndex });
  }

  for (let i = 0; i < posizioni.length; i++) {
    const inizio = posizioni[i].fineMatch;
    const fine = i + 1 < posizioni.length ? posizioni[i + 1].fineMatch - 10 : testo.length;
    const segmento = testo.slice(inizio, fine);

    // Ferma la scansione se la riga contiene più GRUPPO → sezione nomi
    const occorrenze = (segmento.slice(0, 80).match(/GRUPPO/gi) || []).length;
    if (occorrenze > 1) break;

    const token = segmento.match(tokenTurnoRegex) || [];
    if (token.length < 7) continue;
    if (!griglia[posizioni[i].numGruppo]) {
      griglia[posizioni[i].numGruppo] = token.slice(0, 7).map(t => classificaTurno(t));
    }
  }
  return griglia;
}

async function leggiGrigliaSettimanalePdf(filePath, dataRiferimento) {
  const testo = await estraiTestoPdf(filePath);
  const dataLunediRilevata = estraiDataLunediDaTestoPdf(testo, dataRiferimento);

  // Prova prima FORMATO B (legenda gruppi in fondo, più recente)
  const grigliaB = tentaFormatoB(testo);
  if (grigliaB && Object.keys(grigliaB).length >= 10) {
    return { griglia: grigliaB, dataLunediRilevata };
  }

  // Fallback FORMATO A (GRUPPO N davanti a ogni riga)
  const grigliaA = tentaFormatoA(testo);
  if (grigliaA && Object.keys(grigliaA).length >= 10) {
    return { griglia: grigliaA, dataLunediRilevata };
  }

  throw new Error('Nessun gruppo riconosciuto nel PDF. Verifica che il file sia il piano settimanale corretto.');
}

/**
 * Legge il PDF dell'ordine di servizio GIORNALIERO e cerca la riga
 * corrispondente al cognome di Giorgio.
 */
async function leggiGiornalieroPdf(filePath, cognome = 'MANNUCA') {
  const testo = await estraiTestoPdf(filePath);
  const righe = testo.split('\n').map(r => r.trim()).filter(Boolean);

  const cognomeUpper = cognome.toUpperCase();
  let rigaTrovata = null;

  for (const riga of righe) {
    if (riga.toUpperCase().includes(cognomeUpper)) {
      rigaTrovata = riga;
      break;
    }
  }

  if (!rigaTrovata) {
    return { trovato: false, messaggio: `Nome "${cognome}" non trovato nel giornaliero caricato.` };
  }

  const matchOrarioCompleto = rigaTrovata.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
  const matchOrarioBreve = rigaTrovata.match(/(\d{1,2})\/(\d{1,2})/);

  let orario = null;
  if (matchOrarioCompleto) {
    orario = `${matchOrarioCompleto[1].padStart(2,'0')}:${matchOrarioCompleto[2]}-${matchOrarioCompleto[3].padStart(2,'0')}:${matchOrarioCompleto[4]}`;
  } else if (matchOrarioBreve) {
    const classificato = classificaTurno(`${matchOrarioBreve[1]}/${matchOrarioBreve[2]}`);
    orario = classificato.orario;
  }

  const assente = /ASSENTE/i.test(rigaTrovata);
  const note = [];
  if (assente) note.push('ASSENTE');
  if (rigaTrovata.includes('*')) note.push('* (maggiorazione/nota speciale)');
  if (rigaTrovata.includes('#')) note.push('# (nota speciale)');

  return {
    trovato: true,
    riga_originale: rigaTrovata,
    orario: assente ? null : orario,
    assente,
    note: note.join(', ')
  };
}

module.exports = {
  estraiTestoPdf,
  estraiDataLunediDaTestoPdf,
  leggiGrigliaSettimanalePdf,
  leggiGiornalieroPdf
};
