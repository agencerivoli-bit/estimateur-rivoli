// Fonction d'arrière-plan Netlify (le suffixe "-background" dans le nom la rend asynchrone :
// le navigateur reçoit immédiatement une réponse 202, l'estimation tourne ensuite jusqu'à 15 min).
//
// Variables d'environnement à définir dans Netlify (Site configuration > Environment variables) :
//   ANTHROPIC_API_KEY      clé API Anthropic (obligatoire)
//   BREVO_API_KEY          clé API Brevo (obligatoire)
//   EMAIL_EXPEDITEUR       adresse d'envoi validée dans Brevo (obligatoire)
//   EMAIL_AGENCE           adresse qui reçoit le rapport complet (obligatoire)
//   ENVOI_AUTO_CLIENT      "true" pour envoyer l'estimation au propriétaire automatiquement,
//                          sinon seule l'agence la reçoit et décide de la transmettre (défaut)
//   BREVO_LIST_ID          identifiant de la liste Brevo où ajouter le prospect (facultatif)
//   ANTHROPIC_MODEL        modèle Claude utilisé (facultatif)

const { SYSTEM_PROMPT } = require("./prompt");
const { trouverComparables } = require("./comparables");

const MODELE = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const TEL_AGENCE = "06 01 00 71 16";
const SIGNATURE = "Florian Colonna, Directeur — L'Agence Rivoli";

// ---------- Utilitaires ----------

const LIMITES = { court: 120, moyen: 300, long: 1000 };

function nettoyer(valeur, max = LIMITES.court) {
  if (valeur === undefined || valeur === null) return "";
  return String(valeur).replace(/[<>]/g, "").trim().slice(0, max);
}

function echapperHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function euros(n) {
  return Math.round(Number(n) || 0).toLocaleString("fr-FR") + " €";
}

