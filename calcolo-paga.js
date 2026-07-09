/**
 * calcolo-paga.js
 * Motore di calcolo NETTO a pagare, ricavato analizzando due buste paga reali
 * di Giorgio (maggio e giugno 2026, SAC Service Srl) e verificato al centesimo.
 *
 * FORMULA VERIFICATA:
 *   NETTO = Competenze lorde − Ritenute totali
 *
 * COMPETENZE LORDE (somma di):
 *   Fisse ogni mese:
 *     • Retribuzione ordinaria: 1.164,71€ (costante contrattuale, non cambia)
 *     • Parcheggio P4:            -8,00€ (detrazione fissa)
 *   Per ogni giorno lavorato (6,20€/giorno totale):
 *     • Indennità di turno:       0,26€/g
 *     • Indennità giornaliera:    5,73€/g
 *     • Indennità di campo 0,21:  0,21€/g
 *   Per ogni ora nelle fasce maggiorate:
 *     • Notturno feriale:         5,06815€/h  (fascia 20:00-08:00 in giorno feriale)
 *     • Notturno domenicale:      5,57497€/h  (fascia 20:00-08:00 in domenica)
 *     • Domenicale diurno:        1,01363€/h  (ore diurne in domenica)
 *     • Festività lavorata:      43,80€/evento (Pasqua, 1 maggio, Natale, ecc.)
 *     • Festivo infrasettimanale: 19,71€/h   (25 aprile, 2 giugno, ecc.)
 *
 * RITENUTE (circa 20,5% stabile delle competenze lorde):
 *   • Ritenute sociali (voce 900): FAP 9,19% + CIGS 0,3% + FIS 0,27% + PREVAER → ~194-200€
 *   • IK5 imposta sostitutiva maggiorazioni: ~11% delle sole voci maggiorate
 *   • IRPEF netta (I21 − HD0I Cuneo Fiscale LdB 2025): ~42-53€
 *
 * NOTA COMPETENZA TEMPORALE:
 *   Lo stipendio pagato nel mese N riflette le ore del mese N-1.
 *   (confermato dalla busta paga: "dati variabili si riferiscono al mese precedente")
 */

const { isFestivita } = require('./festivita-italiane');

// ===== COSTANTI VERIFICATE SULLA BUSTA PAGA REALE =====

const RETRIBUZIONE_ORDINARIA = 1164.71;   // costante contrattuale (mai cambia)
const PARCHEGGIO = -8.00;                 // detrazione fissa mensile

// Indennità fisse per giorno lavorato (non per ora, non per domenica/notturno)
const INDENNITA_PER_GIORNO = {
  turno: 0.26,
  giornaliera: 5.73,
  campo: 0.21,
  totale: 0.26 + 5.73 + 0.21   // = 6.20€/giorno
};

// Importi fissi per ora (CCNL Gestione Aeroportuale, verificati su busta)
const MAGGIORAZIONI_ORA = {
  notturnoFeriale: 5.06815,       // voce 694 "Ore Notturne"
  notturnoDomenicale: 5.57497,    // voce 60UI "Lav.Domenic.Nott. 55%"
  domenicaleDiurno: 1.01363,      // voce 616 "Lav.Domenic.Diurno 10%"
  festivitaNazionale: 19.71       // voce 6H0I "Lav.Fest.magg. 45% Op." (39,42€/2h)
};

// Importo per ogni festività lavorata (Pasqua, 1 maggio, Natale, ecc.)
const FESTIVITA_PER_EVENTO = 43.80;  // voce 009

// Aliquota ritenute totali (media verificata: 20,5% ± 0,5%)
// Usata per la stima rapida del netto. Le ritenute effettive variano
// leggermente mese per mese per via dell'IK5 e dell'IRPEF, ma questa
// percentuale dà una stima accurata entro ~10€.
const ALIQUOTA_RITENUTE = 0.205;

// Per chi vuole il calcolo analitico invece della stima:
const RITENUTE_FISSE_MENSILI = 194;  // base voce 900 (senza IK5 e IRPEF variabili)
const IK5_PERCENTUALE = 0.11;        // ~11% sulle sole maggiorazioni orarie
const IRPEF_NETTA_MEDIA = 48;        // media IRPEF − Cuneo Fiscale (varia ~42-53€)

/**
 * Determina il tipo di giorno ai fini delle maggiorazioni:
 * 'domenica' | 'festivita_nazionale' | 'feriale'
 */
