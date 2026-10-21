# The Things Network pour Gladys

Cette intégration amène dans Gladys les dernières valeurs décodées des
capteurs LoRaWAN d'une application **The Things Network** (édition
communautaire de The Things Stack) ou **The Things Stack Cloud** :
température, humidité, pression, luminosité, CO2, particules fines, humidité
du sol, vent, UV, distance, batterie, fuite d'eau et mouvement.

Elle lit l'**API Storage officielle** de The Things Stack, en **lecture
seule** : rien n'est jamais envoyé à vos appareils (pas de message
descendant), rien n'est modifié dans la console.

> Connecteur **non officiel**, sans lien avec The Things Industries.
> L'intégration n'a **jamais été testée avec un vrai compte** The Things
> Network pour l'instant : vos retours sont les bienvenus.

## 1. Activer l'intégration Storage (indispensable)

Sans elle, The Things Stack ne garde aucun message et l'intégration ne voit
rien.

1. Ouvrez la console (par exemple https://eu1.cloud.thethings.network/console)
   et votre application.
2. Menu **Integrations > Storage Integration**.
3. Cliquez sur **Activate Storage Integration**.

Seuls les messages reçus **après** l'activation sont gardés, pour une durée
limitée qui dépend de votre offre (voir la documentation de The Things
Stack).

## 2. Un décodeur pour chaque appareil

L'intégration lit la charge **décodée** (`decoded_payload`). Chaque appareil
(ou l'application) doit avoir un décodeur (**Payload formatters > Uplink**) :
celui du catalogue d'appareils (Device Repository), Cayenne LPP, ou le vôtre.

## 3. Créer une clé API

1. Dans l'application : **API keys > Add API key**.
2. Donnez-lui seulement le droit **Read application traffic (uplink and
   downlink)**.
3. Copiez la clé (elle commence par `NNSXS.`) : elle ne sera plus affichée.

## 4. Configurer l'intégration dans Gladys

- **Cluster** : celui de votre application, visible dans l'adresse de la
  console (`eu1` pour l'Europe). Pour un tenant The Things Stack Cloud ou
  votre propre serveur, choisissez **Autre serveur** et saisissez son nom
  d'hôte (HTTPS seulement, par exemple
  `montenant.eu1.cloud.thethings.industries`).
- **ID de l'application** : tel qu'affiché dans la console.
- **Clé API** : gardée par Gladys dans sa base, jamais réaffichée ; envoyée
  seulement au serveur choisi, dans un en-tête (jamais dans une adresse), et
  jamais écrite dans les journaux.
- **Intervalle de lecture** : 5 minutes par défaut (2 à 60). Une seule
  requête par lecture, pour tous les appareils de l'application.

Puis cliquez sur **Tester l'application** : le bouton affiche les dernières
valeurs de chaque appareil, les champs ignorés et l'heure de la prochaine
lecture possible. Les appareils apparaissent dans l'onglet **Découverte** dès
leur premier message reçu.

## Les valeurs reconnues

Un décodeur peut nommer ses champs comme il veut. L'intégration ne crée une
fonction dans Gladys que si elle sait **ce que mesure** le champ **et dans
quelle unité**, et seulement avec les unités que Gladys connaît. Les valeurs
hors bornes sont écartées (jamais ramenées dans les bornes). Les autres champs
sont ignorés (le bouton de test les liste).

| Mesure              | Noms de champs reconnus (majuscules, `_` et numéro de canal Cayenne ignorés)                                         | Unité dans Gladys                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Température         | `temperature`, `temp`, `TempC`, `TempC_SHT`, `TempC_DS`, `air_temperature`, `soil_temperature`, `water_temperature`… | °C (-50 à 125)                       |
| Humidité            | `humidity`, `hum`, `Hum_SHT`, `relative_humidity`, `air_humidity`, `rh`                                              | %                                    |
| Pression            | `pressure`, `barometric_pressure`, `barometer`, `air_pressure`                                                       | hPa (une valeur en Pa est convertie) |
| Luminosité          | `illuminance`, `luminosity`, `lux`, `light`, `light_intensity`, `ILL_lx`                                             | lux                                  |
| CO2                 | `co2`, `co2_ppm`, `carbon_dioxide`                                                                                   | ppm                                  |
| Particules          | `pm25`, `pm2_5`, `pm10`                                                                                              | µg/m³                                |
| Batterie            | `battery_level`, `battery_percent`, `battery` ou `bat` (nombre entier seulement)                                     | %                                    |
| Tension de batterie | `BatV`, `battery_voltage`, `vbat` ; en mV : `battery_mv`, `bat_mv`                                                   | V                                    |
| Distance            | `distance_mm`, `distance_cm`, `distance_m` (une distance sans unité est ignorée)                                     | mm, cm, m                            |
| Humidité du sol     | `soil_moisture`, `moisture`, `water_soil`, `vwc`                                                                     | %                                    |
| Vent                | `wind_speed` (m/s), `wind_speed_kmh`                                                                                 | m/s, km/h                            |
| UV                  | `uv`, `uv_index`                                                                                                     | indice UV                            |
| Fuite d'eau         | `leak`, `water_leak`, `leakage` (vrai/faux ou 0/1)                                                                   | détectée ou non                      |
| Mouvement           | `motion`, `occupancy`, `pir` (vrai/faux ou 0/1)                                                                      | détecté ou non                       |

Les capteurs **SenseCAP** (Seeed) sont lus par leurs types (`Air
Temperature`, `Air Humidity`, `Light Intensity`, `Barometric Pressure`, `UV
Index`, `Wind Speed`…) et leur batterie. Un décodeur peut aussi déclarer
l'unité de ses champs avec `_sensor_attr`, comme dans Home Assistant :
`{"_sensor_attr": {"distance": {"unit": "cm", "device_class": "distance"}}}`.

Le type et l'unité d'un champ sont choisis à sa première lecture, puis ne
changent plus. Une fonction déjà créée n'est jamais retirée de l'appareil.

## Fonctionnement

- Chaque message est publié **une seule fois**, daté de sa réception par The
  Things Stack (une valeur relue n'ajoute rien à l'historique). Au tout
  premier démarrage, seuls les messages des 3 dernières heures sont publiés.
- Un appareil est identifié par son **DevEUI** (ou, sans DevEUI, par l'ID de
  l'application et celui de l'appareil) : un appareil supprimé puis recréé
  avec un autre DevEUI sous le même ID devient un nouvel appareil.
- Au plus 100 appareils, 24 valeurs par appareil et 1000 messages par
  lecture (au-delà, le statut conseille de réduire l'intervalle).
- Gladys accepte 300 états par minute : les états partent par lots, dans ce
  budget ; le surplus attend la minute suivante.

## Erreurs et pauses

- **Clé refusée** (401), **droit manquant** (403) ou **application
  introuvable / intégration Storage non activée** (404) : les lectures
  s'arrêtent, un nouvel essai toutes les 6 heures, ou tout de suite si vous
  changez la configuration. Le statut dit pourquoi.
- **Serveur occupé** (429 ou 5xx) : pause (Retry-After, sinon 5 minutes
  doublées à chaque fois, de 1 minute à 6 heures).
- Rien ne lit plus vite que l'intervalle : ni le bouton de test, ni une
  reconnexion, ni un redémarrage. L'heure de la dernière requête, les pauses
  et les refus sont gardés dans `/data` (jamais la clé ; seulement, tant
  qu'une clé est refusée, une empreinte salée de cette clé refusée, effacée
  au premier succès).

## Limites

- Lecture seule : pas de message descendant, pas de commande.
- Les positions GPS ne sont pas reprises (Gladys n'a pas de fonction de
  position pour un capteur).
- Les champs sans unité connue (ex. `analog_in`, `Work_mode`) sont ignorés.

## Crédits

La logique de l'API Storage et des décodeurs (par défaut et SenseCAP) est
portée de [ttn_client](https://github.com/angelnu/thethingsnetwork_python_client)
(MIT, Angel Nunez Mencias), la bibliothèque de l'intégration The Things
Network de Home Assistant. The Things Network et The Things Stack sont des
marques de leur propriétaire.
