Offline lettergravering
======================

Plaats hier het bestand Roboto-Black.ttf voor lettergravering zonder internet.

Download (rechtermuisknop → Opslaan als):
  https://cdn.jsdelivr.net/gh/opentypejs/opentype.js@master/test/fonts/Roboto-Black.ttf

Sla het bestand op als: Roboto-Black.ttf (in deze map).

Als je Node.js hebt geïnstalleerd kun je ook het script uitvoeren:
  node scripts/fetch-font-base64.js
Daarmee wordt een font-base64.js bestand gegenereerd dat je in de map van de app plaatst.
Voeg in index.html vóór main.js een regel toe:
  <script src="font-base64.js"></script>
Dan werkt lettergravering volledig offline, ook bij openen via file://.
