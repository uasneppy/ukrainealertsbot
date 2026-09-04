/**
 * "What flew over my region tonight, and how many" — assembled from the night
 * log, never from a guess.
 *
 * Two layers, deliberately separate:
 *   • facts — track tallies from NEPTUN (hard numbers, classified against the
 *     region's geometry the same way the live map does) and the channel posts
 *     that mention the region or announce a nationwide event. This is what the
 *     caption line shows and what the Gemini prompt is built from.
 *   • the AI digest — Gemini reading those posts for the phrasing a regex
 *     can't ("наче мінус", "далі на центр міста"). It reads; it never wakes
 *     anyone up. When it's unavailable the deterministic fallback below still
 *     answers with the numbers and the latest posts.
 *
 * Everything here says "за даними NEPTUN" and "за повідомленнями": track counts
 * are tracks, not confirmed targets, and channel posts are claims.
 */

import {
  findOblastFeature, featureBbox, pointInFeature, distanceToBboxKm, distanceToFeatureKm, haversineKm,
  fmtKyivTime,
} from './regionContext.js';
import { THREAT_EMOJI, THREAT_NAMES_UA } from './threatMeta.js';
import { detectEvents, EVENT_KINDS } from './eventDetector.js';
import { relevantRegionKeys, messageConcerns } from './regionMentions.js';
import { nightWindow } from './nightLog.js';
import { esc, b, i } from './telegramFormat.js';

const NEAR_KM = 90;
/** Repeated reports of one launch wave within this window are one wave. */
const LAUNCH_BUCKET_MS = 30 * 60 * 1000;

/**
 * Classifies a stored track against a region: 'in' if any recorded position
 * was inside it, 'near' if one came within reach, else null.
 */
export function classifyTrack(track, region, geo) {
  let best = null;
  const promote = (v) => { if (v === 'in' || (v === 'near' && best !== 'in')) best = v; };
  if (region.kind === 'city') {
    const inKm = region.radiusKm ?? 60;
    const nearKm = Math.max(140, inKm * 2);
    for (const [lat, lon] of track.samples ?? []) {
      const d = haversineKm(region.lat, region.lon, lat, lon);
      if (d <= inKm) return 'in';
      if (d <= nearKm) promote('near');
    }
    return best;
  }
  const feature = findOblastFeature(geo, region.geoKey);
  if (!feature) return null;
  const bbox = featureBbox(feature);
  for (const [lat, lon] of track.samples ?? []) {
    if (pointInFeature(lat, lon, feature)) return 'in';
    if (bbox && distanceToBboxKm(lat, lon, bbox) <= NEAR_KM && distanceToFeatureKm(lat, lon, feature) <= NEAR_KM) promote('near');
  }
  return best;
}

/**
 * @param {object} opts
 * @param {object} opts.region        resolver descriptor
 * @param {object} opts.log           night log (tracksSince / messagesSince)
 * @param {object} opts.geo           boundary GeoJSON
 * @param {Set<string>} [opts.eventChannels]  channels whose posts count as nationwide event sources
 * @param {number} [opts.now]
 */
