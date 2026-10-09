// Recherche des ventes comparables dans la base DVF (ventes réellement signées).
// Trois niveaux, du plus précis au plus large : même rue, même section cadastrale, même commune.

const BASE = require("./dvf06.json");
const I = Object.fromEntries(BASE.champs.map((c, i) => [c, i]));

// ---------- Normalisation des adresses ----------

const TYPES_VOIE = {
  AVENUE: "AV", AVE: "AV", BOULEVARD: "BD", BLD: "BD", BOUL: "BD", CHEMIN: "CHE", CHEM: "CHE",
  ROUTE: "RTE", ALLEE: "ALL", ALLEES: "ALL", IMPASSE: "IMP", PROMENADE: "PROM", PLACE: "PL",
  CORNICHE: "COR", TRAVERSE: "TRA", MONTEE: "MTE", COURS: "CRS", PASSAGE: "PAS", SQUARE: "SQ",
  RUELLE: "RLE", ESPLANADE: "ESP", DESCENTE: "DSC", ESCALIER: "ESC", VALLON: "VAL",
};
const MOTS_VIDES = new Set(["DE", "DU", "DES", "LA", "LE", "LES", "L", "D", "ET", "AUX", "AU"]);
const ABREVIATIONS = new Set(["RUE", "AV", "BD", "CHE", "RTE", "ALL", "IMP", "PROM", "PL", "COR", "TRA",
  "MTE", "CRS", "PAS", "SQ", "RLE", "ESP", "DSC", "ESC", "VAL", "QUAI", "CAMI", "CR", "PTE", "VC", "VOIE"]);

function normaliser(s) {
  return String(s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase().replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/).filter(Boolean)
    .map((m) => TYPES_VOIE[m] || m)
    .join(" ");
}

// « 12 bis rue de France » -> { numero: 12, voie: "RUE DE FRANCE", coeur: "FRANCE" }
function decouperAdresse(adresse) {
  const n = normaliser(adresse);
  const m = n.match(/^(\d+)\s*(?:BIS|TER|QUATER|[A-D])?\s+(.*)$/);
  const voie = m ? m[2] : n;
  return { numero: m ? parseInt(m[1], 10) : null, voie, coeur: coeurVoie(voie) };
}

function coeurVoie(voie) {
  return voie.split(" ").filter((m) => !ABREVIATIONS.has(m) && !MOTS_VIDES.has(m)).join(" ");
}

// ---------- Localisation du bien (géocodage + parcelle cadastrale) ----------

async function localiser(adresse, codePostal, commune) {
  const res = { codeCommune: null, section: null, voieOfficielle: null, numero: null };
  try {
    const q = encodeURIComponent(`${adresse} ${codePostal} ${commune}`);
    const r = await fetch(`https://data.geopf.fr/geocodage/search?q=${q}&index=address&limit=1`,
      { signal: AbortSignal.timeout(8000) });
    const f = (await r.json()).features?.[0];
    if (!f || f.properties.score < 0.5) return res;
    const p = f.properties;
    if (p.citycode?.startsWith("06")) res.codeCommune = p.citycode.slice(2);
    if (p.street) res.voieOfficielle = p.street;
    if (p.housenumber) res.numero = parseInt(p.housenumber, 10);

    const geom = encodeURIComponent(JSON.stringify(f.geometry));
    const c = await fetch(`https://apicarto.ign.fr/api/cadastre/parcelle?geom=${geom}`,
      { signal: AbortSignal.timeout(8000) });
    const parcelle = (await c.json()).features?.[0]?.properties;
    if (parcelle?.section) res.section = parcelle.section.replace(/^0+/, "");
  } catch (e) {
    console.error("Localisation impossible :", e.message);
  }
  return res;
}

// ---------- Statistiques ----------

const prixM2 = (v) => v[I.prix] / v[I.surface];
function mediane(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}
function quartiles(arr) {
  if (arr.length < 4) return null;
  const s = [...arr].sort((a, b) => a - b);
  return [Math.round(s[Math.floor(s.length * 0.25)]), Math.round(s[Math.floor(s.length * 0.75)])];
}
function statsParAnnee(ventes) {
  const parAn = {};
  for (const v of ventes) (parAn[v[I.date].slice(0, 4)] ||= []).push(prixM2(v));
  return Object.entries(parAn).sort().map(([an, l]) => {
    const q = quartiles(l);
    return `${an} : ${l.length} ventes, médiane ${mediane(l).toLocaleString("fr-FR")} €/m²` +
      (q ? ` (moitié centrale ${q[0].toLocaleString("fr-FR")}–${q[1].toLocaleString("fr-FR")} €/m²)` : "");
  }).join("\n");
}

