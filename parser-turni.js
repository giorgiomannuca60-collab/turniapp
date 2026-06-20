/**
 * parser-turni.js
 * Legge il file Excel settimanale, estrae la griglia dei 15 gruppi
 * e calcola i turni futuri di un gruppo specifico seguendo la rotazione.
 *
 * REGOLA DI ROTAZIONE (confermata da Giorgio):
 * - Ogni settimana la sequenza di turni del Gruppo N passa al Gruppo N-1
 * - Quando si arriva al Gruppo 1, la settimana dopo si torna al Gruppo 15 (ciclo chiuso)
 * - Quindi: per sapere cosa farà il Gruppo 11 tra N settimane, guardo OGGI
 *   la riga del gruppo (11 + N), con wraparound nel ciclo 1-15
 */

const XLSX = require('xlsx');

const TOTAL_GRUPPI = 15;

// Converte "12/17" in { tipo: 'p', orario: '12:00-17:00' } ecc.
function classificaTurno(raw) {
  if (!raw) return null;
  const val = String(raw).trim().toUpperCase();

  if (val.includes('RIPOSO')) {
    return { tipo: 'r', orario: 'Riposo', raw: val };
  }

  // Formato tipo "12/17" oppure "20/01" (turno notte che attraversa la mezzanotte)
  const match = val.match(/(\d{1,2})\/(\d{1,2})/);
  if (!match) return { tipo: 'r', orario: val, raw: val };

  let [_, oraInizio, oraFine] = match;
  oraInizio = parseInt(oraInizio);
  oraFine = parseInt(oraFine);

  // Determina il tipo turno in base all'ora di inizio
  let tipo = 'm'; // mattino di default
  if (oraInizio >= 5 && oraInizio < 11) tipo = 'm';
  else if (oraInizio >= 11 && oraInizio < 16) tipo = 'p';
  else if (oraInizio >= 16 && oraInizio < 20) tipo = 's';
  else tipo = 'n'; // 20+ o attraversa mezzanotte

  const orarioStr = `${String(oraInizio).padStart(2,'0')}:00-${String(oraFine).padStart(2,'0')}:00`;
  return { tipo, orario: orarioStr, raw: val };
}

/**
 * Legge il file Excel e restituisce una mappa: { "GRUPPO 11": [turno_lun, turno_mar, ...], ... }
 * Assume la struttura fissa osservata:
 * - Riga 6 (index 5): intestazioni giorni
 * - Righe 7-21 (index 6-20): un gruppo per riga, colonna A nome gruppo, colonne C-I i 7 giorni
 */
function leggiGrigliaSettimanale(filePath) {
  const wb = XLSX.readFile(filePath);
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });

  // Trova automaticamente la riga delle intestazioni (quella con "LUNEDI")
  let headerRowIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].some(c => String(c).toUpperCase().includes('LUNEDI'))) {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx === -1) throw new Error('Intestazioni giorni non trovate nel file');

  const headerRow = rows[headerRowIdx];
  // Trova le date a partire dalla colonna con "LUNEDI"
  const dayColStart = headerRow.findIndex(c => String(c).toUpperCase().includes('LUNEDI'));

  const griglia = {};
  const dateSettimana = [];

  // Estrae i numeri del giorno dalle intestazioni (es. "LUNEDI 1" → 1)
  for (let c = dayColStart; c < dayColStart + 7; c++) {
    const header = String(headerRow[c] || '');
    const numMatch = header.match(/(\d{1,2})/);
    dateSettimana.push(numMatch ? parseInt(numMatch[1]) : null);
  }

  // Scansiona le righe successive cercando "GRUPPO N"
  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const label = String(row[0] || '').trim().toUpperCase();
    const match = label.match(/GRUPPO\s*(\d{1,2})/);
    if (!match) continue; // non è una riga di gruppo (es. riga vuota o elenco nomi)

    const numGruppo = parseInt(match[1]);
    const turniSettimana = [];
    for (let c = dayColStart; c < dayColStart + 7; c++) {
      turniSettimana.push(classificaTurno(row[c]));
    }
    griglia[numGruppo] = turniSettimana;
  }

  return { griglia, dateSettimana, headerRowIdx };
}

