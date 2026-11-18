# Proč je Abyssal Garden plynulý a co z toho používá MUDQUAKE

Referenční zdroj: [Noniv/abyssal-garden](https://github.com/Noniv/abyssal-garden). Kontrolovaný byl přímo zdrojový kód, nikoli pouze velikost distribuovaného HTML. Uváděných přibližně 180 FPS při 1440p na RTX 5070 Ti je výsledek autora v README, nikoli naše měření nebo srovnání na stejném hardwaru.

| Oblast | Abyssal Garden podle zdroje | MUDQUAKE |
|---|---|---|
| Stíny | Mapa stínů se předpočítá při startu | Intaktní scéna se uloží do mapy jednou; za pohybu se aktualizuje po fyzikálním kroku |
| Pohyb objektů | Velká část animací je rovnice ve vertex shaderu | Déšť a vítr běží na GPU; velké padající kusy mají skutečné kontakty Rapier |
| Geometrie | Sdílené buffery, instancing, prostorové buňky a vzdálenostní LOD | Sdílený buffer po materiálech, GPU paleta transformací, instancované fragmenty |
| Rozlišení | Automatická adaptace pixelů a poté vzdáleného detailu | Výchozí Auto podle okna a GPU; zvlášť pevné 1440p pro srovnatelné měření |
| CPU práce | Předpočítané prostředí a lokální kolize kamery | 250+ dynamických částí během vrcholu kolapsu, úlohy solveru 60× za sekundu |
| Efekty | Specializované WGSL, část efektů v polovičním rozlišení | TSL/WGSL, stínování kontaktů v polovičním rozlišení, omezené pooly |

Podklady: [main.js – jednorázové výpočty, buffery, LOD, adaptace](https://github.com/Noniv/abyssal-garden/blob/main/source/src/main.js), [shaders.js – animace a osvětlení](https://github.com/Noniv/abyssal-garden/blob/main/source/src/shaders.js), [quality.js – úrovně detailu](https://github.com/Noniv/abyssal-garden/blob/main/source/src/quality.js), [dev.js – benchmark s pevným rozlišením](https://github.com/Noniv/abyssal-garden/blob/main/source/src/dev.js).

Důležitá praktická oprava: pevné 2560 × 1440 i v malém okně je zbytečné supersamplingové zatížení. Auto u MUDQUAKE zohledňuje velikost okna a skutečné GPU dotazy. V režimu 1440p se rozlišení během testu nesnižuje a každý report obsahuje skutečné rozměry.

U MUDQUAKE se po sloučení neprůhledné geometrie snížilo maximum GPU draw calls ze zaznamenaných 841 na přibližně 62. Neznamená to čtrnáctinásobné FPS: hlavní zbývající CPU zátěž je fyzika a zobrazovací kadenci může omezovat VSync. Renderer nemá vlastní limit 60 FPS; pouze fyzikální krok je pevně 1/60 s.

Aktuální celé běhy a jejich podmínky jsou v `verification/browser-results.json`. Nelze přepočítávat milisekundy GPU přímo na skutečná FPS ani porovnávat adaptivně snížené rozlišení s pevným 1440p.
