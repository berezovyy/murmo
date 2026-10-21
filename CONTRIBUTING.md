# Contributing

You need Node 24.18.0 (see `.node-version`), pnpm 10 (`corepack enable`), rustup (the toolchain in `rust-toolchain.toml` installs itself), and on Linux, Docker.

```sh
docker build -t murmo-offline:local tools/offline   # Linux only
tools/offline/fetch.sh
pnpm lint && pnpm check && pnpm build && pnpm test && pnpm test:portable
```

Read [AGENTS.md](AGENTS.md) for the commands, the offline rule and the disk rules, and [docs/plan/](docs/plan/README.md) for what each phase builds.
