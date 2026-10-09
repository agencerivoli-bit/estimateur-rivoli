# Estimateur en ligne — L'Agence Rivoli

## Comment ça marche

1. Le propriétaire remplit le formulaire (`index.html`).
2. La demande est enregistrée dans Netlify Forms (sauvegarde du contact), puis transmise à la fonction `estimation-background`.
3. La fonction ajoute le contact dans Brevo, localise le bien (géocodage et parcelle cadastrale via les services publics de l'IGN), puis extrait de la base DVF les ventes réellement signées dans la même rue, la même section cadastrale et la même commune.
4. Ces ventes sont transmises à Claude avec votre prompt d'expert. La recherche web ne sert plus qu'à compléter (tendance récente, annonces en cours).
5. Vous recevez par email le rapport complet (méthodes, comparables, prix de mise en vente, confiance).
6. Le propriétaire reçoit une version synthétique (fourchette, prix au m², points forts, points d'attention) — automatiquement ou après votre relecture, selon `ENVOI_AUTO_CLIENT`.

Le traitement prend en général une à trois minutes. La page affiche tout de suite une confirmation, l'estimation arrive ensuite par email.

## Contenu du dossier

```
index.html                                   la page du formulaire
netlify.toml                                 configuration Netlify
netlify/functions/estimation-background/
    estimation-background.js                 la logique (Claude + Brevo)
    prompt.js                                votre prompt d'expert (modifiable)
    comparables.js                           recherche des ventes DVF comparables
    dvf06.json                               ventes DVF des Alpes-Maritimes (2022 à fin 2025)
outils/preparer-dvf.py                       script de mise à jour de la base DVF
```

## La base DVF

`dvf06.json` contient environ 78 500 ventes d'un seul logement (appartement ou maison) dans les Alpes-Maritimes, de janvier 2022 à décembre 2025, issues des fichiers que vous avez fournis. Ont été écartées : les ventes de plusieurs logements en un seul acte, celles comprenant un local commercial, et les prix au m² aberrants (moins de 1 000 € ou plus de 60 000 €). Les ventes en VEFA (neuf) sont conservées mais exclues des comparables.

Pour chaque estimation, le rapport que vous recevez se termine par la liste exacte des ventes DVF transmises à Claude, pour que vous puissiez vérifier ses comparables.

Mise à jour : la DGFiP publie un nouveau fichier chaque semestre sur data.gouv.fr. Téléchargez-le puis lancez, depuis le dossier du projet :

```
python3 outils/preparer-dvf.py ValeursFoncieres-2023.txt ValeursFoncieres-2024.txt ValeursFoncieres-2025.txt ValeursFoncieres-2026.txt
```

Gardez trois à quatre ans d'historique. Pour couvrir aussi le Var, ajoutez "83" dans DEPARTEMENTS en tête du script.

## Mise en place

### 1. Clé API Anthropic
Créez un compte sur console.anthropic.com, ajoutez un moyen de paiement et générez une clé API. C'est une facturation à l'usage, distincte de votre abonnement Claude. Fixez une limite de dépense mensuelle dans la console.

### 2. Brevo
- Clé API : Brevo > SMTP & API > Clés API.
- Expéditeur : utilisez de préférence une adresse sur votre domaine (ex. florian.colonna@lagencerivoli.fr) avec le domaine authentifié dans Brevo. Une adresse @gmail.com comme expéditeur est souvent classée en indésirable.
- Liste : l'identifiant de la liste où ajouter les prospects (ex. 3 pour « CONTACT APIMO »), ou une liste dédiée « Estimations en ligne ». Si vos attributs de contact ne s'appellent pas PRENOM et NOM, adaptez-les dans `ajouterContact`.

### 3. Netlify
Déployez le dossier (glisser-déposer ou dépôt Git), puis dans Site configuration > Environment variables :

| Variable | Valeur |
|---|---|
| ANTHROPIC_API_KEY | votre clé Anthropic |
| BREVO_API_KEY | votre clé Brevo |
| EMAIL_EXPEDITEUR | adresse d'envoi validée dans Brevo |
| EMAIL_AGENCE | adresse qui reçoit les rapports complets |
| ENVOI_AUTO_CLIENT | `false` pour relire avant envoi (recommandé au début), `true` pour un envoi automatique |
| BREVO_LIST_ID | facultatif, ex. `3` |
| ANTHROPIC_MODEL | facultatif, défaut `claude-sonnet-5-5` |

Redéployez après avoir ajouté les variables.

Important : les fonctions « background » (traitement long en arrière-plan) peuvent nécessiter un forfait Netlify payant. Vérifiez sur votre compte. Sans elles, l'estimation dépasserait le délai maximal d'une fonction classique.

### 4. Tester
Remplissez le formulaire avec un bien que vous connaissez bien et comparez avec votre propre estimation. En cas de souci : Netlify > Logs > Functions > estimation-background.

## Modifier l'outil
- Méthode d'estimation : `prompt.js`, partie `PROMPT_EXPERT`.
- Textes de l'email au propriétaire : fonction `emailClient`.
- Champs du formulaire : `index.html` (et la liste des champs dans `formaterDonnees` et dans le point d'entrée).

## Mentions
Le formulaire indique au propriétaire que l'estimation est préparée avec un outil d'intelligence artificielle et qu'elle ne remplace pas un avis de valeur. Pensez à compléter votre politique de confidentialité (données transmises à Anthropic et Brevo pour le traitement).