// Conversion Markdown -> HTML volontairement minimaliste (titres, gras, listes, paragraphes, tableaux simples).
function markdownVersHtml(md) {
  const lignes = echapperHtml(md).split("\n");
  let html = "", dansListe = false, dansTableau = false;
  const inline = (t) => t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>");
  const fermer = () => {
    if (dansListe) { html += "</ul>"; dansListe = false; }
    if (dansTableau) { html += "</table>"; dansTableau = false; }
  };
  for (const brute of lignes) {
    const l = brute.trim();
    if (/^\|.*\|$/.test(l)) {
      if (/^\|[\s:|-]+\|$/.test(l)) continue; // ligne de séparation
      if (!dansTableau) { fermer(); html += '<table cellpadding="6" style="border-collapse:collapse;font-size:14px">'; dansTableau = true; }
      const cellules = l.slice(1, -1).split("|").map((c) => `<td style="border:1px solid #ddd">${inline(c.trim())}</td>`);
      html += `<tr>${cellules.join("")}</tr>`;
      continue;
    }
    const titre = l.match(/^(#{1,4})\s+(.*)$/);
    if (titre) { fermer(); const n = Math.min(titre[1].length + 1, 4); html += `<h${n} style="color:#0b1f3a">${inline(titre[2])}</h${n}>`; continue; }
    const puce = l.match(/^[-*]\s+(.*)$/) || l.match(/^\d+\.\s+(.*)$/);
    if (puce) { if (dansTableau) fermer(); if (!dansListe) { html += "<ul>"; dansListe = true; } html += `<li>${inline(puce[1])}</li>`; continue; }
    fermer();
    if (l) html += `<p>${inline(l)}</p>`;
  }
  fermer();
  return html;
}

// ---------- Appel à Claude ----------

function formaterDonnees(d) {
  const lignes = [
    ["Type de bien", d.type],
    ["Adresse", `${d.adresse}, ${d.code_postal} ${d.commune}`],
    ["Surface Carrez (m²)", d.surface],
    ["Nombre de pièces", d.pieces],
    ["Nombre de chambres", d.chambres],
    ["Étage", d.etage],
    ["Nombre d'étages de l'immeuble", d.etages_immeuble],
    ["Ascenseur", d.ascenseur],
    ["Extérieur", d.exterieur],
    ["Surface de l'extérieur (m²)", d.surface_exterieur],
    ["Vue", d.vue],
    ["Exposition principale", d.exposition],
    ["Stationnement", d.parking],
    ["Cave", d.cave],
    ["État général", d.etat],
    ["Époque de construction", d.epoque],
    ["DPE", d.dpe],
    ["Charges de copropriété annuelles (€)", d.charges],
    ["Taxe foncière annuelle (€)", d.taxe_fonciere],
    ["Projet de vente", d.projet],
    ["Précisions du propriétaire", d.precisions],
  ];
  return lignes
    .map(([k, v]) => `${k} : ${v ? v : "Information non renseignée"}`)
    .join("\n");
}

async function appelerClaude(donnees, dvf) {
  const messages = [{
    role: "user",
    content:
      "Voici les informations transmises par un propriétaire via le formulaire d'estimation en ligne de L'Agence Rivoli, " +
      "suivies des ventes réelles extraites de la base DVF pour ce secteur. Produis l'estimation selon tes consignes.\n\n" +
      "<donnees_formulaire>\n" + formaterDonnees(donnees) + "\n</donnees_formulaire>\n\n" +
      "<donnees_dvf>\n" + dvf + "\n</donnees_dvf>",
  }];

  const tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }];
  let texte = "";

  // Les recherches web peuvent mettre la réponse en pause ("pause_turn") : on relance jusqu'à 4 fois.
  for (let tour = 0; tour < 4; tour++) {
    const rep = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: MODELE, max_tokens: 10000, system: SYSTEM_PROMPT, tools, messages }),
    });
    if (!rep.ok) throw new Error(`API Anthropic ${rep.status} : ${await rep.text()}`);
    const data = await rep.json();

    texte += data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    if (data.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: data.content });
  }

  const rapport = (texte.match(/<rapport>([\s\S]*?)<\/rapport>/) || [])[1]?.trim() || texte;

  // 1er essai : lire le JSON placé entre <synthese> et </synthese>
  let synthese = null;
  const brute = (texte.match(/<synthese>([\s\S]*?)(<\/synthese>|$)/) || [])[1] || "";
  const debut = brute.indexOf("{"), fin = brute.lastIndexOf("}");
  if (debut !== -1 && fin > debut) {
    try { synthese = JSON.parse(brute.slice(debut, fin + 1)); } catch (_) { /* on passe au 2e essai */ }
  }

  // 2e essai : on demande la synthèse à part, dans un format imposé (ne peut pas être illisible)
  if (!synthese || !(Number(synthese.valeur_centrale) > 0)) {
    console.error("Synthèse non lisible dans la réponse, extraction séparée. Début :", brute.slice(0, 300));
    synthese = await extraireSynthese(rapport).catch((e) => { console.error("Extraction synthèse :", e); return null; });
  }

  return { rapport, synthese };
}

