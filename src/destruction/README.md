# MUDQUAKE – modul destrukce (Agent B)

Aktualizace po integračním zadání: oba moduly nyní běží ve společné aplikaci z kořenového `index.html`. Aktuální spuštění, ovládání, výsledky prohlížeče a omezení popisuje kořenový `README.md`. Níže zůstává popis veřejného modulového rozhraní; prohlížečové reporty jsou v `verification/`.

Veškeré soubory tohoto modulu jsou v `src/destruction/`. Runtime modulu nevytváří aplikaci, renderer, kameru, terén ani hlavní smyčku. Obsahuje destrukci, izolovanou ověřovací scénu bez rendereru v `tests/fixture.ts` a integrační headless test obou modulů.

## Zmrazené rozhraní a závislosti

Uživatel schválil tuto hranici dne 17. 11. 2026:

- Three.js **0.187.0**, Rapier `@dimforge/rapier3d-compat` **0.19.3**. Původní Three.js 0.182.0 byl následně s výslovným souhlasem uživatele sjednocen na verzi 0.187.0 používanou prostředím A.
- `groundDisplacement`: `readonly { x: number; y: number; z: number }`, metry.
- `createDestruction(scene, world, options)` vrací instanci. Dostupné jsou i požadované stejnojmenné exporty modulu pro jednu aktivní instanci.
- Integrace vlastní scénu, renderer, kameru, fyzikální svět, časovou osu, pevný krok **1/60 s** a kolidery terénu.
- Přesné typy: `contracts.ts`. Lokální `EarthquakeState` je strukturálně kompatibilní s typem sdílené aplikace; modul nevyžaduje změnu společného kontraktu.
- Měřítko: metry, Y nahoru, XZ zem, střed domu `(0,0,0)`. `baseElevation` posune stavbu svisle. Transformaci `root` ani jeho rodiče neměnit: fyzika používá světové souřadnice.

Runtime balíčky musí ve společné Vite aplikaci existovat **v jediné kopii**, zejména Rapier/WASM. Root npm workspace a Vite `resolve.dedupe` nyní sjednocují runtime závislosti. Instalujte pomocí `npm ci` v kořenovém adresáři; modulové testy lze spustit `npm test -w @mudquake/destruction`.

## Co je implementováno

- Procedurální venkovský dům: přibližně 10 × 8 × 7 m, základová deska, prkenná podlaha, dělený strop s trámy, sloupky a obvodové nosníky, otevřené krovy, 16 střešních sekcí se 768 zakřivenými překládanými taškami, okenní rámy, zasklení, dveře, komín a lokálně obnažené cihly.
- Souvislé nepravidelné Voronoi díly cihlového zdiva. Celá fasáda se dělí před vyříznutím oken; nevznikají pravidelné pásy podél každého parapetu. Okna a krovy mají složené kolidery místo plných neviditelných bloků.
- Asymetrický kolaps začíná u jednoho oslabeného rohu. Seed určuje roh, prostorově související slabá místa, únavu jednotlivých spojů a různou prodlevu selhání. Ztráta podpor a skutečné nárazy šíří poruchy dál. Všechny nosné cesty se nejdřív vyhodnotí a až potom se uvolní tělesa, takže pořadí ID nemůže v jediném kroku shodit celou pravidelnou řadu. Zbývající podpora střechy brání jejímu předčasnému odletu.
- PBR materiály s procedurálním fallbackem pro samostatné testy. Společná aplikace používá lokálně přibalené fotografické 1K mapy z Poly Haven (CC0); geometrii domu stále generuje kód.
- Orientovaný graf podpor a sousedních spojů: únava při bočním zatížení, oslabení při ztrátě podpor, viditelné trhliny, přenos poškození od skutečných nárazů. Slabší strana spodních sloupů zavádí asymetrické porušení.
- Po selhání přechod k dynamickému tělesu Rapier, hustoty materiálů, tření, nízká restituce, CCD. Stropní a střešní díly a trámy mohou krátce viset na kulovém spoji, než spoj povolí.
- 376 konstrukčních těles pro výchozí seed; počet právě dynamických těles závisí na průběhu poruch a terénu. Cihlové jádro má samostatnou 6mm omítku s menšími nepravidelnými povrchovými díly (rozteč přibližně 34 cm). Ty se odlupují podle poškození bez přidávání fyzikálních těles; část omítky zůstává na troskách. Odkryté líce a lomové hrany zobrazují cihlový materiál. Kosmetická geometrie má vlastní deterministický generátor.
- Drobné světlé, ploché odštěpky omítky se odlišují od tmavších úlomků cihel. Celkem sdílejí instancovaný pool 1400 částic. Prach má 320 billboardů s TSL opacity uzlem, životností 3.2–5.4 s, expanzí a větrem. Limit 54 nových oblaků/s s rezervou 36 chrání již rostoucí oblaky před neustálým přepisováním při kaskádě nárazů. Padající části emitují stopy prachu.
- 8 sdílených meshů s GPU paletou transformací pro neprůhledné materiály, `BatchedMesh` pro sklo a 2 instance efektů. **11 objektů není tvrzení o 11 skutečných GPU draw calls**. Aktuální skutečný počet měří report společného rendereru; původní multi-draw emulace s mnoha voláními byla nahrazena.
- Web Audio: filtrované dunění řízené intenzitou, prostorové zvuky praskání, rozbití skla, selhání a nárazů, omezení 24 současných hlasů, kompresor. Storm ambience zůstává modulu A.
- Úplný reset vlastních těles, koliderů, spojů, transformací, poškození, poolů a zvuků; idempotentní disposal vlastních prostředků.

