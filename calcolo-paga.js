/**
 * calcolo-paga.js
 * Motore di calcolo della paga mensile, ricalibrato sui valori REALI letti
 * dalla busta paga di Giorgio (maggio 2026, periodo competenza aprile 2026,
 * SAC Service Srl — Gestione aeroportuale).
 *
 * A differenza della prima versione (basata su percentuali generiche da
 * tabella CCNL), qui usiamo gli IMPORTI FISSI PER ORA effettivamente
 * applicati in busta paga, confermati da Giorgio come stabili mese su mese:
 *
 *   - Notturno feriale (ordinario):       5,06815 €/h
 *   - Notturno domenicale:                5,57497 €/h
 *   - Domenicale diurno:                  1,01363 €/h
 *   - Festività nazionale (infrasett.):   19,71000 €/h (39,42€ / 2h in busta)
 *
 * Indennità FISSE per ogni giorno di turno lavorato (non per ora, per giorno):
 *   - Indennità di turno:    0,26 €/giorno
 *   - Indennità giornaliera: 5,73 €/giorno
 *
 * REGOLA DI COMPETENZA TEMPORALE (confermata da Giorgio e dalla busta paga
 * stessa, che nel footer scrive "I dati variabili della retribuzione [...]
 * si riferiscono al mese precedente"): lo stipendio pagato nel mese N
 * riflette le ore di straordinario, notturno e festivo MATURATE nel mese
 * N-1. Il riepilogo mensile dell'app deve quindi mostrare, per il "mese di
 * paga" selezionato, i dati relativi al mese calendario precedente.
 *
 * Definizioni:
 *   - Notturno: qualsiasi ora compresa tra le 20:00 e le 08:00
 *   - Domenica: maggiorazione domenicale specifica (diversa da festività)
 *   - Festività nazionale: maggiorazione festiva specifica, voce separata
 *     in busta paga rispetto alla domenica
 */

const { isFestivita } = require('./festivita-italiane');

// Importi fissi per ora, dalla busta paga reale (€/h)
const IMPORTI_FISSI = {
  notturnoFeriale: 5.06815,
  notturnoDomenicale: 5.57497,
  domenicaleDiurno: 1.01363,
  festivitaNazionale: 19.71000  // 39,42€ / 2h osservate in busta
};

// Indennità fisse per giorno di turno lavorato (non in riposo), in euro
const INDENNITA_GIORNALIERE = {
  indennitaTurno: 0.26,
  indennitaGiornaliera: 5.73
};

/**
 * Scompone un turno "HH:MM-HH:MM" (gestendo l'attraversamento di mezzanotte)
 * nelle sue ore NOTTURNE (20:00-08:00) e DIURNE, in formato decimale.
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
  if (fine <= inizio) fine += 24;

  const oreTotali = fine - inizio;
  let oreNotturne = 0;

  const fasceNotte = [[0, 8], [20, 24], [24, 32], [44, 48]];
  fasceNotte.forEach(([fInizio, fFine]) => {
    const overlapInizio = Math.max(inizio, fInizio);
    const overlapFine = Math.min(fine, fFine);
    if (overlapFine > overlapInizio) oreNotturne += (overlapFine - overlapInizio);
  });
  oreNotturne = Math.min(oreNotturne, oreTotali);

  return { oreDiurne: oreTotali - oreNotturne, oreNotturne, oreTotali };
}

/**
 * Determina il "tipo di giorno" ai fini della maggiorazione, distinguendo
 * esplicitamente domenica da festività nazionale infrasettimanale, perché
 * in busta paga sono due voci diverse con importi diversi.
 */
function tipoGiorno(dataIso) {
  const d = new Date(dataIso + 'T00:00:00');
  const isDomenica = d.getDay() === 0;
  const isFestivitaNazionale = isFestivita(dataIso); // 25 aprile, Natale, Pasqua ecc.

  if (isDomenica) return 'domenica';
  if (isFestivitaNazionale) return 'festivita_nazionale';
  return 'feriale';
}

