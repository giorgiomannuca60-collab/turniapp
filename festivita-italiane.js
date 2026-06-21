/**
 * festivita-italiane.js
 * Calcola le festività nazionali italiane per un anno dato, incluse
 * quelle "mobili" legate alla Pasqua (Pasqua e Pasquetta), usando
 * l'algoritmo di Gauss per la data della Pasqua.
 */

const { formattaDataLocale } = require('./parser-turni');

/**
 * Calcola la data di Pasqua per un anno dato (algoritmo di Gauss/Meeus).
 * Ritorna un oggetto Date.
 */
function calcolaPasqua(anno) {
  const a = anno % 19;
  const b = Math.floor(anno / 100);
  const c = anno % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mese = Math.floor((h + l - 7 * m + 114) / 31); // 3=marzo, 4=aprile
  const giorno = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(anno, mese - 1, giorno);
}

/**
 * Ritorna l'insieme (Set) di tutte le date festive italiane per un anno,
 * in formato stringa YYYY-MM-DD, pronte per un confronto rapido.
 */
function festivitaAnno(anno) {
  const pasqua = calcolaPasqua(anno);
  const pasquetta = new Date(pasqua.getFullYear(), pasqua.getMonth(), pasqua.getDate() + 1);

  const fisse = [
    [0, 1],   // 1 Gennaio - Capodanno
    [0, 6],   // 6 Gennaio - Epifania
    [3, 25],  // 25 Aprile - Liberazione
    [4, 1],   // 1 Maggio - Festa Lavoro
    [5, 2],   // 2 Giugno - Festa Repubblica
    [7, 15],  // 15 Agosto - Ferragosto
    [10, 1],  // 1 Novembre - Ognissanti
    [11, 8],  // 8 Dicembre - Immacolata
    [11, 25], // 25 Dicembre - Natale
    [11, 26]  // 26 Dicembre - Santo Stefano
  ];

  const date = fisse.map(([mese, giorno]) => formattaDataLocale(new Date(anno, mese, giorno)));
  date.push(formattaDataLocale(pasqua));
  date.push(formattaDataLocale(pasquetta));

  return new Set(date);
}

// Cache per evitare di ricalcolare la Pasqua ogni volta nella stessa esecuzione
const cacheFestivita = {};

/**
 * Verifica se una data (stringa YYYY-MM-DD) è festività nazionale.
 */
function isFestivita(dataIso) {
  const anno = parseInt(dataIso.slice(0, 4));
  if (!cacheFestivita[anno]) cacheFestivita[anno] = festivitaAnno(anno);
  return cacheFestivita[anno].has(dataIso);
}

/**
 * Verifica se una data è "festiva" ai fini della maggiorazione:
 * domenica OPPURE festività nazionale.
 */
function isGiornoFestivo(dataIso) {
  const d = new Date(dataIso + 'T00:00:00');
  const isDomenica = d.getDay() === 0;
  return isDomenica || isFestivita(dataIso);
}

module.exports = { calcolaPasqua, festivitaAnno, isFestivita, isGiornoFestivo };
