# SpeechMike : boutons et LED par WebHID

Interface HID vendeur Philips : page d'utilisation `0xFFA0`, rapport d'entrée et rapport de sortie de 9 octets (identifiant de rapport 0).

## Boutons (rapport d'entrée)
Identifiant = `int8[7]-int8[8]-int8[0]` (SpeechMike), voir `renderer/speechmike.js` pour les tables SpeechMike, PowerMic 4 et RecMic.

## LED (rapport de sortie)
Octet 0 = `0x02`, octets 1 à 5 = 0, puis 2 bits par (LED, couleur) dans les octets 6 à 8 : `0` éteinte, `1`/`2` clignotante, `3` fixe.

| Octet | Bits | LED (SpeechMike II, 0911:149a) |
|---|---|---|
| 6 | 0-1 | grande LED, vert |
| 6 | 2-3 | grande LED, rouge (`0x0C` = rouge fixe) |
| 6 | 4-5 | bas gauche, vert |
| 7 | 4-5 | bas droite, vert |
| 8 | 4-5 | rangée du bas, milieu |
| 8 | 6-7 | rangée du bas |

Réglage dans l'application : `settings.led.on` / `settings.led.off` (liste de `{ reportId, data }`), envoyés au début et à la fin de l'enregistrement. D'autres modèles peuvent utiliser une autre correspondance : adaptez les trames dans le fichier de réglages.
