"""
Prépare la base de ventes DVF utilisée par l'estimateur.

Usage :
    python3 outils/preparer-dvf.py ValeursFoncieres-2023.txt ValeursFoncieres-2024.txt ...

Les fichiers se téléchargent sur data.gouv.fr (jeu « Demandes de valeurs foncières »).
Le résultat remplace netlify/functions/estimation-background/dvf06.json.
Pour ajouter d'autres départements, complétez DEPARTEMENTS (ex. {"06", "83"}).
"""
import sys, json, os
from collections import defaultdict

DEPARTEMENTS = {"06"}
SORTIE = os.path.join(os.path.dirname(__file__), "..", "netlify", "functions", "estimation-background", "dvf06.json")

def num(s):
    try: return float(s.strip().replace(",", "."))
    except ValueError: return None

mutations = defaultdict(list)
for chemin in sys.argv[1:]:
    with open(chemin, encoding="utf-8", errors="replace") as f:
        next(f)
        for ligne in f:
            c = ligne.rstrip("\n").split("|")
            if len(c) < 43 or c[18] not in DEPARTEMENTS: continue
            if c[9] not in ("Vente", "Vente en l'état futur d'achèvement"): continue
            mutations[(c[8], c[10], c[18], c[19], c[7], c[9])].append(c)

ventes = []
for lignes in mutations.values():
    prix = num(lignes[0][10])
    if not prix: continue
    logements, dependance, autre, terrain, parcelles = {}, False, False, 0, set()
    for c in lignes:
        t = c[36]
        if t in ("Appartement", "Maison"): logements[(t, c[38], c[39], c[11], c[15], c[37])] = c
        elif t == "Dépendance": dependance = True
        elif t: autre = True
        p = c[20] + c[21] + c[22]
        if p not in parcelles:
            parcelles.add(p); terrain += num(c[42]) or 0
    # On ne garde que les ventes d'un seul logement, sans local commercial
    if autre or len(logements) != 1: continue
    c = next(iter(logements.values()))
    surface = num(c[38])
    if not surface or surface < 9: continue
    if not 1000 <= prix / surface <= 60000: continue
    lots = [num(c[i]) for i in (25, 27, 29, 31, 33) if num(c[i])]
    j, m, a = c[8].split("/")
    ventes.append([
        f"{a}-{m}-{j}", round(prix), "A" if c[36] == "Appartement" else "M", round(surface),
        int(num(c[39]) or 0), c[11].strip(), (c[13] + " " + c[15]).strip(), c[16].strip().zfill(5),
        c[19].zfill(3), c[17], (c[20] + c[21]).strip(), 1 if dependance else 0,
        round(lots[0], 1) if len(lots) == 1 else 0, 1 if c[9].startswith("Vente en") else 0,
        round(terrain) if c[36] == "Maison" else 0,
    ])

ventes.sort(key=lambda v: v[0])
donnees = {
    "champs": ["date", "prix", "type", "surface", "pieces", "numero", "voie", "cp", "code_commune",
               "commune", "section", "dependance", "carrez", "vefa", "terrain"],
    "periode": f"{ventes[0][0]} au {ventes[-1][0]}",
    "ventes": ventes,
}
with open(SORTIE, "w", encoding="utf-8") as f:
    json.dump(donnees, f, ensure_ascii=False, separators=(",", ":"))
print(f"{len(ventes)} ventes enregistrées ({donnees['periode']}) dans {os.path.abspath(SORTIE)}")
