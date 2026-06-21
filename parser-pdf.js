/**
 * parser-pdf.js
 * Legge i PDF che arrivano via email: il piano SETTIMANALE (stessa griglia
 * a 15 gruppi vista nell'Excel, ma esportata in PDF) e l'ordine di servizio
 * GIORNALIERO (elenco nominativo con orario del giorno).
 *
 * L'estrazione testo da PDF è meno strutturata di un Excel (niente celle,
 * solo testo "appiattito"), quindi i pattern qui sono scritti per essere
 * tolleranti a piccole variazioni di spaziatura/a capo.
 */

const fs = require('fs');
const pdfParse = require('pdf-parse');
const { classificaTurno, formattaDataLocale } = require('./parser-turni');

const MESI_IT = {
  GENNAIO: 0, FEBBRAIO: 1, MARZO: 2, APRILE: 3, MAGGIO: 4, GIUGNO: 5,
  LUGLIO: 6, AGOSTO: 7, SETTEMBRE: 8, OTTOBRE: 9, NOVEMBRE: 10, DICEMBRE: 11
};

/**
 * Estrae tutto il testo grezzo da un file PDF.
 */
async function estraiTestoPdf(filePath) {
  const buffer = fs.readFileSync(filePath);
  const dati = await pdfParse(buffer);
  return dati.text;
}

/**
 * Stessa logica di rilevamento data usata per l'Excel ("TURNI DAL 22 AL 28 GIUGNO"),
 * applicata al testo grezzo estratto dal PDF.
 */
function estraiDataLunediDaTestoPdf(testo) {
  const meseRegex = new RegExp(`\\b(${Object.keys(MESI_IT).join('|')})\\b`, 'i');
  const matchGiorni = testo.match(/DAL\s+(\d{1,2})\s+AL\s+(\d{1,2})/i);
  const matchMese = testo.match(meseRegex);
  const matchAnno = testo.match(/\b(20\d{2})\b/);

  if (!matchGiorni || !matchMese) return null;

  const giornoInizio = parseInt(matchGiorni[1]);
  const mese = MESI_IT[matchMese[1].toUpperCase()];
  let anno = matchAnno ? parseInt(matchAnno[1]) : null;

  if (anno === null) {
    const oggi = new Date();
    const candidati = [oggi.getFullYear() - 1, oggi.getFullYear(), oggi.getFullYear() + 1];
    let migliore = null, distanzaMin = Infinity;
    candidati.forEach(annoTest => {
      const d = new Date(annoTest, mese, giornoInizio);
      const dist = Math.abs(d - oggi);
      if (dist < distanzaMin) { distanzaMin = dist; migliore = annoTest; }
    });
    anno = migliore;
  }

  return formattaDataLocale(new Date(anno, mese, giornoInizio));
}

/**
 * Legge il PDF del piano SETTIMANALE e ricostruisce la griglia { numGruppo: [7 turni] },
 * stesso formato output di leggiGrigliaSettimanale() in parser-turni.js (per l'Excel),
 * così il resto del programma (calcolo rotazione, confronto discrepanze) funziona identico
 * indipendentemente dal fatto che il file fosse Excel o PDF.
 *
 * Il testo PDF non ha colonne reali: ogni riga "GRUPPO N" è seguita dai 7 turni
 * della settimana, separati da spazi, nello stesso ordine Lun→Dom.
 * Pattern atteso per riga: "GRUPPO 11   RIPOSO  18/23  12/17  12/17  10/15  11/16  RIPOSO"
 */
async function leggiGrigliaSettimanalePdf(filePath) {
  const testo = await estraiTestoPdf(filePath);
  const dataLunediRilevata = estraiDataLunediDaTestoPdf(testo);

  const griglia = {};

  // Pattern: "GRUPPO" + numero, poi cattura fino a 7 token turno (RIPOSO o HH/HH)
  // su quella riga o le righe immediatamente successive (alcuni PDF vanno a capo).
  const regexGruppo = /GRUPPO\s*(\d{1,2})/gi;
  let match;
  const posizioni = [];
  while ((match = regexGruppo.exec(testo)) !== null) {
    posizioni.push({ numGruppo: parseInt(match[1]), indice: match.index, fineMatch: regexGruppo.lastIndex });
  }

  const tokenTurnoRegex = /RIPOSO|\d{1,2}\/\d{1,2}/g;

  for (let i = 0; i < posizioni.length; i++) {
    const inizio = posizioni[i].fineMatch;
    const fine = (i + 1 < posizioni.length) ? posizioni[i + 1].indice : testo.length;
    const segmento = testo.slice(inizio, fine);

    const token = segmento.match(tokenTurnoRegex) || [];
    if (token.length < 7) continue; // riga incompleta/non valida, salta

    const turniSettimana = token.slice(0, 7).map(t => classificaTurno(t));
    griglia[posizioni[i].numGruppo] = turniSettimana;
  }

  if (Object.keys(griglia).length === 0) {
    throw new Error('Nessun gruppo riconosciuto nel PDF. Verifica che il file sia il piano settimanale corretto.');
  }

  return { griglia, dataLunediRilevata };
}

/**
 * Legge il PDF dell'ordine di servizio GIORNALIERO e cerca la riga
 * corrispondente al cognome di Giorgio, estraendone orario e note
 * (es. ASSENTE, *, #).
 *
 * Pattern tollerante: cerca "MANNUCA" (case-insensitive) seguito,
 * sulla stessa riga o nelle vicinanze, da un orario HH:MM-HH:MM o HH/HH,
 * più eventuali note come ASSENTE, *, #.
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

  // Cerca orario in formato HH:MM-HH:MM oppure HH/HH (gestendo anche turno notte tipo 20:00-01:00)
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