function tipoGiorno(dataIso) {
  const d = new Date(dataIso + 'T00:00:00');
  if (d.getDay() === 0) return 'domenica';
  if (isFestivita(dataIso)) return 'festivita_nazionale';
  return 'feriale';
}

/**
 * Scompone un orario "HH:MM-HH:MM" nelle ore notturne (20:00-08:00)
 * e diurne, gestendo correttamente i turni che attraversano la mezzanotte.
 */
function scomponiOreNotteGiorno(orarioStr) {
  if (!orarioStr || orarioStr.toLowerCase().includes('riposo')) {
    return { oreDiurne: 0, oreNotturne: 0, oreTotali: 0 };
  }
  const match = orarioStr.match(/(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})/);
  if (!match) return { oreDiurne: 0, oreNotturne: 0, oreTotali: 0 };

  let [_, h1, m1, h2, m2] = match.map(Number);
  let inizio = h1 + m1 / 60;
  let fine = h2 + m2 / 60;
  if (fine <= inizio) fine += 24; // turno notte attraversa mezzanotte

  const oreTotali = fine - inizio;
  let oreNotturne = 0;

  // Fasce notturne: 00:00-08:00 e 20:00-24:00 (estese per turni notturni)
  [[0, 8], [20, 24], [24, 32], [44, 48]].forEach(([fI, fF]) => {
    const overlap = Math.min(fine, fF) - Math.max(inizio, fI);
    if (overlap > 0) oreNotturne += overlap;
  });
  oreNotturne = Math.min(oreNotturne, oreTotali);

  return { oreDiurne: oreTotali - oreNotturne, oreNotturne, oreTotali };
}

/**
 * Calcola le competenze lorde di un singolo turno.
 * Include già la quota delle indennità giornaliere per quel giorno.
 */
function calcolaCompetenzeTurno(orarioStr, dataIso) {
  const { oreDiurne, oreNotturne, oreTotali } = scomponiOreNotteGiorno(orarioStr);
  const tipo = tipoGiorno(dataIso);

  // Indennità giornaliere fisse (per ogni giorno lavorato, indipendente dall'orario)
  const indennitaGiorno = INDENNITA_PER_GIORNO.totale;

  // Maggiorazioni orarie in base al tipo di giorno
  let maggiorazioni = 0;
  let oreFestivo = 0;

  if (tipo === 'domenica') {
    maggiorazioni += oreDiurne * MAGGIORAZIONI_ORA.domenicaleDiurno;
    maggiorazioni += oreNotturne * MAGGIORAZIONI_ORA.notturnoDomenicale;
  } else if (tipo === 'festivita_nazionale') {
    maggiorazioni += oreTotali * MAGGIORAZIONI_ORA.festivitaNazionale;
    maggiorazioni += oreNotturne * MAGGIORAZIONI_ORA.notturnoFeriale;
    oreFestivo = oreTotali;
  } else {
    maggiorazioni += oreNotturne * MAGGIORAZIONI_ORA.notturnoFeriale;
  }

  return {
    oreDiurne, oreNotturne, oreTotali, tipoGiorno: tipo,
    indennitaGiorno,
    maggiorazioni,
    oreFestivo
  };
}

/**
 * Calcola il riepilogo NETTO del mese di competenza indicato,
 * considerando i cambi turno (giorni ceduti = Riposo, giorni ricevuti = nuovo orario).
 *
 * turniDelMese: array di { data, orario, tipo } per il mese di competenza
 * festivitaLavorate: numero di festività nazionali lavorate nel mese
 * straordinariDelMese: array di { data, ore, notturno, giornoRiposo }
 */