/**
 * Calcola la paga di un singolo turno ORDINARIO (non straordinario),
 * usando paga oraria base (per le ore diurne feriali, retribuzione
 * ordinaria) più le maggiorazioni a importo fisso per le ore che rientrano
 * in notturno/domenica/festività.
 */
function calcolaPagaTurno(orarioStr, dataIso, pagaOraria) {
  const { oreDiurne, oreNotturne, oreTotali } = scomponiOreNotteGiorno(orarioStr);
  const tipo = tipoGiorno(dataIso);

  // Retribuzione ordinaria: tutte le ore lavorate vengono pagate alla paga
  // base oraria piena (come "Retribuzione ordinaria" in busta paga),
  // a cui si SOMMANO le maggiorazioni fisse per le ore notturne/festive.
  let pagaBase = oreTotali * pagaOraria;
  let maggiorazione = 0;

  if (tipo === 'domenica') {
    maggiorazione += oreDiurne * IMPORTI_FISSI.domenicaleDiurno;
    maggiorazione += oreNotturne * IMPORTI_FISSI.notturnoDomenicale;
  } else if (tipo === 'festivita_nazionale') {
    maggiorazione += oreTotali * IMPORTI_FISSI.festivitaNazionale;
    maggiorazione += oreNotturne * IMPORTI_FISSI.notturnoFeriale; // il notturno si applica comunque
  } else {
    maggiorazione += oreNotturne * IMPORTI_FISSI.notturnoFeriale;
  }

  return {
    oreDiurne, oreNotturne, oreTotali, tipoGiorno: tipo,
    pagaBase, maggiorazione,
    paga: pagaBase + maggiorazione
  };
}

/**
 * Calcola le indennità fisse giornaliere (turno + giornaliera) per un
 * singolo giorno lavorato. Si applicano una volta per giorno di turno,
 * indipendentemente dall'orario.
 */
function calcolaIndennitaGiorno() {
  return INDENNITA_GIORNALIERE.indennitaTurno + INDENNITA_GIORNALIERE.indennitaGiornaliera;
}

/**
 * Calcola la maggiorazione di un blocco di ore di STRAORDINARIO inserito
 * manualmente, usando le stesse logiche di importo fisso per coerenza con
 * gli importi reali di busta paga (notturno/festivo), più una maggiorazione
 * percentuale per lo straordinario "puro" feriale diurno (non coperto da
 * importi fissi specifici in busta, quindi resta a percentuale standard CCNL).
 */
function calcolaPagaStraordinario(ore, dataIso, isNotturno, isGiornoRiposo, pagaOraria) {
  const tipo = tipoGiorno(dataIso);
  let pagaBase = ore * pagaOraria;
  let maggiorazione = 0;
  let etichetta = '';

  if (tipo === 'domenica') {
    maggiorazione = isNotturno ? ore * IMPORTI_FISSI.notturnoDomenicale : ore * IMPORTI_FISSI.domenicaleDiurno;
    etichetta = isNotturno ? 'Straordinario domenicale notturno' : 'Straordinario domenicale diurno';
  } else if (tipo === 'festivita_nazionale') {
    maggiorazione = ore * IMPORTI_FISSI.festivitaNazionale + (isNotturno ? ore * IMPORTI_FISSI.notturnoFeriale : 0);
    etichetta = 'Straordinario festività nazionale';
  } else if (isNotturno) {
    maggiorazione = ore * IMPORTI_FISSI.notturnoFeriale;
    etichetta = 'Straordinario notturno feriale';
  } else if (isGiornoRiposo) {
    maggiorazione = ore * pagaOraria * 0.30; // +30% CCNL, nessun importo fisso osservato in busta per questo caso
    etichetta = 'Straordinario diurno in giorno di riposo (+30%)';
  } else {
    maggiorazione = ore * pagaOraria * 0.25; // +25% CCNL feriale diurno standard
    etichetta = 'Straordinario feriale diurno (+25%)';
  }

  return { ore, etichetta, pagaBase, maggiorazione, paga: pagaBase + maggiorazione };
}