const OUTIL_SYNTHESE = {
  name: "enregistrer_synthese",
  description: "Enregistre la synthèse de l'estimation destinée au propriétaire.",
  input_schema: {
    type: "object",
    properties: {
      valeur_basse: { type: "integer", description: "Valeur basse en euros, arrondie au millier" },
      valeur_centrale: { type: "integer", description: "Prix médian (valeur la plus probable) en euros, arrondi au millier" },
      valeur_haute: { type: "integer", description: "Valeur haute en euros, arrondie au millier. Écart haute-basse ≤ 15 % de la valeur centrale" },
      niveau_confiance: { type: "integer", description: "Niveau de confiance sur 100" },
      secteur: { type: "string", description: "Quartier ou micro-secteur retenu" },
      explication: { type: "string", description: "3 à 4 phrases qui partent d'un chiffre réel du rapport (médiane de la rue ou du secteur, vente comparable) et arrivent au prix médian de CE bien en nommant les caractéristiques qui font la différence" },
      ajustements: { type: "array", items: { type: "string" }, description: "3 à 5 lignes : caractéristique précise du bien — effet en % approximatif (+ ou −) — raison concrète, repris du rapport" },
      marche_local: { type: "string", description: "2 à 3 phrases sur le marché du secteur, chiffres à l'appui" },
      ventes_reference: { type: "array", items: { type: "string" }, description: "2 à 4 ventes réelles citées dans le rapport, sans numéro de rue : mois et année — rue — type et surface — prix au m²" },
      points_forts: { type: "array", items: { type: "string" }, description: "2 à 4 phrases, chacune sur une caractéristique précise de CE bien, avec un chiffre si possible ; jamais de formule générique" },
      points_attention: { type: "array", items: { type: "string" }, description: "1 à 3 phrases, chacune sur une caractéristique précise de CE bien et son effet concret sur la vente, avec tact" },
      informations_a_verifier: { type: "array", items: { type: "string" }, description: "1 à 3 éléments qu'une visite permettrait de préciser" },
    },
    required: ["valeur_basse", "valeur_centrale", "valeur_haute", "niveau_confiance", "secteur", "explication",
      "ajustements", "marche_local", "ventes_reference", "points_forts", "points_attention", "informations_a_verifier"],
  },
};

async function extraireSynthese(rapport) {
  const rep = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODELE,
      max_tokens: 1500,
      tools: [OUTIL_SYNTHESE],
      tool_choice: { type: "tool", name: "enregistrer_synthese" },
      messages: [{
        role: "user",
        content: "Voici un rapport d'estimation immobilière destiné à une agence. Reprends-en fidèlement les valeurs " +
          "(sans en inventer ni les modifier ; ne cite que des ventes présentes dans le rapport) et rédige la synthèse " +
          "destinée au propriétaire, en français. Sois précis et personnalisé : chaque phrase doit citer une caractéristique de CE bien " +
          "et, si possible, un chiffre du rapport ; aucune formule générique. Si la fourchette du rapport dépasse 15 % de la valeur centrale, resserre-la autour de la valeur centrale. " +
          "dans un langage simple et avec tact.\n\n<rapport>\n" + rapport + "\n</rapport>",
      }],
    }),
  });
  if (!rep.ok) throw new Error(`API Anthropic ${rep.status} : ${await rep.text()}`);
  const data = await rep.json();
  return data.content.find((b) => b.type === "tool_use")?.input || null;
}

// ---------- Garde-fou sur la fourchette ----------
// Écart maximal entre valeur haute et valeur basse, en proportion de la valeur centrale.
const ECART_MAX = 0.15;
const arrondir = (n) => Math.round(n / 1000) * 1000;

function encadrerFourchette(s, surface) {
  if (!s) return s;
  let c = Number(s.valeur_centrale), b = Number(s.valeur_basse), h = Number(s.valeur_haute);
  if (!(c > 0)) return s;
  if (!(b > 0) || b > c) b = c * (1 - ECART_MAX / 2);
  if (!(h > 0) || h < c) h = c * (1 + ECART_MAX / 2);
  // Si l'écart dépasse le maximum, on le réduit en gardant la même asymétrie autour de la valeur centrale
  const ecart = h - b, max = c * ECART_MAX;
  if (ecart > max) {
    const k = max / ecart;
    b = c - (c - b) * k;
    h = c + (h - c) * k;
  }
  s.valeur_basse = arrondir(b);
  s.valeur_centrale = arrondir(c);
  s.valeur_haute = arrondir(h);
  // Prix au m² calculés sur la surface déclarée, pour rester cohérents avec les trois valeurs
  if (surface > 0) {
    s.prix_m2_bas = Math.round(s.valeur_basse / surface);
    s.prix_m2_median = Math.round(s.valeur_centrale / surface);
    s.prix_m2_haut = Math.round(s.valeur_haute / surface);
  }
  return s;
}

// ---------- Brevo ----------