## Zapojení do jedné společné aplikace

Rapier musí být před vytvořením světa inicializovaný integrační vrstvou. Nastavení světa, včetně solveru, musí být pro deterministické běhy shodné. Aplikace i současné modulové testy používají gravitaci `(0,-9.81,0)`, 6 iterací solveru a `world.integrationParameters.contact_natural_frequency = 10`. Příliš tuhá korekce počátečních průniků jinak může do uvolněných sekcí vnášet nereálnou energii.

```ts
import { createDestruction, sampleEarthquake, FIXED_DELTA_TIME } from './destruction';

// scene, world, renderer a environment jsou již existující objekty společné aplikace.
const destruction = createDestruction(scene, world, {
  seed: 0x4d554451,
  sampleGroundHeight: (x, z) => environment.getTerrainHeightAt(x, z),
  onEvent(event) {
    if (event.type === 'earthquake-request') integrationTimeline.start();
    if (event.type === 'impact' && Math.abs(event.position.y - environment.getTerrainHeightAt(event.position.x, event.position.z)) < 0.28) {
      environment.notifyDebrisImpact(event.position, event.energy * 35, 0.2 + event.energy * 0.6);
    }
    // crack, failure, glass, impact mohou spustit reakce bahna/deště nebo UI.
    // Událost je neměnný snapshot a lze si ji bezpečně uložit.
  },
});

// Z EXISTUJÍCÍHO handleru tlačítka, přímo v uživatelském gestu:
void destruction.unlockAudio();
destruction.triggerEarthquake();

// Uvnitř EXISTUJÍCÍHO fixed-step callbacku integrátoru:
const state = sampleEarthquake(integrationTimeline.elapsedTime, eventSeed);
destruction.updateDestruction(FIXED_DELTA_TIME, state); // před fyzikou
world.step();                                        // právě jednou
destruction.syncVisuals();                            // po fyzice

// Před renderem v EXISTUJÍCÍ smyčce:
destruction.setListenerPosition(camera.position);
// Volitelně interpolationAlpha ze společného akumulátoru:
destruction.syncVisuals(interpolationAlpha);

// Při teardownu, před world.free():
destruction.disposeDestruction();
```

`sampleEarthquake()` je čistá referenční funkce bez hodin nebo smyčky. Zahrnuje klid 0–3 s, tremor 3–6 s, silné otřesy 6–9 s, hlavní porušení 9–12 s, progresivní kolaps 12–17 s a dozvuk 17–25 s. Intenzita i posun jsou spojité přes hranice fází. Integrace může dodat vlastní průběh stejného typu.

`triggerEarthquake()` pouze emituje `earthquake-request`, při opakovaném volání do resetu je idempotentní. Nepřepíná fázi ani nepočítá vlastní čas. Integrace musí při neaktivní události předávat nulovou intenzitu a posun a při spuštění začít čas od nuly. Opětovné spuštění vyžaduje reset.

`syncVisuals()` po každém fyzikálním kroku sbírá kontakty a aktualizuje polohy; další volání se stejným krokem pouze interpolují. Není potřeba sdílenou `EventQueue` předávat nebo vyprazdňovat. Vynechání `syncVisuals()` před dalším fyzikálním krokem vyvolá chybu. Pohyb držených částí a desky sleduje `groundDisplacement`; uvolněné trosky zdědí rychlost povrchu a dále na ně působí gravitace a kontakty. Nemají umělé rozletové impulzy ani průběžné síly ve vzduchu. Podmilimetrový dozvuk pod intenzitou 0.01 ve fázi aftermath přepne zbývající držené části na pevné, aby trvale nebudily hromadu suti.

