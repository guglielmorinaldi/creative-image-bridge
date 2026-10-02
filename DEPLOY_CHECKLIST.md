# Deploy checklist

1. Create an OpenAI API key in your OpenAI developer account.
2. Set `OPENAI_API_KEY` on the hosting service.
3. Generate a separate random `BRIDGE_API_KEY` and set it on the hosting service.
4. Deploy the Docker image on a public HTTPS URL.
5. Confirm `https://YOUR-DOMAIN/health` returns `{ "ok": true }`.
6. Open `https://YOUR-DOMAIN/`, enter your bridge key, upload one test reference and generate one image.
7. In Claude, add `https://YOUR-DOMAIN/mcp` as a Custom Connector.
8. Select `No sign in` and add request header `x-bridge-key` with your bridge key.
9. Enable the connector and ask Claude to call `bridge_status`.
10. Add `CLAUDE_PROJECT_ADDENDUM.md` to the campaign project instructions.
