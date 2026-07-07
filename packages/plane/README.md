# @dexwox-labs/paperclip-plugin-plane

Bidirectional [Plane](https://plane.so) CE sync for [Paperclip](https://github.com/paperclipai/paperclip).

- Webhook intake with HMAC verification (`X-Plane-Signature`), idempotent against Plane CE duplicate deliveries
- Agent tools: `plane_get_work_item`, `plane_search_work_items`, `plane_create_work_item`, `plane_add_comment`, `plane_update_state`
- Outbound mirror: Paperclip status/comments → Plane, with echo-loop guard
- Reconciliation job healing missed webhooks (Plane CE bugs makeplane/plane#4097, #6848)

Design blueprint credit: [@oldharlem/paperclip-plugin-linear](https://github.com/Oldharlem/paperclip-linear-plugin).