## Kolize a události pro Agent A

- Připravená rovná plocha pod základy má horní úroveň `baseElevation`. Půdorys základové desky je 10.4 × 8.4 m, spodní plocha je o 0.04 m níže. Střešní přesah dosahuje přibližně 10.4 × 9 m.
- **Modul nevytváří terénní kolider.** Agent A / integrátor dodá skutečný Rapier heightfield, trimesh nebo jiné vhodné kolidery okolí. Dům i trosky patří do dodaného světa a mohou kolidovat s terénem i hráčem.
- `collisionGeometry`: veřejný seznam `{ componentId, kind, body, collider }`. Složené části mají více záznamů se stejným ID. `body.userData` obsahuje `module`, `componentId`, `kind`.
- Po `resetDestruction()` je potřeba **znovu získat `collisionGeometry`**; předchozí Rapier handly jsou neplatné. Reset odstraňuje jen tělesa tohoto modulu a nesahá na terén, hráče ani nastavení světa.
- `onEvent`: `earthquake-request`, `crack`, `glass`, `failure`, `impact`, `reset`; čas v sekundách, neměnná světová pozice, ID, druh, normalizovaná energie a deterministický seed. Agent A může pro nárazy emitovat bahno, stříkance a reakce kaluží.
- Pozice `impact` je skutečný kontaktní bod solveru, nikoli střed padajícího dílu. `energy` je normalizovaná vizuální/zvuková síla; není to impulz v N·s. Pro přesné fyzikální impulzy může integrátor použít zveřejněné kolidery a vlastní Rapier kontaktní události. Doporučené propojení prostředí A: `sampleGroundHeight: environment.getTerrainHeightAt`; při nárazu v blízkosti povrchu `environment.notifyDebrisImpact(event.position, event.energy * 35, 0.2 + event.energy * 0.6)` (škálování pro vizuální efekt).
- `sampleGroundHeight(x,z)` používají **jen kosmetické fragmenty**. Dodání sampleru nenahrazuje Rapier kolidery. Sampler by neměl během kolapsu vytvářet objekty.
- Zvuk se odemkne až gestem uživatele; dodaný `audioContext` modul nikdy nezavírá. Pozici kamery předávejte přes `setListenerPosition()`; modul nepřepisuje globální listener sdíleného audio kontextu.

## Reset a přesný replay

Rychlý reset ve stejném světě: `destruction.resetDestruction()` a reset společné časové osy / události. Dům i všechny vlastní efekty se obnoví. Interní broadphase, pořadí ostrovů a stav okolních dynamických těles v Rapier zůstávají vlastnictvím integrátoru, proto **rychlý reset sám o sobě nezaručuje identické fyzikální trajektorie**.

Přesný replay celé simulace: integrátor nejprve odstraní modul, obnoví nebo znovu vytvoří svůj svět se stejnými kolidery ve stejném pořadí, vytvoří destrukci se stejným seedem, obnoví čas i prostředí a znovu použije stejnou posloupnost vstupů po 1/60 s. To odpovídá vlastnictví světa ve společném kontraktu. Test dvou takto identicky inicializovaných světů porovnává všechny události a výsledné polohy **přesně**, nikoli jen přibližně. Reset celého světa nelze provést uvnitř modulu B bez zásahu do prostředí A.

## Ověření a měření

```powershell
# Z kořenové složky repozitáře MudQuake:
npm ci
npm run check -w @mudquake/destruction
npm test -w @mudquake/destruction
npm run test:integration -w @mudquake/destruction
npm run benchmark -w @mudquake/destruction
```

`tests/fixture.ts` vytváří pouze headless testovací scénu a fyzikální podlahu. Nevytváří druhou prohlížečovou aplikaci. Testy ověřují generování a počet těles, nosný graf bez cyklů, celistvost lomené plochy, kolizní otvory, klid před otřesy, progresivní kolaps, události, dopad střechy, konečné rychlosti trosek, reset, přesný replay v obnoveném světě a disposal bez odstranění terénu.

Názvy `*.node-test.ts` oddělují testy `node:test` od kořenových testů Vitest pro prostředí, aby oba runneri omylem nesbírali cizí sady.

