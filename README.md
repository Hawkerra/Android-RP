# ChatForge

A roleplay chatbot frontend for Android. You can create characters, connect to Chub's API (or any OpenAI-compatible API), use lorebooks, and run group chats with several bots in one scene.

Everything is stored on the phone. There's no server and no account.

## Install on your phone

1. Open **Releases → latest** in this repo (on github.com, from your phone's browser).
2. Download **ChatForge.apk** and open it. If Android asks, allow installs from your browser.
3. A push to `main` rebuilds the APK automatically. To update, install the new one over the old one. Your data is kept.

## First-time setup

1. **Settings → API connection**. Pick a Chub preset, paste your Chub API key, then tap **Test**.
   * **Fetch models** lists the models the endpoint offers.
   * You can add more connections, such as OpenRouter or a local KoboldCPP / text-generation-webui `…/v1` URL on your Wi-Fi, and switch between them.
2. **Personas** tab. Edit the default persona (your name and a short description), or make several.
3. **Characters → +** creates a character. You can also:
   * use **⬆** to import a Tavern card (`.png` or `.json`, V1/V2/V3)
   * use **🔍** to browse bots online (search by name and filter by tags) and import directly
4. **Chats → +**. Pick one character for a 1-on-1 chat, or several for a group RP.

## Features

**Characters.** Each character has a description, personality, scenario, a greeting plus alternate greetings (you swipe between them), example dialogue, a per-character system prompt, post-history instructions, tags, and talkativeness. You can export a character as a PNG card or JSON that works with SillyTavern, Chub, etc.

**Personas**
* Save as many personas as you want. Sort them into folders, and find them with the search bar.
* One persona is your default. Any chat can use a different one (⋮ → Switch persona, or Chat settings).
* Import the personas saved on your Chub account (uses your Chub API key). They go into a "Chub" folder, and importing again updates them.
* Import/export persona JSON, including SillyTavern persona backups.

**Chat background:** the bot's image fills the chat background, zoomed in, blurred and darkened. In group chats it fades to whoever spoke last. Turn it off or change the blur and darkness in Settings → Chat background.

**Bot browser:** searches Chub and Botbooru together, mixing their results (tap a site chip to turn it on or off). Search by name and filter by tags. Chub tags are free-form, so you can type any tag. Tags found in the current results are suggested, most common first. You can also tap a tag on any bot to search with it.

**Lorebooks**
* Kinds: standalone books, books embedded in a character, and global books that are active in every chat.
* Entry settings:
  * keywords (supports `/regex/i`)
  * secondary keys with AND/NOT logic
  * always-on entries
  * insertion position: before the character, after the character, or at a chosen depth in the chat
  * order, probability, case sensitivity, and whole-word matching
* Scanning: recursive (entries can trigger other entries), with a scan depth and token budget per book.
* Import: SillyTavern world-info JSON, V2 `character_book`, or straight from Chub.

**Group chats.** Who replies after you send a message:
* **Natural:** characters you name reply first. If you name nobody, one character is picked based on talkativeness.
* **Round robin:** every character replies in turn.
* **Manual:** nobody replies until you choose who speaks.

In every mode, tap a character's chip above the message box to make them speak next. Muting a character keeps them in the scene without letting them reply. Send an empty message to let the scene continue on its own.

**Chat tools**
* Streaming replies, plus regenerate, swipe through alternatives, continue, edit, delete, and branch into a new chat.
* An author's note and a scenario override for each chat.
* Narrator messages: `/n A storm rolls in.`
* **⋮ → View last prompt** shows exactly what was sent to the model and which lore entries fired.

**Continuity check**
* After each bot reply, a second request compares it against the chat log, character sheets, your persona and active lore. It flags contradictions, for example:
  * the bot says you did or revealed something you never did
  * a character knows something they never learned
  * facts change (names, places, injuries, who's present)
  * the bot writes your character's actions
* Flagged wording is highlighted in the message. **Review** shows each problem with a suggested drop-in fix:
  * **Apply fix** (or **Apply all**) swaps in the suggested text
  * **Ignore** dismisses that issue
  * **Rewrite reply instead** regenerates the reply with the problems spelled out to the model
* Settings → Continuity check:
  * run it automatically, only on demand (message menu → Check continuity), or never
  * optionally use a different connection or a cheaper model for checks

**Macros:** `{{char}}`, `{{user}}`, `{{members}}`, `{{time}}`, `{{date}}`, `{{random:a,b,c}}`, `{{roll:2d6}}`.

**Backup:** Settings → Data → Export/Import backup. The backup file includes your API keys.

## Development

The app is plain HTML/CSS/JS in `www/`, with no build step. It's wrapped for Android with [Capacitor](https://capacitorjs.com).

```bash
npm install
npm run serve          # try it in a desktop browser at http://localhost:8080
npx cap sync android   # copy www/ into the Android project
npm run android        # open in Android Studio (or: npm run build:apk)
```

Desktop browsers block most API calls from a web page (CORS). The Android app sends them through native HTTP, so Chub and other APIs work there.

| File | What it does |
|---|---|
| `www/js/app.js` | Screens, chat flow, group turn-taking |
| `www/js/engine.js` | Prompt building, lorebook scanning, API client |
| `www/js/cards.js` | Card/lorebook import & export, Chub search/import |
| `www/js/booru.js` | Botbooru (or any booru-style site) search & card import |
| `www/js/db.js` | IndexedDB storage, defaults, data models |
| `www/js/native.js` | Android bridges (native HTTP, file saving, back button) |

`android/app/chatforge-debug.keystore` is a fixed debug signing key. It lets any build install as an update over the previous one. It isn't a secret.
