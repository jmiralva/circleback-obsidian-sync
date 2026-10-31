# Circleback Sync

Circleback Sync is an Obsidian plugin that copies your [Circleback](https://circleback.ai) meetings into your vault as notes and transcripts.

## What it does

Each Circleback meeting becomes a Markdown note in your vault. The note holds Circleback's meeting notes, the meeting's action items and insights, and a link back to the meeting in Circleback. If you want, each meeting also gets a transcript with real speaker names. The plugin runs in the background on a schedule, or whenever you ask it to. Circleback Sync is unofficial and not affiliated with Circleback.

- It works with one Circleback account or several. Each account has its own API key, and all of them sync into the same vault.
- It writes one note per meeting into its sync folder, the folder you choose for notes. It finds a meeting's note there by the meeting's id, so a note you rename, or move to another folder inside the sync folder, is updated where it is, never copied.
- It leaves your own frontmatter fields alone, and it never moves a note. Moving a note out of the sync folder makes it yours: the plugin stops updating it, and puts a fresh note in the sync folder at the next sync that covers that meeting.
- It can add a link to each meeting in your daily notes, or put whole meeting sections inside them.

## Requirements and disclosures

- **Circleback account and API key.** You need a Circleback account and an API key from it. See [Getting started](#getting-started).
- **Obsidian 1.11.4 or later, on desktop.** The plugin does not support Obsidian mobile.
- **Network use.** The plugin connects only to Circleback, at `https://circleback.ai/api`. Every request is a read-only GET request, so the plugin never writes anything back to Circleback. Each request carries your API key so that Circleback knows whose meetings to return. No note, transcript or other content from your vault is ever sent. The plugin refuses to send your key to any other address.
- **No telemetry and no ads.** The plugin talks to no other server and collects no usage data.
- **Files.** The plugin reads and writes only files inside your vault: your meeting notes and transcripts, the folders for them, daily notes (when you turn on the daily note options), and its own settings file. To find your daily notes folder, name format and template, it reads the settings of the core Daily Notes plugin, or of Periodic Notes if you use that, from your vault's configuration folder. It does not read or write anything outside the vault.
- **What the plugin stores.** Settings (including the list of accounts, but no keys) are in the plugin's `data.json`. Small items that belong to one device are kept in Obsidian's local storage for this vault on this device: when each account last synced, whether it is failing and the last error, the email and name that Circleback has for each key, the rate limit Circleback last reported for each account, where an unfinished full sync stopped, the meetings whose transcripts Circleback would not give, and the "Sync on this device" choice. API keys are kept in Obsidian's secret storage. The plugin's log is kept in memory only.
- **Where your data goes.** Your meetings are saved into your vault as ordinary Markdown files. If a service syncs or backs up your vault (iCloud, Obsidian Sync, git), those notes go with it. Your API keys do not. See [API keys and devices](#api-keys-and-devices).

## Installing

Until Circleback Sync is available in Obsidian's community plugin directory, install it by hand:

1. Download `main.js`, `manifest.json` and `styles.css` from the latest release on this repository's Releases page.
2. In your vault, create the folder `.obsidian/plugins/circleback-sync/`. If you changed your vault's configuration folder from `.obsidian`, use that folder's name instead. The folder must be called `circleback-sync`.
3. Copy the three files into it.
4. Restart Obsidian. Open Settings, then Community plugins, turn on community plugins if they are off, and enable Circleback Sync.

To update, replace the three files with the ones from the newer release and restart Obsidian.

## Getting started

1. In Circleback, open Settings > API keys and create an API key. Copy it.
2. In Obsidian, open Settings > Circleback Sync and click "Add account".
3. Give the account a label, for example "Work", and paste the key into "API key". The key is saved when you press Enter or click out of the field.
4. Click "Test connection". A working key shows "Connected as" followed by the email address of the person the key belongs to.
5. Run "Circleback Sync: Sync now" from the command palette. Or wait: the first automatic sync comes about 10 minutes (the settle delay) after the plugin loads, or at the next check, within a minute, if that time has already passed when you add your first account.

Adding your first account also turns on "Periodic sync".

The first sync fetches the meetings from the last 7 days that already have notes in Circleback. To bring in older meetings, raise "Sync history (days)" or run "Full sync" (see [How syncing works](#how-syncing-works)).

Out of the box, notes go into a `Circleback` folder, one file per meeting, named after the meeting's title. Transcripts and daily note links are off. You can change all of this in the settings. See the [settings reference](#settings-reference).

## API keys and devices

- **Where keys are kept.** Each key is saved in Obsidian's secret storage, under the name `circleback-sync-` followed by an internal account id. Obsidian keeps it on this device, for this vault. A key is never written to the plugin's settings file (`data.json`), to your notes, or to anything a sync service or git backup would carry away.
- **See and remove keys.** Obsidian lists the keys stored on this device under Settings > Keychain, including this plugin's. You can see and remove them there.
- **The key field stays empty.** After you save a key, the field empties and says "Stored on this device". The plugin never shows a saved key again.
- **A second device needs its own copy of the key.** The list of accounts is part of the plugin's settings and travels with your vault, but the keys do not. On a second device, an account without a key shows "Key needed on this device" under its API key field, and the status bar says the same. Paste the key there once. No sync runs for that account on that device until you do.
- **Clear key** removes a key from this device only. The account stays in the list and starts syncing again when you paste a key. The button appears only when this device has a key. Obsidian 1.11.4, the oldest version this plugin supports, gives plugins no way to delete a secret, so the plugin overwrites the key with an empty value. An empty entry named `circleback-sync-` followed by the account's internal id may remain in Obsidian's secret storage.
- **Remove** takes the account out of the list on every device that shares the vault, and removes its key from the device where you click it. It asks you to confirm first. The account's notes stay in your vault. Like "Clear key", it leaves an empty entry on the device where you click it. A key already stored on another device is not touched, so use "Clear key" on that device first if you want it gone.
- **To make a key stop working everywhere,** delete it in Circleback.
- **Linux without a system keyring.** Obsidian cannot encrypt stored secrets there, and it warns about it. The plugin cannot change that.
- **Logs never contain keys.** Anything that looks like a Circleback key is replaced before a line is stored or shown.

## How syncing works

### Automatic syncs

- With "Periodic sync" on, the plugin syncs every "Sync interval (minutes)" minutes (30 by default). The interval counts from the start of the last automatic sync.
- It never syncs at the moment Obsidian opens. The first automatic sync comes about one "Settle delay (minutes)" (10 by default) after the plugin loads, so that your vault sync service can bring in files first. If that time has already passed when you add your first account, the sync comes at the next check, which runs once a minute.
- When the computer wakes from sleep, the plugin notices and waits for the settle delay again before its next automatic sync.
- Only one sync runs at a time on a device. If you ask for a sync while another is running, you get a notice and nothing starts. An automatic sync that finds another running is skipped quietly.
- No sync starts until Obsidian has finished loading and indexing the vault. "Sync now" waits for that and tells you it is waiting.
- With "Sync on this device" off, nothing syncs on that device. This setting is saved on the device only, so it is the way to choose which of several devices syncs.

### Commands

None of the commands has a default hotkey. You can assign your own in Obsidian's hotkey settings.

| Command | What it does |
| --- | --- |
| Circleback Sync: Sync now | Runs a normal sync now and tells you how it went. |
| Circleback Sync: Full sync | Rewrites every synced note from your whole Circleback history, not only the sync window. It applies your filters. It blocks other syncs while it runs, and the status bar shows its progress. |
| Circleback Sync: Cancel full sync | Stops a running full sync after the current meeting. The next full sync starts over. |

The settings tab has the same full sync as a button, under Advanced.

A full sync can take a long time on a large history, because Circleback limits how fast an account may make requests. If Obsidian closes during a full sync, it picks up where it stopped at the next automatic sync, or when you run "Full sync" again. With "Create missing daily notes" set to "Always" and daily note links or sections on, a full sync can create a daily note for every past meeting day that lacks one.

### Which meetings are synced

- Only meetings that have notes in Circleback. A meeting without notes is skipped, and picked up in a later sync if notes arrive.
- A normal sync looks at meetings that started within "Sync history (days)" (7 by default). A full sync ignores that limit.
- "Include shared meetings" (off by default) also fetches meetings that colleagues shared with you, your team or your workspace.
- The title filter can limit syncing to titles that contain a keyword, or skip those titles. The match ignores capital letters.
- A meeting with no title is treated as "Untitled meeting".
- If two of your connected accounts can see the same meeting, you still get one note. The account that owns the meeting writes it. If the owner's account is not connected, the first account in your list that can see it writes it.

### When a note is rewritten

A normal sync rewrites a meeting's note only when Circleback's copy is newer than the note, or when a file the settings call for is missing. A full sync rewrites everything. Changing a setting that changes what goes into notes does not change existing notes by itself: when you close the settings after such a change, a notice offers "Run full sync", which updates the text of existing notes. See the [settings reference](#settings-reference) for which settings that covers.

### The status bar

The status bar shows one entry for each account, for example `Circleback: Work 10:42, Personal error`.

- A time (today) or a date (`MMM D`) is the last successful sync on this device.
- "error" means the account stopped syncing. Open the settings tab to see why, under the account's API key.
- "key needed on this device" and "not synced yet" mean what they say.
- During a full sync it shows `Circleback: full sync` and the number of meetings done.
- With "Sync on this device" off it says `Circleback: off on this device`.
- With no accounts, it is hidden.

### Notices

- **Manual syncs and full syncs always answer.** You see how many meetings were updated, or that everything is up to date, and a count of meetings that could not be written or accounts that could not sync.
- **Automatic syncs speak up only when they updated notes or could not write some**, and only while "Show sync notifications" is on.
- **An account that stops syncing is announced once,** with the reason and what to do, for example: `Circleback Sync: "Work" stopped syncing because the API key was not accepted. Check its API key in the plugin settings.` When it works again, you get one more notice. Neither depends on "Show sync notifications", and a failing account is not announced again at every sync.
- **Duplicates.** A notice appears when the number of meetings with duplicate notes grows. See [Duplicates](#duplicates).

## What gets written

### Notes and transcripts

Each meeting becomes a note file. With "Sync transcripts" on, it also gets a transcript, either as a separate file or inside the note (see "Transcript handling"). Where files go, and what they are called, is set under Notes and Transcripts in the settings.

**The sync folder.** The base folder for notes, with every folder inside it, is the plugin's sync folder. When transcripts are saved in a custom folder, the transcript base folder is one too, and with "Sections in daily notes" so is your daily notes folder. Only the files in the sync folders count as a meeting's note and transcript. The plugin keeps them up to date, so the sync folder holds the full record of your synced meetings. If the base folder is the vault root, the whole vault is the sync folder.

Changing the subfolder or filename settings affects new notes only. Existing notes keep their folders and names and are still updated, since they are still in the sync folder. Changing a base folder moves the sync folder: meetings get new notes in the new folder as they sync, and the notes in the old folder stay where they are and are no longer updated. A full sync updates the text of existing notes, but it never moves or renames them.

**The body of a note belongs to the plugin.** Whenever the plugin rewrites a note, it replaces everything below the frontmatter, so any edit you made to the body is lost. Circleback updates each meeting once more the morning after it happens, so a meeting's note is rewritten then too. Put your own notes in frontmatter fields with names of your choosing, or in a separate note that links to the meeting note.

### Frontmatter

Frontmatter fields the plugin does not own are never touched or removed, so add your own freely. The fields below marked "Every write" are rewritten whenever the plugin rewrites the file, so changes you make to them are lost.

| Field | Set | What it holds |
| --- | --- | --- |
| `type` | Once, when the file is created | `note`, or `transcript` for a transcript file. A note with its transcript inside is also `note`. You can change it. |
| `title` | Every write | The meeting's title. |
| `created` | Every write | When Circleback started recording, as a UTC timestamp. This is usually a minute or two after the scheduled start. File names, folders and daily note times use it, in your local time. |
| `duration` | Every write | Length in minutes. |
| `attendees` | Every write (notes only) | Each attendee's name, or their email when there is no name. The key's owner is left out. |
| `attendee_emails` | Every write (notes only) | The attendees' emails. |
| `circleback_tags` | Every write | The meeting's tags in Circleback. |
| `meeting_url` | Every write | The video call link, when the meeting has one. |
| `transcript` | Every write (notes only) | A link to the transcript file, when it is a separate file. |
| `note` | Every write (transcripts only) | A link to the meeting's note, when there is a note file. |
| `circleback_id` | Every write | The meeting's id. This is how the plugin recognizes the note. |
| `circleback_kind` | Every write | `note`, `transcript` or `combined` (a note with its transcript inside). |
| `circleback_account` | Every write | The label of the account that wrote the file. |
| `circleback_updated` | Every write | When Circleback last updated the meeting, as of the last write. A normal sync compares it with Circleback's copy. |
| `circleback_first_synced` | Once, when the file is created | When the plugin first created the file. |
| `circleback_hash` | Every write | A fingerprint of the body the plugin wrote. |
| `circleback_url` | Every write | `https://circleback.ai/meetings/` followed by the meeting's id. |

Leave `circleback_id` and `circleback_kind` alone. Without them the plugin cannot recognize the note, and it would write a new one.

### Note body

The body has these parts, in this order. A part is left out when it has nothing to say.

1. With "Include private notes" on and private notes present: `## Private Notes`, then `## Enhanced Notes` holding Circleback's notes. Otherwise Circleback's notes stand alone.
2. `## Action Items`, with "Include action items" on: one plain bullet per item, giving the title, the assignee (or "unassigned"), the description, and "(done)" when finished. Circleback's own notes have no action items section, so the plugin adds this one from the meeting's action items. The bullets are not checkboxes, so task plugins do not show them as open tasks.
3. `## Insights`, with "Include insights" on: a `###` heading for each insight, with a bullet for each entry.
4. A closing line, `View in Circleback:` followed by the meeting's link.

### Transcripts

A transcript has one block for each run of consecutive lines by the same speaker:

```markdown
# Transcript for: Weekly planning

### Alex Rivera (2026-10-27T18:31:02.250Z)

Good morning. Thanks for making the time.

### You (2026-10-27T18:31:09.800Z)

Happy to. Let's start with the roadmap.
```

- Each time is the meeting's start plus the line's offset, in UTC.
- Your own lines are labeled "You", or with your name if "Self label" is set to "Your name". The plugin recognizes your lines by name: it looks among the speakers for the account's "Your name in transcripts", or when that is empty for the name it learns from Circleback's meeting data (capital letters do not matter). If your lines are not labeled, set "Your name in transcripts" to the name Circleback shows for you in transcripts. When "Self label" is "Your name", that name is also the label.
- A line with no speaker is labeled "Guest".
- When the transcript is inside the note, it goes after the closing "View in Circleback" line, under `## Transcript`.
- With "Save as" set to "Sections in daily notes", a transcript set to "In the note itself" cannot live inside a daily note, so it is saved as a separate file in your daily notes folder instead.
- Circleback may not have a transcript ready yet. With transcripts in separate files, the plugin asks again at the next sync. A note that holds its transcript gets it the next time Circleback updates the meeting, or at a full sync. If the key may not read a meeting's transcript, the plugin does not ask again until the meeting changes.
- Renaming a speaker in Circleback counts as an update to the meeting, so the fix reaches the transcript at the next sync, if the meeting is inside the sync history window. For an older meeting, run a full sync or raise "Sync history (days)".

### Files you move, rename or delete

- **A note you rename or move inside the sync folder stays where you put it,** and is still updated there. The plugin never moves a note to another folder.
- **A note you move out of the sync folder is yours.** The plugin no longer updates, renames, reports or trashes it. At the next sync that covers that meeting, it puts a fresh note in the sync folder: a normal sync, if the meeting is inside the sync history window, or a full sync. The meeting's transcript links to the fresh note, and so does the plugin's line for the meeting in the daily note, unless you edited that line. The same goes for a transcript you move out of its folder: the meeting gets a fresh transcript.
- **Renames.** If a meeting's title or date changes in Circleback, the plugin renames the note, inside its folder, but only if the note is still where and what the plugin named it. A note you renamed keeps your name.
- **Names.** Characters that file systems or wikilinks do not allow (`/ \ : * ? " < > | # ^ [ ]`) become `_`, and a title is cut to 200 characters. If another meeting already has the name, the plugin adds the meeting's date and time before `.md`.
- **A note you delete comes back** at the next sync, if its meeting is still inside the sync history window. A full sync brings back every note.
- **A meeting deleted in Circleback** leaves its note in your vault. Apart from the optional duplicate clean-up below, the plugin deletes only a file it has just created and could not finish: if writing the frontmatter fails right after it creates a file, it moves that half-written file to the trash.

## Daily notes

The plugin finds your daily notes the way Obsidian does. It uses the folder, name format and template from the core Daily Notes plugin, or from Periodic Notes if that plugin is enabled with daily notes on. With neither, it uses the vault root, the `YYYY-MM-DD` format and no template.

### Links

With "Link from daily notes" on and "Save as" set to "Individual files", the plugin adds one line for each meeting to the daily note of the day the meeting started (local time):

```markdown
- 14:31 - [[Circleback/Weekly planning|Weekly planning]]
```

- The line goes under the heading set in "Link heading" (`# Meetings` by default). Include the `#` marks and match the heading in your daily note template, or the plugin adds a second heading at the end of the note.
- New lines go in time order among the plugin's own lines. With none after them, a line goes at the end of the section.
- The plugin recognizes its own lines by their exact format and by their link pointing to a note with a `circleback_id`, so a line still counts after you rename or move the note.
- Lines you typed or edited are left alone. A meeting already linked anywhere in the section, in any form, is not added again.
- Each meeting has one line, linking to its note in the sync folder. If the plugin's line for a meeting, still as the plugin wrote it, links to a copy you moved out of the sync folder, the plugin changes that line, where it is, to link to the note in the sync folder. A line you edited, including one whose link text you changed, stays as it is, and the plugin adds no second line for that meeting.
- The plugin removes a line only when its meeting moved to a different day and the line is still as the plugin wrote it.
- The daily note is changed only when something in it needs to change.

### Sections

With "Save as" set to "Sections in daily notes", each meeting's notes go into the daily note itself, under the heading set in "Section heading" (`# Circleback notes` by default). Each meeting's block sits between two marker lines, `%% circleback-start <id> %%` and `%% circleback-end <id> %%`. Obsidian treats these as comments, so they do not show in reading view. An update replaces only what is between the markers. Text outside them is never touched. Circleback's own headings are moved below the meeting's heading, so they cannot end the section early. Sections are written only while "Sync notes" is on.

### Creating missing daily notes

"Create missing daily notes" decides what happens when a meeting's day has no daily note yet: "Always" creates it, "Only for today" creates it only when the meeting is from today, and "Never" creates none, so links and sections go only into daily notes that already exist. The new note starts from your daily note template. The plugin fills in `{{date}}`, `{{date:FORMAT}}`, `{{time}}` and `{{title}}`. It copies anything else as it is, including Templater tags, so vaults whose template uses Templater get the raw tags in notes the plugin creates.

## Duplicates

Before the plugin creates a file, it looks for an existing file with the same meeting id and the same kind (`note` or `transcript`) in its sync folders (see [The sync folder](#notes-and-transcripts)). That is why a note you rename, or move inside the sync folder, is updated and not copied, and why editing `type` does not cause a copy. A file outside the sync folders does not count: it is never reported as a duplicate and never trashed, and its meeting gets a fresh file in the sync folder.

A meeting can still end up with two files. Two devices syncing the same vault at the same moment, before each one has the other's new files, can each create one. So can copying a note by hand.

- **By default, duplicates are only reported.** After a sync, a notice tells you when the number of meetings with duplicates grows. The settings tab lists them under Duplicates, with a link to each file. This list shows the result of the last sync on this device. The first file in each group is the one the plugin treats as the original: the one with the earliest `circleback_first_synced`. A tie goes to the shorter path, then to path order, so a copy such as `Standup copy.md` or `Standup 1.md` never wins over `Standup.md`.
- **"Clean up duplicates" is off by default.** When on, the plugin moves an extra copy to the trash only if its body is unchanged since the plugin wrote it and it has no frontmatter fields beyond the plugin's own (`type` counts as the plugin's). The original is never trashed. It uses Obsidian's own trash setting.
- **Anything else is only reported.** That includes a copy you edited, and a meeting you split into several notes by hand.

To avoid duplicates from two devices, let only one device sync ("Sync on this device"), or keep the settle delay long enough for your sync service to bring in new files before a sync starts.

## Settings reference

Settings are grouped as they are in the settings tab. Each default is the value you get before changing anything. Numbers must be whole numbers within the range shown.

When you change a setting, what happens to existing notes depends on its kind:

- **Content settings** change what goes into notes: Sync notes, Sync transcripts, Include private notes, Include action items, Include insights, Save as, Link from daily notes, Transcript handling and Self label. A change applies to meetings synced from now on. When you close the settings, a notice offers to run a full sync, which updates the text of existing notes.
- **Placement settings** decide where new notes and transcripts go: Base folder, Custom base folder, Subfolders, Custom subfolder pattern and Filename pattern for notes, and Transcript base folder, Transcript subfolders, Custom transcript subfolder pattern and Transcript filename pattern for transcripts. A change affects new files only. A full sync never moves or renames an existing note, so existing notes keep their folders and file names. If you changed only placement settings, the notice says so and has no button. If you changed both kinds, the full sync notice adds that existing notes keep their folders and file names.
- **Changing a base folder moves the sync folder** (see [The sync folder](#notes-and-transcripts)). This happens when you change Base folder, Custom base folder or Transcript base folder, and also when "Save as" or "Transcript handling" changes which folders the plugin syncs. Meetings get new notes in the new folder as they sync, and the notes in the old folder stay where they are and are no longer updated. The notice says so. If you also changed a content setting, the full sync notice says it too. Nothing is left behind when the old folder is still inside a sync folder, for example when the new base folder is a folder above the old one, or when the old transcript base folder is inside the base folder, as it is by default. Then the notice only says that new notes use the new folders.

### Accounts

Add an account with "Add account". New accounts are labeled "Account 1", "Account 2" and so on. Each account has its own card in the tab, titled with its label ("Unnamed account" if the label is empty). A line after the last card says that everything below applies to every account. Each account has these settings:

| Setting | Default | What it does |
| --- | --- | --- |
| Label | "Account 1" | A name that tells your accounts apart. It appears in the status bar, in notices and in `circleback_account`. It cannot be empty. |
| API key | None | The account's Circleback API key. Saved on this device only. Beside it, "Clear key" removes the key from this device. |
| Test connection | | Checks the key and shows the email it belongs to, and the key's name. |
| Your name in transcripts | Empty | The speaker name that is you in transcripts. The plugin looks for it among the speakers to recognize your lines, and labels them as Self label says. It wins over the name found in your meetings, which is used when this is empty. |
| Remove account | | Removes the account and its key (see [API keys and devices](#api-keys-and-devices)). |

### Sync

| Setting | Default | What it does |
| --- | --- | --- |
| Periodic sync | Off, then on when you add your first account | Syncs automatically in the background. |
| Sync interval (minutes) | 30 | How often to sync. From 1 to 1440. |
| Settle delay (minutes) | 10 | How long to wait after Obsidian starts or the computer wakes before the next automatic sync. From 0 to 1440. |
| Sync on this device | On | Turn off on a device that should not sync. Saved on this device only. |
| Sync notes | On | Writes a note for each meeting. Off syncs only transcripts. |
| Sync transcripts | Off | Also writes each meeting's transcript. The Transcripts settings appear when this is on. |
| Show sync notifications | On | Shows a notice when an automatic sync updates notes or cannot write some. An account that stops syncing or starts again, and any sync you start yourself, always get a notice. |

### Filtering

| Setting | Default | What it does |
| --- | --- | --- |
| Sync history (days) | 7 | How far back each sync looks for meetings. From 1 to 3650. A full sync ignores it. |
| Include shared meetings | Off | Also syncs meetings shared with you, your team or your workspace. This can bring in many more meetings. |
| Title filter | Off | "Off", "Only titles containing the keyword", or "Skip titles containing the keyword". |
| Title filter keyword | Empty | The text to look for in titles. Shown when the title filter is on. With no keyword, the filter does nothing. |

### Notes

| Setting | Default | What it does |
| --- | --- | --- |
| Include private notes | Off | Adds the private notes you wrote on a meeting. |
| Include action items | On | Adds the meeting's action items. |
| Include insights | On | Adds the meeting's insights. |
| Save as | Individual files | "Individual files", or "Sections in daily notes". |
| Base folder | Custom folder | "Custom folder", or "Daily notes folder". Only for individual files. After a change, notes in the old folder are no longer updated. |
| Custom base folder | `Circleback` | The vault folder for notes. After a change, notes in the old folder are no longer updated. |
| Subfolders | None | Sorts notes into folders inside the base folder: "None", "By day" (`2026-10-27`), "By month" (`2026-10`), "Year, then month" (`2026/10`), "Year, then quarter" (`2026/Q4`) or "Custom pattern". |
| Custom subfolder pattern | Empty | The folders to use for "Custom pattern". A `/` makes a folder inside a folder. See [Pattern variables](#pattern-variables). |
| Filename pattern | `{title}` | What each note file is called, without `.md`. See [Pattern variables](#pattern-variables). |
| Link from daily notes | Off | Adds a link to each meeting in the daily note for its day. Only for individual files. |
| Link heading | `# Meetings` | The heading the links go under. |
| Section heading | `# Circleback notes` | The heading that meeting sections go under, for "Sections in daily notes". |
| Create missing daily notes | Always | "Always", "Only for today" or "Never". Shown when links or sections are on. |

### Transcripts

These settings appear when "Sync transcripts" is on.

| Setting | Default | What it does |
| --- | --- | --- |
| Transcript handling | Separate files in a custom folder | "Separate files in a custom folder", "Separate files next to the note", or "In the note itself". "In the note itself" needs individual files and "Sync notes" on. Otherwise the transcript gets a file next to the note. |
| Transcript base folder | `Circleback/Transcripts` | The vault folder for transcripts. Only for a custom folder. After a change, transcripts in the old folder are no longer updated. |
| Transcript subfolders | None | Same choices as "Subfolders", inside the transcript base folder. |
| Custom transcript subfolder pattern | Empty | The folders to use for "Custom pattern". See [Pattern variables](#pattern-variables). |
| Transcript filename pattern | `{title}-transcript` | What each transcript file is called, without `.md`. Not used for "In the note itself". See [Pattern variables](#pattern-variables). |
| Self label | You | "You", or "Your name". How your own lines are labeled. |

### Duplicates

| Setting | Default | What it does |
| --- | --- | --- |
| Clean up duplicates | Off | Moves an extra copy of a note to the trash, but only if nobody has edited it since the plugin wrote it. See [Duplicates](#duplicates). |

The tab also lists the duplicates found in the last sync on this device. Clicking a file in the list closes the settings window and opens the file.

### Advanced

| Setting | Default | What it does |
| --- | --- | --- |
| Full sync | | "Start full sync" starts a full sync. While one runs, the button says "Cancel full sync". |
| Debug logging | Off | Also prints the plugin's log to the developer console. Detail lines are at the Verbose level, so set the console to show Verbose to see them. Warnings and errors show at the console's default levels. |
| Copy logs | | Copies the plugin's recent log to the clipboard, with API keys removed. |

### Pattern variables

Filename and subfolder patterns can use these variables. They use the meeting's start in your local time.

| Variable | Gives | Example |
| --- | --- | --- |
| `{title}` | The meeting's title, cleaned for use in a file name | `Weekly planning` |
| `{date}` | The date | `2026-10-27` |
| `{time}` | The time | `13-45-00` |
| `{year}` | The year | `2026` |
| `{month}` | The month | `10` |
| `{day}` | The day | `27` |
| `{quarter}` | The quarter | `Q4` |

In a custom subfolder pattern, `{title}` gives an empty string, because a folder has no title. Text that is not a variable stays as you typed it. `{date} - {title}` gives file names like `2026-10-27 - Weekly planning.md`.

## Troubleshooting

### Copy logs and debug logging

The plugin keeps its recent log (up to 2,000 lines) in memory only. It never writes the log to your vault. "Copy logs" under Advanced copies it to the clipboard, with API keys removed. The log can include meeting titles, account labels and file paths, so read it before you share it.

"Debug logging" also prints the log to Obsidian's developer console. Detail lines are at the Verbose level, so set the console to show Verbose to see them. Warnings and errors show at the console's default levels.

### When an account stops syncing

The notice and the account's status line under its API key name the reason. The notice reads `Circleback Sync: "Work" stopped syncing because` followed by one of these:

| Reason | What to do |
| --- | --- |
| the API key was not accepted | The key is wrong, or may have been revoked in Circleback. Paste a working key in the plugin settings. |
| Circleback refused access | The key is valid, but Circleback says it may not view what was asked for. Check in Circleback that the key's owner can open those meetings. |
| Circleback's rate limit was reached | Circleback limits how many requests an account can make, shared across all its API keys and tools. The plugin spaces out its requests and waits when told to. It tries again at the next sync. A long full sync, or a short sync interval, makes this more likely. |
| Circleback did not answer in time | The plugin waits up to 60 seconds for each request. It tries again at the next sync. |
| there was no connection to Circleback | Check your network connection. It tries again at the next sync. |
| Circleback had a server error | It tries again at the next sync. |
| Circleback sent data this plugin version does not understand | Circleback may have changed its API. Check for a plugin update. |
| of an unexpected error | Use "Copy logs" for details. |

One account failing never stops the others.

### Other messages

- **"Key needed on this device"** (under an account's API key): paste the account's key on this device.
- **"syncing is off on this device"**: turn on "Sync on this device" in the plugin settings.
- **"no account has an API key on this device"**: add an account or paste a key in the plugin settings.
- **"a sync is already running"**: wait for it to finish. A full sync can take a while.

### A meeting is missing

- It has no notes in Circleback yet. The plugin picks it up when notes arrive.
- It started before the sync window. Raise "Sync history (days)" or run a full sync.
- The title filter excludes it.
- It was shared with you, and "Include shared meetings" is off.

### A setting did not change my old notes

Settings that change what goes into notes apply to meetings synced from now on. Run "Full sync" to update the text of the older ones. A full sync replaces the text of every synced note. Fields the plugin does not own are kept. Changing the subfolder or filename settings affects new notes only: a full sync never moves or renames an existing note. After a base folder change, the notes in the old folder are no longer updated: meetings get new notes in the new folder as they sync, and a full sync gives every meeting one.

## Credits and license

Circleback Sync is inspired by Tom Elliot's [`granola-sync`](https://github.com/tomelliot/obsidian-granola-sync) plugin, which does the same job for Granola. The settings and behavior follow that plugin so that the two feel alike. Circleback Sync is written from scratch and shares no code with it.

Circleback Sync is an unofficial plugin and is not affiliated with Circleback.

The plugin is released under the MIT License. See [LICENSE](LICENSE).
