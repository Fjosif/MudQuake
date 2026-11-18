# MUDQUAKE

Jedna desktopová prohlížečová aplikace: deštivá bahnitá krajina, průchozí scéna, procedurální venkovský dům a řízený fyzikální kolaps. TypeScript + Vite, Three.js **0.187.0 / WebGPU**, Rapier **0.19.3**, Web Audio. Prostředí i destrukce běží v jedné scéně a jediné smyčce.

## Spuštění

```powershell
git clone https://github.com/Fjosif/MudQuake.git
cd MudQuake
npm ci
npm run dev
```

Otevřete `http://127.0.0.1:5173/` v Chrome nebo Edge s funkčním WebGPU. Produkční verze:

```powershell
npm run build
npm exec vite preview -- --host 127.0.0.1 --port 4173
```

Pak `http://127.0.0.1:4173/`. Není potřeba žádná služba ani externí účet. Materiály jsou přibalené lokálně. Root `npm ci` spravuje i workspace destrukce, aby runtime nenačetl dvě oddělené kopie Rapier/WASM.

`npm run open` otevře běžící produkční preview v samostatném okně Edge a ponechá jej pro interaktivní ovládání. Automatický benchmark se tím nespouští.

## Ovládání

- **Procházet scénu** nebo kliknutí do obrazu: myš pro rozhlížení, **WASD** pro chůzi, **Shift** rychleji, **Esc** uvolní myš.
- Rozhlížení funguje i **tažením myši**; **Q/E** zatáčí klávesnicí. Kamera má kapslový kolider, respektuje dům a trosky a může celou stavbu obejít.
- **Mezerník** spustí 25sekundové zemětřesení. **R** obnoví dům, prostředí, fyziku, efekty i kameru. **P** pozastaví / obnoví simulaci.
- Zvuk se zapíná tlačítkem; bez gesta prohlížeč zvuk nespouští. Tlačítko celé obrazovky a úrovně detailu jsou v dolní liště.
- Výchozí **Auto · 60 FPS** respektuje velikost okna, omezuje zbytečné supersamplingové rozlišení a podle skutečných GPU dotazů může upravovat počet pixelů. Volba **1440p** drží přesně **2560 × 1440** bez adaptace. HUD vždy ukazuje skutečný drawing buffer.

## Jak je aplikace propojená

- `src/main.ts`: jediný renderer, scéna, kamera, RAF smyčka, pevný akumulátor 1/60 s, společný stav, ovládání a reset.
- `src/app/world.ts`: integrační vrstva vlastní svět Rapier, terénní kolidery, kolizní skupiny a propojení nárazů s bahenními efekty.
- `src/environment/`: původní modul A; krajina, déšť, voda, mlha a světla.
- `src/destruction/`: modul B; model domu, poškození, dynamické části, drobné úlomky, prach a zvukové události. Veřejné signatury a `EarthquakeState` zůstaly kompatibilní.
- `src/materials/photoLibrary.ts`: lokální 1K fotografické PBR mapy a HDR obloha z Poly Haven. Původ, licence CC0, odkazy a kontrolní součty: `public/textures/CREDITS.md` a `manifest.json`.
- `src/app/cinematic.ts`: stínování kontaktů GTAO v polovičním rozlišení. Nízký detail jej vynechává.

Při pevném kroku se nejprve aktualizuje destrukce a hráč, potom fyzika, potom vizuální transformace a prostředí. Render interpoluje polohy; fyzika nezávisí na obnovovací frekvenci obrazovky. Scéna se na skryté kartě nepřeskakuje dopředu.

Reset vytváří nový svět se stejným pořadím těles, seedem a nastavením solveru. Také začátek události obnoví fyzikální výchozí stav a zachová zvolenou pozici pozorovatele. Tím libovolně dlouhá procházka před spuštěním nezmění kontaktní historii následného replaye. Identické vstupy a pozice pozorovatele mají stejnou posloupnost poruch.

## Kolaps a oprava vystřelování střechy

Porušení postupuje nosným grafem. Střešní sekce se neuvolní, dokud nepovolí jejich nosné vazníky. Krátký rotační spoj je umístěný u skutečné podpory, nikoli ve středu sekce. Kolider střechy tvoří tenká vrstva tašek a jednotlivé krokve s mezerou u hřebene; není to plný blok vzduchu pod střechou.

Odstraněny jsou umělé rozletové impulzy a průběžné síly na vzduchem letící trosky. Otřesy působí pohybem základů a fyzikálního terénu. Korekce kontaktů má frekvenci **10 Hz** při 6 iteracích solveru: původní tuhá korekce průniků zaváděla do uvolněných částí nežádoucí energii. Kontakty se nevypínají a rychlosti nejsou uměle ořezávané. Test omezuje vzestup středů střešních sekcí i jejich rychlost vzhůru ve výšce; běžné odrazy při sekundárních nárazech u země zůstávají fyzikální.

Motor hráče má samostatný pevný dotazovací povrch, protože na kinematickém heightfieldu se může zasekávat. Kolizní skupiny zajišťují, že tento povrch neovlivňuje trosky; jejich jediný terénní kontakt je s pohybujícím se heightfieldem. Vnitřní hrany terénu jsou opravené příznakem `FIX_INTERNAL_EDGES`.

## Výkon a ověření

```powershell
npm run typecheck
npm test
npm test -w @mudquake/destruction
npm run build
# v jiném terminálu běží produkční preview na portu 4173
npm run verify:browser
```

