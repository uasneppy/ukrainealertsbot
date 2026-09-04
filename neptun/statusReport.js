/**
 * Operator-facing health summary behind /status.
 *
 * Every degradation in this bot is designed to be invisible to users: a dead
 * Gemini key reads as "the AI had nothing to add", a dead socket reads as a
 * quiet sky, a wedged render reads as a text answer. That is right for someone
 * sheltering and useless for whoever has to keep the thing running, so the
 * facts are collected in one place.
 */

const ago = (timestamp, now) => {
  if (!timestamp) return 'ніколи';
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds} с тому`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} хв тому`;
  return `${Math.round(seconds / 3600)} год тому`;
};

/**
 * @param {object} facts
 * @param {boolean} facts.streamConnected
 * @param {number}  facts.streamAgeMs
 * @param {number}  facts.geoAgeMs
 * @param {object}  facts.ai            from getAiHealth()
 * @param {object}  facts.renderQueue   from renderQueueStats()
 * @param {number}  facts.subscriptions subscriptions for the asking chat
 * @param {number}  facts.watchedRegions distinct regions the watcher polls
 * @param {object|null} [facts.eventFeed] from eventWatcher.stats(); null when disabled
 * @param {{ tracks: number, messages: number }} [facts.nightLog]
 * @param {object|null} [facts.extraChannels] channelPoller.stats(): handle → { lastOkAt, lastError }
 * @param {number}  [facts.now]
 */
export function formatStatusReport(facts = {}) {
  const now = facts.now ?? Date.now();
  const lines = ['🩺 Стан бота'];

  const streamOk = facts.streamConnected && facts.streamAgeMs < 90_000;
  lines.push(
    `${streamOk ? '🟢' : '🔴'} NEPTUN потік: ${
      Number.isFinite(facts.streamAgeMs)
        ? `дані ${Math.round(facts.streamAgeMs / 1000)} с тому`
        : 'немає зʼєднання'
    }`
  );

  // The map path reads the API on every request, so this is what actually
  // decides whether a reply is possible.
  lines.push(
    `${facts.apiOk ? '🟢' : '🔴'} NEPTUN API: ${
      facts.apiOk ? `відповідає (${facts.apiLatencyMs} мс)` : `недоступний — ${facts.apiError ?? '?'}`
    }`
  );

  const ai = facts.ai ?? {};
  if (!ai.configured) {
    lines.push('⚪ AI-аналіз: вимкнено (немає GEMINI_API_KEY)');
  } else if (ai.failures && !ai.lastOkAt) {
    // Every call has failed: the fallback text hides this from users entirely.
    lines.push(`🔴 AI-аналіз: усі запити з помилкою (${ai.failures}) — ${ai.lastError}`);
  } else if (ai.lastFailAt > ai.lastOkAt) {
    lines.push(`🟠 AI-аналіз: остання помилка ${ago(ai.lastFailAt, now)} — ${ai.lastError}`);
  } else if (ai.lastOkAt) {
    lines.push(`🟢 AI-аналіз: працює (востаннє ${ago(ai.lastOkAt, now)})`);
  } else {
    lines.push('⚪ AI-аналіз: ще не викликався');
  }

  const q = facts.renderQueue ?? {};
  lines.push(`🖼 Рендер: ${q.active ?? 0}/${q.limit ?? '?'} активних, у черзі ${q.queued ?? 0}`);
  // geoCacheAgeMs() reports Infinity when any boundary file is missing —
  // "оновлено Infinity год тому" is not a status line.
  lines.push(
    Number.isFinite(facts.geoAgeMs)
      ? `🗺 Кеш меж: оновлено ${ago(now - facts.geoAgeMs, now)}`
      : '🔴 Кеш меж: файли відсутні'
  );
  // The event feed fails the same silent way as everything else: a dead
  // endpoint just means no take-offs are ever announced.
  if (facts.eventFeed === null) {
    lines.push('⚪ Стрічка подій: вимкнено (EVENT_CHANNELS=none)');
  } else if (facts.eventFeed) {
    const feed = facts.eventFeed;
    if (!feed.lastPollAt) {
      lines.push('⚪ Стрічка подій: ще не опитувалась');
    } else if (feed.lastError && feed.lastPollAt > feed.lastOkAt) {
      lines.push(`🔴 Стрічка подій: помилка — ${feed.lastError}`);
    } else {
      const last = feed.lastEventAt ? `, остання подія ${ago(feed.lastEventAt, now)}` : '';
      lines.push(`🟢 Стрічка подій: опитано ${ago(feed.lastOkAt, now)}, подій: ${feed.announced ?? 0}${last}`);
    }
  }
  if (facts.nightLog) {
    lines.push(`🌙 Нічний журнал: треків ${facts.nightLog.tracks ?? 0}, повідомлень ${facts.nightLog.messages ?? 0}`);
  }
  if (facts.extraChannels && Object.keys(facts.extraChannels).length) {
    // One line per channel: the t.me preview dies per channel, not all at once.
    for (const [handle, s] of Object.entries(facts.extraChannels)) {
      if (s.lastError && !s.lastOkAt) lines.push(`🔴 ${handle}: ${s.lastError}`);
      else if (s.lastError) lines.push(`🟠 ${handle}: останній успіх ${ago(s.lastOkAt, now)} — ${s.lastError}`);
      else if (s.lastOkAt) lines.push(`🟢 ${handle}: опитано ${ago(s.lastOkAt, now)}`);
      else lines.push(`⚪ ${handle}: ще не опитувався`);
    }
  }
  lines.push(`🔔 Підписки цього чату: ${facts.subscriptions ?? 0}`);
  lines.push(`👀 Регіонів під наглядом: ${facts.watchedRegions ?? 0}`);

  return lines.join('\n');
}
