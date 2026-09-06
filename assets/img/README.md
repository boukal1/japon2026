# Photos de la page

La page charge en priorité les images de ce dossier (`<slug>.jpg`, listées dans `manifest.json`),
puis, pour celles qui manquent, l'image principale de l'article Wikipédia indiqué dans le HTML.

## Remplir le dossier en une commande (depuis une machine qui accède à Wikipédia)

```bash
node scripts/fetch-photos.mjs          # Node 18+, aucune dépendance
git add assets/img && git commit -m "Photos" && git push
```

Le script lit les `data-wiki="…"` du HTML, télécharge l'image libre de chaque article (1200 px),
écrit `manifest.json` (lu par la page) et `CREDITS.md` (auteur + licence de chaque fichier).

## Mettre ses propres photos

Déposer un fichier `<slug>.jpg` ici, puis relancer le script (il complète le manifest sans écraser).
Le slug est le titre Wikipédia en minuscules, sans accents, avec des tirets :
`Yufuin, Ōita` → `yufuin-oita.jpg`, `Dazaifu Tenman-gū` → `dazaifu-tenman-gu.jpg`, `The Bund` → `the-bund.jpg`.
