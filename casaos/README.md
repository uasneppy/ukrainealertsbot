# CasaOS packaging

Files here are for running the bot on [CasaOS](https://casaos.io).

- **`docker-compose.yml`** — the CasaOS install manifest (published image + `x-casaos` metadata).
- **`icon.png`** — app tile icon. **Not yet added.** Drop a 256×256 PNG here; until then the CasaOS tile shows a blank icon, which does not affect installation.

Installation steps for end users are in [`../docs/INSTALL-CasaOS.md`](../docs/INSTALL-CasaOS.md).

## The icon

CasaOS reads `icon:` in the compose as a URL and loads it at display time — it is not baked into the image. The manifest points at:

```
https://raw.githubusercontent.com/uasneppy/ukrainealertsbot/main/casaos/icon.png
```

Add `casaos/icon.png` (256×256, PNG) and commit it, and the tile fills in on next refresh. Nothing else needs to change.
