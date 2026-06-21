/**
 * calcolo-paga.js
 * Motore di calcolo della paga mensile, basato sulle percentuali di
 * maggiorazione del CCNL (Tabella "Gestione aeroportuale" fornita da Giorgio):
 *
 *   - Lavoro notturno compreso in turni regolari:        +50%
 *   - Lavoro festivo (diurno):                            +45%
 *   - Lavoro festivo notturno:                             +55%
 *   - Straordinario feriale diurno:                       +25%
 *   - Straordinario diurno in giorno di riposo:            +30%
 *   - Straordinario notturno:                              +45%
 *   - Straordinario festivo:                                +45%
 *
 * Definizioni usate (confermate da Giorgio):
 *   - Notturno: qualsiasi ora compresa tra le 20:00 e le 08:00
 *   - Festivo: domeniche + festività nazionali italiane (incluse mobili)
 */

const { isGiornoFestivo } = require('./festivita-italiane');

const MAGGIORAZIONI = {
  notturno: 0.50,
  festivo: 0.45,
  festivoNotturno: 0.55,
  straordinarioFerialeDiurno: 0.25,
  straordinarioRiposoDiurno: 0.30,
  straordinarioNotturno: 0.45,
  straordinarioFestivo: 0.45
};

/**
 * Scompone un turno "HH:MM-HH:MM" (gestendo l'attraversamento di mezzanotte)
 * nelle sue ore NOTTURNE (20:00-08:00) e DIURNE, in formato decimale.
 * Ritorna { oreDiurne, oreNotturne, oreTotali }.
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
  if (fine <= inizio) fine += 24; // turno che attraversa la mezzanotte

  const oreTotali = fine - inizio;
  let oreNotturne = 0;

  // Calcola l'overlap del turno con le due fasce notturne possibili nelle 24h:
  // [0,8) e [20,24) (estese a [24,32) e [44,48) se il turno supera la mezzanotte)
  const fasceNotte = [[0, 8], [20, 24], [24, 32], [44, 48]];
  fasceNotte.forEach(([fInizio, fFine]) => {
    const overlapInizio = Math.max(inizio, fInizio);
    const overlapFine = Math.min(fine, fFine);
    if (overlapFine > overlapInizio) oreNotturne += (overlapFine - overlapInizio);
  });

  // Evita doppio conteggio nel raro caso di sovrapposizione tra fasce adiacenti
  oreNotturne = Math.min(oreNotturne, oreTotali);

  return {
    oreDiurne: oreTotali - oreNotturne,
    oreNotturne,
    oreTotali
  };
}

/**
 * Calcola la paga di un singolo turno (ordinario, non straordinario),
 * date la paga oraria base e se il giorno è festivo.
 */
function calcolaPagaTurno(orarioStr, dataIso, pagaOraria) {
  const { oreDiurne, oreNotturne, oreTotali } = scomponiOreNotteGiorno(orarioStr);
  const festivo = isGiornoFestivo(dataIso);

  let maggiorazioneDiurna = 0;
  let maggiorazioneNotturna = 0;

  if (festivo) {
    maggiorazioneDiurna = MAGGIORAZIONI.festivo;
    maggiorazioneNotturna = MAGGIORAZIONI.festivoNotturno;
  } else {
    maggiorazioneDiurna = 0; // ore diurne feriali ordinarie: nessuna maggiorazione
    maggiorazioneNotturna = MAGGIORAZIONI.notturno;
  }

  const pagaDiurna = oreDiurne * pagaOraria * (1 + maggiorazioneDiurna);
  const pagaNotturna = oreNotturne * pagaOraria * (1 + maggiorazioneNotturna);

  return {
    oreDiurne, oreNotturne, oreTotali, festivo,
    paga: pagaDiurna + pagaNotturna
  };
}

/**
 * Calcola la maggiorazione di un blocco di ore di STRAORDINARIO inserito
 * manualmente da Giorgio (non derivato dalla griglia turni), in base a:
 * - se è notturno (orario tra 20-8) o diurno
 * - se cade in giorno festivo, in giorno di riposo settimanale, o feriale normale
 */
function calcolaPagaStraordinario(ore, dataIso, isNotturno, isGiornoRiposo, pagaOraria) {
  const festivo = isGiornoFestivo(dataIso);
  let maggiorazione;

  if (festivo) {
    maggiorazione = MAGGIORAZIONI.straordinarioFestivo;
  } else if (isNotturno) {
    maggiorazione = MAGGIORAZIONI.straordinarioNotturno;
  } else if (isGiornoRiposo) {
    maggiorazione = MAGGIORAZIONI.straordinarioRiposoDiurno;
  } else {
    maggiorazione = MAGGIORAZIONI.straordinarioFerialeDiurno;
  }

  return {
    ore, maggiorazione,
    paga: ore * pagaOraria * (1 + maggiorazione)
  };
}

/**
 * Calcola il riepilogo paga di un mese intero, dati tutti i turni (array
 * di { data, orario, tipo }) e gli eventuali straordinari inseriti a mano
 * (array di { data, ore, notturno, giornoRiposo }), filtrati per quel mese.
 */
function calcolaRiepilogoMensile(turniDelMese, straordinariDelMese, pagaOraria) {
  let oreDiurneFeriali = 0, oreNotturneFeriali = 0;
  let oreDiurneFestive = 0, oreNotturneFestive = 0;
  let pagaOrdinaria = 0;
  let oreNotturneTotali = 0;

  turniDelMese.forEach(t => {
    if (t.tipo === 'r') return; // riposo, niente da calcolare
    const calcolo = calcolaPagaTurno(t.orario, t.data, pagaOraria);
    pagaOrdinaria += calcolo.paga;
    oreNotturneTotali += calcolo.oreNotturne;

    if (calcolo.festivo) {
      oreDiurneFestive += calcolo.oreDiurne;
      oreNotturneFestive += calcolo.oreNotturne;
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

  const oreLavorateTotali = oreDiurneFeriali + oreNotturneFeriali + oreDiurneFestive + oreNotturneFestive;

  return {
    oreLavorateTotali,
    oreDiurneFeriali, oreNotturneFeriali,
    oreDiurneFestive, oreNotturneFestive,
    oreNotturneTotali,
    oreStraordinarioTotali,
    pagaOrdinaria,
    pagaStraordinari,
    pagaTotale: pagaOrdinaria + pagaStraordinari,
    dettaglioStraordinari
  };
}

module.exports = {
  MAGGIORAZIONI,
  scomponiOreNotteGiorno,
  calcolaPagaTurno,
  calcolaPagaStraordinario,
  calcolaRiepilogoMensile
};
