---
name: Ukrainian region name matching
description: Prefix-matching UA place names from chat text — city/oblast tie-breaks, Cyrillic \b pitfall
---

## City vs oblast tie-break for shared stems

Rule: when a query stem matches both a city and its oblast (донецьк, луганськ, хмельницьк, івано-франківськ…), decide by grammar: the word "область"/"обл" or an adjective ending on the first token (-ій/-їй/-ої/-ою) → oblast; a plain locative ("в донецьку", "у хмельницькому") → city.

**Why:** Ukrainian city names and oblast adjectives share stems, and users genuinely mean different things ("в донецьку" = місто, "в донецькій" = область). Longest-prefix alone cannot separate them.

**How to apply:** any place-name matching in this bot must reuse `neptun/regionResolver.js` (prefix tables + `isOblastish` tie-break) instead of new ad-hoc regexes.

## JS regex \b is ASCII-only

`\b` never matches at Cyrillic word edges (Cyrillic is non-\w), so `\bчому\b` silently never fires. Use lookarounds `(?<![а-яґєіїa-z])…(?![а-яґєіїa-z])` or explicit `(?:^|\s)` anchors for Ukrainian text.

**Why:** cost two failing tests before being caught; the failure is silent (pattern just never matches).
