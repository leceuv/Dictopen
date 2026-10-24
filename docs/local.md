# Moteur de transcription local

Dictopen embarque `whisper-server` de [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (licence MIT) et le lance sur `127.0.0.1` avec un port libre. Les modèles (format GGML quantifié) sont téléchargés depuis `huggingface.co/ggerganov/whisper.cpp` dans le dossier de données de l'application (`models/`).

## Binaires fournis
- `bin/darwin-arm64/whisper-server` : compilé depuis whisper.cpp v1.8.3 en statique avec Metal embarqué :
  `cmake -B build -DBUILD_SHARED_LIBS=OFF -DGGML_METAL_EMBED_LIBRARY=ON -DWHISPER_BUILD_TESTS=OFF -DCMAKE_BUILD_TYPE=Release && cmake --build build --target whisper-server -j`
- `bin/win32-x64/` : `whisper-server.exe` et ses DLL (ggml, whisper, OpenBLAS) issus de l'archive `whisper-blas-bin-x64.zip` de la release b5454.
- Mac Intel : non fourni (compiler avec `-DCMAKE_OSX_ARCHITECTURES=x86_64`, sans Metal, et le déposer dans `bin/darwin-x64/`).

## Fonctionnement
L'audio capté (PCM 16 bits, 24 kHz) est rééchantillonné en 16 kHz, encapsulé en WAV et envoyé à `POST /inference` (`response_format=json`, `no_timestamps=true`, `prompt` = contexte + mots-clés, langue = première langue des réglages). Le serveur est lancé avec une recherche en faisceau de 5 (`-bs 5`), qui améliore nettement les noms de médicaments et termes rares. Il reste chargé entre les énoncés ; il est arrêté à la fermeture de l'application ou au changement de modèle.

## Ordres de grandeur (MacBook Air M2, 8 Go)
- Chargement du modèle Recommandé : ≈ 8 s au premier lancement.
- Énoncé de 8 s : ≈ 1,4 s de transcription (Recommandé), ≈ 0,6 s (Léger).
