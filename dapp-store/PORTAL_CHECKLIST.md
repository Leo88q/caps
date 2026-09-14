# Publisher Portal submission notes

The old CLI flow this file used to configure (`dapp-store create-publisher`
/ `create-app` / `create-release` reading a local `config.yaml`) is no
longer how a **first** submission works. As of the current docs
(docs.solanamobile.com/dapp-publishing/overview), the flow is:

1. Create your app in the **Publisher Portal** (https://publish.solanamobile.com)
   — a web form, not a CLI command. This mints the Publisher NFT and App
   NFT for you when you submit the form.
2. Upload your signed release APK (from `solana-mobile webshell build`,
   see the main README's "Мобильная упаковка" section) as a **New
   Version** in the portal. This mints the Release NFT.
3. Submit for review from the portal.

Only **subsequent updates** use the CLI (`@solana-mobile/dapp-store-cli`),
and even then it's a thin wrapper that just uploads a new APK to the
already-existing portal app using an API key — not the old NFT-minting
command chain:

```bash
npm install -g @solana-mobile/dapp-store-cli
export DAPP_STORE_API_KEY=<from https://publish.solanamobile.com/dashboard/settings/api-keys>
dapp-store --apk-file ./app/build/outputs/apk/release/app-release.apk \
  --keypair ./path/to/keypair.json \
  --whats-new "What changed in this version"
```

This file is just a checklist of what the portal form will ask for —
filling it in doesn't do anything by itself, unlike the old config.yaml.

## Checklist for the portal form

- [ ] Publisher name / website / contact email
- [ ] App name: GUTTERCAPS
- [ ] Android package id: match whatever `solana-mobile webshell init`
      generated (`--application-id`, default derived from the app name)
- [ ] Short description (~1 sentence)
- [ ] Long description — draw from the site's "Mechanics" and "Rules &
      fairness" sections (guttercaps-landing.html) rather than writing
      fresh; keep the same honesty about odds/fees, don't oversell
- [ ] Category: Games
- [ ] Icon 512×512 PNG, no alpha — see client/public/ICONS_NEEDED.txt
- [ ] Banner 1200×600 PNG — see media/README.txt
- [ ] Minimum 4 screenshots or videos, 1080p — take these from a real
      device/emulator running the actual UI once art assets exist, not
      mockups
- [ ] Privacy policy / terms / copyright URLs (required fields — even a
      simple static page works, but they must resolve)
- [ ] Signed APK path: `app/build/outputs/apk/release/app-release.apk`
      after `solana-mobile webshell build`