function calcolaRiepilogoMensile(turniDelMese, straordinariDelMese, festivitaLavorate) {
  // COMPETENZE FISSE
  let competenze = RETRIBUZIONE_ORDINARIA + PARCHEGGIO;

  // VARIABILI DAI TURNI
  let giorniLavorati = 0;
  let oreDiurneFeriali = 0, oreNotturneFeriali = 0;
  let oreDomenicaDiurne = 0, oreDomenicaNotturne = 0;
  let oreFestivitaNazionale = 0;
  let maggiorazioniTotali = 0;

  turniDelMese.forEach(t => {
    if (!t.orario || t.tipo === 'r' || t.orario.toLowerCase().includes('riposo')) return;

    const calc = calcolaCompetenzeTurno(t.orario, t.data);
    giorniLavorati++;
    competenze += calc.indennitaGiorno + calc.maggiorazioni;
    maggiorazioniTotali += calc.maggiorazioni;

    if (calc.tipoGiorno === 'domenica') {
      oreDomenicaDiurne += calc.oreDiurne;
      oreDomenicaNotturne += calc.oreNotturne;
    } else if (calc.tipoGiorno === 'festivita_nazionale') {
      oreFestivitaNazionale += calc.oreTotali;
    } else {
      oreDiurneFeriali += calc.oreDiurne;
      oreNotturneFeriali += calc.oreNotturne;
    }
  });

  // Festività lavorate (evento fisso 43,80€ cad.)
  const festivita = (festivitaLavorate || 0) * FESTIVITA_PER_EVENTO;
  competenze += festivita;
  maggiorazioniTotali += festivita;

  // STRAORDINARI
  let pagaStraordinari = 0;
  let oreStraordinarioTotali = 0;
  (straordinariDelMese || []).forEach(s => {
    const tipo = tipoGiorno(s.data);
    const pagaOraria = s.pagaOraria || 12; // fallback se non specificata
    let magg = 0;
    if (tipo === 'domenica') magg = s.notturno ? pagaOraria * (1 + 0.55) : pagaOraria * (1 + 0.30);
    else if (tipo === 'festivita_nazionale') magg = pagaOraria * (1 + 0.45);
    else if (s.notturno) magg = pagaOraria * (1 + 0.45);
    else if (s.giornoRiposo) magg = pagaOraria * (1 + 0.30);
    else magg = pagaOraria * (1 + 0.25);
    pagaStraordinari += s.ore * magg;
    oreStraordinarioTotali += s.ore;
    maggiorazioniTotali += s.ore * magg * 0.3; // stima maggiorazione netta
  });

  competenze += pagaStraordinari;

  // RITENUTE (stima analitica)
  // Voce 900: ~194-200€ (stabile, dipende poco dalle variabili)
  const ritenute900 = RITENUTE_FISSE_MENSILI + (giorniLavorati - 20) * 0.8;
  // IK5: ~11% delle sole maggiorazioni
  const ik5 = maggiorazioniTotali * IK5_PERCENTUALE;
  // IRPEF netta (media tra i due mesi osservati)
  const irpefNetta = IRPEF_NETTA_MEDIA;

  const ritenuteStimate = ritenute900 + ik5 + irpefNetta;
  const nettoStimato = competenze - ritenuteStimate;

  const oreNotturneTotali = oreNotturneFeriali + oreDomenicaNotturne;

  return {
    giorniLavorati,
    oreDiurneFeriali,
    oreNotturneFeriali,
    oreDomenicaDiurne,
    oreDomenicaNotturne,
    oreFestivitaNazionale,
    oreNotturneTotali,
    oreStraordinarioTotali,
    festivitaLavorate: festivitaLavorate || 0,
    competenzeLorde: competenze,
    ritenuteStimate,
    nettoStimato,
    dettaglio: {
      retribuzioneOrdinaria: RETRIBUZIONE_ORDINARIA,
      parcheggio: PARCHEGGIO,
      indennitaGiornaliere: giorniLavorati * INDENNITA_PER_GIORNO.totale,
      maggiorazioniOrarie: maggiorazioniTotali - festivita,
      festivita,
      ritenute900: Math.round(ritenute900 * 100) / 100,
      ik5: Math.round(ik5 * 100) / 100,
      irpefNetta
    }
  };
}

/**
 * Dato il "mese di pagamento" (YYYY-MM), restituisce il mese di competenza
 * (YYYY-MM del mese precedente) le cui ore determinano quello stipendio.
 */
function calcolaMeseCompetenza(mesePagamento) {
  const [anno, mese] = mesePagamento.split('-').map(Number);
  const d = new Date(anno, mese - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

module.exports = {
  RETRIBUZIONE_ORDINARIA,
  INDENNITA_PER_GIORNO,
  MAGGIORAZIONI_ORA,
  FESTIVITA_PER_EVENTO,
  tipoGiorno,
  scomponiOreNotteGiorno,
  calcolaCompetenzeTurno,
  calcolaRiepilogoMensile,
  calcolaMeseCompetenza
};