export function buildNightFacts({ region, log, geo, eventChannels = null, now = Date.now() }) {
  const window = nightWindow(now);
  const tally = { in: {}, near: {} };
  const advisories = [];
  const add = (bucket, track) => {
    const slot = (bucket[track.type] ??= { tracks: 0, units: 0 });
    slot.tracks += 1;
    slot.units += Math.max(1, track.count ?? 1);
  };
  for (const track of log.tracksSince(window.since)) {
    if (track.firstAt < window.since && track.lastAt < window.since) continue;
    const where = classifyTrack(track, region, geo);
    if (!where) continue;
    if (track.advisory) {
      if (where === 'in') advisories.push(track);
      continue;
    }
    add(tally[where], track);
  }

  const relevant = relevantRegionKeys(region);
  const messages = log.messagesSince(window.since);
  const regionMessages = messages.filter((m) => messageConcerns(m, relevant));

  const events = [];
  for (const m of messages) {
    if (eventChannels && !eventChannels.has(String(m.channel).toLowerCase())) continue;
    for (const ev of detectEvents(m.text)) {
      events.push({ kind: ev.kind, count: ev.count, at: m.at, channel: m.channel, sentence: ev.sentence });
    }
  }
  events.sort((a, b) => a.at - b.at);

  // One wave per half hour: the same launch is reported by several channels.
  let uavLaunched = 0;
  let bucketStart = -Infinity;
  let bucketMax = 0;
  for (const ev of events) {
    if (ev.kind !== 'uav_launch' || ev.count == null) continue;
    if (ev.at - bucketStart > LAUNCH_BUCKET_MS) {
      uavLaunched += bucketMax;
      bucketStart = ev.at;
      bucketMax = 0;
    }
    bucketMax = Math.max(bucketMax, ev.count);
  }
  uavLaunched += bucketMax;

  return { region, window, tally, advisories, regionMessages, events, uavLaunched, now };
}

const tallyText = (bucket) =>
  Object.entries(bucket)
    .sort((a, b) => b[1].units - a[1].units)
    .map(([type, { units }]) => `${THREAT_NAMES_UA[type] ?? type} ${units}`)
    .join(' · ');

/** First occurrence of each notable nationwide event kind, with time. */
function notableEvents(events) {
  const seen = new Map();
  for (const ev of events) {
    if (ev.kind === 'uav_launch' || seen.has(ev.kind)) continue;
    seen.set(ev.kind, ev);
  }
  const short = {
    mig31k_takeoff: 'МіГ-31К', kinzhal_launch: '«Кинджал»', strategic_takeoff: 'стратег. авіація',
    cruise_launch: 'пуски КР', kalibr_carriers: 'носії «Калібрів»', kalibr_launch: 'пуски «Калібрів»',
    ballistic_threat: 'загроза балістики', ballistic_launch: 'балістика',
  };
  return [...seen.values()].map((ev) => `${short[ev.kind] ?? ev.kind} ${fmtKyivTime(new Date(ev.at).toISOString())}`);
}

/** The one- or two-line block under a region map caption (Telegram HTML). */
export function formatNightLine(facts) {
  const inText = tallyText(facts.tally.in);
  const nearText = tallyText(facts.tally.near);
  const head = `🌙 ${b(`За ніч (${facts.window.label})`)}`;
  const parts = [];
  if (inText) parts.push(`над регіоном: ${esc(inText)}`);
  if (nearText) parts.push(`поблизу: ${esc(nearText)}`);
  if (facts.advisories.length) parts.push(`⚠️ попереджень: ${facts.advisories.length}`);
  const line1 = parts.length ? `${head} — ${parts.join(' · ')}` : `${head} — цілей над регіоном не зафіксовано`;

  const second = [];
  if (facts.uavLaunched) second.push(`пуски БпЛА ≈${facts.uavLaunched}`);
  second.push(...notableEvents(facts.events).slice(0, 3));
  const line2 = second.length ? `📡 ${i('За повідомленнями:')} ${esc(second.join(' · '))}` : '';
  return [line1, line2].filter(Boolean).join('\n');
}

const fmt = (at) => fmtKyivTime(new Date(at).toISOString());

/**
 * The facts as plain text — the body of the Gemini prompt and the skeleton of
 * the no-AI fallback. Numbers first, then the posts, newest last so the story
 * reads in order.
 */