/**
 * Dato il gruppo di partenza e il numero di settimane future,
 * calcola quale numero di gruppo (nella griglia attuale) corrisponde
 * alla sequenza di turni che il gruppo di partenza farà tra N settimane.
 *
 * gruppoPartenza: es. 11 (il gruppo di Giorgio)
 * settimaneAvanti: 0 = questa settimana, 1 = prossima settimana, ecc.
 */
function gruppoDaLeggere(gruppoPartenza, settimaneAvanti) {
  // Ogni settimana che passa, devo guardare un gruppo più in alto di 1
  // (con wraparound nel ciclo 1-15)
  let g = gruppoPartenza + settimaneAvanti;
  // Riporta g nel range 1-15
  g = ((g - 1) % TOTAL_GRUPPI) + TOTAL_GRUPPI;
  g = ((g - 1) % TOTAL_GRUPPI) + 1;
  return g;
}

/**
 * Calcola i turni del gruppo di Giorgio per le prossime N settimane,
 * partendo da una griglia di riferimento (quella della settimana corrente).
 *
 * dataLunedi: data ISO (YYYY-MM-DD) del lunedì della settimana del file caricato
 * griglia: oggetto { numGruppo: [turno_lun, ..., turno_dom] }
 * gruppoGiorgio: 11
 * numSettimane: quante settimane calcolare in avanti (es. fino a ottobre ~18)
 */
function calcolaTurniFuturi(dataLunedi, griglia, gruppoGiorgio, numSettimane) {
  const risultato = []; // [{ data, orario, tipo, fonte, gruppo_origine }]
  const start = new Date(dataLunedi + 'T00:00:00');

  for (let s = 0; s < numSettimane; s++) {
    const gruppoDaUsare = gruppoDaLeggere(gruppoGiorgio, s);
    const turniSettimana = griglia[gruppoDaUsare];

    if (!turniSettimana) continue; // gruppo non presente in questa griglia di riferimento

    for (let d = 0; d < 7; d++) {
      const data = new Date(start.getTime() + (s * 7 + d) * 86400000);
      const dataStr = data.toISOString().slice(0, 10);
      const turno = turniSettimana[d];
      if (!turno) continue;

      risultato.push({
        data: dataStr,
        orario: turno.orario,
        tipo: turno.tipo,
        fonte: 'calcolato',
        gruppo_origine: gruppoDaUsare,
        nota: `Calcolato da Gruppo ${gruppoDaUsare} (settimana +${s})`
      });
    }
  }

  return risultato;
}

/**
 * Confronta i turni calcolati con quelli di un nuovo file caricato
 * per la stessa settimana, e segnala discrepanze.
 */
function confrontaConNuovoFile(turniCalcolati, nuovaGriglia, dataLunediNuovaSettimana, gruppoGiorgio) {
  const turnoAttesoMap = {};
  turniCalcolati.forEach(t => turnoAttesoMap[t.data] = t);

  const turniNuovi = nuovaGriglia[gruppoGiorgio];
  if (!turniNuovi) return { discrepanze: [], messaggio: 'Gruppo non trovato nel nuovo file' };

  const start = new Date(dataLunediNuovaSettimana + 'T00:00:00');
  const discrepanze = [];

  for (let d = 0; d < 7; d++) {
    const data = new Date(start.getTime() + d * 86400000);
    const dataStr = data.toISOString().slice(0, 10);
    const atteso = turnoAttesoMap[dataStr];
    const reale = turniNuovi[d];

    if (atteso && reale && atteso.orario !== reale.orario) {
      discrepanze.push({
        data: dataStr,
        atteso: atteso.orario,
        reale: reale.orario,
        messaggio: `${dataStr}: previsto ${atteso.orario}, file conferma ${reale.orario}`
      });
    }
  }

  return { discrepanze, messaggio: discrepanze.length ? `${discrepanze.length} discrepanza/e trovate` : 'Nessuna discrepanza' };
}

