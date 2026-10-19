# Врата AI для VS Code

## Совместимость

Минимум — **VS Code 1.104.0**: в этой версии появился стабильный
[Language Model Chat Provider API](https://code.visualstudio.com/updates/v1_104#_language-model-chat-provider-api).
Компиляция использует типы именно 1.104.0, чтобы случайно не добавить API более
нового редактора. CI устанавливает VSIX и проверяет активацию/SecretStorage
после перезапуска на **1.104.0, 1.135.0 и 1.138.0** (Linux).

На ранних версиях доступ к встроенному чату может требовать входа в GitHub и
подходящего плана Copilot; расширение не снимает ограничения самого редактора.
Управление ключом доступно также через строку состояния и палитру команд.
В палитре оставлены основные действия; служебные команды обслуживания и
диагностики доступны через соответствующие уведомления.
Работа без GitHub sign-in подтверждена для onboarding; полный агентный сценарий
без подписки ранее проверен на 1.138.0 в отчёте #335, а не на всех версиях.

## Выпуск новой версии

Откройте **Actions → Release → Run workflow**, выберите **main** и укажите
новую стабильную версию без `v`, например `0.1.42`. Workflow обновит версию в
`package.json`, `package-lock.json` и текущую ссылку на VSIX в README, выполнит
`npm run check`, соберёт VSIX, создаст коммит и тег `v<версия>`, затем опубликует
GitHub Release с автоматически сформированными release notes и файлом
`vrata-ai-<версия>.vsix`. Публикация использует встроенный `GITHUB_TOKEN`.

Версия должна быть выше текущей. Выпуски выполняются последовательно. Если
публикация прервалась после отправки тега, повторите запуск с той же версией:
workflow соберёт пакет из исходного тега и завершит черновик релиза. Уже
опубликованный релиз остаётся без изменений.

Если `main` обновится во время проверок, атомарный push отклонит и коммит,
и тег. Начните новый запуск с той же версией, чтобы проверить актуальный `main`.
Правила репозитория должны разрешать GitHub Actions отправлять коммиты версий
в `main`, создавать теги `v*` и использовать `contents: write`.

## Разработка и проверки

```sh
npm ci
npm run check
npm run package
```

Для разработки нужен Node.js 22. `npm run check` выполняет проверку типов,
ESLint, проверку форматирования и тесты. `npm run format` применяет Prettier.
Нажмите **F5** для запуска Extension Development Host с папкой `fixture`:
задача `npm: watch` пересобирает TypeScript, доступны точки останова.

Инструкции для агентов — в [AGENTS.md](AGENTS.md); [пакет skills](.agents/README.md) перенесён из основного репозитория
`ai-billing-gateway`. `vrata-vscode-dev` задаёт маршрут разработки, а planning,
review, simplification и GitHub workflow используют полные локальные пакеты.
CI повторяет `check`, собирает VSIX и проверяет его в трёх версиях VS Code.
Workflow можно запустить вручную; JSON-результаты и логи host tests
сохраняются и при ошибке.

Пакет TypeScript находится в корне этого репозитория. Stable API, vendor `vrata`,
extension ID `vrata.vrata-ai`; без proposed API и собственного webview-чата.
VSIX содержит только manifest, README, walkthrough media и скомпилированный код.
`@vscode/vsce` — только build dependency; runtime dependencies отсутствуют.

Unit/integration tests покрывают lifecycle, ошибки хранения/проверки, смену
аккаунта, запоздалые ответы, native UI commands и read-only HTTP через локальный
сервер, а также оба потоковых транспорта и циклы инструментов.

Для проверки реального SecretStorage и production-активации установите VSIX в
изолированные каталоги, затем запустите host test дважды с тем же профилем:

```sh
code --user-data-dir /tmp/vrata-profile --extensions-dir /tmp/vrata-extensions \
  --install-extension "$PWD/vrata-ai-0.1.6.vsix"
VRATA_HOST_PHASE=write VRATA_HOST_RESULT=/tmp/vrata-write.json code --user-data-dir /tmp/vrata-profile \
  --extensions-dir /tmp/vrata-extensions --extensionDevelopmentPath "$PWD/test/host-extension"
VRATA_HOST_PHASE=read VRATA_HOST_RESULT=/tmp/vrata-read.json code --user-data-dir /tmp/vrata-profile \
  --extensions-dir /tmp/vrata-extensions --extensionDevelopmentPath "$PWD/test/host-extension"
```

Не добавляйте `--extensionTestsPath`: VS Code включает для него in-memory storage,
который не проверяет сохранение после перезапуска. Тестовое расширение запускает
проверку автоматически и закрывает редактор; проверьте `passed: true` в обоих JSON-файлах результата.

Host test использует только синтетический ключ в SecretStorage тестового
расширения и loopback HTTP. Реальные credentials и платные запросы не нужны.
На Linux нужен доступный системный keyring; не используйте plaintext password
store для настоящего ключа. Windows/macOS и Remote/WSL пока не проверены.

История и техническая база:
[отчёт #335](https://github.com/v-lebedev/vrata-docs/blob/main/reports/2026-09-23/vscode-335/report.md).

Автоматический Linux-прогон с изолированными profile/keyring (нужны `xvfb`,
`xauth`, `dbus-x11`, `gnome-keyring`; путь результата должен быть новым):

```sh
VRATA_HOST_VERSION=1.135.0 dbus-run-session -- xvfb-run -a bash test/run-host.sh \
  /path/to/VSCode-linux-x64/code "$PWD/vrata-ai-0.1.6.vsix" /tmp/vrata-host-1.135
```

## Диагностика подключения

Нажмите **Открыть журнал** в уведомлении об ошибке или выполните команду
**Врата AI: Открыть журнал**. Канал **Врата AI** в Output содержит исходную
ошибку с уровнем **error**: сообщение, стек, `cause`, `AggregateError` и дополнительные
поля, включая неизвестные коды. Исключения перехватываются на уровне активации,
команд, событий хранилища и методов провайдера. GatewayClient пропускает их
наверх без подмены и повторного журналирования. Модельные ошибки классифицируются по HTTP-статусу и безопасным кодам; сырые ответы upstream не попадают в уведомления и журнал.

Точные значения доступных обработчику API-ключей (текущего, вводимого и ключа запроса) маскируются как `[REDACTED]`.
Для ошибок загрузки каталога и хранилища исходный стек сохраняется. Для модельного потока записывается безопасный код, статус и request ID без тела ответа. Команда **Врата AI: Скопировать диагностику** копирует только версии, ID модели, код и request ID. Баланс счёта виден в строке состояния; заданный остаток квоты ключа виден в панели Врата AI и подсказке. Обновление выполняется после подключения и каждого завершившегося запроса без периодического опроса.