export function describeNightFacts(facts, { maxMessages = 60, maxEvents = 25 } = {}) {
  const lines = [`Регіон: ${facts.region.name}. Вікно: ${facts.window.label} за Києвом до ${fmt(facts.now)}.`, ''];
  lines.push('Цілі за даними NEPTUN (кількість треків; рій рахується за його розміром):');
  lines.push(`• над регіоном: ${tallyText(facts.tally.in) || 'не зафіксовано'}`);
  lines.push(`• поблизу (до ~90 км): ${tallyText(facts.tally.near) || 'не зафіксовано'}`);
  if (facts.advisories.length) {
    lines.push(`• попередження над регіоном: ${facts.advisories.map((t) => `${t.title || t.type} ${fmt(t.firstAt)}`).join(', ')}`);
  }
  lines.push('');
  if (facts.events.length) {
    lines.push('Загальнодержавні події за повідомленнями каналів (час за Києвом):');
    for (const ev of facts.events.slice(-maxEvents)) {
      const meta = EVENT_KINDS[ev.kind];
      lines.push(`• ${fmt(ev.at)} ${meta?.title ?? ev.kind}${ev.count != null ? ` (${ev.count})` : ''} — ${ev.channel}: ${String(ev.sentence).slice(0, 160)}`);
    }
    lines.push('');
  }
  const posts = facts.regionMessages.slice(0, maxMessages).reverse();
  if (posts.length) {
    lines.push(`Повідомлення каналів, що згадують регіон (${facts.regionMessages.length}; від найстаріших до найновіших):`);
    for (const m of posts) lines.push(`• ${fmt(m.at)} ${m.channel}: ${m.text.replace(/\s+/g, ' ').slice(0, 300)}`);
  } else {
    lines.push('Повідомлень каналів про регіон за цей час немає.');
  }
  return lines.join('\n');
}

/** Digest without AI: the numbers and the latest posts, plainly (Telegram HTML). */
export function formatNightFallback(facts, { maxPosts = 6 } = {}) {
  const lines = [`🌙 ${b(`${facts.region.name} — за ніч`)} ${i(`(${facts.window.label})`)}`, ''];
  lines.push(`🛰 ${b('За даними NEPTUN')}`);
  lines.push(`  • над регіоном: ${esc(tallyText(facts.tally.in) || 'цілей не зафіксовано')}`);
  const near = tallyText(facts.tally.near);
  if (near) lines.push(`  • поблизу: ${esc(near)}`);
  if (facts.advisories.length) lines.push(`  • ⚠️ попереджень над регіоном: ${facts.advisories.length}`);
  const notable = notableEvents(facts.events);
  if (facts.uavLaunched || notable.length) {
    lines.push('');
    lines.push(`📡 ${b('За повідомленнями каналів')}`);
    if (facts.uavLaunched) lines.push(`  • пуски ударних БпЛА: ≈${facts.uavLaunched}`);
    for (const n of notable.slice(0, 5)) lines.push(`  • ${esc(n)}`);
  }
  const posts = facts.regionMessages.slice(0, maxPosts);
  if (posts.length) {
    lines.push('');
    lines.push(`💬 ${b('Останнє про регіон')} ${i(`(${facts.regionMessages.length} повідомлень)`)}`);
    for (const m of posts) {
      lines.push(`  • ${fmt(m.at)} ${esc(m.channel)}: ${i(m.text.replace(/\s+/g, ' ').slice(0, 140))}`);
    }
  }
  lines.push('');
  lines.push(`🗺 Зараз: /map ${esc(facts.region.name)}`);
  return lines.join('\n');
}

/**
 * Stable fingerprint of what the digest would be built from, so a Gemini
 * answer is reused only while nothing new has come in.
 */
export function nightFactsFingerprint(facts) {
  const tracks = Object.entries(facts.tally.in).concat(Object.entries(facts.tally.near))
    .map(([t, v]) => `${t}:${v.tracks}:${v.units}`).join(',');
  const lastMsg = facts.regionMessages[0]?.at ?? 0;
  const lastEvent = facts.events[facts.events.length - 1]?.at ?? 0;
  return `${facts.region.cacheKey}|${facts.window.since}|${tracks}|${facts.regionMessages.length}|${lastMsg}|${lastEvent}|${facts.advisories.length}`;
}
