# agora

A [Claude Code plugin marketplace](https://code.claude.com/docs/en/plugins/create-marketplace): one repository that lists plugins and where each one lives, so anyone with access can add it once and install plugins from it by name.

## Plugins

| Plugin | What it does |
| --- | --- |
| [`ticket-tracker`](plugins/ticket-tracker) | Tracks the Jira and GitHub issues and pull requests touched during a conversation, and what was done to each, in a pane you toggle on and off. |

## Using the marketplace

### 1. Add it

From a shell:

```bash
claude plugin marketplace add ilionblaze/agora
```

Or at the prompt inside a Claude Code session:

```
/plugin marketplace add ilionblaze/agora
```

In the desktop app, click **+** next to the prompt box, then **Plugins → Add marketplace**, and enter `ilionblaze/agora`.

If this repository is private, you need read access on GitHub and a git credential for github.com on your machine (an SSH key, or `gh auth login` followed by `gh auth setup-git`). The install never prompts for one.

### 2. Install a plugin

The install id is `<plugin>@agora`:

```bash
claude plugin install ticket-tracker@agora
```

Or `/plugin install ticket-tracker@agora` inside a session, which opens the plugin's details so you can pick a scope (user, project or local). You can also browse everything in the marketplace with `/plugin`.

One-step install that adds the marketplace if you haven't yet:

```
/plugin install ticket-tracker --marketplace ilionblaze/agora
```

### 3. Keep up to date

```bash
claude plugin marketplace update agora   # fetch the latest catalog
claude plugin update ticket-tracker@agora # move an installed plugin to the latest version
```

Then run `/reload-plugins` in an open session, or start a new one.

### Remove

```bash
claude plugin uninstall ticket-tracker@agora
claude plugin marketplace remove agora    # also uninstalls every plugin from it
```

### Make it available to a whole team

Commit this to a project's `.claude/settings.json` so everyone who trusts the project is offered the marketplace and its plugins:

```json
{
  "extraKnownMarketplaces": {
    "agora": { "source": { "source": "github", "repo": "ilionblaze/agora" } }
  },
  "enabledPlugins": {
    "ticket-tracker@agora": true
  }
}
```

## Adding a plugin

### Layout

```
agora/
├── .claude-plugin/
│   └── marketplace.json        # the catalog: one entry per plugin
└── plugins/
    └── <plugin-name>/
        ├── .claude-plugin/
        │   └── plugin.json     # the plugin's manifest; "name" must match its marketplace entry
        ├── README.md
        ├── skills/             # any of: skills, commands, agents, hooks, MCP servers ...
        ├── agents/
        ├── hooks/
        └── .mcp.json
```

See [plugin components](https://code.claude.com/docs/en/plugins/components) for everything a plugin directory can hold.

### Steps

1. **Create the plugin** under `plugins/<plugin-name>/` with at least `.claude-plugin/plugin.json`:

   ```json
   {
     "name": "my-plugin",
     "version": "0.1.0",
     "description": "One line about what it does",
     "author": { "name": "Your Name" }
   }
   ```

   Use lowercase letters, digits and hyphens for the name.

2. **Try it from disk** before listing it:

   ```bash
   claude --plugin-dir ./plugins/my-plugin
   claude plugin validate ./plugins/my-plugin
   ```

3. **List it** by adding an entry to `plugins` in [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json):

   ```json
   {
     "name": "my-plugin",
     "source": "./plugins/my-plugin",
     "description": "One line people see when browsing /plugin",
     "version": "0.1.0"
   }
   ```

   Rules that catch most broken installs:
   - `source` is a path from the **repository root** (the folder holding `.claude-plugin/`), starts with `./`, and never contains `..`.
   - The entry `name` and the `name` in the plugin's own `plugin.json` are the same.

   A plugin that lives in another repository can be listed too, with a source object instead of a path:

   ```json
   { "name": "other-plugin", "source": { "source": "github", "repo": "owner/other-plugin" } }
   { "name": "mono-plugin",  "source": { "source": "git-subdir", "url": "owner/monorepo", "path": "tools/mono-plugin" } }
   ```

4. **Validate the whole marketplace** and test an install from your working copy:

   ```bash
   claude plugin validate .
   claude plugin marketplace add ./          # registers your local checkout as "agora"
   claude plugin install my-plugin@agora
   ```

   A plugin installed from a local folder is read from that folder, so edits show up after `/reload-plugins`. Remove the local registration (`claude plugin marketplace remove agora`) before adding the GitHub one, since both use the name `agora`.

5. **Bump `version`** in both `plugin.json` and the marketplace entry whenever you change a published plugin, so `claude plugin update` picks it up. Then open a pull request.

### Further reading

- [Create a marketplace](https://code.claude.com/docs/en/plugins/create-marketplace)
- [Marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference): every `marketplace.json` field and source type
- [Host and maintain a marketplace](https://code.claude.com/docs/en/plugins/host-marketplace): private repos, versioning, renaming and removing plugins