Volitelné `test:integration` používá skutečný modul A v jedné společné headless scéně a ověřuje celý 25sekundový kolaps proti výškovému kolideru vzorkovanému z jeho terénu, předávání nárazů do jeho bahenních efektů a reset bez smazání terénu. Výsledek zapisuje do `tests/integration-results.json`. Nevytváří renderer ani konkurenční prohlížečovou aplikaci a nepředstavuje vizuální/GPU ověření.

Stroj pro zdejší CPU měření: Windows, Node 22.21.0, AMD Ryzen 5 5600G. Po jednom zahřívacím běhu následují tři 25sekundové sekvence, celkem 4500 měřených kroků. Stroj hlásí RTX 3080; pro tento headless test GPU nebylo použito. Detailní výsledek a rozdělení podle fází je v `tests/benchmark-results.json`. Toto měření zahrnuje update, `world.step()` a synchronizaci vizuálních transformací; **nezahrnuje renderer, shader compilation, prostředí, prohlížeč ani prezentaci snímků**.

Historický CPU report před dokončením společné aplikace naměřil průměr 2.01 ms a p95 4.84 ms; nepopisuje nynější renderovací cestu ani celý prohlížeč. Aktuální skript CPU report přepíše po novém měření. Pro výkon celé aplikace je rozhodující `verification/browser-results.json`, který zaznamenává pevné rozlišení, skutečný adaptér, FPS, CPU a GPU dotazy.

Pro následný test společné aplikace lze připojit exportovaný `BrowserFrameBenchmark` k jejímu existujícímu začátku/konce snímku. Třída sama nic neplánuje ani nerenderuje. Po zahřátí shaderů ověřte skutečný drawing buffer 2560 × 1440, nikoli jen CSS rozměry, a profilujte celou sekvenci i nejdražší část 9–17 s v Chrome/Edge na cílovém RTX 4090. `report(canvas)` uvádí skutečnou kadenci snímků a CPU/submit latenci; čas GPU vyžaduje GPU tracing. Přerušení, minimalizaci a skrytou kartu z měření vyřaďte resetem sondy.

## Známá omezení a neověřené části

- Oba moduly jsou propojené v jedné aplikaci a WebGPU shadery byly spuštěné v Edge na hardwarovém adaptéru RTX 3080. Aktuální celé běhy jsou zaznamenané v `verification/`. Cíl na RTX 4090 nebyl přímo měřený a samotný fotorealismus není potvrzený metrikou FPS.
- Three.js byl s výslovným souhlasem uživatele sjednocen na 0.187.0 podle prostředí A. Na následné integrační zadání vznikla společná aplikace, pohyb terénních koliderů, chůze, ovládání, fotografie materiálů, reset a benchmark. Veřejný `EarthquakeState` a základní modulové signatury se nezměnily.
- Jde o řízený model destrukce pro real-time vizualizaci, nikoliv FEM ani statický posudek. Neporušené části jsou kinematické; skutečná dynamika začíná jejich selháním. Poškození je fenomenologická kombinace zatížení, únavy, podpor a nárazů, kalibrovaná na dramatickou sekvenci.
- Velké kusy mají skutečné vzájemné kolize. Drobné fragmenty jsou kosmetické balistické částice s výškovým samplerem země, bez kolizí s domem a hráčem; vyžaduje to rozpočet těles. Jednotlivé tašky se fyzikálně pohybují v sekcích, drobné odštěpky je doprovázejí.
- Při rozbití zasklení se odstraní kolizní tabule a objeví se úlomky. Průhlednost, řazení prachu a skla a vzhled kosmetických střepů je nutné doladit pod skutečným světlem a mlhou Agent A. Prach je billboardový, nikoli objemový.
- Hromada suti může mít mnoho těles stále vedených solverem jako awake i při prakticky nulovém pohybu. Test usazení proto měří rychlosti, nikoliv jen příznak spánku. Hustá hromada je nejdražší část CPU fyziky.
- Striktní fyzikální replay vyžaduje obnovu celého světa integrátorem, jak je popsáno výše. Změna seedů, pořadí koliderů, vstupů, solveru nebo verze Rapier mění výsledek.
- Kompatibilní Rapier 0.19.3 při `init()` vypisuje upozornění z interního WASM loaderu o zastaralých inicializačních parametrech; jeho veřejný typ přijímá `init()` bez parametrů. Testy fungují; upozornění nebylo skrýváno ani řešeno změnou schválené verze.
