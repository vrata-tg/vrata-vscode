# Разработка Врата AI для VS Code

Процесс работы и ограничения расширения описаны в [AGENTS.md](../AGENTS.md).
Команды сборки и проверки определены в [package.json](../package.json).

## Локальный запуск

Нужен Node.js 22:

```sh
npm ci
npm run check
npm run package
```

`check` запускает TypeScript, ESLint, Prettier и тесты. `npm run format`
применяет форматирование. **F5** запускает Extension Development Host
с папкой `fixture` и TypeScript watch.

`build` собирает официальные SDK OpenAI и Anthropic вместе с общим модулем
транспорта через esbuild и добавляет лицензионные уведомления. VSIX работает
без внешнего `node_modules`; исходники, тесты и source maps исключены.

## Проверки в VS Code

Минимальная версия — **VS Code 1.104.0**, типы API закреплены на ней.
Матрица в [CI](../.github/workflows/ci.yml) проверяет установку VSIX,
активацию и SecretStorage после перезапуска на Linux.
Windows/macOS и Remote/WSL пока не проверены.

Для Linux host tests нужны `xvfb`, `xauth`, `dbus-x11`, `gnome-keyring`
и распакованный VS Code нужной версии:

```sh
VRATA_HOST_VERSION=1.135.0 dbus-run-session -- xvfb-run -a bash test/run-host.sh \
  /path/to/VSCode-linux-x64/code /path/to/vrata-ai.vsix /tmp/vrata-host-1.135
```

Передайте путь к собранному VSIX. Каталог результата должен быть новым.
Скрипт использует изолированные профиль и keyring, проверяет `passed: true`
для фаз записи и чтения после перезапуска. Запросы идут только на loopback
с синтетическим ключом. `--extensionTestsPath` использовать нельзя:
он включает in-memory storage.

## Параметры модельных запросов

Приоритет уровня рассуждений: явный `modelOptions.reasoningEffort` в запросе,
`vrata.reasoningEffortByModel` по ID модели, общий уровень профиля.
Неизвестные значения пропускаются; если уровень не задан, используется
значение сервера. Строка состояния показывает общий уровень.
В Chat Completions передаётся `reasoning_effort`, в Responses —
`reasoning.effort`; Messages использует значение сервера.

Фактический usage передаётся Copilot на VS Code 1.106+; до ответа оценка
токенов остаётся локальной.

## Диагностика

Канал **Врата AI** в Output содержит исходные исключения ошибок хранилища,
каталога и модельных запросов, включая стек и цепочку причин.
Для модельных запросов журнал содержит код, статус, request ID и подробности
ошибки SDK или события сбоя Responses. Длинные строки и массивы диагностик
не обрезаются. Известные операции API-ключи маскируются как `[REDACTED]`.

**Скопировать диагностику** копирует только версии, ID модели, код и request ID.

## Выпуск

В **Actions → Release → Run workflow** выберите **main** и новую стабильную
версию без `v`, выше текущей. Workflow обновит версии в `package.json`
и `package-lock.json`. Обновите ссылку на текущий VSIX в README до выпуска
и проверьте, что имя файла и тег в ссылке соответствуют новой версии.
Workflow выполнит проверки, создаст коммит, тег `v<версия>` и GitHub Release
с `vrata-ai-<версия>.vsix` через `GITHUB_TOKEN`.

Если `main` обновится во время проверок, атомарный push отклонит коммит
и тег; запустите workflow заново. Прерванную публикацию после push тега
можно продолжить с той же версией. Опубликованный релиз не изменяется.
Правила репозитория должны разрешать Actions коммиты в `main`, теги `v*`
и `contents: write`.
