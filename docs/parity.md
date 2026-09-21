# Parity inventory (S0 record; S1 implements scheduled static text to the fake adapter)

Full approved parity gates **S5 / M4**, not this slice. MVP (M1) is durable owner-only **static text delivery**, outbound-only, with later companion status/enqueue/job tools. This is not full pi-telegram parity. Existing plugins are not removed or called obsolete.

| Feature | Target owners | MVP | Later |
| --- | --- | --- | --- |
| Static text send | adapter + core outbox | M1 | |
| Message identity / receipts (`accepted`, optional `confirmed`) | adapter + core | M1 accepted | stronger receipts when provider evidence exists |
| Scheduled once-at UTC / daily local IANA | core scheduler | M1 (S1 fake adapter) | general cron deferred |
| Streaming edits, Markdown/HTML | adapter + Telegram renderer | no | S5 |
| Files/images/albums | adapter + authorized attachment service | no | S5 |
| Buttons/menus/callbacks | adapter primitives + companion registry | no | M3/M4 |
| Threads, reply ownership, leader/follower | core leases + companion | no | M3/M4 |
| Activity/status/tool-progress | companion events + adapter render | no | S5 |
| Voice in/out | optional explicit STT/TTS providers | no | S5 |
| Generative Apps / custom plugin registrations | explicit bridge | no | S5 |
| Approvals/permission prompts | explicit challenge mapping | no | M3/M4 |
| Inbound execution | refuse-by-default + pairing | no | M3 |
| Isolated model report jobs | gateway worker | no | M2 |
| WhatsApp send | adapter-whatsapp | M1b send-only injected send | live socket / inbound later |
| Existing-account cutover | migration procedure | no | M5 |

Capability negotiation is explicit and additive within a protocol major. Unsupported results must be visible. No silent truncation or auto-chunking of oversized text in M1.