async function envoyerEmail({ a, nom, sujet, html, repondreA }) {
  const corps = {
    sender: { email: process.env.EMAIL_EXPEDITEUR, name: "L'Agence Rivoli" },
    to: [{ email: a, name: nom || a }],
    subject: sujet,
    htmlContent: html,
  };
  if (repondreA) corps.replyTo = { email: repondreA };
  const rep = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "content-type": "application/json", "api-key": process.env.BREVO_API_KEY },
    body: JSON.stringify(corps),
  });
  if (!rep.ok) throw new Error(`Brevo email ${rep.status} : ${await rep.text()}`);
}

async function ajouterContact(d) {
  const liste = parseInt(process.env.BREVO_LIST_ID, 10);
  if (!liste) return;
  const rep = await fetch("https://api.brevo.com/v3/contacts", {
    method: "POST",
    headers: { "content-type": "application/json", "api-key": process.env.BREVO_API_KEY },
    body: JSON.stringify({
      email: d.email,
      attributes: { PRENOM: d.prenom, NOM: d.nom },
      listIds: [liste],
      updateEnabled: true,
    }),
  });
  if (!rep.ok) console.error("Brevo contact", rep.status, await rep.text());
}

// ---------- Gabarits d'emails ----------

function cadreEmail(contenu) {
  return `<div style="background:#eef0f4;padding:24px 0;font-family:Georgia,'Times New Roman',serif">
  <div style="max-width:620px;margin:0 auto;background:#fff">
    <div style="background:#0b1f3a;padding:28px 32px;color:#c9a24a;font-size:22px;letter-spacing:.06em">L'Agence Rivoli</div>
    <div style="padding:32px;color:#1B2740;font-size:16px;line-height:1.6">${contenu}</div>
    <div style="padding:20px 32px;border-top:1px solid #e3e6ec;color:#5b6475;font-size:13px">
      L'Agence Rivoli — 75 rue de France, 06000 Nice — ${TEL_AGENCE}<br>
      <span style="font-size:11px;line-height:1.5">AR.CAM.GE IMMOBILIER, SAS au capital de 30 000 €, RCS Nice 798 374 161.
      Carte professionnelle Transaction n° 06052015000002443 délivrée par la CCI Nice Côte d'Azur.
      RC professionnelle QBE n° QRCAI000680.</span>
    </div>
  </div></div>`;
}

