# S1 gate commands (frozen by worker)

All commands run from `/home/damian-linux/workspace/billioner-coder/apps/pi-hermes-gateway-s1`.

| id | command |
| --- | --- |
| G1 | `bash docs/evidence/s1/run-g1.sh` |
| G2 | `bash docs/evidence/s1/run-g2.sh` |
| G3 | `npm test` |
| G4 | `node packages/gateway/test/g4-pack-import.mjs` |
| G5 | covered by `npm test` (flock/socket + unauthorized-route + no IPC route creation) |
| G6 | `bash docs/evidence/s1/run-g6.sh` |
| G7 | recorded after local commit in worker-summary / g7-receipt |
