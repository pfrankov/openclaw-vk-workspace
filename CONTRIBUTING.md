# Разработка и выпуск

## Проверки

```bash
npm ci --ignore-scripts
npm run check
npm run install:host
npm run check:host
```

`npm run check` запускает тесты, сборку и проверку npm-архива. `check:host` загружает упакованный плагин с закреплённым настоящим SDK OpenClaw. Пользовательские action/result-контракты находятся в [SCENARIOS.md](SCENARIOS.md).

HTTP-контракт сверяется с [OpenAPI subset](https://github.com/pfrankov/n8n-nodes-vk-teams/blob/master/docs/vk-teams-bot-api.openapi.yaml) и [официальным Python SDK](https://github.com/mail-ru-im/bot-python). Дополнительно: [VK Teams Bot API](https://teams.vk.com/botapi/?lang=ru) и [SDK каналов OpenClaw](https://docs.openclaw.ai/plugins/sdk-channel-plugins).

## Выпуск

Синхронно обновите версию `X.Y.Z` в `package.json`, `package-lock.json`, `openclaw.plugin.json` и CHANGELOG. После успешного CI на `main` создайте совпадающий аннотированный тег:

```bash
git tag -a vX.Y.Z -m "@openclaw-vk/vk-workspace X.Y.Z"
git push origin vX.Y.Z
```

Release workflow повторяет проверки, публикует пакет в npm через OIDC Trusted Publishing и создаёт GitHub Release из CHANGELOG. Существующие версии и релизы не перезаписываются.
