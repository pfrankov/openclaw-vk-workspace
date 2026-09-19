# OpenClaw — VK Workspace

Канал [OpenClaw](https://github.com/openclaw/openclaw) для корпоративных **VK Workspaces / VK Teams**. Он получает сообщения через long polling, поэтому публичный webhook и входящий порт не нужны.

Это не интеграция социальной сети «ВКонтакте». Для неё используйте [openclaw-vk](https://github.com/pfrankov/openclaw-vk).

Поддерживаются личные и групповые чаты, несколько ботов, pairing и allowlist, упоминания, ответы с цитатой в группах, Markdown, кнопки, выбор модели через `/models`, редактирование сообщений бота, файлы, изображения, стикеры и голосовые сообщения. Очередь входящих событий сохраняется на диск и переживает перезапуск Gateway.

## Требования

- OpenClaw `>=2026.9.3 <2027`; проверки выполняются на baseline `2026.9.3`;
- Node.js `24.16–24.x` или `26.1+` — тот же диапазон, что у OpenClaw 2026.9.3;
- URL Bot API и токен бота VK Teams.

Gateway, агент, модель и её credentials должны быть настроены в OpenClaw заранее: канал их не создаёт. Node.js 25 не поддерживается. У пакета нет runtime-зависимостей, кроме OpenClaw.

## Быстрый старт

1. Установите и включите плагин:

   ```bash
   openclaw plugins install @openclaw-vk/vk-workspace
   openclaw plugins enable vk-workspace
   ```

   Если OpenClaw требует capability consent или отменяет установку из-за отсутствия trust metadata, сначала проверьте источник пакета и запрошенные capabilities. Только после этого подтвердите установку:

   ```bash
   openclaw plugins install --force --accept-capabilities @openclaw-vk/vk-workspace
   openclaw plugins enable --accept-capabilities vk-workspace
   ```

2. Создайте бота в Metabot на вашем сервере VK Teams. Получите токен и уточните URL Bot API у администратора: адрес может отличаться от URL веб-клиента.

3. Добавьте канал в существующий `~/.openclaw/openclaw.json`:

   ```json
   {
     "plugins": {
       "allow": ["vk-workspace"],
       "entries": { "vk-workspace": { "enabled": true } }
     },
     "channels": {
       "vk-workspace": {
         "enabled": true,
         "baseUrl": "https://teams.example.com/bot/v1",
         "botToken": "YOUR_BOT_TOKEN",
         "dmPolicy": "pairing"
       }
     }
   }
   ```

   Не заменяйте примером весь конфиг. **`plugins.allow` — ограничивающий список, а не добавление одного разрешения.** При его создании перечислите все используемые плагины, включая встроенные провайдеры (например, `openai` для STT); при изменении сохраните существующие записи и добавьте `vk-workspace`. Иначе работавшие провайдеры могут отключиться; так же объедините `plugins.entries`, модели, агентов и каналы. `YOUR_BOT_TOKEN` — плейсхолдер, не настоящий токен.

4. Перезапустите Gateway и проверьте соединение:

   ```bash
   openclaw gateway restart
   openclaw channels status --probe
   ```

   Probe проверяет `/self/get`. Канал считается подключённым после успешного `/events/get`.

5. Напишите боту в личный чат. Он вернёт pairing-код. Одобрите его и отправьте сообщение повторно:

   ```bash
   openclaw pairing list vk-workspace
   openclaw pairing approve vk-workspace <code>
   ```

## Обновление

Публикация в npm не обновляет уже установленную копию автоматически:

```bash
openclaw plugins update vk-workspace
openclaw gateway restart
openclaw plugins inspect vk-workspace
openclaw plugins list
openclaw channels status --probe
```

Сверьте версию и путь загруженного плагина с ожидаемым релизом. Обновлённый пакет на диске ещё не означает, что работающий Gateway использует новый код: нужен успешный restart. После него отправьте обычный текст и голосовое и проверьте `openclaw logs --follow`; один успешный probe не проверяет скачивание CDN или STT.

Пакет публикуется как [`@openclaw-vk/vk-workspace`](https://www.npmjs.com/package/@openclaw-vk/vk-workspace) через npm Trusted Publishing с provenance и без постоянного `NPM_TOKEN`. История версий находится в [GitHub Releases](https://github.com/pfrankov/openclaw-vk-workspace/releases).

## Доступ к чатам

### Личные чаты

По умолчанию действует `dmPolicy: "pairing"`. До одобрения неизвестный пользователь не передаёт сообщения агенту.

- `pairing` — доступ после ручного одобрения;
- `allowlist` — только пользователи из `allowFrom`;
- `open` — все пользователи; не рекомендуется для агента с инструментами;
- `disabled` — личные чаты отключены.

Пример allowlist:

```json
{ "dmPolicy": "allowlist", "allowFrom": ["user@example.com"] }
```

Идентификаторы сохраняйте полностью, включая `@`, домен и другие символы. Если `session.dmScope` не задан, канал использует `per-account-channel-peer`, чтобы разные пользователи и боты не делили один личный диалог.

### Групповые чаты

В безопасной конфигурации нужно разрешить и чат, и отправителей:

```json
{
  "channels": {
    "vk-workspace": {
      "baseUrl": "https://teams.example.com/bot/v1",
      "tokenFile": "/absolute/path/to/vk-workspace.token",
      "groupPolicy": "allowlist",
      "groupAllowFrom": ["user@example.com"],
      "groups": {
        "123456@chat.agent": { "requireMention": true }
      }
    }
  }
}
```

`groupAllowFrom` содержит пользователей, а ключ в `groups` — точный `payload.chat.chatId` Bot API. Личный pairing не разрешает доступ к группам.

По умолчанию бот отвечает на нативное упоминание, ответ на своё сообщение или mention pattern OpenClaw. Настройки конкретной группы (`allowFrom`, `requireMention`, `enabled`, `systemPrompt`) переопределяют общие; `groups["*"]` задаёт правило для всех групп. `groupPolicy: "disabled"` отключает группы, а `open` разрешает любые группы и участников, но не отменяет проверку управляющих команд OpenClaw.

В личном чате ответ приходит без цитаты. В группе он цитирует входящее сообщение; callback сохраняет привязку к сообщению с кнопкой.

### Несколько ботов

```json
{
  "channels": {
    "vk-workspace": {
      "defaultAccount": "office",
      "dmPolicy": "pairing",
      "accounts": {
        "office": {
          "baseUrl": "https://teams.example.com/bot/v1",
          "tokenFile": "/run/secrets/office.token"
        },
        "support": {
          "baseUrl": "https://support.example.com/proxy/bot/v1",
          "tokenFile": "/run/secrets/support.token"
        }
      }
    }
  }
}
```

Аккаунты наследуют общие политики и URL, но никогда не наследуют чужие токены. `VK_WORKSPACE_BOT_TOKEN` используется только неявным аккаунтом `default`. Для маршрутизации к агенту задайте стандартный binding OpenClaw с `channel: "vk-workspace"` и нужным `accountId`.

## Токен и URL API

Вместо `botToken` рекомендуется обычный файл с единственной строкой токена. Это фрагмент `channels.vk-workspace` или конкретного `accounts.<id>`:

```json
{
  "baseUrl": "https://teams.example.com/bot/v1",
  "tokenFile": "/absolute/path/to/vk-workspace.token"
}
```

Путь должен быть абсолютным; каталог и символическая ссылка запрещены. Максимальный размер — 64 КиБ. На Linux/macOS ограничьте доступ командой `chmod 600`. Нельзя одновременно задавать `botToken` и `tokenFile`.

`VK_WORKSPACE_BOT_TOKEN` используется только неявным аккаунтом `default`. `VK_WORKSPACE_BASE_URL` также применяется к явно описанному `accounts.default`, если у него нет собственного `baseUrl`. Переменные должны быть заданы у процесса Gateway, а не только в интерактивном терминале.

`baseUrl` принимает адрес сервера или полный endpoint `/bot/v1`; префикс reverse proxy сохраняется. URL с credentials, query или fragment отклоняются. По умолчанию требуется HTTPS. Для внутреннего CA используйте `NODE_EXTRA_CA_CERTS`; `allowInsecureHttp: true` явно разрешает незашифрованный HTTP и передачу токена открытым текстом.

## Основные настройки

Большинство параметров можно задавать на уровне `channels.vk-workspace` и внутри `accounts.<id>`. Поля `accounts` и `defaultAccount` существуют только на корневом уровне канала.

| Параметр | По умолчанию | Назначение |
|---|---:|---|
| `enabled` | `true` | Включает канал или отдельный аккаунт. |
| `name` | — | Отображаемое имя аккаунта. |
| `baseUrl` | встроенный fallback | URL сервера или endpoint `/bot/v1`; оператору следует задавать явно. |
| `botToken` / `tokenFile` | — | Один из двух способов передать токен. |
| `dmPolicy` | `pairing` | `pairing`, `allowlist`, `open` или `disabled`. |
| `allowFrom` | `[]` | Пользователи для личного allowlist. |
| `groupPolicy` | `allowlist` | `allowlist`, `open` или `disabled`. |
| `groupAllowFrom` | `[]` | Общий список разрешённых отправителей групп. |
| `groups` | `{}` | Настройки конкретных `chatId`; поддерживается ключ `*`. |
| `requireMention` | `true` | Требовать обращение к боту в группе. |
| `defaultTo` | — | Получатель по умолчанию для исходящих сообщений. |
| `textFormat` | `markdown` | `markdown` или точный `plain`. |
| `pollTime` | `30` | Long polling, 1–60 секунд. |
| `requestTimeoutMs` | `30000` | Тайм-аут обычного запроса, 1000–300000 мс. |
| `mediaMaxMb` | `20` | Лимит одного файла, 1–100 МБ. |
| `mediaAllowedOrigins` | `[]` | Дополнительные точные origin для входящих файлов. |
| `allowInsecureHttp` | `false` | Разрешить HTTP вместо HTTPS. |
| `defaultAccount` | — | Аккаунт по умолчанию при нескольких ботах; только корневой уровень. |
| `accounts` | — | Именованные аккаунты; только корневой уровень. |

Идентификатор аккаунта: до 64 строчных латинских букв, цифр, `_` и `-`; первый символ — буква или цифра.

## Форматирование, кнопки и медиа

### Текст

`textFormat: "markdown"` поддерживает жирный и курсивный текст, зачёркивание, HTTP(S)-ссылки, заголовки, inline-код и fenced code blocks. HTML экранируется; таблицы и неизвестные конструкции остаются текстом. Длинные ответы разбиваются без потери символов. Для буквальной передачи задайте `textFormat: "plain"`.

Для одного сообщения инструмент `message` может переопределить формат:

```json
{
  "action": "send",
  "channel": "vk-workspace",
  "target": "user@example.com",
  "message": "**Этот текст останется буквальным**",
  "vkTextFormat": "plain"
}
```

### Кнопки и выбор модели

Команда `/models` показывает нативные кнопки провайдеров и моделей с пагинацией; текущая модель отмечена галочкой.

Пример аргументов инструмента `message`:

```json
{
  "action": "send",
  "channel": "vk-workspace",
  "target": "user@example.com",
  "message": "Продолжить?",
  "vkButtons": [[
    { "text": "Да", "callbackData": "Продолжить", "style": "primary" },
    { "text": "Документация", "url": "https://teams.vk.com/botapi/" }
  ]]
}
```

У кнопки должно быть ровно одно действие: `url` или `callbackData`. Стили: `base`, `primary`, `attention`. Максимум — 10 рядов по 8 кнопок, 128 UTF-16 единиц в подписи и 256 UTF-8 байт в callback. Принятое нажатие погашает всё меню; срок действия — 24 часа.

Меню из входящего хода привязано к его отправителю. Меню, созданное без пользовательского контекста, доступно любому отправителю, который проходит политики доступа канала. Callback всегда привязан к боту, аккаунту, чату и сообщению. Управляющая команда из callback отдельно проходит авторизацию OpenClaw; доступ к чату не выдаёт этих прав. Кнопки не подтверждают привилегированные инструменты OpenClaw.

Для редактирования передайте `action: "edit"`, `messageId` ранее отправленного текстового сообщения и новый `message`. `vkButtons: []` удаляет кнопки; если поле отсутствует, существующие кнопки сохраняются. Чужие и неизвестные сообщения не редактируются. Плагин хранит до 1000 отправленных сообщений на аккаунт не дольше 7 дней.

### Файлы и голосовые

Для повторного использования файла без скачивания передайте `vkFileId`. `vkVoice: true` отправляет одно вложение AAC, OGG или M4A как нативное голосовое; `forceDocument: true` принудительно отправляет его обычным файлом. Плагин не транскодирует звук. В одном исходящем сообщении допускается до 10 источников вложений.

```json
{
  "action": "send",
  "channel": "vk-workspace",
  "target": "user@example.com",
  "vkFileId": "EXISTING_VOICE_FILE_ID",
  "vkVoice": true,
  "message": "Голосовой ответ"
}
```

Входящие voice распознаются перед передачей в STT OpenClaw: сигнатура содержимого имеет приоритет над audio MIME в metadata, расширением имени и HTTP `Content-Type`. Это исправляет и `application/octet-stream`, и ошибочный конкретный MIME. Поддерживаются контейнеры OGG/Opus, MP3, AAC/ADTS, M4A, WAV и WebM; расширение сохраняется даже у длинных имён. Это определение формата, не декодирование и не перекодирование звука. В группе с `requireMention: true` одиночное голосовое может пройти предварительную транскрипцию только для проверки произнесённого обращения к боту. Доступ отправителя проверяется до скачивания.

### Корпоративный OpenAI-compatible STT

Обычный chat provider с произвольным именем (например, `ai-gateway`) не становится media provider с `transcribeAudio`. Для совместимого `/v1/audio/transcriptions` используйте встроенный media provider `openai`, отдельную STT-модель и корпоративный `baseUrl`. Ниже **фрагмент для объединения** с существующим конфигом OpenClaw 2026.9.3, не замена моделей, агентов и плагинов:

```json
{
  "models": {
    "providers": {
      "openai": {
        "baseUrl": "https://ai.example.com/v1",
        "api": "openai-completions",
        "auth": "api-key",
        "apiKey": "YOUR_STT_API_KEY",
        "request": { "allowPrivateNetwork": true },
        "models": []
      }
    }
  },
  "tools": {
    "media": {
      "models": [{
        "type": "provider",
        "provider": "openai",
        "model": "YOUR_STT_MODEL",
        "capabilities": ["audio"],
        "baseUrl": "https://ai.example.com/v1"
      }],
      "audio": { "enabled": true, "preferredModel": "openai/YOUR_STT_MODEL" }
    }
  }
}
```

`YOUR_STT_API_KEY` и `YOUR_STT_MODEL` — плейсхолдеры. В production используйте поддерживаемые OpenClaw env/file-backed secrets; убедитесь, что они доступны именно сервису Gateway. Не затирайте уже настроенный `models.providers.openai`: его URL, credentials и request policy используются и другими обращениями к этому provider. Сохраните существующие модели и записи `tools.media.models`. Встроенный плагин `openai` должен быть включён и присутствовать в `plugins.allow`, если этот список задан.

`allowPrivateNetwork` нужен **только** для контролируемого endpoint, который резолвится в private/internal IP; для публичного сервера удалите `request`. Не отключайте SSRF или TLS глобально. Это отдельная настройка от `channels.vk-workspace.mediaAllowedOrigins`: первая разрешает запрос STT к доверенному провайдеру, вторая — скачивание файла с CDN. Успешный chat completion не подтверждает работоспособность STT.

Отказ STT, который OpenClaw обработал без исключения, сам по себе не делает событие failed. Без транскрипта одиночное голосовое в группе с обязательным упоминанием не обходит mention gate; следующее текстовое обращение продолжает обрабатываться. Реальная ошибка dispatch/delivery остаётся в очереди и требует решения оператора.

## Вложения и безопасность сети

Файл скачивается напрямую только с origin Bot API или из `mediaAllowedOrigins`:

```json
{ "mediaAllowedOrigins": ["https://files.example.com"] }
```

Origin из ответа `files/getInfo` может отличаться от Bot API (включая дополнительный CDN или redirect). Сверьте его с администратором и внесите каждый доверенный origin отдельно. Указывайте точный origin без пути, query и конечного `/`; каждый redirect проверяется заново. Добавление origin означает явное доверие этому серверу и для входящих файлов, и для исходящих URL. Остальные исходящие URL проходят SSRF-защиту OpenClaw, поэтому не добавляйте произвольные внутренние сервисы. Токен бота не отправляется файловому серверу, а подписанный URL не передаётся модели. Локальные исходящие файлы доступны только внутри media roots OpenClaw. Поддерживается до 10 входящих вложений; исходящие файлы ограничены 100 МБ суммарно.

Bot API передаёт токен и текст в query. Плагин скрывает полные URL и сырые API-ошибки, но access-логи сервера и reverse proxy также должны скрывать query. Не запускайте два long-poll потребителя с одним токеном: они будут забирать события друг у друга.

## Ошибки очереди и восстановление

Ошибка обработки события блокирует только свой чат и сохраняется в `<OPENCLAW_STATE_DIR>/vk-workspace/<hash>.json` (обычно внутри `~/.openclaw`). Другие чаты продолжают работать. Автоматического повтора нет, потому что прерванный ход мог уже отправить сообщение или выполнить инструмент. Ошибка записи, переполнение или повреждение очереди останавливает монитор до вмешательства оператора.

Очередь вмещает не более 1000 событий и 16 МиБ. При заполнении освободите её только осознанным `retry` или `discard`; не удаляйте JSON и не сбрасывайте курсор.

В failed-событии сохраняются безопасные `stage`, `code`, `message`: отдельно metadata, download, normalize, media-store, agent-dispatch и reply-delivery. Наличие аудиовложения не доказывает, что сбой доставки вызван STT. Сырые provider errors и подписанные URL в эту диагностику не копируются; подробности провайдера ищите в Gateway logs с учётом его политики редактирования секретов.

Утилита входит **в установленный npm-пакет**; доступ к GitHub для восстановления не нужен. Путь плагина найдите через `openclaw plugins inspect vk-workspace` и подставьте вместо `/absolute/plugin`. В checkout доступна та же утилита через `node scripts/inbox.mjs`.

```bash
openclaw gateway stop
node /absolute/plugin/dist/inbox-cli.js status /absolute/path/to/inbox.json

# Выберите ОДНО действие после проверки уже выполненных ответов и внешних действий:
node /absolute/plugin/dist/inbox-cli.js retry /absolute/path/to/inbox.json EVENT_ID
# Или отбросьте только выбранное событие, не трогая следующие pending:
node /absolute/plugin/dist/inbox-cli.js discard /absolute/path/to/inbox.json EVENT_ID

openclaw gateway start
```

Выберите файл `*.json`, но не `*.messages.json` и не `*.backup-*`, в каталоге `vk-workspace`; hash зависит от URL и токена. При нескольких ботах сопоставьте очередь по ID событий. `status` не меняет JSON и не печатает тексты сообщений; `interrupted` перечисляет ID начатых, но не завершённых pending-событий. Команды `retry` и `discard` принимают ID из failed или interrupted; обычные ещё не начатые pending не затрагиваются. Повтор всех таких событий возможен только явно: `retry /absolute/path/to/inbox.json --all`.

Перед изменениями утилита под тем же эксклюзивным lock создаёт рядом копию `*.json.backup-<uuid>` с правами `0600` и выводит её путь. Если копирование или синхронизация не удались, очередь не меняется. Прерванные ходы карантинируются только после backup; затем выполняется выбранное действие. Курсор и остальные сообщения сохраняются. Копия содержит исходные сообщения: храните её как приватные данные. `retry` может повторить уже выполненные побочные эффекты; `discard` сознательно отказывается от повторного выполнения выбранного хода. Утилита не удаляет lock автоматически и не создаёт новую очередь при ошибке в пути.

Если после аварии остался `.lock`, сначала остановите все процессы Gateway с этим ботом и только затем удалите lock именно выбранной очереди:

```bash
/bin/rm -f /absolute/path/to/inbox.json.lock
```

Не удаляйте сами `inbox.json` и `*.messages.json`. Lock удаляйте только у выбранной очереди после остановки всех процессов Gateway. Повреждённую очередь восстановите из резервной копии; не обнуляйте курсор.

## Диагностика окружения

```bash
openclaw config validate
openclaw gateway status --deep
openclaw channels status --probe
openclaw logs --follow
```

`ECONNREFUSED 127.0.0.1:18789` означает, что TUI не подключился к Gateway, а не ошибку VK Bot API. Проверьте запуск через `openclaw gateway start`. На macOS сбои LaunchAgent и предупреждения о Node из nvm проверяйте через `openclaw doctor`; плагин не должен переустанавливать сервис или менять системный PATH. Недоступность внешнего каталога моделей не равна отказу канала, если настроенные локальные сервисы работают.

## Ограничения

- Новые сообщения и разрешённые callback запускают агента; редактирования, удаления, реакции и ветки обсуждений — нет.
- Административные операции с чатами и участниками не предоставляются.
- Потоковое редактирование ответа на каждом токене не поддерживается.
- Локальные тесты не заменяют проверку корпоративных proxy, TLS, прав бота и файлового origin на вашем сервере.

## Разработка

Проверки, пользовательские сценарии и процедура выпуска описаны в [CONTRIBUTING.md](https://github.com/pfrankov/openclaw-vk-workspace/blob/main/CONTRIBUTING.md).

## Лицензия

[Apache-2.0](LICENSE).
