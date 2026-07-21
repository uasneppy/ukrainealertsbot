# Air Raid Alerts Telegram Bot

[![CI](https://github.com/uasneppy/ukrainealertsbot/actions/workflows/ci.yml/badge.svg)](https://github.com/uasneppy/ukrainealertsbot/actions/workflows/ci.yml)
[![Docker Image](https://img.shields.io/docker/v/uasneppy/ukrainealertsbot?sort=semver&label=docker%20hub)](https://hub.docker.com/r/uasneppy/ukrainealertsbot)

Telegram-бот, який показує актуальну карту повітряних загроз в Україні: відповідає мапою на слово **«тривога»**, будує наближену мапу окремого регіону, пояснює причину тривоги за допомогою AI та надсилає сповіщення про тривогу й відбій за підпискою.

Дані — з живого потоку **NEPTUN** (`neptun.in.ua`): WebSocket для оновлень у реальному часі та REST як резерв. Мапа не є скріншотом чужого сайту — вона рендериться власноруч у headless Chromium (Puppeteer + Leaflet), тому вигляд, підписи й масштаб контролюються повністю.

---

## ✨ Можливості

| Запит | Що робить |
| --- | --- |
| **«тривога»** | Мапа загроз по всій Україні: області та райони з тривогою, маркери загроз, легенда |
| **«тривога в &lt;місто/область&gt;»** | Наближена мапа регіону — кожна загроза підписана; для міст кадр максимально щільний, зі слідом польоту та стрілкою курсу |
| **«чому тривога»** | AI-підсумок останніх повідомлень каналу Повітряних сил (@kpszsu) |
| **«чому тривога в &lt;регіон&gt;»** | AI-пояснення саме для регіону: живі дані NEPTUN + повідомлення ПС |
| **`/map <регіон>`** | Мапа регіону на вимогу (напр. `/map харківщина`) |
| **`/subscribe <регіон>`** | Підписка на сповіщення про тривогу та відбій у регіоні |
| **`/unsubscribe [регіон\|all]`** | Скасування підписки |
| **`/subscriptions`** | Список активних підписок чату |
| **`/status`** | Стан бота: потік NEPTUN, API, AI-аналіз, черга рендеру, підписки |

Під кожною мапою — кнопки **🔄 Оновити** та **🔔 Підписатися**: під час тривоги натиснути швидше, ніж набирати текст. Оновлення замінює саме зображення, а не додає нове повідомлення.

Регіон розпізнається в будь-якому відмінку та в розмовних формах: «в Києві», «київській області», «харківщина», «на Буковині», «в Криму».

### Сповіщення за підпискою

- **Тривога** надсилається одразу, щойно її видно — затримка тут коштує людям часу на укриття.
- **Відбій** надсилається лише якщо він протримався 60 секунд: передчасне «відбій» небезпечніше за його відсутність.
- Якщо потік даних застарів (обірваний сокет), сповіщення **не надсилаються взагалі** — мовчання краще за неправдиве «відбій».
- Після перезапуску бот не розсилає повторно те, що вже триває — але **звіряє** стан і повідомляє про зміни, що сталися, поки він був недоступний.

---

## 🏠 Встановлення в CasaOS

Готовий образ (`amd64`) — на [Docker Hub](https://hub.docker.com/r/uasneppy/ukrainealertsbot). Покрокова інструкція: **[docs/INSTALL-CasaOS.md](docs/INSTALL-CasaOS.md)**. Маніфест для імпорту — [`casaos/docker-compose.yml`](casaos/docker-compose.yml).

## 🐳 Запуск з готового образу

```bash
docker run -d --name ukrainealertsbot --restart unless-stopped \
  -e BOT_TOKEN=<токен від @BotFather> \
  -e GEMINI_API_KEY=<необов'язково> \
  -e TZ=Europe/Kyiv \
  -v ukrainealerts-data:/app/data \
  -v ukrainealerts-geo:/app/neptun/geo \
  uasneppy/ukrainealertsbot:latest
```

`-v …:/app/data` обов'язковий — це підписки й стан тривог, а не кеш.

## 🚀 Запуск через Docker Compose (збірка з коду)

```bash
cp .env.example .env      # і вписати BOT_TOKEN
docker compose up -d --build
docker compose logs -f
```

Compose уже налаштований для довготривалої роботи на VPS: перезапуск після падінь і ребуту, `tini` як PID 1 (щоб Chromium не лишав зомбі-процесів), ліміти CPU/памʼяті, обмеження розміру логів і коректне завершення по SIGTERM.

Два томи, обидва важливі:

- `geo-cache` → `/app/neptun/geo` — кеш меж областей і районів, щоб не завантажувати їх щоразу.
- `subscriptions` → `/app/data` — підписки користувачів. **Без цього тому кожен `docker compose up` тихо стирає всі підписки.**

### Локальний запуск

```bash
npm install
node bot.js
```

Потрібен Chromium: або системний (`chromium` / Google Chrome), або через змінну `CHROME_EXECUTABLE_PATH`.

---

## ⚙️ Змінні середовища

| Змінна | Обовʼязкова | Призначення |
| --- | --- | --- |
| `BOT_TOKEN` | так | Токен бота від @BotFather |
| `GEMINI_API_KEY` | ні | Вмикає AI-аналіз («чому тривога»). Без нього бот віддає живі дані NEPTUN без пояснення |
| `TZ` | ні | Часовий пояс для логів (напр. `Europe/Kyiv`) |
| `CHROME_EXECUTABLE_PATH` / `PUPPETEER_EXECUTABLE_PATH` | ні | Шлях до Chromium, якщо автовизначення не спрацювало |
| `MAX_CONCURRENT_RENDERS` | ні | Скільки мап рендериться одночасно (типово `2`) |
| `THREAT_ICONS_DIR` | ні | Тека з іконками загроз (типово `./icons`) |
| `NEPTUN_GEO_DIR` | ні | Тека кешу GeoJSON |
| `SUBSCRIPTIONS_FILE` | ні | Файл зі сховищем підписок (типово `./data/subscriptions.json`) |
| `ALERT_STATE_FILE` | ні | Останній стан тривог для звірки після перезапуску |
| `HEARTBEAT_FILE` | ні | Файл живучості для healthcheck контейнера |

---

## 🎨 Іконки загроз

Файл `icons/<тип>.<png\|svg\|webp\|jpg\|gif>` перевизначає маркер для цього типу: `uav`, `fpv`, `missile`, `ballistic`, `kab`, `recon`, `mig31k`, `unknown`. Тека читається на кожному рендері — іконки можна міняти без перезапуску. Без своїх файлів використовуються вбудовані SVG-бейджі (не emoji: у headless Chromium emoji залежать від шрифтів і перетворюються на «тофу» □).

---

## 🧪 Розробка

```bash
npm test                                  # уся тестова база (vitest)
npm test -- alertWatcher                  # окремий файл

node scripts/render-preview.js mock /tmp/map.png            # мапа з тестових даних
node scripts/render-preview.js live /tmp/kyiv.png "київ"    # мапа регіону з живих даних
```

`render-preview.js` — найшвидший спосіб побачити зміни в рендері без Telegram.

---

## 🛠 Технології

Node.js (ESM) · Puppeteer + @sparticuz/chromium · Leaflet (вбудований локально, без CDN) · NEPTUN WebSocket/REST · Google Gemini · Telegram Bot API · Vitest · Docker