`verify:browser` spustí skutečný Edge s WebGPU, vynutí pevný drawing buffer 2560 × 1440 a vysoký detail, ověří klávesnicovou chůzi, myš, zvukové přepínání, pauzu, dva celé kolapsy, kontakty s terénem, úplný reset a přesnou shodu událostí poruch. Výsledky: `verification/browser-results.json`, jednotlivé běhy `run-1.json` a `run-2.json`.

`--headed` zobrazí automatizovaný test v okně, `--screenshots` pořídí snímky praskání a kolapsu (přidá zátěž v prvním měřeném běhu), `--keep-open` ponechá po úspěšném testu okno otevřené. Pro čisté měření používejte výchozí příkaz bez snímků a nespouštějte souběžně další náročné úlohy. Headless režim je uvedený ve výsledku; stále používá skutečný hardwarový WebGPU adaptér a pevné rozlišení, nikoli softwarový renderer.

Měří se intervaly skutečného zahájení callbacků přes `performance.now()`, CPU čas včetně fyziky a odeslání renderu a GPU timestamp dotazy renderovacích průchodů. Nepoužívají se pouze plánované vsync časové značky RAF. Jde o prohlížečovou kadenci callbacků, nikoli hardwarovou telemetrii skutečně prezentovaných snímků monitoru. Report zaznamenává rozlišení, detail, skutečný adaptér, seed, chyby a přerušení. Změna rozlišení, pauza nebo skrytí karty zneplatní běh. Místní hardware je **RTX 3080 + Ryzen 5 5600G**, proto výsledky nepředstavují měření RTX 4090.

Optimalizace: společné buffery a paleta transformací v TSL pro všechny neprůhledné části domu, instancované částice, jednorázově uložený stín nepohyblivé scény, aktualizace stínu až po fyzikálním kroku, omezené počty těles a 1K textury. Maximum draw calls v ověřeném prohlížeči kleslo z 841 na přibližně 62 včetně postprocessingu. V porovnání s Abyssal Garden rozlišujeme statické předpočítané prostředí a skutečnou kontaktní fyziku; rozbor je v `docs/performance.md`.

Poslední čisté měření po úpravě vody, přerušovaných stop kol a nepravidelných louží (18. 11. 2026): **dva celé 25sekundové běhy**, Edge 157 v headless režimu se skutečnou RTX 3080, vysoký detail, **pevné 2560 × 1440**, bez screenshotů v měřené části. Oba běhy: průměr **60.00 FPS**, p95 intervalu **16.80 ms**. Nejhorší intervaly byly **19.10 / 17.20 ms**, žádný interval nebyl nad 20 ms (1501 vzorků/běh). Průměrný GPU čas renderovacích průchodů **3.60 / 3.64 ms**, průměrný CPU čas snímku **6.64 / 6.53 ms**. Maximum draw calls bylo 61. Nejde o tvrzení o 180 FPS ani o měření RTX 4090. Oba běhy prošly resetem, kontrolou pádu střechy a přesnou shodou událostí poruch; browser hlásil nula chyb.

Zdivo a omítka jsou oddělené: těžší nepravidelné cihlové kusy mají fyzikální kolize, tenké povrchové díly omítky se postupně odlupují a emitují ploché světlé úlomky a prach. Menší dělení omítky nezvyšuje počet rigidních těles. Výchozí dům má 376 konstrukčních těles a efekty mají pevné pooly. Okna se vyřezávají až po lomení celé fasády, takže nevznikají pravidelné dlouhé pásy. Odstraněné velké průhledné plochy deště už neprotínají terén; vzdálený zákal zajišťuje mlha.

Kolaps začíná v jednom rohu a šíří se podle ztráty podpor, místních slabin a fyzikálních nárazů. Seed určuje oslabený roh i prostorově související nepravidelnosti a prodlevy jednotlivých spojů. Vyhodnocení poruch a jejich provedení probíhá odděleně, takže pořadí ID nemůže shodit celý pás zdiva v jediném kroku. Modulový test ověřuje lokalizaci prvních poruch, odstup poruch protější fasády i postupné uvolňování střechy. Snímky a diagnostiku lze obnovit příkazem `node scripts/diagnose-stripe.mjs --collapse`.

Voda a terén: mělké přerušované stopy kol se plní jen lokálně; louže tvoří samostatné nepravidelné prohlubně místo dvou souvislých zaplavených pruhů a celé sítě zatopených struh. Periodický profil pneumatik je odstraněný. TSL normály bahna i vodního filmu se správně převádějí do prostoru kamery, včetně čiré povrchové vrstvy. Místo silných pravidelných seizmických vln používá hladina jemný nepravidelný pohyb a krátké lokální kroužky po dopadech kapek. Vzdálené detaily postupně mizí, aby neblikaly. `node scripts/verify-water.mjs` pořídí kontrolní snímky v klidu, při otřesech, po kolapsu a při chůzi; nejde o výkonový benchmark.

## Praktická omezení

Jde o real-time vizualizaci destrukce, ne stavební FEM výpočet. Neporušené části jsou kinematické. Tašky padají v sekcích; malé odštěpky jsou kosmetické a nemají kolize s hráčem nebo domem. Prach používá billboardy. Kalné odrazy ukazují okolní HDR oblohu, nikoli přesné zrcadlení dynamického domu. Déšť má zatím omezené zakrytí střechou. Samotný fotorealismus není číselně ověřený výsledek. Přesný replay vyžaduje stejné verze, vstupy, solver a obnovu celého světa, kterou tato aplikace provádí.
