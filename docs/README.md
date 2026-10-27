# Agent Box user guide

Create an isolated workspace, work with Codex, Pi or Devin CLI, and suspend it with its files
and running processes preserved. Everything is available in the browser.

This guide assumes Agent Box is already installed. Ask your administrator for
the HTTPS address, sign-in credentials and access to the configured model provider.
For platform setup and administration, see the [main README](../README.md).

## Quick start: your first sandbox

1. Open the HTTPS address provided by your administrator. If the installation
   uses Cloudflare Access, complete its identity-provider login and any required
   MFA, then sign in using the Agent Box form and your panel credentials. See
   [connection settings](../README.md#connect-to-an-installation) for CLI access.
2. Open Sandboxes, then Create Sandbox.
3. Keep the generated Name, generate another with the button beside it, or
   enter your own. Custom names use 2–50 lowercase letters, digits or hyphens,
   start with a letter and end with a letter or digit.
4. Choose Codex, Pi or Devin CLI under Agent. The default is Codex
   with GPT-6.1 Sol. Choose another Model if needed. Devin CLI can use its
   own default and requires first-time sign-in in Superterminal.
5. Optionally enter an Initial prompt, for example:

   ```text
   Create /workspace/hello.py that prints "Hello from Agent Box", run it,
   and report the result.
   ```

6. Click Create Sandbox. Follow the sandbox, agent and optional prompt
   progress. A successful prompt stage means the task was accepted. The agent
   may still be working.
7. Click Open Superterminal in the success notification, or open the sandbox's
   … menu and choose Open Superterminal. Select its agent and use Chat
   to follow the response. If you supplied an initial prompt, wait for that task
   instead of sending it again.

You can close the browser and reconnect later: native agent processes keep running.
Use Suspend when you want to save and suspend the whole sandbox.

## Creation options

| Option | What it does |
| --- | --- |
| Name | Identifies the sandbox in lists and navigation. The suggested name is editable. |
| Agent | Starts Codex, Pi or Devin CLI, or creates an empty sandbox with No agent. |
| Model | Offers GPT-6 Luna, GPT-6.1 Sol and GPT-6 Astra for Codex/Pi. Other model… accepts a custom ID. Devin CLI has an optional model ID. Availability depends on the provider account. |
| Initial prompt | Sends one task after the primary agent becomes ready. Leave it empty to prepare files first. |
| Advanced → Directory | Sets the primary agent's working directory. Defaults to `/workspace`. Missing folders inside it are created. |

Model, prompt and directory options apply when creating a sandbox with an agent.
To change the model later, use the agent's native model controls or commands in
Superterminal. Creating another agent lets you use a different working directory
without replacing the existing conversation.

No agent creates a workspace you can use immediately through Terminal and
Files. To add an agent later, open Superterminal, select the sandbox and
click New workspace. Choose an agent, set a directory inside `/workspace`,
optionally name the workspace, then click Start.

## Work in Superterminal

The navigation tree is Host → Worker → Sandbox → Agents. Agent Box is the
application. The configured host label names the machine hosting it. Workers
provide capacity, sandboxes contain your files and processes, and agents are the
individual Codex, Pi, Devin CLI or shell sessions inside them.

Select a sandbox, expand it and choose an agent. The right pane switches to that
agent while the navigation remains in place. Select a Worker to filter the tree.
All workers clears that filter. On small screens, use the navigation drawer.

| View or control | Use it for |
| --- | --- |
| Chat | Send messages and read responses, tool activity and command output. Expand tool details when needed. |
| Terminal inside Superterminal | Interact with the selected agent's native terminal, including native commands and prompts. |
| Stop agent | Interrupt the current task. This does not suspend the whole sandbox. |
| Input or permission card | Read the request and answer explicitly. Use the native terminal if the interaction needs it. |
| New workspace | Start another workspace in the selected sandbox with Codex, Pi, Devin CLI or a Shell. |
| New tab | Add another agent or shell in the current workspace's directory. |

Use Command palette in the session header for actions such as New workspace.
On a small screen it is under More. Its default shortcut is Ctrl+Shift+K
on Windows/Linux or ⌘⇧K on macOS. The + in the tab strip opens New tab.

The chat composer also supports Attach files, file/image paste and drag-and-drop.
Wait for attachments to finish uploading before sending. Use the native slash
command suggestions for commands offered by the selected agent. File paths in
responses can open a preview when supported.

Several agents, including Codex and Pi together, can run in one sandbox. Choose
the intended agent in the tree or its tab before sending a message. They share
the sandbox's files, CPU and memory. Create another sandbox when you need an
independent environment. Herdr workspaces and tabs share the selected sandbox.

Chat history is read from the agents' native conversation journals. Reconnecting
attaches to the existing session. A suspended sandbox must be resumed before its
conversation can be opened. Drafts and view selection stay scoped to their
conversation, so switching agents does not send or move an unsent message.

### Read agent status separately from sandbox state

A running sandbox can contain a working agent, an idle agent, or no agent.
Superterminal uses the native status indicator, with colours following its theme:

| Agent status | Meaning |
| --- | --- |
| RUN / animated arc | The agent is working. |
| BG / stationary arc | The turn is waiting on background work. |
| INPUT / question mark | The agent needs an answer or permission. |
| DONE / completion dot | Work finished and has not yet been acknowledged. |
| READY | The agent is idle and ready for input. |
| — | Its state is unknown. Inspect the session before taking action. |

## Prepare files and use a shell

Use the sandbox row's Files icon or the Files page to select a sandbox,
browse folders, create directories, upload files, download results and delete
files or empty directories. The file browser is limited to `/workspace`, rejects
symlinks and accepts uploads up to 64 MiB per file. Resume the sandbox before
using Files.

To bring in a project, upload files or open the sandbox row's Terminal icon
and clone the repository under `/workspace`. Repository access requires its own
credentials. Keep project files under `/workspace` so the agent and file browser
can work with them.

Keep `/workspace/.agent-state` intact: it holds native session and authentication
state used when reconnecting and resuming.

The separate Terminal page opens a shell. For persistent terminal work, run:

```sh
herdr
```

This attaches to the sandbox's existing Herdr server. Its agent and shell panes
remain available after browser disconnects. After Resume, use Connect on the
Terminal page to reconnect. Closing a browser connection does not create a snapshot.

Tasks is a simple way to send a prompt to the sandbox's configured primary
agent. Select a sandbox, enter a prompt and click Send task, then follow it
in Superterminal. For additional agents, use their Superterminal chat. Tasks targets the primary agent selected at creation. Use Superterminal chat
for agents added later.

## Manage sandboxes

The first action icon in a sandbox row changes with its state: Suspend for a
running sandbox and Resume for a suspended one. Terminal and Files icons sit
beside it. … contains the text actions, including Open Superterminal,
Resume & open, Send task, Restore snapshot when available, and deletion.

| Action | Result |
| --- | --- |
| Suspend | Saves a MEMORY snapshot of the whole sandbox, including process memory and files, then suspends it. Wait for completion. |
| Resume | Restores the saved sandbox and its existing processes and conversations. |
| Restore snapshot | Recovers a crashed sandbox from its last completed snapshot. Changes after that snapshot are lost. Confirmation is required. |
| Delete sandbox… | Permanently deletes the sandbox, workspace data and snapshots after confirmation. Export anything you want to keep first. Reusing the name creates a different sandbox. |

### Group actions

1. Check individual rows, or use the header checkbox to select all visible rows.
2. Choose Resume, Suspend or Delete….
   Resume applies to suspended selections. Suspend applies to running selections.
   Delete includes all selected states and asks you to confirm the listed names.
3. Keep this page open until processing finishes. Resume and Suspend run up to two
   sandboxes at a time. Deletion runs one at a time. Progress counts completed
   operations. Successful targets are deselected. Failures remain selected for an
   explicit retry after you inspect their state and the error.

Sorting and refreshing preserve selection. Changing the label filter clears it.
Use Clear to start over. Leaving the management page stops operations
that have not been sent. A request already submitted can still finish.

### Idle suspension and capacity

The current sandbox profile is 2 vCPU and 2 GiB RAM, shared by all its agents
and shell processes. There is no resource-size selector in the creation form.
Worker placement and capacity are managed by the platform.

Automatic suspension normally happens after 15 minutes of inactivity, once
there is no active turn, pending input, tool work or background/shell process.
Unknown state or failed probes delay it. An open shell pane can prevent idle
suspension. Use manual Suspend when you need an explicit saved state.

Suspend and Resume preserve an environment. Deleting it does not. Before deletion,
download valuable files to your own machine, or commit and push them to a remote
repository. Local commits inside the sandbox are deleted with its workspace.

## Appearance and sign-out

The panel's Theme selector offers light, dark, cupcake and synthwave.
Superterminal Settings contains its native appearance, font and keyboard
preferences. Its System theme follows the panel. Explicit Light/Dark overrides
apply across sandboxes in that browser. These preferences are stored per browser.

Sign out ends the current browser session across its open tabs and clears
unsent chat and terminal drafts. Native conversations and running agents remain.
Other browsers keep their own sessions. Sign-in supports password managers and
the password visibility button. Prompts and relevant project context are sent to
the configured model provider as part of agent work.

## When something goes wrong

| Situation | Next step |
| --- | --- |
| Creation reports an error or uncertain delivery | Use Check status or Open sandbox when offered, or inspect Sandboxes. Creation can continue after the tab disconnects. Check the existing sandbox before creating another or repeating the initial prompt. |
| The sandbox is suspended | Use Resume or Resume & open, then reconnect to the agent or shell. |
| The sandbox is running but the agent is unavailable | Read the displayed error and inspect it in Terminal. Running and agent readiness are separate states. |
| You do not know whether a message was delivered | Read the agent's current state, terminal and history before sending again. Input is not automatically retried. |
| The agent requests input | Select that agent and answer its prompt. Waiting for input is not idle suspension. |
| A model is unavailable or provider authentication fails | Ask the administrator to check provider access, or choose a model your account supports. |
| Repository or network requests fail | Check repository credentials and ask the administrator to check outbound access. The installation controls network policy. |
| A sandbox crashed | Use Restore snapshot only if offered, and accept that changes after the saved snapshot will be discarded. Otherwise ask the administrator to inspect it. |
| A batch partly fails | Inspect the reported targets, refresh their state and retry only the intended action. Successful targets have already been deselected. |

For command-line access, see
[CLI examples and access configuration](../README.md#connect-to-an-installation).


For Devin CLI, leave the model empty to use its own default and complete sign-in
in Superterminal on first launch. See [Devin CLI](DEVIN_CLI.md).
