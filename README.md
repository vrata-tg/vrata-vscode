# Врата AI для VS Code

Устанавливаемое расширение для VS Code **1.104.0+**. Введите существующий
API-ключ Врата AI: адрес сервиса вводить не требуется.

1. Установите `vrata-ai-0.1.3.vsix` через **Extensions → Install from VSIX…**.
2. На экране начала работы нажмите **Вставить API-ключ**. Если ключа ещё нет,
   нажмите **Получить ключ в боте**.
3. Управляйте подключением через **Chat → Manage Models → Врата AI**, строку
   состояния или команду **Врата AI: Управление подключением**.

Выпуск 0.1.3 реализует подключение из
[задачи #336](https://github.com/v-lebedev/ai-billing-gateway/issues/336).
**Выбор моделей и баланс пока недоступны**: серверные metadata, каталог и UI
добавляются в [#337](https://github.com/v-lebedev/ai-billing-gateway/issues/337),
[#338](https://github.com/v-lebedev/ai-billing-gateway/issues/338) и
[#340](https://github.com/v-lebedev/ai-billing-gateway/issues/340).
Расширение не показывает фиктивные модели и лимиты прежнего прототипа.

Ключ сохраняется только через VS Code SecretStorage. Отмена ввода и неудачная
проверка замены сохраняют прежний ключ. Удаление отключает локальный профиль,
но не отзывает ключ на сервере. Буфер обмена читается только самим редактором,
когда вы вставляете текст в поле. Настройки рабочей папки и переменные окружения
не могут подменить адрес сервиса.

Проверка — `GET https://api.vrata.tg/v1/models` с Bearer, без генерации, повторов
или переходов по redirect. Нулевой баланс не мешает проверке действительного
ключа. Ошибки не включают ключ, содержимое ответа сервера или сетевую диагностику.
После смены ключа отменяются запросы старой сессии, очищается её кэш и
уведомляется провайдер; поздние ответы не применяются к новой сессии.

Служебные запросы редактора также могут оплачиваться. Если настройка доступна в вашей версии, в **User Settings** задайте
`chat.byokUtilityModelDefault` = `mainAgent`, чтобы использовать модель агента
для таких запросов. Расширение открывает настройку по явному действию и не меняет
её автоматически. Если настройка отсутствует, команда сообщает об этом. Workspace Trust и корпоративные BYOK policies остаются в силе.

## Совместимость

Минимум — **VS Code 1.104.0**: в этой версии появился стабильный
[Language Model Chat Provider API](https://code.visualstudio.com/updates/v1_104#_language-model-chat-provider-api).
Компиляция использует типы именно 1.104.0, чтобы случайно не добавить API более
нового редактора. CI устанавливает VSIX и проверяет активацию/SecretStorage
после перезапуска на **1.104.0, 1.135.0 и 1.138.0** (Linux).

На ранних версиях доступ к встроенному чату может требовать входа в GitHub и
подходящего плана Copilot; расширение не снимает ограничения самого редактора.
Управление ключом доступно также через строку состояния и палитру команд.
Работа без GitHub sign-in подтверждена для onboarding; полный агентный сценарий
без подписки ранее проверен на 1.138.0 в отчёте #335, а не на всех версиях.

## Разработка и проверки

```sh
npm ci
npm test
npm run package
```

Пакет TypeScript находится в корне этого репозитория. Stable API, vendor `vrata`,
extension ID `vrata.vrata-ai`; без proposed API и собственного webview-чата.
VSIX содержит только manifest, README, walkthrough media и скомпилированный код.
`@vscode/vsce` — только build dependency; runtime dependencies отсутствуют.

Unit/integration tests покрывают lifecycle, ошибки хранения/проверки, смену
аккаунта, запоздалые ответы, native UI commands и read-only HTTP через локальный
сервер. Транспортные тесты сохранены для последующей работы
[#339](https://github.com/v-lebedev/ai-billing-gateway/issues/339).

Для проверки реального SecretStorage и production-активации установите VSIX в
изолированные каталоги, затем запустите host test дважды с тем же профилем:

```sh
code --user-data-dir /tmp/vrata-profile --extensions-dir /tmp/vrata-extensions \
  --install-extension "$PWD/vrata-ai-0.1.3.vsix"
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
  /path/to/VSCode-linux-x64/code "$PWD/vrata-ai-0.1.3.vsix" /tmp/vrata-host-1.135
```

## Диагностика подключения

Нажмите **Открыть журнал** в уведомлении об ошибке или выполните команду
**Врата AI: Открыть журнал**. Канал **Врата AI** в Output содержит исходную
ошибку проверки ключа: сообщение, стек, `cause`, `AggregateError` и дополнительные
поля, включая неизвестные коды. Списка распознаваемых ошибок нет.

Точное значение проверяемого API-ключа маскируется как `[REDACTED]`.
Остальные детали ошибки сохраняются. HTTP-статус записывается отдельно;
тела HTTP-ответов специально не журналируются, но фрагменты ответа могут быть
частью исходной ошибки парсера.
