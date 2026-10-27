# Devin CLI

Devin CLI runs as a native terminal agent in the sandbox. Herdr manages launch,
state hooks, conversation identity and resume. Devin uses its own account and
permission settings.

## Create and sign in

1. Choose Devin CLI in Create Sandbox.
2. Leave Model ID empty for the CLI default, or enter a model supported by your account.
3. Open Superterminal and complete login and workspace trust. In a remote sandbox,
   choose Paste a token manually. Open the link shown by Devin in your browser
   and paste the credential directly into the CLI prompt.
4. Send a task after the agent reports ready.

The Python CLI can also create a Devin sandbox:

```sh
python3 agent.py devin-dev --kind devin
```

If an initial task arrives before login is complete, the sandbox remains available
for setup. Complete login, then send the task. Keep sign-in tokens out of Agent
Tasks and chat.

## State and lifecycle

HOME is `/workspace/.agent-state`. Devin stores credentials, configuration and
conversations under `.config/devin` and `.local/share/devin` in that directory.
Keep these files with the sandbox and protect them as credentials.

Herdr owns the terminal process and installs the Devin session hooks. Chat and
Tasks use the agent's readiness state before submitting a prompt. Reconnecting
attaches to the running session. Suspend/Resume preserves processes and files.

Active turns, pending input, background tasks and unknown processes keep the
sandbox awake. Idle agents are eligible for the configured automatic suspension.

## Runtime image

`runtime/Dockerfile` pins Devin CLI 3000.11.205 and verifies its SHA-256 digest.
`deploy/refresh-native-runtime.py` creates runtime revisions for new sandboxes
when images change. Existing sandboxes keep their own images and saved state.

Official documentation: [Devin CLI](https://docs.devin.ai/cli).
