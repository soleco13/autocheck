# Деплой фичи: проверка фото-ответов учеников через vision-модель

**Коммит фичи:** `528c3ba` в `origin/master` (репозиторий `soleco13/autocheck`)
**Прод:** Docker Compose на `109.248.198.60` (`homework-shkola.ru`), рабочая копия `/opt/autocheck`, секреты в `/opt/autocheck/.env` (chmod 600, не в git). См. `DEPLOYMENT.md`.

## Что добавляет

В материалах бывают задания, где ученик прикрепляет фото рукописного решения
(компонент `CFileLoader`). Раньше такие задания либо игнорировались, либо
уходили в ручную проверку. Теперь их проверяет мультимодальная модель
(`AI_VISION_MODEL`, по умолчанию `google/gemini-3.7-flash` через OpenRouter),
а её вердикт (балл + разбор для ученика + заметка учителю) пишется в строку
`answers` так же, как у любого другого чекера, и попадает в итоговый отчёт,
который собирает Claude.

**Затронутые файлы:**
- `backend/src/services/answer-parser.ts` — новый `task_type` `'photo_answer'`;
  `buildPhotoMap()` читает список файлов из `rawState.securedVars["{compId}filesInternal"]`.
- `backend/src/services/ai-checker.ts` — `checkPhotoAnswer()`: качает фото
  **только в память** (лимиты 6 файлов / 12 МБ / 20 с), шлёт base64 в vision-модель,
  пишет результат. Кэш ответов по хэшу картинок. Делегируется из `checkAnswer`
  и `checkAnswersBatch`.
- `backend/src/services/report-generator.ts` — заметки по проблемным заданиям
  (в т.ч. фото) прокидываются в промпты Claude.
- `backend/src/api/reports.ts` — новый эндпоинт
  `GET /api/reports/answers/:answerId/photo/:idx` — прокси-стрим картинки через
  бэкенд (same-origin, с проверкой принадлежности учителю). Фото **нигде не
  сохраняется**.
- `backend/src/api/settings.ts` — редактируемый промпт `checker_vision_system`.
- `backend/src/lib/openrouter-client.ts` — `getOpenRouterVisionClient()`.
- `frontend/src/pages/Report.tsx`, `Settings.tsx` — показ миниатюр фото + промпт.
- `backend/src/debug-photo.ts` — live-пробник (в проде не запускается сам по себе).

**Миграция БД не требуется** — новых таблиц/колонок нет, фото-URL лежат в
существующей JSONB-колонке `answers.student_answer_structured`.

## Обязательный шаг: переменные окружения

Перед пересборкой добавить в `/opt/autocheck/.env` **одну обязательную строку**:

```bash
AI_VISION_MODEL=google/gemini-3.7-flash
```

Без неё фото-задания не грейдятся автоматически, а помечаются `manual_required`
(«Автопроверка фото не настроена») — деплой при этом не ломается, просто фича
неактивна.

**Опционально** — если владелец хочет отдельный биллинг/лимит под vision:
```bash
OPENROUTER_VISION_API_KEY=<ключ, взять у владельца / из менеджера секретов>
```
Если этой строки нет — vision-запросы идут по уже настроенному
`OPENROUTER_API_KEY` (он уже в проде и работает). **Не коммить ключ в git.**

Проверить актуальность слага модели на <https://openrouter.ai/models> — если
`google/gemini-3.7-flash` там больше нет, взять текущий слаг vision-модели
(напр. `google/gemini-2.5-flash`) и вписать его в `AI_VISION_MODEL`.

## Шаги на проде

```bash
cd /opt/autocheck

# 1. Убедиться, что нет незакоммиченных локальных изменений (кроме .env)
git status

# 2. Забрать коммит
git fetch origin
git log --oneline HEAD..origin/master        # ожидается: 528c3ba feat: grade student photo answers... + этот doc-коммит
git merge --ff-only origin/master

# 3. Добавить AI_VISION_MODEL в .env (см. раздел выше)
grep -q AI_VISION_MODEL .env || echo 'AI_VISION_MODEL=google/gemini-3.7-flash' >> .env
grep AI_VISION_MODEL .env

# 4. Пересобрать и перезапустить (backend-api, backend-worker и frontend —
#    все три образа меняются: TS-код бэкенда, React-код фронта)
./scripts/deploy.sh
```

`scripts/deploy.sh` сам: тегает текущие образы как `:previous` (для отката),
делает `git pull --ff-only` (повторный, безвредный), `docker compose build`,
`docker compose up -d` (миграции backend-api прогоняет автоматически на старте —
здесь миграций нет), чистит dangling-образы.

Если предпочитаешь вручную:
```bash
docker tag autocheck-backend:latest autocheck-backend:previous
docker tag autocheck-frontend:latest autocheck-frontend:previous
docker compose build backend-api backend-worker frontend
docker compose up -d backend-api backend-worker frontend
```

## Проверка после деплоя

```bash
docker compose ps                                  # все healthy
docker compose logs --tail=60 backend-api          # старт без ошибок
docker compose logs --tail=60 backend-worker       # старт без ошибок
```

Затем в интерфейсе:
1. Открыть под учительским аккаунтом ученика, у которого есть работа с
   заданием «прикрепи фото решения».
2. Нажать **«Проверить»** (или «Проверить заново», если работа уже проверялась
   — старый кэш не подтянется, ключ кэша содержит тег `photo-v2`).
3. В отчёте на слайде с фото-заданием должна появиться карточка типа
   **«Фото-ответ»**: миниатюра(ы) фото ученика + «Комментарий ИИ» с разбором
   решения. Клик по миниатюре открывает картинку в новой вкладке
   (`/api/reports/answers/<id>/photo/0`).
4. Итоговые сводки (ученику и учителю) должны учитывать это задание —
   если на фото есть недочёты, они упоминаются в тексте.
5. `Настройки → Промпты ИИ` — должен появиться редактируемый промпт
   **«Системный промпт проверки фото»**.

Проверить расход токенов: `Настройки → Расход ИИ` — после проверки фото там
прибавится вызов модели `google/gemini-3.7-flash` (~1.5–2.5к токенов ≈ $0.004
за одно фото-задание).

## Существующие отчёты не пересчитываются

Фича влияет только на **новые** проверки. Отчёты по материалам с фото-заданиями,
сгенерированные до деплоя, останутся без оценки фото — их нужно перепроверить
вручную кнопкой «Проверить заново». Массового пересчёта нет (стоит токенов).

## Откат

```bash
cd /opt/autocheck
./scripts/rollback.sh          # вернёт образы :previous и перезапустит
git revert 528c3ba            # + doc-коммит, если нужно убрать и из кода
```
Откат безопасен: схема БД не менялась, данные не мигрировались. Строку
`AI_VISION_MODEL` из `.env` можно оставить — без кода фичи она ни на что не
влияет.
