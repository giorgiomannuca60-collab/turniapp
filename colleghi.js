/**
 * colleghi.js
 * Elenco statico colleghi → gruppo, estratto dal file Excel della griglia turni.
 * Aggiornare questo file se cambia la composizione dei gruppi.
 */

const COLLEGHI = {
  1: ["WOLF", "BOTTIGLIERI", "CANNAVO'", "PAGANO", "TESTA AG", "MUSUMECI"],
  2: ["ALAMIA", "ARDINI", "AUTERI", "CASTELLI", "CONDORELLI", "DE MARTINO"],
  3: ["LO VERDE", "MANGANO", "CAMPIONE", "TINNIRELLO", "CALVAGNA"],
  4: ["COTTONE", "D'EMANUELE", "D'URSO", "IURATO", "PELLEGRINO", "DI PALMA"],
  5: ["ZAPPALA'", "MOTTA SIM", "SILVESTRI", "SEMINARA C", "COSTA AL", "CONSOLINO", "CARCAGNOLO"],
  6: ["ESPOSITO L", "FRANCAVIGLIA", "FURIA", "GAMBERA", "GRANATA"],
  7: ["DI DIO", "DI SALVO AL", "DOROJAN", "FERRARA", "LA ROCCA", "LIOTTA"],
  8: ["SPAMPINATO", "SCARCIA", "VITALE", "SICURELLA", "SORTINO"],
  9: ["GEN 02 9/15", "GUGLIELMO", "MARLETTA", "CARONIA", "SAMPERI"],
  10: ["BARTILOTTA", "GRILLO", "MOTTA SAR", "PLACENTI", "REITANO S", "PAOLILLO", "RUSSO Y"],
  11: ["MANCINI MA", "MANNUCA", "SANTORO ER", "SCIBETTA", "LOMBARDO"],
  12: ["PADELLARO", "NOTARMURZI", "SANTAPAOLA", "RUSSO W", "TRIPI"],
  13: ["MAUGERI V", "MILAZZO", "MAURO", "PAPPALARDO M", "PATERNO' AN"],
  14: ["DI SALVO A", "SERAFICA", "SIGNORELLO", "CONTI", "TOMARCHIO AL", "MAUGERI G"],
  15: ["CARUSO", "SBIRZIOLA", "RINALDI", "TESTA L", "BLANCATO"],
};

/**
 * Cerca un collega per nome (ricerca parziale, case-insensitive)
 * Restituisce array di { nome, gruppo }
 */
function cercaCollega(query) {
  if (!query || query.length < 2) return [];
  const q = query.trim().toUpperCase();
  const risultati = [];
  for (const [gruppo, nomi] of Object.entries(COLLEGHI)) {
    nomi.forEach(nome => {
      if (nome.includes(q)) {
        risultati.push({ nome, gruppo: parseInt(gruppo) });
      }
    });
  }
  return risultati.slice(0, 8); // max 8 suggerimenti
}

/**
 * Trova il gruppo esatto di un nome (match esatto, case-insensitive)
 */
function trovaGruppoEsatto(nome) {
  if (!nome) return null;
  const n = nome.trim().toUpperCase();
  for (const [gruppo, nomi] of Object.entries(COLLEGHI)) {
    if (nomi.includes(n)) return parseInt(gruppo);
  }
  return null;
}

module.exports = { COLLEGHI, cercaCollega, trovaGruppoEsatto };