function ligneVente(v) {
  const annexes = [];
  if (v[I.dependance]) annexes.push("avec dépendance (parking, cave ou box)");
  if (v[I.terrain]) annexes.push(`terrain ${v[I.terrain]} m²`);
  if (v[I.carrez]) annexes.push(`Carrez ${v[I.carrez]} m²`);
  return `- ${v[I.date]} | ${v[I.numero] || "s/n"} ${v[I.voie]} (section ${v[I.section]}) | ` +
    `${v[I.prix].toLocaleString("fr-FR")} € | ${v[I.surface]} m² bâtis | ${v[I.pieces]} p. | ` +
    `${Math.round(prixM2(v)).toLocaleString("fr-FR")} €/m²${annexes.length ? " | " + annexes.join(", ") : ""}`;
}

// ---------- Point d'entrée ----------

async function trouverComparables(d) {
  const type = d.type === "Maison" ? "M" : "A";
  const surface = Number(d.surface);
  const loc = await localiser(d.adresse, d.code_postal, d.commune);

  // Code commune : géocodage, sinon nom de commune
  let codeCommune = loc.codeCommune;
  if (!codeCommune) {
    const nom = normaliser(d.commune);
    const v = BASE.ventes.find((x) => normaliser(x[I.commune]) === nom);
    codeCommune = v ? v[I.code_commune] : null;
  }
  if (!codeCommune) {
    return "Aucune donnée DVF exploitable : commune non trouvée dans la base des Alpes-Maritimes.";
  }

  const saisie = decouperAdresse(d.adresse);
  const officielle = loc.voieOfficielle ? decouperAdresse(loc.voieOfficielle) : null;
  const voie = officielle?.voie || saisie.voie;
  const coeur = officielle?.coeur || saisie.coeur;
  const numero = loc.numero ?? saisie.numero;

  const commune = BASE.ventes.filter((v) => v[I.code_commune] === codeCommune && v[I.type] === type && !v[I.vefa]);
  const nomCommune = commune[0]?.[I.commune] || d.commune;
  const proche = (v) => v[I.surface] >= surface * 0.65 && v[I.surface] <= surface * 1.5;
  const recent = (a, b) => b[I.date].localeCompare(a[I.date]);
  const libelle = type === "A" ? "appartements" : "maisons";
  const tous = type === "A" ? "tous les appartements" : "toutes les maisons";

  const blocs = [`Source : DVF (ventes signées), période ${BASE.periode}. Type analysé : ${libelle}, hors ventes en l'état futur d'achèvement.`];

  // 1. Même rue
  const memeRue = commune.filter((v) => {
    const n = normaliser(v[I.voie]);
    return n === voie || (coeur.length > 3 && coeurVoie(n) === coeur);
  });
  if (memeRue.length) {
    const tri = [...memeRue].sort((a, b) => {
      const da = numero ? Math.abs((parseInt(a[I.numero], 10) || 9999) - numero) : 0;
      const db = numero ? Math.abs((parseInt(b[I.numero], 10) || 9999) - numero) : 0;
      return da - db || recent(a, b);
    }).slice(0, 15);
    const pm = memeRue.map(prixM2);
    blocs.push(`## Même rue (${memeRue.length} ventes, médiane ${mediane(pm).toLocaleString("fr-FR")} €/m²)\n` +
      `Les plus proches en numéro :\n${tri.map(ligneVente).join("\n")}`);
  } else {
    blocs.push("## Même rue\nAucune vente de ce type trouvée dans cette rue sur la période.");
  }

  // 2. Même section cadastrale (micro-secteur)
  // Section : celle du cadastre, sinon celle de la vente la plus proche en numéro dans la rue
  let section = loc.section;
  if (!section && memeRue.length) {
    const ecart = (v) => numero ? Math.abs((parseInt(v[I.numero], 10) || 9999) - numero) : 0;
    section = [...memeRue].sort((a, b) => ecart(a) - ecart(b))[0][I.section];
  }
  if (section) {
    const memeSection = commune.filter((v) => v[I.section] === section);
    const similaires = memeSection.filter(proche).sort(recent).slice(0, 15);
    blocs.push(`## Même section cadastrale ${section}${loc.section ? "" : " (déduite des ventes de la rue)"} — ${memeSection.length} ventes\n` +
      `Évolution du prix au m² :\n${statsParAnnee(memeSection) || "aucune"}\n` +
      `Ventes récentes de surface comparable (${Math.round(surface * 0.65)}–${Math.round(surface * 1.5)} m²) :\n` +
      (similaires.map(ligneVente).join("\n") || "aucune"));
  } else {
    blocs.push("## Section cadastrale\nSection non déterminée (adresse non localisée).");
  }

  // 3. Commune
  blocs.push(`## Commune de ${nomCommune} — ${tous}\n${statsParAnnee(commune)}\n` +
    `## Commune — ${libelle} de surface comparable\n${statsParAnnee(commune.filter(proche))}`);

  return blocs.join("\n\n");
}

module.exports = { trouverComparables, decouperAdresse, normaliser };
