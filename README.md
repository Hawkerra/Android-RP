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
* Each persona has two sections:
  * **Public:** appearance, voice, reputation, anything others could notice. Characters can react to it.
  * **Private:** secrets, hidden abilities, history, inner thoughts. The AI gets this as out-of-character reference only. It's told the characters don't know it and that none of it has happened in the story until it comes up in the chat, and it's reminded of this right before every reply. The continuity check flags any reply that leaks it.
  * **✨ Split with AI** sorts an existing mixed description into the two sections for you to review.
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

**Story & World** (Chat settings): two optional fields for this chat only.
* **World:** setting, places, rules, factions.
* **Story:** premise and where the story should head.
Both are sent to the bot as the frame for the story. The continuity check and scene tracker see them too.

**🎬 Director** (button beside the message box): describe what the next reply should do, like "a hooded stranger bursts in with news of the dragon".
* It applies to the next round of replies, then clears. Tick **Keep** to leave it on.
* Regenerating a directed reply reuses its direction.
* The continuity check knows about it, so things you directed aren't flagged.

**Empty send = continue:** tapping send with an empty box sends nothing visible. The bot gets a hidden out-of-character note saying you have nothing to add this turn and to carry the scene on without writing your actions. This also works in Manual group mode. The wording is editable in Settings → Prompts.

**Opening post:** the first message has no story to continue from, so rewriting it asks how the scene should open. This happens when you swipe past the last greeting, choose "Rewrite opening…", or start a chat whose character has no greeting by tapping send with an empty box.
* The box is pre-filled with your Director note, or with what you used last time.
* **Surprise me** lets the AI choose.
* Other posts regenerate as usual, using the Director note if one is set.

**🗺 Scene tracker** (map button in a chat): automatic notes kept for each chat. After each reply, the helper AI records:
* the current location, time, who's present and what's happening
* side characters, places, objects and facts that come up (not the main characters, who have their own cards)

The bot is sent the current scene, plus the notes that matter right now: pinned ones, people present, and anything mentioned recently.
* You can edit, add, pin or delete notes. Editing a note locks it so the tracker won't overwrite your version.
* Regenerating a reply undoes what the discarded version added.
* Settings: automatic, manual (Update now), or off.

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
* Settings → Continuity check (the check uses the **Helper AI** connection, see below):
  * run it automatically, only on demand (message menu → Check continuity), or never

**Helper AI** (Settings): the connection and model for background jobs: continuity checks, the scene tracker and persona splitting. A cheaper or faster model works well.

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