/**
 * Calcola il riepilogo paga di un mese intero. IMPORTANTE: per riflettere
 * correttamente la regola di competenza (lo stipendio del mese N paga le
 * ore del mese N-1), il chiamante deve passare i turni/straordinari del
 * mese DI COMPETENZA (quello lavorato), non del mese di pagamento — la
 * funzione calcolaMeseCompetenza() in fondo a questo file aiuta a derivare
 * il mese giusto da passare.
 */
function calcolaRiepilogoMensile(turniDelMese, straordinariDelMese, pagaOraria) {
  let oreDiurneFeriali = 0, oreNotturneFeriali = 0;
  let oreDomenicaDiurne = 0, oreDomenicaNotturne = 0;
  let oreFestivitaNazionale = 0;
  let pagaOrdinaria = 0;
  let maggiorazioniTotali = 0;
  let oreNotturneTotali = 0;
  let giorniLavorati = 0;
  let indennitaGiornaliereTotali = 0;

  turniDelMese.forEach(t => {
    if (t.tipo === 'r') return; // riposo, niente da calcolare
    const calcolo = calcolaPagaTurno(t.orario, t.data, pagaOraria);
    pagaOrdinaria += calcolo.paga;
    maggiorazioniTotali += calcolo.maggiorazione;
    oreNotturneTotali += calcolo.oreNotturne;
    giorniLavorati += 1;
    indennitaGiornaliereTotali += calcolaIndennitaGiorno();

    if (calcolo.tipoGiorno === 'domenica') {
      oreDomenicaDiurne += calcolo.oreDiurne;
      oreDomenicaNotturne += calcolo.oreNotturne;
    } else if (calcolo.tipoGiorno === 'festivita_nazionale') {
      oreFestivitaNazionale += calcolo.oreTotali;
    } else {
      oreDiurneFeriali += calcolo.oreDiurne;
      oreNotturneFeriali += calcolo.oreNotturne;
    }
  });

  let pagaStraordinari = 0;
  let oreStraordinarioTotali = 0;
  const dettaglioStraordinari = (straordinariDelMese || []).map(s => {
    const calcolo = calcolaPagaStraordinario(s.ore, s.data, s.notturno, s.giornoRiposo, pagaOraria);
    pagaStraordinari += calcolo.paga;
    oreStraordinarioTotali += s.ore;
    if (s.notturno) oreNotturneTotali += s.ore;
    return { ...s, ...calcolo };
  });

  const oreLavorateTotali = oreDiurneFeriali + oreNotturneFeriali + oreDomenicaDiurne + oreDomenicaNotturne + oreFestivitaNazionale;
  const pagaTotale = pagaOrdinaria + pagaStraordinari + indennitaGiornaliereTotali;

  return {
    oreLavorateTotali,
    giorniLavorati,
    oreDiurneFeriali, oreNotturneFeriali,
    oreDomenicaDiurne, oreDomenicaNotturne,
    oreFestivitaNazionale,
    oreNotturneTotali,
    oreStraordinarioTotali,
    pagaOrdinaria,
    maggiorazioniTotali,
    indennitaGiornaliereTotali,
    pagaStraordinari,
    pagaTotale,
    dettaglioStraordinari
  };
}

/**
 * Dato un "mese di pagamento" (YYYY-MM, il mese in cui arriva il cedolino),
 * restituisce il "mese di competenza" effettivo (YYYY-MM del mese
 * precedente), le cui ore sono quelle da sommare per calcolare quella busta
 * paga — coerente con la regola di sfasamento confermata da Giorgio e dalla
 * busta paga stessa.
 */
function calcolaMeseCompetenza(mesePagamento) {
  const [anno, mese] = mesePagamento.split('-').map(Number);
  const d = new Date(anno, mese - 1 - 1, 1); // mese-1 (0-index) poi -1 mese ancora
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

module.exports = {
  IMPORTI_FISSI,
  INDENNITA_GIORNALIERE,
  scomponiOreNotteGiorno,
  tipoGiorno,
  calcolaPagaTurno,
  calcolaIndennitaGiorno,
  calcolaPagaStraordinario,
  calcolaRiepilogoMensile,
  calcolaMeseCompetenza
};
