# G-Portal Game Data API request

The configured REST API responds successfully for `/v1/api/info`, `/v1/api/players`, `/v1/api/metrics` and `/v1/api/settings`, but `/v1/api/game-data` returns HTTP 404.

Please send this exact request to G-Portal support:

> Can you add the Palworld dedicated-server startup argument `-enable-gamedata-api` to my server?

Server details:

- Server name: `vieraguti`
- REST API port: `29117`
- Palworld version reported by REST: `v1.0.4.102642`

Please confirm whether this startup argument is supported on the current G-Portal Palworld plan. `RESTAPIEnabled=true` and `RESTAPIPort=29117` are already configured, but `/v1/api/game-data` returns 404 until the launch argument is active.