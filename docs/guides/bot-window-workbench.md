# Bots and Windows

The workbench has two modes over the same work:
- **Window mode** arranges conversations side by side, as layouts you keep.
- **Bot mode** lists your agents like a chat app and shows one conversation at a time.

Switch with **View → Bot mode** or **Window mode**, ⌥⌘2 and ⌥⌘1 (Ctrl+Alt+2 and Ctrl+Alt+1 elsewhere), or the command palette (⌘K).

## Groups and bots

Every Window is a **group**, and every current session in it is a **bot**: an ordinary session, a Side, a Team Leader or member, a Support session, or a TPM. Roles show as tags beside the name, and a label you give a bot shows beside its role. Asks are not bots: they nest under the bot they ask about.

- **Each session appears once in Bot mode**, in the first group that holds it, even if several Windows show it.
- **A group appears in both modes until you hide it** from one of them. Use **Hide in Bot mode** in the Window list, or the group's ⋯ menu in Bot mode. A group stays visible in at least one mode.
- **A group can hold bots from different Hosts.** Each bot's Info names its Host and provider.

**+ New bot** starts a session in a group of its own. The group is named after the session and follows the session's title once it has one.

## Working with a bot

Each bot has a ⋯ menu above its conversation. On a desktop, right-click its row, or press Shift+F10 or the context menu key. The menu offers:
- **Info**: Host, provider, model, and the providers before a handoff.
- **Label…**: add a short label.
- **Sleep**
- **Hide in Bot mode**: the bot stays a pane in Window mode.
- **Remove from group…**: asks first, and names what closes with the bot.

In a bot's conversation:
- **/side** (or **/btw**) opens a Side beside the bot in the same group.
- **/handoff** continues the bot on another provider of its Host. The bot keeps its place and its earlier conversation, which stays readable above a quiet divider.
- To start a Team, TPM work or a call for support from a bot, open its group in Window mode.

In Window mode, opening another session from a bot's pane opens it **beside** the bot, through the sidebar, Favorites, Track or a new session. Navigating within the bot's own handoff history stays in place, as do empty and history views.

## Folding, sleep and what stays live

- **Folding.** × on a bot's pane folds it into a slim card that stays in its group. × on the card removes the bot from the group, after asking.
- **Sleep.** A sleeping bot is dimmed and its conversation is released until it wakes. Opening it wakes it on every device. On a phone, Window panes do not fold, so a sleeping bot shows an **Asleep** bar with **Wake** instead.
- **Live conversations.** Each device keeps live the conversations on screen and the four it used most recently. Any other one is released 20 seconds after it leaves the screen, and shows its last loaded history until it is opened again. A conversation with input still on its way is never released.

## Replies, unread and drafts

Bot rows work like a chat list:
- Each row shows its bot's latest reply and when it came.
- A **dot** marks a reply you have not seen. It never shows a count.
- A bot at work shows typing dots.
- Read positions follow you: a reply read on one device is read on all of them. After a handoff, a row goes on with the bot's latest reply until the new session answers.
- A **draft** follows you to every device, and its row shows *Draft* until you send it.

## When a Host is offline

A bot whose Host is offline keeps its conversation readable. If that Host's Controller is 0.2.82 or newer, the composer offers **Send when ⟨Host⟩ is back**:
- The message waits on the Relay and shows as an outgoing message marked *Waiting for ⟨Host⟩* on every device.
- **Cancel** on any device removes it everywhere.
- When the Host returns, its Controller delivers the message once.
- A failed delivery stays visible with **Send again**.

Bot mode learns at once that a Host left or came back, from the same channel that carries replies.

## On a phone

Bot mode is a list, then a chat. **‹ Bots** returns to the list where you left it. Window mode shows one view at a time; switch views from the Window list.

## Limits

- **Notifications.** None arrive without an open page.
- **Teams.** There are no group chats for Teams.
- **Previews.** A bot that has not been opened since its Controller started keeping replies (0.2.81) shows no preview until it replies or is opened.
- **Rolling back the Worker.** Once the Relay stores sleep, read positions, drafts or outbox messages, Worker versions from before those stages cannot read it. Fix forward.

The Lab performance notes describe the budgets that keep the workbench quick as it grows ([stage 6](../../packages/agent-remote-lab/performance/README.md#bot-and-window-workbench-stage-6)) and the hour-long soak that checks it stays so ([stage 7](../../packages/agent-remote-lab/performance/README.md#bot-and-window-workbench-stage-7)).
