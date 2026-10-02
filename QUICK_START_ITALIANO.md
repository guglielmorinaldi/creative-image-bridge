# Avvio rapido — Creative Image Bridge

## Cosa devi avere

- una chiave API OpenAI con accesso ai modelli GPT Image;
- Node.js 22+ **oppure** Docker;
- per Claude web: un URL HTTPS pubblico dove ospitare il bridge.

## Test locale in 5 passaggi

1. Duplica `.env.example` e chiamalo `.env`.
2. Inserisci `OPENAI_API_KEY`.
3. Inserisci una password lunga in `BRIDGE_API_KEY`.
4. Esegui `npm install` e poi `npm start`.
5. Apri `http://localhost:8787`, inserisci la Bridge Key, carica una reference e prova la generazione.

## Collegamento a Claude

Il server locale non basta per claude.ai: devi renderlo raggiungibile via HTTPS pubblico.

Una volta pubblicato:

- URL connector: `https://TUO-DOMINIO/mcp`
- Authentication: `No sign in`
- Request header: `x-bridge-key`
- Valore header: il tuo `BRIDGE_API_KEY`

Poi abilita il connector nella chat e scrivi:

`Usa Creative Image Bridge: esegui bridge_status e poi list_assets.`

## Workflow consigliato per le campagne

1. Carica nel dashboard prodotti, loghi e reference.
2. Claude usa `list_assets` / `get_asset` per recuperarli.
3. Claude crea sfondi e scene con `generate_ad_visual`.
4. Se una reference deve guidare la nuova immagine, usa `edit_image` con Sunburst.
5. Se logo/prodotto deve rimanere identico, usa `compose_exact` invece di farlo ridisegnare all'AI.
6. Per formati diversi usa generazione dedicata quando cambia la composizione; usa `make_format_variant` solo per adattamenti deterministici appropriati.
7. Per piccoli batch usa `generate_campaign_batch`.

## Uso da ChatGPT

Il pacchetto include `openapi.yaml` e REST API proprio per rendere il bridge utilizzabile anche da piattaforme che accettano integrazioni OpenAPI/HTTP. Questa chat non può collegare automaticamente un server MCP arbitrario appena creato: prima il server deve essere pubblicato e poi aggiunto come integrazione/plugin compatibile nel tuo ambiente ChatGPT. Fino a quel momento, qui posso comunque generare immagini direttamente con gli strumenti immagini nativi della conversazione.
