# scripts

Operational scripts: load-test harness (Phase 2), seed data, and the RAG eval
runner (Phase 3). Empty in Phase 0.

Handy Phase 0 smoke checks once the dev stack is deployed:

```bash
# HTTP health check (grab HttpUrl from the cdk deploy outputs)
curl "$HTTP_URL/health"

# WebSocket connect check (grab WebSocketUrl from the outputs; needs wscat:
#   npm i -g wscat)
wscat -c "$WEBSOCKET_URL"
```