function emailClient(d, s) {
  const liste = (arr) => (arr || []).map((x) => `<li style="margin-bottom:6px">${echapperHtml(x)}</li>`).join("");
  const titre = (t) => `<p style="font-family:Georgia,serif;font-size:18px;color:#0b1f3a;margin:28px 0 8px">${t}</p>`;
  const case3 = (libelle, valeur, m2, accent) => `
    <td width="33%" style="padding:14px 8px;text-align:center;vertical-align:top;${accent ? "background:#0b1f3a;color:#fff" : "background:#f5f6f8;color:#0b1f3a"}">
      <div style="font-size:13px;${accent ? "color:#c9a24a" : "color:#5b6475"}">${libelle}</div>
      <div style="font-size:${accent ? 24 : 19}px;margin:6px 0 4px">${euros(valeur)}</div>
      ${m2 ? `<div style="font-size:13px;${accent ? "color:#d9dde5" : "color:#5b6475"}">${euros(m2)} / m²</div>` : ""}
    </td>`;
  return cadreEmail(`
    <p>Bonjour ${echapperHtml(d.prenom)},</p>
    <p>Merci pour votre demande. Voici l'estimation de votre ${echapperHtml(d.type.toLowerCase())}
    de ${echapperHtml(d.surface)} m² situé ${echapperHtml(d.adresse)}, ${echapperHtml(d.commune)}${s.secteur ? ` (secteur ${echapperHtml(s.secteur)})` : ""}.
    Elle repose sur les ventes réellement signées dans votre rue et votre quartier, et sur les caractéristiques que vous nous avez décrites.</p>

    <table width="100%" cellspacing="6" cellpadding="0" style="margin:24px 0 8px;border-collapse:separate">
      <tr>
        ${case3("Prix bas", s.valeur_basse, s.prix_m2_bas, false)}
        ${case3("Prix médian", s.valeur_centrale, s.prix_m2_median, true)}
        ${case3("Prix haut", s.valeur_haute, s.prix_m2_haut, false)}
      </tr>
    </table>
    <p style="font-size:14px;color:#5b6475;margin-top:0">Le prix médian correspond à la valeur la plus probable de votre bien sur le marché actuel.</p>

    ${s.explication ? `${titre("Comment nous avons établi cette valeur")}<p>${echapperHtml(s.explication)}</p>` : ""}
    ${s.ajustements?.length ? `${titre("Ce qui distingue votre bien")}
      <table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:4px 0 8px">
        ${s.ajustements.map((a) => `<tr><td style="padding:10px 0;border-bottom:1px solid #e3e6ec">${echapperHtml(a)}</td></tr>`).join("")}
      </table>
      <p style="font-size:13px;color:#5b6475">Ordres de grandeur, appliqués aux prix constatés dans votre secteur.</p>` : ""}
    ${s.marche_local ? `${titre("Le marché de votre secteur")}<p>${echapperHtml(s.marche_local)}</p>` : ""}
    ${s.ventes_reference?.length ? `${titre("Ventes récentes de référence")}<ul style="padding-left:20px">${liste(s.ventes_reference)}</ul>
      <p style="font-size:13px;color:#5b6475">Source : base DVF des ventes immobilières publiée par l'administration fiscale.</p>` : ""}
    ${s.points_forts?.length ? `${titre("Ce qui valorise votre bien")}<ul style="padding-left:20px">${liste(s.points_forts)}</ul>` : ""}
    ${s.points_attention?.length ? `${titre("Ce qui peut peser sur le prix")}<ul style="padding-left:20px">${liste(s.points_attention)}</ul>` : ""}
    ${s.informations_a_verifier?.length ? `${titre("Ce qu'une visite permettrait de préciser")}<ul style="padding-left:20px">${liste(s.informations_a_verifier)}</ul>` : ""}

    <div style="border-left:3px solid #c9a24a;padding:4px 0 4px 16px;margin:28px 0">
      <p style="margin:0">Pour transformer cette estimation en avis de valeur précis et gratuit, je vous propose une visite de votre bien.
      Répondez simplement à cet email ou appelez-moi au <a href="tel:+33601007116" style="color:#0b1f3a">${TEL_AGENCE}</a>.</p>
    </div>

    <p style="font-size:13px;color:#5b6475">Estimation indicative établie sans visite. Elle ne remplace pas un avis de valeur :
    seule une visite permet de tenir compte de la luminosité, de la vue réelle, de la qualité des prestations et de l'état de la copropriété.</p>
    <p>${SIGNATURE}</p>`);
}

function emailAgence(d, resultat, envoyeAuClient) {
  const s = resultat.synthese;
  const statut = envoyeAuClient
    ? "L'estimation synthétique a été envoyée automatiquement au propriétaire."
    : "L'estimation n'a PAS été envoyée au propriétaire : à relire puis transmettre.";
  return cadreEmail(`
    <p><strong>Nouvelle demande d'estimation en ligne</strong></p>
    <p>${statut}</p>
    <p><strong>Contact :</strong> ${echapperHtml(d.prenom)} ${echapperHtml(d.nom)} — ${echapperHtml(d.email)} — ${echapperHtml(d.telephone)}<br>
    <strong>Projet :</strong> ${echapperHtml(d.projet || "non précisé")}</p>
    ${s ? `<p><strong>Envoyé au propriétaire :</strong> bas ${euros(s.valeur_basse)} — médian ${euros(s.valeur_centrale)} — haut ${euros(s.valeur_haute)} (écart ${Math.round((s.valeur_haute - s.valeur_basse) / s.valeur_centrale * 100)} %) — confiance ${s.niveau_confiance}/100</p>` : "<p><strong>Synthèse illisible</strong> : voir le rapport ci-dessous.</p>"}
    <p><strong>Données saisies</strong></p>
    <pre style="white-space:pre-wrap;font-size:13px;background:#f5f6f8;padding:12px">${echapperHtml(formaterDonnees(d))}</pre>
    <hr style="border:none;border-top:1px solid #c9a24a;margin:24px 0">
    ${markdownVersHtml(resultat.rapport)}
    <hr style="border:none;border-top:1px solid #c9a24a;margin:24px 0">
    <p><strong>Ventes DVF transmises à l'estimateur</strong> (pour vérification)</p>
    <pre style="white-space:pre-wrap;font-size:12px;background:#f5f6f8;padding:12px">${echapperHtml(resultat.dvf || "")}</pre>`);
}

// ---------- Point d'entrée ----------

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return;

  let brut;
  try { brut = JSON.parse(event.body || "{}"); } catch { return; }

  // Champ piège invisible : rempli uniquement par les robots.
  if (brut.site_web) return;

  const d = {};
  for (const champ of ["type", "adresse", "code_postal", "commune", "surface", "pieces", "chambres", "etage",
    "etages_immeuble", "ascenseur", "exterieur", "surface_exterieur", "vue", "exposition", "parking", "cave",
    "etat", "epoque", "dpe", "charges", "taxe_fonciere", "projet", "prenom", "nom", "telephone"]) {
    d[champ] = nettoyer(brut[champ], champ === "adresse" ? LIMITES.moyen : LIMITES.court);
  }
  d.email = nettoyer(brut.email, LIMITES.court).toLowerCase();
  d.precisions = nettoyer(brut.precisions, LIMITES.long);

  const surface = Number(d.surface);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email) || !d.adresse || !d.commune || !(surface > 8 && surface < 2000) || !brut.consentement) {
    console.error("Demande rejetée : champs obligatoires invalides");
    return;
  }

  await ajouterContact(d).catch((e) => console.error(e));

  try {
    const dvf = await trouverComparables(d).catch((e) => {
      console.error("DVF :", e);
      return "Données DVF indisponibles pour cette demande.";
    });
    const resultat = await appelerClaude(d, dvf);
    resultat.dvf = dvf;
    const s = encadrerFourchette(resultat.synthese, Number(d.surface));
    const estimationExploitable = s && Number(s.valeur_centrale) > 0;
    const envoiAuto = process.env.ENVOI_AUTO_CLIENT === "true" && estimationExploitable;

    if (envoiAuto) {
      await envoyerEmail({
        a: d.email, nom: `${d.prenom} ${d.nom}`,
        sujet: "Votre estimation — L'Agence Rivoli",
        html: emailClient(d, s),
        repondreA: process.env.EMAIL_AGENCE,
      });
    }

    await envoyerEmail({
      a: process.env.EMAIL_AGENCE, nom: "L'Agence Rivoli",
      sujet: `Estimation en ligne — ${d.adresse}, ${d.commune}${s ? " — " + euros(s.valeur_centrale) : ""}`,
      html: emailAgence(d, resultat, envoiAuto),
      repondreA: d.email,
    });
  } catch (err) {
    console.error(err);
    // En cas d'échec, l'agence est quand même prévenue pour rappeler le prospect.
    await envoyerEmail({
      a: process.env.EMAIL_AGENCE, nom: "L'Agence Rivoli",
      sujet: `Estimation en ligne À TRAITER MANUELLEMENT — ${d.adresse}`,
      html: cadreEmail(`<p>L'estimation automatique a échoué (${echapperHtml(err.message).slice(0, 300)}).</p>
        <p>${echapperHtml(d.prenom)} ${echapperHtml(d.nom)} — ${echapperHtml(d.email)} — ${echapperHtml(d.telephone)}</p>
        <pre style="white-space:pre-wrap">${echapperHtml(formaterDonnees(d))}</pre>`),
      repondreA: d.email,
    }).catch((e) => console.error(e));
  }
};