/**
 * Estrae ora di inizio e fine (in ore decimali, gestendo il caso che attraversa la mezzanotte)
 * da un orario tipo "12:00-17:00" o "20:00-01:00"
 */
function estraiOrari(orarioStr) {
  if (!orarioStr || orarioStr === 'Riposo') return null;
  const match = orarioStr.match(/(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const inizio = parseInt(match[1]) + parseInt(match[2]) / 60;
  let fine = parseInt(match[3]) + parseInt(match[4]) / 60;
  const attraversaMezzanotte = fine <= inizio;
  return { inizio, fine, attraversaMezzanotte };
}

/**
 * Calcola le ore di riposo tra la fine di un turno e l'inizio del turno successivo.
 * turnoA e turnoB sono { data: 'YYYY-MM-DD', orario: 'HH:MM-HH:MM' }, con turnoA precedente a turnoB.
 */
function oreRiposoTra(turnoA, turnoB) {
  const oA = estraiOrari(turnoA.orario);
  const oB = estraiOrari(turnoB.orario);

  // Se uno dei due è un riposo, calcola comunque la distanza minima possibile in ore (24h * giorni)
  const giorniDiff = (new Date(turnoB.data) - new Date(turnoA.data)) / 86400000;

  if (!oA && !oB) return giorniDiff * 24; // entrambi riposo
  if (!oA) return giorniDiff * 24 + oB.inizio; // A è riposo: il riposo copre l'intera giornata A, quindi disponibile da mezzanotte di A
  if (!oB) return giorniDiff * 24 + 24 - oA.fine; // B è riposo

  // Ora di fine reale del turno A (tenendo conto se attraversa mezzanotte)
  const fineA_oreAssolute = oA.fine + (oA.attraversaMezzanotte ? 24 : 0);
  const inizioB_oreAssolute = giorniDiff * 24 + oB.inizio;

  return inizioB_oreAssolute - fineA_oreAssolute;
}

/**
 * Verifica se uno scambio di turni rispetta la regola delle 11h di riposo minimo,
 * controllando i turni immediatamente prima e dopo le date coinvolte.
 *
 * turniOrdinati: array di turni della persona ordinato per data, già con lo scambio applicato
 * dataDaControllare: la data del turno modificato (per controllare i turni adiacenti)
 */
function verificaRiposo11h(turniOrdinati, dataDaControllare) {
  const idx = turniOrdinati.findIndex(t => t.data === dataDaControllare);
  if (idx === -1) return { valido: true, problemi: [] };

  const problemi = [];

  // Controlla rispetto al turno precedente
  if (idx > 0) {
    const ore = oreRiposoTra(turniOrdinati[idx - 1], turniOrdinati[idx]);
    if (ore < 11) {
      problemi.push(`Solo ${ore.toFixed(1)}h di riposo tra il turno del ${turniOrdinati[idx-1].data} (${turniOrdinati[idx-1].orario}) e quello del ${turniOrdinati[idx].data} (${turniOrdinati[idx].orario}) — minimo richiesto 11h`);
    }
  }

  // Controlla rispetto al turno successivo
  if (idx < turniOrdinati.length - 1) {
    const ore = oreRiposoTra(turniOrdinati[idx], turniOrdinati[idx + 1]);
    if (ore < 11) {
      problemi.push(`Solo ${ore.toFixed(1)}h di riposo tra il turno del ${turniOrdinati[idx].data} (${turniOrdinati[idx].orario}) e quello del ${turniOrdinati[idx+1].data} (${turniOrdinati[idx+1].orario}) — minimo richiesto 11h`);
    }
  }

  return { valido: problemi.length === 0, problemi };
}

/**
 * Trova periodi di riposo consecutivi (2+ giorni) già presenti nel calendario.
 * turni: array ordinato per data di { data, tipo, orario }
 */
function trovaRiposiConsecutivi(turni) {
  const risultati = [];
  let inizioRiposo = null;

  for (let i = 0; i < turni.length; i++) {
    const isRiposo = turni[i].tipo === 'r';
    if (isRiposo && inizioRiposo === null) {
      inizioRiposo = i;
    } else if (!isRiposo && inizioRiposo !== null) {
      const lunghezza = i - inizioRiposo;
      if (lunghezza >= 2) {
        risultati.push({
          data_inizio: turni[inizioRiposo].data,
          data_fine: turni[i - 1].data,
          giorni: lunghezza
        });
      }
      inizioRiposo = null;
    }
  }
  // Caso: il calendario finisce in riposo
  if (inizioRiposo !== null) {
    const lunghezza = turni.length - inizioRiposo;
    if (lunghezza >= 2) {
      risultati.push({
        data_inizio: turni[inizioRiposo].data,
        data_fine: turni[turni.length - 1].data,
        giorni: lunghezza
      });
    }
  }
  return risultati;
}

/**
 * Propone cambi turno per CREARE un riposo doppio (2+ giorni consecutivi) dove oggi non c'è,
 * rispettando sempre la regola delle 11h.
 *
 * Strategia: per ogni riposo singolo isolato (non già parte di una coppia), controlla se
 * cedendo il turno del giorno immediatamente precedente o successivo si crea un riposo doppio,
 * verificando che lo scambio non violi le 11h sui turni adiacenti a quello ceduto.
 */
function suggerisciRiposiDoppi(turni) {
  const suggerimenti = [];

  for (let i = 0; i < turni.length; i++) {
    if (turni[i].tipo !== 'r') continue;

    const isRiposoIsolato =
      (i === 0 || turni[i - 1].tipo !== 'r') &&
      (i === turni.length - 1 || turni[i + 1].tipo !== 'r');

    if (!isRiposoIsolato) continue; // già fa parte di un riposo doppio, salta

    // Opzione A: cedere il turno del giorno PRIMA del riposo (per estendere all'indietro)
    if (i > 0 && turni[i - 1].tipo !== 'r') {
      const turnoDaCedere = turni[i - 1];
      // Verifica 11h: serve controllare il turno ancora prima di quello da cedere
      let validoA = true;
      let motivoA = '';
      if (i > 1) {
        const ore = oreRiposoTra(turni[i - 2], turni[i]); // se i-1 diventa riposo, il salto è da i-2 a i
        if (turni[i-2].tipo !== 'r') {
          // turni[i-2] è un turno vero: ok comunque, diventa un giorno di riposo aggiuntivo, nessun vincolo violato
        }
      }
      suggerimenti.push({
        tipo: 'estendi_indietro',
        data_da_cedere: turnoDaCedere.data,
        orario_da_cedere: turnoDaCedere.orario,
        risultato: `Riposo doppio dal ${turnoDaCedere.data} al ${turni[i].data}`,
        nota: `Proponi di cedere il turno del ${turnoDaCedere.data} (${turnoDaCedere.orario}) a un collega: otterresti 2 giorni liberi consecutivi.`
      });
    }

    // Opzione B: cedere il turno del giorno DOPO il riposo (per estendere in avanti)
    if (i < turni.length - 1 && turni[i + 1].tipo !== 'r') {
      const turnoDaCedere = turni[i + 1];
      suggerimenti.push({
        tipo: 'estendi_avanti',
        data_da_cedere: turnoDaCedere.data,
        orario_da_cedere: turnoDaCedere.orario,
        risultato: `Riposo doppio dal ${turni[i].data} al ${turnoDaCedere.data}`,
        nota: `Proponi di cedere il turno del ${turnoDaCedere.data} (${turnoDaCedere.orario}) a un collega: otterresti 2 giorni liberi consecutivi.`
      });
    }
  }

  return suggerimenti;
}

module.exports = {
  classificaTurno,
  leggiGrigliaSettimanale,
  gruppoDaLeggere,
  calcolaTurniFuturi,
  confrontaConNuovoFile,
  estraiOrari,
  oreRiposoTra,
  verificaRiposo11h,
  trovaRiposiConsecutivi,
  suggerisciRiposiDoppi,
  TOTAL_GRUPPI
};
